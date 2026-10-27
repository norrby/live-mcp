// build.mts – bundles src/extension.ts into one CommonJS file for the Extension Host (it reads no node_modules).
// The banner installs the web globals the host's vm context lacks (see src/prelude.ts).
import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  define: { global: "globalThis", __VERSION__: JSON.stringify(manifest.version) },
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  keepNames: true, // device kinds are class names (MxDeviceMidiEffect, RackDevice …), shown to the client
  sourcemap: !production,
});
