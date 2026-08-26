/** @jsxImportSource @opentui/solid */

// ---------------------------------------------------------------------------
// 弹窗组件：Cache 详情 / Subagents 列表（按 docs/proto/dialog-prototype.html 实现）
// 由宿主 api.ui.Dialog 承载；子代理行点击展开详情，「→ open session」跳转子会话
// ---------------------------------------------------------------------------

import type { JSX } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { execSync } from "node:child_process"
import { createSignal, onMount, onCleanup, For, Show } from "solid-js"
import type { CacheStats } from "./cache"
import { fmtTokens, fmtCost } from "./cache"
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

/** 弹窗内分隔线（视觉宽度约 44 列） */
const SEP = "\u2500".repeat(44)
const METER_CELLS = 10

function meterBar(ratio: number, cells: number, full: string, empty: string): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * cells)
  return full.repeat(filled) + empty.repeat(cells - filled)
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function hhmmss(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function elapsedOf(e: SubEntry, now: number): string {
  return fmtDuration((e.endedAt ?? now) - e.startedAt)
}

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`
}

/** 会话剪贴板复制（跨平台多级降级，失败静默返回 false） */
function copyText(s: string): boolean {
  const cmds =
    process?.platform === "darwin"
      ? ["pbcopy"]
      : process?.platform === "win32"
        ? ["clip"]
        : ["wl-copy", "xclip -selection clipboard", "xsel --clipboard --input"]
  for (const c of cmds) {
    try {
      execSync(`printf '%s' '${s.replace(/'/g, "")}' | ${c}`, { timeout: 2000, stdio: "ignore" })
      return true
    } catch {}
  }
  return false
}

// ---------------------------------------------------------------------------
// Cache 详情弹窗
// ---------------------------------------------------------------------------

