#!/usr/bin/env node

/**
 * opencode-status-bar 安装脚本
 *
 * 配置 ~/.config/opencode/tui.jsonc（或 tui.json）加载 TUI 侧边栏插件。
 * 同时将插件添加到 opencode.jsonc 以保持向前兼容。
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir, platform } from "node:os"
import { join, dirname } from "node:path"

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
  const plugins = existing.plugin ?? []
  if (plugins.some((p) => (typeof p === "string" ? p : p[0]) === spec)) {
    return false
  }
  existing.plugin = [...plugins, spec]
  return true
}

async function main() {
  const dir = configDir()
  await mkdir(dir, { recursive: true })

  // ---- tui.jsonc / tui.json ----
  const tuiPathJsonc = join(dir, "tui.jsonc")
  const tuiPathJson = join(dir, "tui.json")
  let tuiPath = await exists(tuiPathJsonc) ? tuiPathJsonc : await exists(tuiPathJson) ? tuiPathJson : tuiPathJsonc
  let tuiChanged = false

  if (await exists(tuiPath)) {
    const cfg = await readJSONC(tuiPath)
    tuiChanged = mergePlugin(cfg, PLUGIN_SPEC)
    if (tuiChanged) {
      await writeFile(tuiPath, formatJSONC(cfg))
      console.log(`[opencode-status-bar] Added to ${tuiPath}`)
    } else {
      console.log(`[opencode-status-bar] Already in ${tuiPath}`)
    }
  } else {
    const cfg = { $schema: "https://opencode.ai/tui.json", plugin: [PLUGIN_SPEC] }
    await writeFile(tuiPath, formatJSONC(cfg))
    console.log(`[opencode-status-bar] Created ${tuiPath}`)
    tuiChanged = true
  }

  // ---- opencode.jsonc (forward compat) ----
  const ocPath = join(dir, "opencode.jsonc")
  const ocPathJson = join(dir, "opencode.json")
  let ocPath2 = await exists(ocPath) ? ocPath : await exists(ocPathJson) ? ocPathJson : null
  if (ocPath2) {
    const cfg = await readJSONC(ocPath2)
    if (mergePlugin(cfg, PLUGIN_SPEC)) {
      await writeFile(ocPath2, formatJSONC(cfg))
      console.log(`[opencode-status-bar] Also added to ${ocPath2}`)
    }
  }

  if (tuiChanged) {
    console.log("\nDone! Restart OpenCode to see the Status Bar sidebar panel.")
  } else {
    console.log("\nAlready installed. Restart OpenCode if you haven't yet.")
  }
}

main().catch((err) => {
  console.error("Install failed:", err.message)
  process.exit(1)
})
