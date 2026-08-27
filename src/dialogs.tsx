/** @jsxImportSource @opentui/solid */

// ---------------------------------------------------------------------------
// 弹窗组件：Cache 详情 / Subagents 列表（按 docs/proto/dialog-prototype.html 实现）
// 由宿主 api.ui.Dialog 承载；子代理行点击展开详情，「→ open session」跳转子会话
// ---------------------------------------------------------------------------

import type { JSX } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { execSync } from "node:child_process"
import { createSignal, onMount, onCleanup, For, Show, createMemo } from "solid-js"
import type { CacheStats } from "./cache"
import { fmtTokens, fmtCost } from "./cache"
import type { SubEntry } from "./subagent"
import type { UsageStats, UsageWindow } from "./usage"
import { collectUsageStats, USAGE_WINDOWS, fmtUsageTokens } from "./usage"

interface Palette {
  text: string
  muted: string
  success: string
  warning: string
  error: string
  accent: string
  primary: string
  border: string
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
            <span style={{ fg: pal.muted }}>上次命中 </span>
            {(() => {
              const lastHit = s().lastHitRate
              return lastHit !== undefined ? (
                <span style={{ fg: pal.text }}>{lastHit.toFixed(1)}%</span>
              ) : (
                <span style={{ fg: pal.muted }}>{"--"}</span>
              )
            })()}
            <Show when={s().stepCount !== undefined}>
              <span style={{ fg: pal.muted }}>{" \u00b7 步数 "}<span style={{ fg: pal.text }}>{s().stepCount}</span></span>
            </Show>
            <Show when={(s().lastCost ?? 0) > 0}>
              <span style={{ fg: pal.muted }}>{" \u00b7 上次成本 "}<span style={{ fg: pal.text }}>{fmtCost(s().lastCost ?? 0)}</span></span>
            </Show>
          </text>
        </box>
      </Show>

      {/* ── TOKENS ── */}
      <box flexDirection="column">
        <text fg={pal.muted}>TOKEN 用量</text>
        <box flexDirection="column" paddingLeft={2}>
          <For each={[["输入", s().input], ["缓存读", s().read], ["缓存写", s().write], ["输出", s().output]] as Array<[string, number]>}>
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
          <text fg={pal.muted}>未命中（输入+写）</text>
          <text fg={pal.muted} marginLeft="auto">{"\u2248 "}{fmtTokens(s().input + s().write)}</text>
        </box>
      </box>

      {/* ── COST ── */}
      {(() => {
        const cost = s().cost
        const saved = s().saved
        if ((cost ?? 0) <= 0 && saved <= 0) return null
        return (
          <box flexDirection="column">
            <text fg={pal.muted}>成本</text>
            <box flexDirection="column" paddingLeft={2}>
              {(cost ?? 0) > 0 ? (
                <box flexDirection="row">
                  <text fg={pal.muted}>会话</text>
                  <text fg={pal.text} marginLeft="auto"><b>{fmtCost(cost!)}</b></text>
                </box>
              ) : null}
              {saved > 0 ? (
                <box flexDirection="row">
                  <text fg={pal.success}>节省</text>
                  <text fg={pal.success} marginLeft="auto"><b>{"~"}{fmtCost(saved).slice(1)}</b></text>
                </box>
              ) : null}
            </box>
          </box>
        )
      })()}

      {/* ── MODEL ── */}
      {(() => {
        const st = s()
        if (!st.providerID || !st.modelID) return null
        return (
          <box flexDirection="column">
            <text fg={pal.muted}>模型</text>
            <box flexDirection="column" paddingLeft={2}>
              <text fg={pal.text}>{st.providerID} / {st.modelID}</text>
              {st.pricing ? (
                <text fg={pal.muted}>输入 {fmtCost(st.pricing.in)} {"\u00b7"} 读 {fmtCost(st.pricing.read)} {"\u00b7"} 写 {fmtCost(st.pricing.write)} /Mtok</text>
              ) : null}
            </box>
          </box>
        )
      })()}

