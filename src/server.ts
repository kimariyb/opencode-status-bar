import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const server: Plugin = async () => ({})

const mod: PluginModule = {
  id: "opencode-status-bar",
  server,
}

export default mod
