"""LiveRemote: JSON lines over TCP 127.0.0.1:9870 -> a fixed set of LOM commands.

Protocol: one line of JSON per call,
  {"token": "<secret>", "cmd": "<name>", "args": [...], "kwargs": {...}}
-> {"ok": true, "result": ...} or {"ok": false, "error": "..."}.

Security: listens on loopback only, closes a connection at the first line
that is not a JSON object (a web browser can only send HTTP, whose first
line never is), and never runs strings as code: every cmd maps to a cmd_*
method with fixed parameters. A token is optional: when a file
.liveremote-token next to this script holds one, every call must carry it.

Commands: ping, amxd_list, amxd_read, midi_read, browser_uri, clip_envelopes, set_clip_envelope, clear_clip_envelope, lom_dir, lom_doc, reload, device_dir, tracks, devices, add_device, delete_device, create_midi_track,
  transport, selection, scenes, clips, fire, undo, redo, param, param_strs, param_set_display (for the live-mcp bridge),
create_audio_track, delete_track, rename_track, select_track, routing,
routing_options, param, browser, log.

All LOM work happens on the main thread: the socket thread queues, _poll() drains
the queue every 100 ms via schedule_message.
"""
import base64
import json
import os
import queue
import secrets
import socket
import threading
import re
import traceback

from _Framework.ControlSurface import ControlSurface

HOST, PORT = "127.0.0.1", 9870
MAIN_THREAD_TIMEOUT = 20.0
TOKEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".liveremote-token")


def ok(result=None):
    return {"ok": True, "result": result}


def err(msg):
    return {"ok": False, "error": msg}


def load_token():
    """The token in .liveremote-token next to this script, or None when there is none (no token required)."""
    try:
        with open(TOKEN_PATH) as f:
            return f.read().strip() or None
    except OSError:
        return None


AMXD_MAX_FILES = 500
AMXD_MAX_DEPTH = 6
AMXD_MAX_BYTES = 32 * 1024 * 1024


def amxd_list(dirs):
    """The .amxd files under the given folders, with modification time and size. Live extensions may not read
    outside their own folder, so the extension asks the bridge; only .amxd files are listed or read."""
    found = []

    def walk(d, depth):
        if depth > AMXD_MAX_DEPTH or len(found) >= AMXD_MAX_FILES:
            return
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name)
        except OSError:
            return
        for e in entries:
            if e.name.startswith(".") or len(found) >= AMXD_MAX_FILES:
                continue
            if e.is_dir(follow_symlinks=False):
                walk(e.path, depth + 1)
            elif e.is_file() and e.name.lower().endswith(".amxd"):
                st = e.stat()
                found.append({"file": e.path, "mtime": st.st_mtime * 1000, "size": st.st_size})

    for d in dirs or []:
        walk(os.path.expanduser(str(d)), 0)
    return found


def _read_b64(path, endings, what):
    path = os.path.expanduser(str(path))
    if not path.lower().endswith(endings) or not os.path.isfile(path):
        raise ValueError("not %s: %r" % (what, path))
    if os.path.getsize(path) > AMXD_MAX_BYTES:
        raise ValueError("%s is larger than %d bytes" % (path, AMXD_MAX_BYTES))
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def amxd_read(path):
    """One .amxd file as base64."""
    return _read_b64(path, (".amxd",), "an .amxd file")


def midi_read(path):
    """One MIDI file (.mid, .midi) as base64; the bridge reads these two kinds of file and nothing else."""
    return _read_b64(path, (".mid", ".midi"), "a MIDI file")