      <text fg={pal.muted}>{SEP}</text>
      <text fg={pal.muted}>esc {"\u21b5"} 关闭</text>
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
          <span style={{ fg: pal.accent }}>{`\u25c6 ${running()} 运行中`}</span>
          <span style={{ fg: pal.muted }}>{" \u00b7 "}</span>
          <span style={{ fg: pal.success }}>{`\u25cf ${done()} 完成`}</span>
          <Show when={failed() > 0}>
            <span style={{ fg: pal.muted }}>{" \u00b7 "}</span>
            <span style={{ fg: pal.error }}>{`\u2715 ${failed()} 失败`}</span>
          </Show>
        </text>
      </box>
      <text>
        <span style={{ fg: pal.text }}><b>{fmtTokens(totalTok())}</b></span>
        <span style={{ fg: pal.muted }}> tok</span>
        <span style={{ fg: pal.muted }}>{" \u00b7 "}</span>
        <span style={{ fg: pal.text }}><b>{fmtDuration(totalTime())}</b></span>
        <span style={{ fg: pal.muted }}> 总耗时</span>
      </text>

      <Show
        when={props.entries().length > 0}
        fallback={<text fg={pal.muted}>本会话暂无子代理活动</text>}
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
                        {e.status === "error" ? "已出错" : `\u23f1\uFE0E ${elapsedOf(e, now())}`}
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
                        <DetailRow label="提示词"><text fg={pal.muted}>{truncateLine(e.prompt!, 58)}</text></DetailRow>
                      </Show>
                      <Show when={e.model}>
                        <DetailRow label="模型"><text fg={pal.text}>{e.model}</text></DetailRow>
                      </Show>
                      <Show when={e.tokens}>
                        <DetailRow label="token">
                          <text fg={pal.text}>{fmtTokens(e.tokens!)} tok</text>
                          <Show when={e.tokensIn !== undefined || e.tokensOut !== undefined}>
                            <text fg={pal.muted}>{"（入 "}{fmtTokens(e.tokensIn ?? 0)}{" \u00b7 出 "}{fmtTokens(e.tokensOut ?? 0) + "）"}</text>
</Show>
                        </DetailRow>
                      </Show>
                      <DetailRow label="时间">
                        <text fg={pal.text}>开始 {hhmmss(e.startedAt)}</text>
                        <text fg={e.status === "running" ? pal.warning : pal.muted}>{" \u00b7 "}{elapsedOf(e, now())}</text>
                      </DetailRow>
                      <Show when={e.todoTotal}>
                        <DetailRow label="待办"><text fg={pal.text}>{e.todoDone ?? 0}/{e.todoTotal} 完成</text></DetailRow>
                      </Show>
                      <Show when={e.sessionId}>
                        <DetailRow label="会话" muted={pal.muted}>
                          <text fg={pal.muted}>{shorten(e.sessionId!)}</text>
                          <text fg={copiedId() === e.sessionId ? pal.success : pal.accent} onMouseUp={() => copySession(e.sessionId!)}>
                            {copiedId() === e.sessionId ? " [已复制]" : " [复制]"}
                          </text>
                        </DetailRow>
                      </Show>
                      <Show when={e.sessionId}>
                        <box paddingLeft={10}>
                          <text fg={pal.accent} onMouseUp={() => openSession(e)}>{"\u2192 打开会话"}</text>
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
      <text fg={pal.muted}>点击 {"\u21b5"} 展开 {"\u00b7"} {"\u2192"} 打开会话 {"\u00b7"} esc {"\u21b5"} 关闭</text>
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
  // token 量级单位（用量弹窗大字使用，如 255.8M / 5.1G）
  "k": ["101", "110", "100", "110", "101"],
  "m": ["101", "111", "111", "101", "101"],
  "g": ["111", "100", "101", "101", "111"],
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

// ---------------------------------------------------------------------------
// Usage 用量统计弹窗（数据自取：内部持有窗口状态，直接调 collectUsageStats）
// v2 布局：TUI 原生布局原语对齐（固定宽 cell + flexGrow/marginLeft auto），
// 零 ASCII 拼接 —— CJK 测宽偏差只会整体平移，不会错行（v1 手工 pad 的教训）。
// 无外框/点阵/进度条（宿主 dialog 自带面板底色；bg 色块点阵在真实终端碎裂）。
// 教训（勿回退）：style 不能传 undefined；Show children 不放组件调用表达式；
// 列表渲染必须用「对象引用 For / 内联表达式」——索引 For + 回调体内提前取值
// 会导致切窗口时行内容不重算（v1 bug：只刷明细表不刷指标）。
// ---------------------------------------------------------------------------

const U_SEP = "\u2500".repeat(56) // 单线分隔（CacheDialog 同款，渲染安全）
const U_TOP_N = 10
const U_TAB_LABEL: Record<UsageWindow, string> = {
  today: "今天",
  "7d": "7天",
  "30d": "30天",
}

/** 简版视觉宽度（CJK 双宽感知；与 index.tsx charColumns 同源逻辑，弹窗内自持避免循环依赖） */
function uCharColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0
  if (code < 0x7F) return 1
  if (code < 0xA0) return 0
  if ((code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE10 && code <= 0xFE6F) ||
      (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6)) return 2
  return 1
}

