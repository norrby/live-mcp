# Live MCP

An MCP server for **Ableton Live** that runs inside Live itself, as a Live extension. An AI assistant connected to
it can read the open set and change it: tracks, devices, parameters, clips and notes. With an optional bridge it
also reaches routing, transport, selection, undo and Live's browser. It understands Max for Live devices: long
parameter names, units, choices and the help texts their authors wrote.

MCP, the Model Context Protocol, is the standard way for an assistant such as Claude Code or GitHub Copilot to use
outside tools. Live MCP is such a tool, and the thing it operates is your Live set.

Not affiliated with or endorsed by Ableton. Use at your own risk.

## Features

- **Read the set:** tracks, return tracks, the main track, devices, rack chains, every parameter with its range,
  choices and current value. `find_parameters` finds a parameter by name across the whole set.
- **Change the set:** set parameters (several in one undo step), tempo, track name, mute, solo and arm. Insert and
  delete Live's built-in devices, create and delete tracks.
- **Clips and notes:** create MIDI clips in session slots or in the arrangement, optionally with notes; create
  audio clips from files; read and replace the notes of a clip in one undo step; rename, loop, mute, delete.
- **Max for Live devices:** Live reports only the short names of a Max for Live device's parameters, and many
  repeat ("Show", "Inv", "A"). Live MCP reads the device's `.amxd` file, recognises the device in the set, and
  answers with long names, units, choices and help texts.
- **Noticing your edits:** Live sends no events to extensions, so `get_changes` compares the set with how it
  looked at the last call and reports what you changed in the meantime.
- **An honest contract:** `get_capabilities` says what can be done right now, what needs the bridge, and what no
  API in Live allows, with the reason. A tool that cannot do something says so instead of failing silently.
- **Through the bridge** (optional, see below): audio and MIDI routing, monitoring, transport, metronome, loop,
  selection, scenes, firing clips and scenes, undo and redo, values as Live displays them (`-6 dB`, `250 Hz`), and
  loading anything the browser shows: saved presets, Max for Live devices, plug-ins.

## Requirements

- Ableton Live 12.4.15 or later, which runs extensions (the 12.4.15 beta does).
- An MCP client on the same computer, for example Claude Code or VS Code with GitHub Copilot.
- For the bridge: Live's Python control surface scripts, which every Live has.

## Install