class LiveRemote(ControlSurface):
    def __init__(self, c_instance):
        super().__init__(c_instance)
        self._queue = queue.Queue()
        self._stop = threading.Event()
        self._sock = None
        self._token = load_token()
        with self.component_guard():
            try:
                self._start_server()
                self.log_message("LiveRemote listening on %s:%d" % (HOST, PORT))
            except Exception:
                self.log_message("LiveRemote: could not start server\n" + traceback.format_exc())
            self.schedule_message(1, self._poll)

    # -- server ---------------------------------------------------------
    def _start_server(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((HOST, PORT))
        s.listen(4)
        s.settimeout(0.5)
        self._sock = s
        threading.Thread(target=self._serve, name="LiveRemote-accept", daemon=True).start()

    def _serve(self):
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            self._serve_connection(conn)
        except OSError:
            pass  # the client hung up or timed out; nothing to answer

    def _serve_connection(self, conn):
        # Everything runs on the main thread (_poll), file work included: Live keeps Python's lock almost all the
        # time, so a background thread that does many system calls crawls (listing a folder took over 20 s).
        with conn:
            conn.settimeout(60)
            f = conn.makefile("rwb")
            for line in f:
                try:
                    req = json.loads(line.decode("utf-8"))
                except Exception:
                    req = None
                if not isinstance(req, dict):
                    # Not our protocol: an HTTP request from a web page, say. Answer nothing and hang up.
                    break
                if self._token is not None and not secrets.compare_digest(str(req.get("token", "")), self._token):
                    resp = err("wrong token (see .liveremote-token next to LiveRemote.py)")
                else:
                    done = threading.Event()
                    holder = {}
                    self._queue.put((req, holder, done))
                    if done.wait(MAIN_THREAD_TIMEOUT):
                        resp = holder.get("resp", err("no response"))
                    else:
                        resp = err("timeout: Live's main thread did not respond")
                try:
                    f.write((json.dumps(resp, default=str) + "\n").encode("utf-8"))
                    f.flush()
                except OSError:
                    break

    def _poll(self):
        try:
            while True:
                req, holder, done = self._queue.get_nowait()
                try:
                    holder["resp"] = self._execute(req)
                except Exception:
                    holder["resp"] = err(traceback.format_exc())
                done.set()
        except queue.Empty:
            pass
        if not self._stop.is_set():
            self.schedule_message(1, self._poll)

    def disconnect(self):
        self._stop.set()
        try:
            if self._sock:
                self._sock.close()
        except OSError:
            pass
        super().disconnect()

    # -- dispatch -------------------------------------------------------
    def _execute(self, req):
        cmd = str(req.get("cmd"))
        args = req.get("args") or []
        kwargs = req.get("kwargs") or {}
        if cmd == "ping":
            return ok("pong")
        handler = getattr(self, "cmd_" + cmd, None) if cmd.isidentifier() else None
        if handler is None:
            return err("unknown command: %r" % cmd)
        return ok(_jsonable(handler(*args, **kwargs)))

    # -- helpers -------------------------------------------------------
    def _tracks_all(self):
        song = self.song()
        return list(song.tracks) + list(song.return_tracks) + [song.master_track]

    def _track(self, index):
        tracks = self._tracks_all()
        if isinstance(index, str):
            for t in tracks:
                if t.name == index:
                    return t
            raise ValueError("no track named %r" % index)
        return tracks[int(index)]

    def _track_kind(self, t):
        song = self.song()
        if t == song.master_track:
            return "master"
        if t in list(song.return_tracks):
            return "return"
        return "midi" if t.has_midi_input else "audio"

    @staticmethod
    def _dn(obj):
        return getattr(obj, "display_name", None) if obj is not None else None

    # -- commands ------------------------------------------------------
    def cmd_reload(self):
        """Reload this module from disk and swap the class of the running instance,
        so that new cmd_* work without restarting Live. Run install-remote.sh
        first."""
        import importlib
        import sys
        mod = importlib.reload(sys.modules[self.__class__.__module__])
        self.__class__ = mod.LiveRemote
        self.log_message("LiveRemote: reloaded")
        return "reloaded"

    def cmd_device_dir(self, track, device):
        """Introspection: public attributes of the device object (read-only)."""
        d = self._device(track, device)
        return {"type": type(d).__name__, "module": type(d).__module__,
                "attrs": [a for a in dir(d) if not a.startswith("_")]}

    def cmd_amxd_list(self, dirs):
        return amxd_list(dirs)

    def cmd_amxd_read(self, path):
        return amxd_read(path)

    def cmd_midi_read(self, path):
        return midi_read(path)

    def cmd_browser_uri(self, name):
        """The uri and source of the first loadable browser item with this name, e.g. query:UserLibrary#Clips:x.mid."""
        label, item = self._find_item(name)
        return None if item is None else {"from": label, "uri": item.uri, "source": item.source}

    def cmd_lom_dir(self, path):
        """Introspection: public names of a class in Live's Python module, e.g. "Clip.Clip" (read-only)."""
        import Live
        obj = Live
        for part in [p for p in str(path).split(".") if p]:
            if part.startswith("_"):
                raise ValueError("private names are not shown")
            obj = getattr(obj, part)
        return [a for a in dir(obj) if not a.startswith("_")]

    def cmd_lom_doc(self, path):
        """Introspection: the docstring of something in Live's Python module, e.g. "Envelope.Envelope.create_event"."""
        import Live
        obj = Live
        for part in [p for p in str(path).split(".") if p]:
            if part.startswith("_"):
                raise ValueError("private names are not shown")
            obj = getattr(obj, part)
        return getattr(obj, "__doc__", None)

    # -- clip automation (session clips only: Live gives no envelope for arrangement clips) ------------------------
    # A parameter is named by a ref: {"devices": [d, c, d2, ...], "param": i} walks track.devices[d], its
    # chains[c].devices[d2] and so on; {"mixer": "volume" | "panning"} or {"mixer": "send", "index": i}.

    def _session_clip(self, track, slot):
        clip = self._track(track).clip_slots[int(slot)].clip
        if clip is None:
            raise ValueError("clip slot %s is empty" % slot)
        return clip

    @staticmethod
    def _nth(seq, n, what):
        n = int(n)
        if n < 0 or n >= len(seq):
            raise ValueError("no %s %d (there are %d)" % (what, n, len(seq)))
        return seq[n]

    def _param_from_ref(self, t, ref):
        if "mixer" in ref:
            m = t.mixer_device
            kind = str(ref["mixer"])
            if kind == "send":
                return self._nth(m.sends, ref.get("index", 0), "send")
            if kind == "volume":
                return m.volume
            if kind == "panning":
                return m.panning
            raise ValueError("unknown mixer control %r" % kind)
        path = list(ref["devices"])
        if not path or len(path) % 2 == 0:
            raise ValueError("a device path is device, then chain and device per rack level")
        d = self._nth(t.devices, path[0], "device")
        i = 1
        while i + 1 < len(path):
            d = self._nth(self._nth(d.chains, path[i], "chain").devices, path[i + 1], "device")
            i += 2
        return self._nth(d.parameters, ref["param"], "parameter")

    def _ref_of(self, t, param):
        m = t.mixer_device
        if param == m.volume:
            return {"mixer": "volume"}
        if param == m.panning:
            return {"mixer": "panning"}
        for i, s in enumerate(m.sends):
            if param == s:
                return {"mixer": "send", "index": i}

        def walk(devices, path):
            for di, d in enumerate(devices):
                for pi, p in enumerate(d.parameters):
                    if p == param:
                        return {"devices": path + [di], "param": pi}
                for ci, c in enumerate(getattr(d, "chains", []) or []):
                    hit = walk(c.devices, path + [di, ci])
                    if hit:
                        return hit
            return None

        return walk(t.devices, [])

    @staticmethod
    def _events(envelope, end):
        return [[e.time, e.value] for e in envelope.events_in_range(0.0, float(end))]

    def cmd_clip_envelopes(self, track, slot):
        """Every automation envelope of a session clip: the parameter's ref and name, and its breakpoints [time, value]."""
        t = self._track(track)
        clip = self._session_clip(track, slot)
        end = max(clip.length, clip.loop_end, clip.end_marker) + 1
        out = []
        for env in clip.automation_envelopes:
            p = env.parameter
            out.append({"ref": self._ref_of(t, p), "name": p.name, "min": p.min, "max": p.max, "events": self._events(env, end)})
        return out

    def cmd_set_clip_envelope(self, track, slot, ref, events, replace=True):
        """Writes breakpoints [time, value] or [time, value, x1, y1, x2, y2] into a session clip's envelope for one
        parameter, as one undo step. replace clears the envelope first; otherwise the points are added."""
        t = self._track(track)
        clip = self._session_clip(track, slot)
        param = self._param_from_ref(t, ref)
        import Live
        song = self.song()
        song.begin_undo_step()
        try:
            env = clip.automation_envelope(param)
            if env is not None and replace:
                clip.clear_envelope(param)
                env = None
            if env is None:
                env = clip.create_automation_envelope(param)
            for ev in events:
                time, value = float(ev[0]), float(ev[1])
                if len(ev) >= 6:
                    cc = Live.Envelope.EnvelopeEventControlCoefficients(float(ev[2]), float(ev[3]), float(ev[4]), float(ev[5]))
                    env.create_event(Live.Envelope.EnvelopeEvent(time, value, cc))
                else:
                    env.create_event(Live.Envelope.EnvelopeEvent(time, value))
        finally:
            song.end_undo_step()
        end = max(clip.length, clip.loop_end, clip.end_marker) + 1
        return {"name": param.name, "events": self._events(env, end)}

    def cmd_clear_clip_envelope(self, track, slot, ref=None):
        """Clears one parameter's envelope in a session clip, or all of them when ref is None, as one undo step."""
        t = self._track(track)
        clip = self._session_clip(track, slot)
        song = self.song()
        song.begin_undo_step()
        try:
            if ref is None:
                clip.clear_all_envelopes()
                return "all"
            param = self._param_from_ref(t, ref)
            clip.clear_envelope(param)
            return param.name
        finally:
            song.end_undo_step()

    def cmd_log(self, msg):
        self.log_message("LiveRemote: %s" % msg)
        return True

    def cmd_tracks(self):
        rows = []
        for i, t in enumerate(self._tracks_all()):
            row = {"index": i, "name": t.name, "kind": self._track_kind(t), "devices": [d.name for d in t.devices]}
            if row["kind"] in ("midi", "audio"):
                row.update(input_type=self._dn(t.input_routing_type), input_channel=self._dn(t.input_routing_channel),
                           output_type=self._dn(t.output_routing_type), output_channel=self._dn(t.output_routing_channel),
                           monitor=["In", "Auto", "Off"][t.current_monitoring_state] if t.can_be_armed else None,
                           arm=t.arm if t.can_be_armed else None)
            rows.append(row)
        return rows

    def cmd_devices(self, track):
        t = self._track(track)
        return [{"index": i, "name": d.name, "class": d.class_name, "class_display": d.class_display_name,
                 "parameters": [p.name for p in d.parameters]} for i, d in enumerate(t.devices)]

    def cmd_select_track(self, track):
        t = self._track(track)
        self.song().view.selected_track = t
        return t.name

    def cmd_create_midi_track(self, index=-1, name=None):
        t = self.song().create_midi_track(int(index))
        if name:
            t.name = name
        return self._tracks_all().index(t)

    def cmd_create_audio_track(self, index=-1, name=None):
        t = self.song().create_audio_track(int(index))
        if name:
            t.name = name
        return self._tracks_all().index(t)

    def cmd_delete_track(self, track):
        t = self._track(track)
        idx = list(self.song().tracks).index(t)
        name = t.name
        self.song().delete_track(idx)
        return "deleted track %d %r" % (idx, name)

    def cmd_rename_track(self, track, name):
        t = self._track(track)
        t.name = str(name)
        return t.name

    def cmd_device_name(self, track, device, name=None):
        """Reads the device's name, or sets it (to test whether Live allows renaming a device)."""
        d = self._device(track, device)
        if name is not None:
            d.name = name
        return {"name": d.name, "class_name": getattr(d, "class_name", None)}

    def cmd_delete_device(self, track, device):
        t = self._track(track)
        if isinstance(device, str):
            device = [d.name for d in t.devices].index(device)
        name = t.devices[int(device)].name
        t.delete_device(int(device))
        return "deleted %r from %r" % (name, t.name)

    # Browser: Places (user_folders) + stock categories.
    def _browser_roots(self):
        b = self.application().browser
        roots = [("Places/" + f.name, f) for f in b.user_folders]
        for attr in ("audio_effects", "midi_effects", "instruments", "max_for_live", "plugins", "user_library"):
            roots.append((attr, getattr(b, attr)))
        return roots

    def _find_item(self, name, max_depth=6):
        want = str(name).lower()
        stem = want.rsplit(".", 1)[0]

        def match(item):
            n = item.name.lower()
            return n == want or n == stem or n.rsplit(".", 1)[0] == stem

        def walk(item, depth):
            if depth > max_depth:
                return None
            for child in item.iter_children:
                if child.is_loadable and match(child):
                    return child
                if child.is_folder or not child.is_loadable:
                    hit = walk(child, depth + 1)
                    if hit:
                        return hit
            return None

        for label, root in self._browser_roots():
            hit = walk(root, 0)
            if hit:
                return label, hit
        return None, None

    def cmd_browser(self, path=""):
        """List the browser roots, or the children of 'root/sub/folder'."""
        if not path:
            return [label for label, _ in self._browser_roots()]
        parts = str(path).split("/")
        node = None
        for label, root in self._browser_roots():
            lp = label.split("/")
            if parts[: len(lp)] == lp:
                node = root
                parts = parts[len(lp):]
                break
        if node is None:
            raise ValueError("unknown root in %r" % path)
        for p in parts:
            nxt = [c for c in node.iter_children if c.name == p]
            if not nxt:
                raise ValueError("not found: %r" % p)
            node = nxt[0]
        return [{"name": c.name, "loadable": c.is_loadable, "device": c.is_device, "folder": c.is_folder} for c in node.iter_children]

    def cmd_add_device(self, track, name):
        """Load a device (stock name or file name under Places) onto the track,
        after the track's selected device."""
        t = self._track(track)
        label, item = self._find_item(name)
        if item is None:
            raise ValueError("no loadable browser item named %r (add the folder under Places)" % name)
        self.song().view.selected_track = t
        before = [d.name for d in t.devices]
        self.application().browser.load_item(item)
        after = [d.name for d in t.devices]
        return {"from": label, "item": item.name, "devices_before": before, "devices_after": after}

    def cmd_routing_options(self, track):
        t = self._track(track)
        return {"input_types": [self._dn(x) for x in t.available_input_routing_types],
                "input_channels": [self._dn(x) for x in t.available_input_routing_channels],
                "output_types": [self._dn(x) for x in t.available_output_routing_types],
                "output_channels": [self._dn(x) for x in t.available_output_routing_channels]}

    def cmd_routing(self, track, input_type=None, input_channel=None, output_type=None, output_channel=None, monitor=None):
        """Set routing by (part of) the display name, case-insensitive.
        monitor: 'In' | 'Auto' | 'Off'. Omitted = unchanged."""
        t = self._track(track)

        def pick(options, want):
            names = [self._dn(o) for o in options]
            for o, n in zip(options, names):
                if n and n.lower() == str(want).lower():
                    return o
            hits = [o for o, n in zip(options, names) if n and str(want).lower() in n.lower()]
            if len(hits) != 1:
                raise ValueError("%r matches %d options: %s" % (want, len(hits), names))
            return hits[0]

        if input_type is not None:
            t.input_routing_type = pick(t.available_input_routing_types, input_type)
        if input_channel is not None:
            t.input_routing_channel = pick(t.available_input_routing_channels, input_channel)
        if output_type is not None:
            t.output_routing_type = pick(t.available_output_routing_types, output_type)
        if output_channel is not None:
            t.output_routing_channel = pick(t.available_output_routing_channels, output_channel)
        if monitor is not None:
            t.current_monitoring_state = ["in", "auto", "off"].index(str(monitor).lower())
        return {"input_type": self._dn(t.input_routing_type), "input_channel": self._dn(t.input_routing_channel),
                "output_type": self._dn(t.output_routing_type), "output_channel": self._dn(t.output_routing_channel),
                "monitor": ["In", "Auto", "Off"][t.current_monitoring_state] if t.can_be_armed else None}

    # Device routing points (Max for Live devices only; External Instrument/Effect expose none).
    def cmd_device_io(self, track, device):
        """List the device's midi_inputs/midi_outputs/audio_inputs/audio_outputs
        with current and available routings."""
        d = self._device(track, device)
        out = {}
        for kind in ("midi_inputs", "midi_outputs", "audio_inputs", "audio_outputs"):
            ios = getattr(d, kind, None)
            if ios is None:
                continue
            out[kind] = [{"index": i, "type": self._dn(io.routing_type), "channel": self._dn(io.routing_channel),
                          "types": [self._dn(x) for x in io.available_routing_types],
                          "channels": [self._dn(x) for x in io.available_routing_channels]} for i, io in enumerate(ios)]
        return out

    def cmd_device_routing(self, track, device, io, type=None, channel=None, index=0):
        """Set routing on the device's io ('midi_outputs' | 'audio_inputs' | …)
        by (part of) the display name. Returns the result."""
        d = self._device(track, device)
        ios = getattr(d, io, None)
        if ios is None:
            raise ValueError("%s has no %s Live exposes (only Max for Live devices have routing points; "
                             "External Instrument's MIDI To / Audio From can only be set in Live's window)" % (d.name, io))
        if not ios or int(index) >= len(ios):
            raise ValueError("%s has %d %s; index %s is out of range" % (d.name, len(ios), io, index))
        target = ios[int(index)]

        def pick(options, want):
            names = [self._dn(o) for o in options]
            exact = [o for o, n in zip(options, names) if n and n.lower() == str(want).lower()]
            if exact:
                return exact[0]
            hits = [o for o, n in zip(options, names) if n and str(want).lower() in n.lower()]
            if len(hits) != 1:
                raise ValueError("%r matches %d options: %s" % (want, len(hits), names))
            return hits[0]

        if type is not None:
            target.routing_type = pick(target.available_routing_types, type)
        if channel is not None:
            target.routing_channel = pick(target.available_routing_channels, channel)
        return {"io": io, "index": int(index), "type": self._dn(target.routing_type), "channel": self._dn(target.routing_channel)}

    def cmd_param(self, track, device, param, value=None):
        t = self._track(track)
        d = t.devices[int(device)] if not isinstance(device, str) else [x for x in t.devices if x.name == device][0]
        p = [x for x in d.parameters if x.name == param][0] if isinstance(param, str) else d.parameters[int(param)]
        if value is not None:
            p.value = float(value)
        return self._param_row(p, list(d.parameters).index(p))

    @staticmethod
    def _param_row(p, index):
        return {"index": index, "name": p.name, "original_name": getattr(p, "original_name", None), "value": p.value,
                "str": p.str_for_value(p.value), "display": p.str_for_value(p.value), "min": p.min, "max": p.max,
                "is_quantized": p.is_quantized, "value_items": list(p.value_items) if p.is_quantized else []}

    def _device(self, track, device):
        t = self._track(track)
        return t.devices[int(device)] if not isinstance(device, str) else [x for x in t.devices if x.name == device][0]

    def cmd_param_strs(self, track, device):
        """Every parameter of the device in one call: index, name, value, str, min, max, is_quantized, value_items."""
        d = self._device(track, device)
        return [self._param_row(p, i) for i, p in enumerate(d.parameters)]

    @staticmethod
    def _shown_number(text):
        """The number in a displayed value such as "-12 dB", "440 Hz", "50 %" or "1/16"; ValueError when there is none."""
        m = re.search(r"-?inf|[-+]?\d+(?:[.,]\d+)?", str(text))
        if not m:
            raise ValueError("no number in the displayed value %r" % text)
        return float(m.group(0).replace(",", "."))

    def cmd_param_set_display(self, track, device, param, target):
        """Set a parameter by its displayed value: quantized ones by item name (exact, then case-insensitive, then by the
        number shown), continuous ones by bisection on the internal value until the number shown is closest to the target."""
        d = self._device(track, device)
        p = [x for x in d.parameters if x.name == param][0] if isinstance(param, str) else d.parameters[int(param)]
        target = str(target)
        if p.is_quantized:
            items = list(p.value_items)
            lo, hi = int(p.min), int(p.max)
            idx = None
            if target in items:
                idx = items.index(target)
            elif target.strip().lower() in [i.strip().lower() for i in items]:
                idx = [i.strip().lower() for i in items].index(target.strip().lower())
            else:
                shown = {v: p.str_for_value(v) for v in range(lo, hi + 1)}
                for v, text in shown.items():
                    if text.strip().lower() == target.strip().lower():
                        idx = v - lo
                        break
                if idx is None:
                    want = self._shown_number(target)
                    best = min(shown, key=lambda v: abs(self._shown_number(shown[v]) - want))
                    idx = best - lo
            p.value = lo + idx
            row = self._param_row(p, list(d.parameters).index(p))
            row.update(target=target, error_abs=0.0)
            return row
        want = self._shown_number(target)
        lo, hi = float(p.min), float(p.max)
        shown = lambda v: self._shown_number(p.str_for_value(v))
        rising = shown(hi) >= shown(lo)
        for _ in range(40):
            mid = (lo + hi) / 2.0
            if (shown(mid) < want) == rising:
                lo = mid
            else:
                hi = mid
        best = min((lo, hi, p.min, p.max), key=lambda v: abs(shown(v) - want))
        p.value = best
        row = self._param_row(p, list(d.parameters).index(p))
        row.update(target=target, error_abs=abs(shown(p.value) - want))
        return row

    # -- transport, selection, scenes and clips (for the live-mcp bridge; the Extensions SDK has none of these) --
    def cmd_transport(self, action=None):
        """Transport status, or run an action first: play | stop | continue | stop_all_clips | record_on | record_off |
        metronome_on | metronome_off | loop_on | loop_off | back_to_arrangement."""
        song = self.song()
        if action is not None:
            action = str(action)
            if action == "play":
                song.start_playing()
            elif action == "stop":
                song.stop_playing()
            elif action == "continue":
                song.continue_playing()
            elif action == "stop_all_clips":
                song.stop_all_clips()
            elif action in ("record_on", "record_off"):
                song.record_mode = action == "record_on"
            elif action in ("metronome_on", "metronome_off"):
                song.metronome = action == "metronome_on"
            elif action in ("loop_on", "loop_off"):
                song.loop = action == "loop_on"
            elif action == "back_to_arrangement":
                # Like the Back to Arrangement button: tracks that a session clip took over play the arrangement again.
                song.back_to_arranger = False
            else:
                raise ValueError("unknown transport action %r" % action)
        return {"is_playing": song.is_playing, "record_mode": song.record_mode, "tempo": song.tempo,
                "signature_numerator": song.signature_numerator, "signature_denominator": song.signature_denominator,
                "current_song_time": song.current_song_time, "loop": song.loop, "loop_start": song.loop_start,
                "loop_length": song.loop_length, "metronome": song.metronome,
                "overdub": getattr(song, "overdub", None), "session_record": getattr(song, "session_record", None),
                "arrangement_overridden": getattr(song, "back_to_arranger", None)}

    def cmd_selection(self, track=None, device=None, scene=None):
        """The selected track (index in tracks + returns + master), device on it and scene; set any of them first."""
        song = self.song()
        if track is not None:
            song.view.selected_track = self._track(track)
        if device is not None:
            song.view.select_device(self._device(track if track is not None else song.view.selected_track.name, device))
        if scene is not None:
            song.view.selected_scene = song.scenes[int(scene)]
        tracks, scenes = self._tracks_all(), list(song.scenes)
        t, sc = song.view.selected_track, song.view.selected_scene
        dev = t.view.selected_device if t is not None else None
        devices = list(t.devices) if t is not None else []
        return {"track": tracks.index(t) if t in tracks else None, "track_name": t.name if t is not None else None,
                "track_kind": self._track_kind(t) if t is not None else None,
                "device": devices.index(dev) if dev in devices else None, "device_name": dev.name if dev is not None else None,
                "scene": scenes.index(sc) if sc in scenes else None}

    def cmd_scenes(self):
        return [{"index": i, "name": s.name, "is_triggered": s.is_triggered} for i, s in enumerate(self.song().scenes)]

    def cmd_clips(self, track):
        """The track's clip slots, with the clip's name and length where there is one."""
        rows = []
        for i, slot in enumerate(self._track(track).clip_slots):
            c = slot.clip if slot.has_clip else None
            rows.append({"index": i, "has_clip": slot.has_clip, "name": c.name if c else None,
                         "is_playing": slot.is_playing, "is_triggered": slot.is_triggered,
                         "length": c.length if c else None, "is_recording": c.is_recording if c else False})
        return rows

    def cmd_fire(self, track=None, scene=None, clip=None):
        """scene without track: fire the scene. track + clip: fire that clip slot. track alone: stop the track's clips."""
        song = self.song()
        if track is None:
            if scene is None:
                raise ValueError("fire needs a scene or a track")
            song.scenes[int(scene)].fire()
            return {"fired": "scene", "scene": int(scene)}
        t = self._track(track)
        if clip is not None:
            t.clip_slots[int(clip)].fire()
            return {"fired": "clip", "track": t.name, "clip": int(clip)}
        t.stop_all_clips()
        return {"fired": "stop", "track": t.name}

    def cmd_undo(self):
        song = self.song()
        if song.can_undo:
            song.undo()
        return {"can_undo": song.can_undo, "can_redo": song.can_redo}

    def cmd_redo(self):
        song = self.song()
        if song.can_redo:
            song.redo()
        return {"can_undo": song.can_undo, "can_redo": song.can_redo}


def _jsonable(v, depth=0):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if depth > 4:
        return repr(v)
    if isinstance(v, dict):
        return {str(k): _jsonable(x, depth + 1) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x, depth + 1) for x in v]
    try:
        return [_jsonable(x, depth + 1) for x in list(v)]  # Live vectors
    except Exception:
        return repr(v)
