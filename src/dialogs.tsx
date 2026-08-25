/** @jsxImportSource @opentui/solid */

// ---------------------------------------------------------------------------
// 弹窗组件：Cache 详情 / Subagents 列表（v5「信号节奏」语言）
// 由宿主 api.ui.Dialog 承载；子代理行点击 → route.navigate 进入子会话执行页
// ---------------------------------------------------------------------------

import type { JSX } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { For, Show } from "solid-js"
import type { CacheStats } from "./cache"
import { fmtTokens } from "./cache"
import type { SubEntry } from "./subagent"

interface Palette {
  text: string
  muted: string
  success: string
  warning: string
  error: string
  accent: string
  primary: string
}

function meterBar(ratio: number, cells: number, full: string, empty: string): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * cells)
  return full.repeat(filled) + empty.repeat(cells - filled)
}

export function CacheDialog(props: { stats: CacheStats; pal: Palette }): JSX.Element {
  const s = () => props.stats
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" gap={2}>
        <text fg={props.pal.accent}><b>{s().hitRate.toFixed(0)}%</b></text>
        <text fg={props.pal.accent}>{meterBar(s().hitRate / 100, 10, "▰", "▱")}</text>
        <text fg={props.pal.muted}>cache hit rate</text>
      </box>
      <Show when={s().saved > 0}>
        <text fg={props.pal.success}>saved ≈ ${s().saved.toFixed(2)} <span style={{ fg: props.pal.muted }}>(cache read pricing)</span></text>
      </Show>
      <text fg={props.pal.muted}>TOKENS</text>
      <box flexDirection="column" paddingLeft={2}>
        <box flexDirection="row"><text fg={props.pal.muted}>input</text><text fg={props.pal.text} marginLeft="auto">{fmtTokens(s().input)}</text></box>
        <box flexDirection="row"><text fg={props.pal.muted}>cache read</text><text fg={props.pal.text} marginLeft="auto">{fmtTokens(s().read)}</text></box>
        <box flexDirection="row"><text fg={props.pal.muted}>cache write</text><text fg={props.pal.text} marginLeft="auto">{fmtTokens(s().write)}</text></box>
        <box flexDirection="row"><text fg={props.pal.muted}>output</text><text fg={props.pal.text} marginLeft="auto">{fmtTokens(s().output)}</text></box>
      </box>
    </box>
  )
}

export function SubagentDialog(props: {
  api: TuiPluginApi
  entries: SubEntry[]
  pal: Palette
  /** 告急/运行中呼吸是否处于「暗态」相位（由面板统一 tick 驱动） */
  breathOn: () => boolean
}): JSX.Element {
  const running = () => props.entries.filter((e) => e.status === "running").length
  const done = () => props.entries.filter((e) => e.status === "done").length
  const failed = () => props.entries.filter((e) => e.status === "error").length
  const totalTok = () => props.entries.reduce((acc, e) => acc + (e.tokens ?? 0), 0)

  function statusDot(e: SubEntry): { ch: string; color: string } {
    if (e.status === "running") return { ch: "◆", color: props.pal.accent }
    if (e.status === "done") return { ch: "●", color: props.pal.success }
    return { ch: "✕", color: props.pal.error }
  }

  function elapsed(e: SubEntry): string {
    const end = e.endedAt ?? Date.now()
    const sec = Math.max(0, Math.floor((end - e.startedAt) / 1000))
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`
  }

  function open(e: SubEntry) {
    if (!e.sessionId) return
    try {
      props.api.ui.dialog.clear() // 先关弹窗再跳转，避免弹窗残留
      props.api.route.navigate("session", { sessionID: e.sessionId })
    } catch {}
  }

  return (
    <box flexDirection="column" gap={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <text fg={props.pal.muted}>
        {running()} running · {done()} done{failed() > 0 ? ` · ${failed()} failed` : ""} · {fmtTokens(totalTok())} tok
      </text>
      <Show
        when={props.entries.length > 0}
        fallback={<text fg={props.pal.muted}>no subagent activity in this session</text>}
      >
        <box flexDirection="column" gap={0} marginTop={1}>
          <For each={props.entries}>
            {(e) => {
              const dot = statusDot(e)
              return (
                <box flexDirection="row" gap={1} onMouseUp={() => open(e)}>
                  <text fg={e.status === "running" ? props.pal.accent : dot.color} flexShrink={0}
                    style={{ fg: e.status === "running" && props.breathOn() ? props.pal.muted : dot.color }}>{dot.ch}</text>
                  <text fg={props.pal.text} flexShrink={0}>{e.agent}</text>
                  <text fg={props.pal.muted} flexGrow={1} overflow="hidden">{e.title}</text>
                  <text fg={props.pal.muted} flexShrink={0}>
                    {e.tokens ? fmtTokens(e.tokens) + " · " : ""}{elapsed(e)}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      <text fg={props.pal.muted} marginTop={1}>click row → open subagent session</text>
    </box>
  )
}