function uVisualWidth(s: string): number {
  let w = 0
  for (const c of s) w += uCharColumns(c)
  return w
}

/** 保头截断（尾 …）到目标视觉宽度 —— 唯一保留的字符串处理（防过长换行） */
function truncateV(s: string, max: number): string {
  if (uVisualWidth(s) <= max) return s
  let w = 0
  let out = ""
  for (const c of s) {
    const cw = uCharColumns(c)
    if (w + cw > max - 1) return out + "\u2026"
    out += c
    w += cw
  }
  return s
}

/** token 缩写（G 档支持见 usage.ts） */
function fmtTok(n: number): string {
  return fmtUsageTokens(n)
}

/** 千分位：25254 → 25,254 */
function fmtInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export function UsageDialog(props: { dbPath?: string; pal: Palette }): JSX.Element {
  const pal = props.pal
  const [win, setWin] = createSignal<UsageWindow>("today")
  const [tick, setTick] = createSignal(0)

  const stats = createMemo(() => {
    tick()
    return collectUsageStats(win(), { dbPath: props.dbPath })
  })
  const s = () => stats()

  /** 命中率颜色分级（与 CacheDialog 一致）：≥85 绿 / ≥70 黄 / <70 红 */
  const hitColor = (v: number) => (v >= 85 ? pal.success : v >= 70 ? pal.warning : pal.error)

  // 明细数据：Top N + 其余聚合为「其他模型」
  const detail = createMemo(() => {
    const rows = s().rows
    if (rows.length <= U_TOP_N) return { shown: rows, rest: null }
    const restRows = rows.slice(U_TOP_N)
    return {
      shown: rows.slice(0, U_TOP_N),
      rest: {
        count: restRows.length,
        requests: restRows.reduce((a, r) => a + r.requests, 0),
        total: restRows.reduce((a, r) => a + r.total, 0),
      },
    }
  })

  // 指标数据（纯数据，非元素 —— 渲染时对象 For，stats 变化即重建行，修复切窗不刷新 bug）
  const metricList = createMemo(() => {
    const t = s().totals
    const list: Array<{ label: string; value: string; color: string; hit?: number }> = [
      { label: "总输入", value: fmtTok(t.input), color: pal.text },
      { label: "总输出", value: fmtTok(t.output), color: pal.text },
      { label: "缓存命中", value: fmtTok(t.read), color: pal.accent, hit: s().hitRate },
    ]
    if (t.write > 0) list.push({ label: "缓存写入", value: fmtTok(t.write), color: pal.text })
    return list
  })
  // 2×2 配对（每次重算生成新对象数组 → For 按引用重建）
  const metricPairs = createMemo(() => {
    const list = metricList()
    const pairs: Array<Array<{ label: string; value: string; color: string; hit?: number }>> = []
    for (let i = 0; i < list.length; i += 2) pairs.push(list.slice(i, i + 2))
    return pairs
  })

  const errorView = () => {
    const st = s()
    switch (st.status) {
      case "engine-missing":
        return "当前运行时不支持 SQLite，无法统计用量"
      case "db-missing":
        return `未找到 opencode.db（${st.dbPath ?? ""}）`
      default:
        return `查询失败：${st.error ?? "未知错误"}`
    }
  }

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      {/* ── 标题行：标题左 + tab 右（flexGrow 占位，永不溢出；点击切换）── */}
      <box flexDirection="row">
        <text flexShrink={0}>
          <span style={{ fg: pal.text }}><b>用量统计</b></span>
          <span style={{ fg: pal.muted }}>{"  // USAGE"}</span>
        </text>
        <box flexGrow={1} />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <For each={USAGE_WINDOWS}>
            {(w) => (
              <text
                flexShrink={0}
                onMouseUp={() => setWin(w)}
                fg={w === win() ? pal.accent : pal.muted}
              >
                {w === win() ? `\u2039${U_TAB_LABEL[w]}\u203a` : `[${U_TAB_LABEL[w]}]`}
              </text>
            )}
          </For>
        </box>
      </box>
      <text fg={pal.border}>{U_SEP}</text>

      {/* ── 非 ok 态：纯字面量 text ── */}
      {s().status !== "ok" ? (
        <box flexDirection="column">
          <text fg={s().status === "empty" ? pal.muted : pal.error}>
            {s().status === "empty" ? "该时间范围内暂无用量数据" : errorView()}
          </text>
          <Show when={s().status === "db-missing"}>
            <text fg={pal.muted}>{"可在 status-bar.jsonc 的 usage.dbPath 指定数据库路径"}</text>
            <text fg={pal.muted}>{"或设置 OPENCODE_DB 环境变量"}</text>
          </Show>
          <Show when={s().status === "query-error"}>
            <text fg={pal.accent} onMouseUp={() => setTick((x) => x + 1)}>{"\u21bb 点击重试"}</text>
          </Show>
        </box>
      ) : null}

      <Show when={s().status === "ok"}>
        {/* ── 总量区：bold + accent 承担视觉权重（响应式内联表达式，stats 变即更新）── */}
        <text>
          <span style={{ fg: pal.accent }}><b>{fmtTok(s().totals.tokens)}</b></span>
          <span style={{ fg: pal.muted }}>{" token 总消耗"}</span>
        </text>
        <text>
          <span style={{ fg: pal.text }}><b>{fmtInt(s().totals.requests)}</b></span>
          <span style={{ fg: pal.muted }}>{" 次请求 \u00b7 "}</span>
          <span style={{ fg: pal.text }}><b>{s().totals.models}</b></span>
          <span style={{ fg: pal.muted }}>{" 个模型"}</span>
        </text>

        {/* ── 指标区 2×2：每半 label + flexGrow 占位 + 值右对齐（布局引擎保证对齐）── */}
        <For each={metricPairs()}>
          {(pair) => (
            <box flexDirection="row">
              <For each={pair}>
                {(m) => (
                  <box flexDirection="row" flexGrow={1}>
                    <text fg={pal.muted} flexShrink={0}>{m.label}</text>
                    <box flexGrow={1} />
                    <text fg={m.color}><b>{m.value}</b></text>
                    {m.hit !== undefined ? (
                      <text fg={hitColor(m.hit)}>{" " + m.hit.toFixed(0) + "%"}</text>
                    ) : null}
                  </box>
                )}
              </For>
              {/* 落单指标补半宽占位，保持值列与上行对齐（2×2 栅格节奏） */}
              {pair.length === 1 ? <box flexGrow={1} /> : null}
            </box>
          )}
        </For>
        <text fg={pal.border}>{U_SEP}</text>

        {/* ── 明细表：模型列 flexGrow（27 字符长名不截断）+ 数值列固定宽右对齐 ── */}
        <box flexDirection="row">
          <text fg={pal.muted} flexGrow={1}>模型</text>
          <box width={10} justifyContent="flex-end" flexShrink={0}>
            <text fg={pal.muted}>请求数</text>
          </box>
          <box width={12} justifyContent="flex-end" flexShrink={0}>
            <text fg={pal.muted}>Token</text>
          </box>
        </box>
        <For each={detail().shown}>
          {(r) => (
            <box flexDirection="row">
              <text fg={pal.text} flexGrow={1} overflow="hidden">{truncateV(r.model, 28)}</text>
              <box width={10} justifyContent="flex-end" flexShrink={0}>
                <text fg={pal.muted}>{fmtInt(r.requests)}</text>
              </box>
              <box width={12} justifyContent="flex-end" flexShrink={0}>
                <text fg={pal.text}>{fmtTok(r.total)}</text>
              </box>
            </box>
          )}
        </For>
        {detail().rest ? (
          <box flexDirection="row">
            <text fg={pal.muted} flexGrow={1} overflow="hidden">
              {`其他模型 · ${detail().rest!.count}`}
            </text>
            <box width={10} justifyContent="flex-end" flexShrink={0}>
              <text fg={pal.muted}>{fmtInt(detail().rest!.requests)}</text>
            </box>
            <box width={12} justifyContent="flex-end" flexShrink={0}>
              <text fg={pal.muted}>{fmtTok(detail().rest!.total)}</text>
            </box>
          </box>
        ) : null}
        <text fg={pal.border}>{U_SEP}</text>

        {/* ── 页脚 ── */}
        <text fg={pal.muted}>{"esc \u21b5 关闭 \u00b7 点击时间范围切换"}</text>
      </Show>
    </box>
  )
}