1. Download `Live-MCP-<version>.ablx` from the latest release on the
   [Releases](https://github.com/norrby/live-mcp/releases) page. It is one file with everything the extension needs;
   Live brings its own Node.js to run it.
2. In Live, open **Settings → Extensions** and drag the file there.
3. On its first start the extension writes two files in its storage folder: `config.json` with a generated token,
   and `connect.txt` with the lines to paste into a client. Live's log names the folder.

## Connect a client

Paste the matching lines from `connect.txt`. For Claude Code:

```sh
claude mcp add -s user --transport http live http://127.0.0.1:9871/mcp --header "Authorization: Bearer <token>"
```

For VS Code with GitHub Copilot, in `.vscode/mcp.json` or the user-level `mcp.json`:

```json
{ "servers": { "live": { "type": "http", "url": "http://127.0.0.1:9871/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

The token is made by the extension, not something you bring. It keeps other programs on the computer from
driving Live. If you do not want one, set `"token": ""` in `config.json`: then any local program may connect, but
requests from web pages are still refused.

## The bridge (optional)

Live's extension API does not cover routing, transport, selection, undo or the browser. A small control surface
script, **LiveRemote**, covers them through Live's older Python API, and Live MCP calls it over a local socket.
Without the bridge everything else works, and the tools that need it say so.

1. Copy the folder `remote/LiveRemote/` from this repository to `User Library/Remote Scripts/` (on a Mac
   `~/Music/Ableton/User Library/Remote Scripts/LiveRemote/`).
2. In Live, **Settings → Link, Tempo & MIDI**, pick **LiveRemote** as a Control Surface, with no ports. No API can
   do this step for you.
3. LiveRemote writes `.liveremote-token` in its own folder on its first start. Put that file's path in
   `config.json` as `bridge.tokenFile` and restart the extension.

## Safety

An assistant that can change your set can also change it in ways you did not want. Live MCP therefore:

- **listens on this computer only** (`127.0.0.1`), requires the token, and refuses requests that come from a web
  page;
- **makes every change undoable:** several parameter changes, or a clip with its notes, form one undo step;
- **never runs code it is sent:** each tool and each bridge command is a fixed function with checked arguments;
- **reports before and after** for every parameter it sets, so the assistant can see what it did.

The bridge has its own token and the same rules.

## What it cannot do

Ask the server: `get_capabilities` answers for the running configuration. In short:

- No events: the extension cannot be told when something changes. Poll with `get_changes`.
- No automation, warping, freezing, recording or quantizing, and no moving a clip's loop or markers.
- No MIDI To / Audio From of an **External Instrument**: no API in Live reaches them. Set them once in Live's
  window, save the device as a preset, and load the preset with `load_browser_item`; a preset keeps its routing.

## Configuration

`config.json` in the extension's storage folder (`local/config.json` while developing):

```json
{
  "port": 9871,
  "token": "generated on first start; \"\" turns authentication off",
  "amxdDirectories": ["/Users/you/Music/Ableton/User Library/Presets"],
  "bridge": { "port": 9870, "tokenFile": "/Users/you/Music/Ableton/User Library/Remote Scripts/LiveRemote/.liveremote-token" }
}
```

| Key | What |
|---|---|
| `port` | the port the MCP server listens on |
| `token` | the bearer token clients must send; `""` turns authentication off |
| `amxdDirectories` | folders searched for `.amxd` files, to recognise Max for Live devices in the set |
| `bridge.port` | the port LiveRemote listens on |
| `bridge.tokenFile` | the token file LiveRemote writes; without it the bridge is off |

## Tools

| Group | Tools |
|---|---|
| Reading | `get_set`, `get_capabilities`, `list_parameters`, `find_parameters`, `get_parameters`, `get_changes` |
| Writing | `set_parameters`, `set_track`, `set_tempo`, `insert_device`, `delete_device`, `create_track`, `delete_track` |
| Clips | `get_clips`, `create_clip`, `create_audio_clip`, `get_notes`, `set_notes`, `set_clip`, `delete_clip` |
| Through the bridge | `set_parameter_display`, `browse`, `load_browser_item`, `transport`, `selection`, `get_scenes`, `fire`, `undo`, `redo`, `get_routing`, `set_routing`, `get_device_routing`, `set_device_routing` |

Resources: `live://set` and `live://capabilities`.

Every object has an **address**: `t0` is the first track, `t0/d1` its second device, `t0/d1/p3` a parameter of
that device, `t0/vol` the track's volume, `t0/s3` its fourth session clip slot, `t0/a0` its first arrangement
clip, `r0` the first return track, `main` the main track. Addresses are positions and shift when things move;
`#id` addresses stay valid while the object exists.

Values are in Live's internal units, within the `min` and `max` that `list_parameters` reports; a parameter with
choices takes the index of the choice. With the bridge, `set_parameter_display` takes the value as Live shows it.

## Development

How Live MCP works, from the big picture down: [docs/architecture.md](docs/architecture.md).

Building needs the Ableton Extensions SDK and CLI. Ableton distributes them and they may not be redistributed, so
they are not in this repository: put the two packages in `vendor/` (`ableton-extensions-sdk-1.0.0-beta.1.tgz` and
`ableton-extensions-cli-1.0.0-beta.1.tgz`, as `package.json` names them) before `npm install`. Node 24.14.1 or
later.

```sh
npm install
npm run build:dev   # bundles src/ into dist/extension.js with a source map
npm run host        # runs the extension in Live's Extension Host; Live must be open with Developer Mode on
npm test            # runs without Live, against a fake Extension Host
npm run package     # minified build, then release/Live-MCP-<version>.ablx
```

`npm run host` needs `EXTENSION_HOST_PATH` in `.env`: the path to the Extension Host module inside Live's
application. `node tools/client.mjs list` talks to the running server as an MCP client does;
`node tools/client.mjs get_set` and `node tools/client.mjs set_parameters '{"changes":[{"address":"t0/d0/p2","value":64}]}'`
call tools.

| Directory | Contents |
|---|---|
| `src/live/` | the adapter: reads and writes the set through the SDK, addresses, change tracking |
| `src/mcp/` | the MCP tools and resources, the HTTP transport, the capability contract |
| `src/m4l/` | the `.amxd` reader and the registry that recognises Max for Live devices |
| `src/bridge/` | the client for LiveRemote |
| `remote/LiveRemote/` | the LiveRemote control surface script (Python) |
| `test/` | `node --test`, with a fake Extension Host |
| `tools/` | running the extension in Live's host, a command-line MCP client |

## License

Copyright (c) 2026 norrby. MIT License; see [LICENSE](LICENSE).

The Ableton Extensions SDK and CLI are not part of this repository and come under Ableton's own license. The
packaged extension contains the parts of the SDK it uses, as that license allows.
