// V2 server 入口：本插件仅在 TUI 侧渲染面板，server 侧无副作用。
// 宿主加载 ./server 时校验 default 导出需含 id + setup（或 effect）。

const mod = {
  id: "opencode-status-bar",
  setup: async () => {},
}

export default mod
