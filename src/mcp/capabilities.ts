// capabilities.ts – the honest contract: what the Extensions SDK lets us do, what it does not, and why.
// The bridge (LiveRemote control surface script) fills some gaps when it is running; the answer says which.
export interface CapabilityState {
  bridgeReachable: boolean;
  knownDevices: number;
  /** how the .amxd files are read: directly, or through the bridge because Live forbids it */
  amxdVia: "files" | "bridge";
}

export function capabilities(state: CapabilityState) {
  const bridge = state.bridgeReachable
    ? "yes, through the LiveRemote bridge"
    : "not now: the LiveRemote bridge is not reachable (install it in the User Library's Remote Scripts folder and pick it as a Control Surface)";
  return {
    can: [
      "read the set: tracks, return tracks, main track, devices, rack chains, parameters (names, ranges, choices, values)",
      "set parameters, several in one undo step; set tempo; rename, mute, solo, arm tracks",
      "insert and delete built-in Live devices; create and delete tracks",
      `recognise Max for Live devices from their .amxd files (${state.knownDevices} known${state.amxdVia === "bridge" ? ", read through the LiveRemote bridge" : ""}) and give long parameter names, units, choices and help texts`,
      "find parameters by name across the set",
      "clips: create MIDI clips in session slots or the arrangement, audio clips from files, read and replace notes, rename, loop, mute, delete",
    ],
    viaBridge: [
      { what: "audio and MIDI routing of tracks and of Max for Live devices, monitoring", available: bridge },
      { what: "transport: play, stop, record, metronome, loop, position", available: bridge },
      { what: "selection: selected track, device and scene; scenes and session clips; firing clips and scenes", available: bridge },
      { what: "undo and redo", available: bridge },
      { what: "parameter values as Live displays them (dB, Hz, ms) for built-in devices, and setting a parameter by such a value", available: bridge },
      { what: "loading anything the browser shows: saved presets (with their routing), Max for Live devices, plug-ins", available: bridge },
    ],
    cannot: [
      { what: "events or listeners: nothing is pushed to the client", why: "the Extensions API has no notifications; get_changes reports what changed since the last call" },
      { what: "automation, warping, freezing, recording, quantizing, moving a clip's loop or markers", why: "not in the Extensions API 1.0 nor in the bridge" },
      { what: "the MIDI To / Audio From of External Instrument and the Audio To / From of External Audio Effect", why: "neither Live's Python API nor the Extensions API exposes them; only Max for Live devices have routing points. Ask the user to set them in Live's window" },
    ],
    notes: [
      "Addresses (t0/d1/p3, t0/s3, t0/a1) are positions; they shift when tracks, devices or arrangement clips move or are deleted. #id addresses are stable while the object exists: use the id a create answers with.",
      "Max for Live devices report short parameter names that can repeat; address by index. Known devices also get long names.",
      "Values go in Live's internal units, within the min..max that list_parameters reports; quantized parameters take the index of the choice. Display strings (dB, Hz) need the bridge.",
    ],
  };
}