export function CacheDialog(props: { stats: () => CacheStats; pal: Palette }): JSX.Element {
  const s = () => props.stats()
  const pal = props.pal

  /** 命中率颜色分级：≥85 绿 / ≥70 黄 / <70 红 */
  const hitColor = (v: number) => (v >= 85 ? pal.success : v >= 70 ? pal.warning : pal.error)

  const trendView = () => {
    const t = s().trend
    if (t === undefined) return { text: "\u2013", color: pal.muted }
    return t > 0
      ? { text: `\u2191 ${t.toFixed(1)}%`, color: pal.success }
      : { text: `\u2193 ${Math.abs(t).toFixed(1)}%`, color: pal.error }
  }

  // TOKENS 占比微条（相对四项总和）
  const share = (n: number) => {
    const total = s().input + s().read + s().write + s().output
    return total > 0 ? n / total : 0
  }

  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      {/* ── SESSION HIT RATE：背景色块大数字（5 行点阵）+ 右侧进度条/趋势垂直居中 ── */}
      <box flexDirection="row" gap={2}>
        <box flexDirection="column" flexShrink={0}>
          <For each={bigTextRows(s().hitRate.toFixed(1) + "%")}>
            {(row) => bigRowText(row, hitColor(s().hitRate))}
          </For>
        </box>
        <box flexDirection="column" justifyContent="center" gap={0}>
          <text fg={hitColor(s().hitRate)}>{meterBar(s().hitRate / 100, METER_CELLS, "\u25b0", "\u25b1")}</text>
          <Show when={s().lastHitRate !== undefined}>
            <text fg={trendView().color}>{trendView().text}</text>
          </Show>
        </box>
      </box>

      {/* ── LAST MESSAGE ── */}
      <Show when={s().lastHitRate !== undefined || s().stepCount !== undefined}>
        <box>
          <text>
            <span style={{ fg: pal.muted }}>last hit </span>
            <Show when={s().lastHitRate !== undefined} fallback={<span style={{ fg: pal.muted }}>{"--"}</span>}>
              <span style={{ fg: pal.text }}>{s().lastHitRate!.toFixed(1)}%</span>
            </Show>
            <Show when={s().stepCount !== undefined}>
              <span style={{ fg: pal.muted }}>{" \u00b7 step "}<span style={{ fg: pal.text }}>{s().stepCount}</span></span>
            </Show>
            <Show when={(s().lastCost ?? 0) > 0}>
              <span style={{ fg: pal.muted }}>{" \u00b7 last cost "}<span style={{ fg: pal.text }}>{fmtCost(s().lastCost ?? 0)}</span></span>
            </Show>
          </text>
        </box>
      </Show>

      {/* ── TOKENS ── */}
      <box flexDirection="column">
        <text fg={pal.muted}>TOKENS</text>
        <box flexDirection="column" paddingLeft={2}>
          <For each={[["input", s().input], ["cache read", s().read], ["cache write", s().write], ["output", s().output]] as Array<[string, number]>}>
            {([label, value]) => (
              <box flexDirection="row">
                <text fg={pal.muted}>{label}</text>
                <text fg={pal.text} marginLeft="auto">{fmtTokens(value).padStart(8)}</text>
                <text fg={pal.primary}> {meterBar(share(value), METER_CELLS, "\u25b0", "\u25b1")}</text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" paddingLeft={2} marginTop={1}>
          <text fg={pal.muted}>miss (input+write)</text>
          <text fg={pal.muted} marginLeft="auto">{"\u2248 "}{fmtTokens(s().input + s().write)}</text>
        </box>
      </box>

      {/* ── COST ── */}
      <Show when={(s().cost ?? 0) > 0 || s().saved > 0}>
        <box flexDirection="column">
          <text fg={pal.muted}>COST</text>
          <box flexDirection="column" paddingLeft={2}>
            <Show when={(s().cost ?? 0) > 0}>
              <box flexDirection="row">
                <text fg={pal.muted}>session</text>
                <text fg={pal.text} marginLeft="auto"><b>{fmtCost(s().cost!)}</b></text>
              </box>
            </Show>
            <Show when={s().saved > 0}>
              <box flexDirection="row">
                <text fg={pal.success}>saved</text>
                <text fg={pal.success} marginLeft="auto"><b>{"~"}{fmtCost(s().saved).slice(1)}</b></text>
              </box>
            </Show>
          </box>
        </box>
      </Show>

      {/* ── MODEL ── */}
      <Show when={s().providerID && s().modelID}>
        <box flexDirection="column">
          <text fg={pal.muted}>MODEL</text>
          <box flexDirection="column" paddingLeft={2}>
            <text fg={pal.text}>{s().providerID} / {s().modelID}</text>
            <Show when={s().pricing}>
              <text fg={pal.muted}>in {fmtCost(s().pricing!.in)} {"\u00b7"} read {fmtCost(s().pricing!.read)} {"\u00b7"} write {fmtCost(s().pricing!.write)} /Mtok</text>
            </Show>
          </box>
        </box>
      </Show>

      <text fg={pal.muted}>{SEP}</text>
      <text fg={pal.muted}>esc {"\u21b5"} close</text>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Subagents 监控弹窗
// ---------------------------------------------------------------------------

export function SubagentDialog(props: {
  api: TuiPluginApi
  /** 条目 accessor（保持响应式：tracker 更新时弹窗实时刷新） */
  entries: () => SubEntry[]
  pal: Palette
}): JSX.Element {
  const pal = props.pal
  const [now, setNow] = createSignal(Date.now())
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [copiedId, setCopiedId] = createSignal<string>()

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  // running 呼吸相位：2s 周期亮暗交替（由 now tick 自驱动，不依赖外部告警定时器）
  const breathOn = () => Math.floor(now() / 1000) % 2 === 0

  const running = () => props.entries().filter((e) => e.status === "running").length
  const done = () => props.entries().filter((e) => e.status === "done").length
  const failed = () => props.entries().filter((e) => e.status === "error").length
  const totalTok = () => props.entries().reduce((acc, e) => acc + (e.tokens ?? 0), 0)
  const totalTime = () =>
    props.entries().reduce((acc, e) => acc + ((e.endedAt ?? now()) - e.startedAt), 0)

  function statusDot(e: SubEntry): { ch: string; color: string; breathing?: boolean } {
    if (e.status === "running") return { ch: "\u25c6", color: pal.accent, breathing: true }
    if (e.status === "done") return { ch: "\u25cf", color: pal.success }
    return { ch: "\u2715", color: pal.error }
  }

  function toggle(id: string): void {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function openSession(e: SubEntry): void {
    if (!e.sessionId) return
    try {
      props.api.ui.dialog.clear() // 先关弹窗再跳转，避免弹窗残留
      props.api.route.navigate("session", { sessionID: e.sessionId })
    } catch {}
  }

  function copySession(sid: string): void {
    if (copyText(sid)) {
      setCopiedId(sid)
      setTimeout(() => setCopiedId((cur) => (cur === sid ? undefined : cur)), 1200)
    }
  }

  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      {/* ── 图例式汇总 + token/总耗时 ── */}
      <box>
        <text>
          <span style={{ fg: pal.accent }}>{`\u25c6 ${running()} running`}</span>
          <span style={{ fg: pal.muted }}>{" \u00b7 "}</span>
          <span style={{ fg: pal.success }}>{`\u25cf ${done()} done`}</span>
          <Show when={failed() > 0}>
            <span style={{ fg: pal.muted }}>{" \u00b7 "}</span>
            <span style={{ fg: pal.error }}>{`\u2715 ${failed()} failed`}</span>
          </Show>
        </text>
      </box>
      <text>
        <span style={{ fg: pal.text }}><b>{fmtTokens(totalTok())}</b></span>
        <span style={{ fg: pal.muted }}> tok</span>
        <span style={{ fg: pal.muted }}>{" \u00b7 "}</span>
        <span style={{ fg: pal.text }}><b>{fmtDuration(totalTime())}</b></span>
        <span style={{ fg: pal.muted }}> total</span>
      </text>

      <Show
        when={props.entries().length > 0}
        fallback={<text fg={pal.muted}>no subagent activity in this session</text>}
      >
        <text fg={pal.muted}>{SEP}</text>
        <box flexDirection="column">
          <For each={props.entries()}>
            {(e, i) => {
              const dot = statusDot(e)
              const isOpen = () => Boolean(expanded()[e.id])
              const dimmed = () => Boolean(dot.breathing && !breathOn())
              return (
                <box flexDirection="column">
                  {/* 行 1：状态点 + agent + 标题 + 展开 marker（整行点击 toggle） */}
                  <box flexDirection="row" gap={1} onMouseUp={() => toggle(e.id)}>
                    <text flexShrink={0} style={{ fg: dimmed() ? pal.muted : dot.color }}>{dot.ch}</text>
                    <text fg={pal.primary} flexShrink={0}>{e.agent}</text>
                    <text fg={pal.text} flexGrow={1} overflow="hidden">{e.title}</text>
                    <text fg={pal.muted} flexShrink={0}>{isOpen() ? "\u25bc" : "\u25b8"}</text>
                  </box>
                  {/* 行 2：元信息缩进（⏱ 耗时 running 为警示色）· tokens · model */}
                  <Show when={!isOpen()}>
                    <box flexDirection="row" paddingLeft={2}>
                      <text fg={e.status === "error" ? pal.error : pal.muted}>
                        {e.status === "error" ? "errored" : `\u23f1\uFE0E ${elapsedOf(e, now())}`}
                      </text>
                      <Show when={e.tokens}>
                        <text fg={pal.muted}>{" \u00b7 "}{fmtTokens(e.tokens!)} tok</text>
                      </Show>
                      <Show when={e.model}>
                        <text fg={pal.muted}>{" \u00b7 "}{e.model}</text>
                      </Show>
                    </box>
                  </Show>
                  {/* 展开态详情 */}
                  <Show when={isOpen()}>
                    <box flexDirection="column" paddingLeft={2}>
                      <Show when={e.prompt}>
                        <DetailRow label="prompt"><text fg={pal.muted}>{truncateLine(e.prompt!, 58)}</text></DetailRow>
                      </Show>
                      <Show when={e.model}>
                        <DetailRow label="model"><text fg={pal.text}>{e.model}</text></DetailRow>
                      </Show>
                      <Show when={e.tokens}>
                        <DetailRow label="tokens">
                          <text fg={pal.text}>{fmtTokens(e.tokens!)} tok</text>
                          <Show when={e.tokensIn !== undefined || e.tokensOut !== undefined}>
                            <text fg={pal.muted}>{" (in "}{fmtTokens(e.tokensIn ?? 0)}{" \u00b7 out "}{fmtTokens(e.tokensOut ?? 0) + ")"}</text>
</Show>
                        </DetailRow>
                      </Show>
                      <DetailRow label="time">
                        <text fg={pal.text}>started {hhmmss(e.startedAt)}</text>
                        <text fg={e.status === "running" ? pal.warning : pal.muted}>{" \u00b7 "}{elapsedOf(e, now())}</text>
                      </DetailRow>
                      <Show when={e.todoTotal}>
                        <DetailRow label="todo"><text fg={pal.text}>{e.todoDone ?? 0}/{e.todoTotal} done</text></DetailRow>
                      </Show>
                      <Show when={e.sessionId}>
                        <DetailRow label="session" muted={pal.muted}>
                          <text fg={pal.muted}>{shorten(e.sessionId!)}</text>
                          <text fg={copiedId() === e.sessionId ? pal.success : pal.accent} onMouseUp={() => copySession(e.sessionId!)}>
                            {copiedId() === e.sessionId ? " [ok]" : " [copy]"}
                          </text>
                        </DetailRow>
                      </Show>
                      <Show when={e.sessionId}>
                        <box paddingLeft={10}>
                          <text fg={pal.accent} onMouseUp={() => openSession(e)}>{"\u2192 open session"}</text>
                        </box>
                      </Show>
                    </box>
                  </Show>
                  {/* item 隔断线（末项不加） */}
                  <Show when={i() < props.entries().length - 1}>
                    <box marginTop={1}><text fg={pal.muted}>{SEP}</text></box>
                  </Show>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      <text fg={pal.muted}>{SEP}</text>
      <text fg={pal.muted}>click {"\u21b5"} expand {"\u00b7"} {"\u2192"} open session {"\u00b7"} esc {"\u21b5"} close</text>
    </box>
  )
}

/** 详情行：label 固定宽 + 值（值区可混排多个 span） */
function DetailRow(props: { label: string; muted?: string; children: JSX.Element }): JSX.Element {
  return (
    <box flexDirection="row">
      <text fg={props.muted ?? "#7A7A72"} flexShrink={0}>{pad(props.label, 9)}</text>
      {props.children}
    </box>
  )
}

function truncateLine(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s
}

// ---------------------------------------------------------------------------
// 块字符点阵大数字（5 行点阵）
// 注意：▀▄█ 等 Block Elements 在 opentui 宽度表中属宽字符（中文环境 ambiguous→wide），
// 会导致字形断裂+折行。故用 ASCII 空格 + 背景色画点阵——宽度绝对 1 列、色块绝对连续。
// ---------------------------------------------------------------------------

const BIG_GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ".": ["000", "000", "000", "000", "010"],
  "%": ["101", "001", "010", "100", "101"],
  "-": ["000", "000", "111", "000", "000"],
  " ": ["000", "000", "000", "000", "000"],
}

/** 渲染大字：返回 5 行点阵（每字形 3 列 + 1 列间隔） */
function bigTextRows(s: string): string[] {
  const glyphs = [...s.toLowerCase()].map((ch) => BIG_GLYPHS[ch] ?? BIG_GLYPHS[" "])
  const rows = ["", "", "", "", ""]
  for (const g of glyphs) {
    for (let r = 0; r < 5; r++) rows[r] += g[r] + "0"
  }
  return rows.map((r) => r.replace(/0+$/, ""))
}

/** 点阵行 → 单行 text：连续 "1" 段用背景色块，"0" 段透明（ASCII 空格，无宽度歧义） */
function bigRowText(row: string, color: string): JSX.Element {
  const spans: JSX.Element[] = []
  let i = 0
  while (i < row.length) {
    const on = row[i] === "1"
    let j = i
    while (j < row.length && (row[j] === "1") === on) j++
    const text = " ".repeat(j - i)
    spans.push(on ? <span style={{ bg: color }}>{text}</span> : <span>{text}</span>)
    i = j
  }
  return <text flexShrink={0}>{spans}</text>
}

function shorten(sid: string): string {
  return sid.length > 14 ? sid.slice(0, 11) + "\u2026" : sid
}
