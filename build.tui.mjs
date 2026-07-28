import * as esbuild from "esbuild"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { solidPlugin } from "esbuild-plugin-solid"

const versionFile = resolve("src/_version.ts")
if (!existsSync(versionFile)) {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"))
  writeFileSync(versionFile, `// auto-generated\nexport const PLUGIN_VERSION=${JSON.stringify(pkg.version)};\n`)
}

await esbuild.build({
  entryPoints: ["src/index.tsx"],
  outfile: "dist/tui.js",
  format: "esm",
  platform: "node",
  bundle: true,
  external: ["@opencode-ai/*", "@opentui/*", "solid-js", "node:*"],
  plugins: [solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } })],
})
