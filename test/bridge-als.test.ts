import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const bridge = path.resolve("remote/LiveRemote");
const python = spawnSync("python3", ["--version"]).status === 0;

/** Runs a function of LiveRemote.py outside Live, with Live's framework stubbed out, and returns its JSON result. */
function callBridge(fn: string, ...args: unknown[]): unknown {
  const code = [
    "import sys, types, json",
    'fw = types.ModuleType("_Framework"); cs = types.ModuleType("_Framework.ControlSurface"); cs.ControlSurface = object',
    'sys.modules["_Framework"] = fw; sys.modules["_Framework.ControlSurface"] = cs',
    `sys.path.insert(0, ${JSON.stringify(bridge)})`,
    "import LiveRemote",
    `print(json.dumps(getattr(LiveRemote, ${JSON.stringify(fn)})(*json.loads(sys.argv[1]))))`,
  ].join("\n");
  const r = spawnSync("python3", ["-I", "-c", code, JSON.stringify(args)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const mx = (name: string, absolute: string, relative: string) =>
  `<MxDeviceMidiEffect Id="0"><UserName Value="${name}" /><PatchSlot><Value><MxPatchRef Id="1"><FileRef>` +
  `<RelativePathType Value="6" /><RelativePath Value="${relative}" /><Path Value="${absolute}" />` +
  `</FileRef></MxPatchRef></Value></PatchSlot></MxDeviceMidiEffect>`;
const chain = (devices: string) => `<DeviceChain><DeviceChain><Devices>${devices}</Devices></DeviceChain></DeviceChain>`;

test("the bridge reads from a saved set which .amxd file each Max for Live device comes from, at its address", { skip: !python }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-mcp-als-"));
  const lib = path.join(dir, "User Library");
  fs.mkdirSync(path.join(lib, "Presets"), { recursive: true });
  fs.writeFileSync(path.join(lib, "Presets", "Moved.amxd"), "x");
  fs.writeFileSync(path.join(dir, "Here.amxd"), "x");
  const rack =
    `<MidiEffectGroupDevice Id="0"><Branches>` +
    `<MidiEffectBranch><DeviceChain><MidiToMidiDeviceChain><Devices><MidiScale /></Devices></MidiToMidiDeviceChain></DeviceChain></MidiEffectBranch>` +
    `<MidiEffectBranch><DeviceChain><MidiToMidiDeviceChain><Devices>${mx("In rack", "/gone/Moved.amxd", "Presets/Moved.amxd")}</Devices></MidiToMidiDeviceChain></DeviceChain></MidiEffectBranch>` +
    `</Branches></MidiEffectGroupDevice>`;
  const xml =
    `<?xml version="1.0"?><Ableton><LiveSet><Tracks>` +
    `<MidiTrack>${chain(`<Operator />${mx("FilterBass", path.join(dir, "Here.amxd"), "Here.amxd")}${rack}`)}</MidiTrack>` +
    `<ReturnTrack>${chain(mx("", "/gone/Nowhere.amxd", "Nowhere.amxd"))}</ReturnTrack>` +
    `<AudioTrack>${chain("")}</AudioTrack>` +
    `</Tracks><MainTrack>${chain(mx("Main", path.join(dir, "Here.amxd"), ""))}</MainTrack></LiveSet></Ableton>`;
  const als = path.join(dir, "Set.als");
  fs.writeFileSync(als, zlib.gzipSync(xml));
  try {
    assert.deepEqual(callBridge("als_devices", als, [lib]), [
      { address: "t0/d1", name: "FilterBass", file: path.join(dir, "Here.amxd") },
      { address: "t0/d2/c1/d0", name: "In rack", file: path.join(lib, "Presets", "Moved.amxd") },
      { address: "r0/d0", name: "", file: "/gone/Nowhere.amxd" },
      { address: "main/d0", name: "Main", file: path.join(dir, "Here.amxd") },
    ]);
    const listed = callBridge("amxd_list", [path.join(dir, "Here.amxd"), path.join(dir, "Missing.amxd"), lib]) as { file: string }[];
    assert.deepEqual(listed.map((f) => f.file), [path.join(dir, "Here.amxd"), path.join(lib, "Presets", "Moved.amxd")], "a listed .amxd file is taken as it is; a missing one is left out");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
