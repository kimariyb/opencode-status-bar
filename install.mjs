#!/usr/bin/env node

/**
 * opencode-status-bar 安装脚本
 *
 * OpenCode V2：配置 ~/.config/opencode/opencode.json（或 opencode.jsonc）的
 * `plugins` 数组加载 TUI 侧边栏插件。V1 的 tui.jsonc（`plugin` 键）已废弃。
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"

const PLUGIN_SPEC = "opencode-status-bar"

function configDir() {
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode")
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
}

async function exists(p) {
  try { await access(p, constants.F_OK); return true }
  catch { return false }
}

async function readJSONC(p) {
  const raw = await readFile(p, "utf-8")
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "")
  return JSON.parse(stripped)
}

function formatJSONC(obj) {
  return JSON.stringify(obj, null, 2) + "\n"
}

function mergePlugin(existing, spec) {
  const plugins = existing.plugins ?? []
  if (plugins.some((p) => (typeof p === "string" ? p : p[0]) === spec)) {
    return false
  }
  existing.plugins = [...plugins, spec]
  return true
}

async function main() {
  const dir = configDir()
  await mkdir(dir, { recursive: true })

  // ---- opencode.json / opencode.jsonc（V2 配置，键 plugins）----
  const ocPathJsonc = join(dir, "opencode.jsonc")
  const ocPathJson = join(dir, "opencode.json")
  let target = await exists(ocPathJsonc) ? ocPathJsonc : await exists(ocPathJson) ? ocPathJson : ocPathJson

  if (await exists(target)) {
    const cfg = await readJSONC(target)
    if (mergePlugin(cfg, PLUGIN_SPEC)) {
      await writeFile(target, formatJSONC(cfg))
      console.log(`[opencode-status-bar] Added to ${target}`)
    } else {
      console.log(`[opencode-status-bar] Already in ${target}`)
    }
  } else {
    await writeFile(target, formatJSONC({ plugins: [PLUGIN_SPEC] }))
    console.log(`[opencode-status-bar] Created ${target}`)
  }

  // ---- V1 tui.jsonc 已废弃（提示迁移）----
  const tuiJsonc = join(dir, "tui.jsonc")
  const tuiJson = join(dir, "tui.json")
  if (await exists(tuiJsonc) || await exists(tuiJson)) {
    console.log("[opencode-status-bar] note: tui.jsonc is deprecated in OpenCode V2; configuration moved to opencode.json `plugins`.")
  }

  console.log("\nDone! Restart OpenCode to see the Status Bar sidebar panel.")
}

main().catch((err) => {
  console.error("Install failed:", err.message)
  process.exit(1)
})
