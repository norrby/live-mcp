# Development

Building Live MCP yourself, configuring it, and the full list of tools. How it works inside is in
[architecture.md](architecture.md).

## Requirements

- Live 12 Suite 12.4.15 or later, with Developer Mode on (Settings → Extensions) while developing.
- Node 24.14.1 or later.
- The Ableton Extensions SDK and CLI, from Ableton's [public beta](https://ableton.github.io/extensions-sdk/).
  They may not be redistributed, so they are not in this repository. Put the two packages in `vendor/` (`ableton-extensions-sdk-1.0.0-beta.1.tgz` and
  `ableton-extensions-cli-1.0.0-beta.1.tgz`, as `package.json` names them) before `npm install`.

## Build and run

```sh
npm install
npm run build:dev   # bundles src/ into dist/extension.js with a source map
npm run host        # runs the extension in Live's Extension Host; Live must be open
npm test            # runs without Live, against a fake Extension Host
npm run package     # minified build, then release/Live-MCP-<version>.ablx
```

`npm run host` needs `EXTENSION_HOST_PATH` in `.env`: the path to the Extension Host module inside Live's
application. Developer Mode makes Live leave the Extension Host to you, so with it on Live runs no installed
extensions at all; turn it off to try an installed `.ablx`, and uninstall that again before `npm run host`, or the
two compete for the port. It runs the extension from this folder, so after a change you rebuild and restart the host, not Live.
The first start after the host was stopped can take half a minute; wait for `MCP listening` in its output.

`tools/client.mjs` talks to the running server as an MCP client does:

```sh
node tools/client.mjs list
node tools/client.mjs get_set
node tools/client.mjs set_parameters '{"changes":[{"address":"t0/d0/p2","value":64}]}'
```

## Configuration

`config.json` in the extension's storage folder, or `local/config.json` while developing. The extension writes it
on its first start, and `connect.txt` next to it with the commands that connect a client.

```json
{
  "port": 9871,
  "token": "",
  "userLibrary": "/Users/you/Music/Ableton/User Library",
  "amxdDirectories": ["/Users/you/Music/Ableton/User Library/Presets"],
  "bridge": { "port": 9870, "tokenFile": "/Users/you/Music/Ableton/User Library/Remote Scripts/LiveRemote/.liveremote-token" }
}
```

| Key | What |
|---|---|
| `port` | the port the MCP server listens on |
| `token` | a password every client must send; `""` (the default) means none |
| `userLibrary` | Live's User Library; set it if you moved yours |
| `amxdDirectories` | folders searched for `.amxd` files, to recognise Max for Live devices in the set |
| `bridge.port` | the port LiveRemote listens on |
| `bridge.tokenFile` | the token file LiveRemote writes in its folder |

**A token.** Without one, any program on this computer can use Live MCP, as with any MCP server that runs locally;
web pages and other computers cannot. To require a token, set `token` to a string of at least 16 characters
(anything shorter is replaced by a generated one) and restart. `connect.txt` then holds the commands with the token
in them.

**The bridge.** On every start the extension writes LiveRemote to `Remote Scripts/LiveRemote/` in the User Library,
and keeps it up to date. A LiveRemote folder it did not write itself, such as one you copied there, is left alone.

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
choices takes the index of the choice. With the bridge, `set_parameter_display` takes the value as Live shows it,
such as `-6 dB`.

## Folders

| Folder | Contents |
|---|---|
| `src/live/` | the adapter: reads and writes the set through the SDK, addresses, change tracking |
| `src/mcp/` | the MCP tools and resources, the HTTP transport, the capability contract |
| `src/m4l/` | the `.amxd` reader and the registry that recognises Max for Live devices |
| `src/bridge/` | the client for LiveRemote, and its installation into the User Library |
| `remote/LiveRemote/` | the LiveRemote control surface script (Python), bundled into the extension |
| `test/` | `node --test`, with a fake Extension Host |
| `tools/` | running the extension in Live's host, a command-line MCP client |

## Tests

The tests run the real SDK, the adapter, the MCP server and the HTTP server against a fake Live in memory, with a
real MCP client on the other end. A test of the `.amxd` reader against a real device runs when `AMXD_FROZEN`,
`AMXD_UNFROZEN` and `AMXD_LIVE_PARAMS` point to the device frozen, unfrozen, and a JSON list of the parameter names
Live reports for it.
