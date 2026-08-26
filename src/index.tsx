/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiSlotContext,
  TuiSlotPlugin,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onMount, onCleanup, Show, For } from "solid-js"
import { execSync } from "node:child_process"
import { readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { PLUGIN_VERSION } from "./_version"
import { readStatusBarConfig, type StatusBarConfig } from "./config"
import { collectCacheStats, fmtTokens, type CacheStats } from "./cache"
import { createSubagentTracker, type SubEntry, type SubagentTracker } from "./subagent"
import { CacheDialog, SubagentDialog } from "./dialogs"

// ---------------------------------------------------------------------------
// 平台检测与全局声明
// ---------------------------------------------------------------------------

declare const process: { platform: string; env: Record<string, string | undefined> } | undefined
const PLATFORM: string = typeof process !== "undefined" ? process.platform : ""

// ---------------------------------------------------------------------------
// CJK 宽度计算（混合文本对齐）
// ---------------------------------------------------------------------------

function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0
  if (code < 0x7F) return 1
  if (code < 0xA0) return 0
  if ((code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE10 && code <= 0xFE6F) ||
      (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x2600 && code <= 0x27BF) ||              // Misc Symbols & Dingbats (⚡ 等 emoji)
      (code >= 0x1F300 && code <= 0x1F64F) ||
      (code >= 0x20000 && code <= 0x3FFFD))
    return 2
  return 1
}

function visualWidth(s: string): number {
  let w = 0; for (const c of s) w += charColumns(c); return w
}

// ---------------------------------------------------------------------------
// 颜色处理（从主题色自适应，自动降低饱和度）
// ---------------------------------------------------------------------------

function rgb(raw: unknown): { r: number; g: number; b: number } | null {
  if (typeof raw === "string" && raw.startsWith("#")) {
    const h = raw.slice(1)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255
      return { r: Math.round(o.r * scale), g: Math.round(o.g * scale), b: Math.round(o.b * scale) }
    }
  }
  return null
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  if (delta === 0) return 0
  const L = (max + min) / 2
  return L <= 0.5 ? delta / (max + min) : delta / (2 - max - min)
}

const MAX_SAT = 0.28

function desaturateTo(raw: unknown, maxSat: number, fallback: string): string {
  const c = rgb(raw)
  if (!c) return fallback
  const sat = saturation(c.r, c.g, c.b)
  if (sat <= maxSat) {
    return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
  }
  const luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114
  let lo = 0, hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const nr = Math.round(c.r + (luma - c.r) * mid)
    const ng = Math.round(c.g + (luma - c.g) * mid)
    const nb = Math.round(c.b + (luma - c.b) * mid)
    if (saturation(nr, ng, nb) > maxSat) lo = mid
    else hi = mid
  }
  const nr = Math.round(c.r + (luma - c.r) * hi)
  const ng = Math.round(c.g + (luma - c.g) * hi)
  const nb = Math.round(c.b + (luma - c.b) * hi)
  return "#" + [nr, ng, nb].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
}

const FALLBACK = {
  primary: "#8B9DAF",
  text:    "#C5C5BB",
  muted:   "#7A7A72",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error:   "#B08A8A",
  border:  "#6B6B63",
  accent:  "#7AA2F7",
} as const

// ---------------------------------------------------------------------------
// 语言检测
// ---------------------------------------------------------------------------

const DEBUG_LANG = typeof process !== "undefined" ? process.env?.STATUS_BAR_LANG : undefined

const LANG_ZH = DEBUG_LANG
  ? DEBUG_LANG === "zh"
  : (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().locale.startsWith("zh") }
      catch { return false }
    })()

const T = LANG_ZH
  ? { title: "状态", retry: "失败 · 点击重试", reset: "已重置", week: "日一二三四五六" }
  : { title: "Status", retry: "Failed \u00b7 click to retry", reset: "reset", week: "SuMoTuWeThFrSa" }

// ---------------------------------------------------------------------------
// 电池读取（跨平台）
// ---------------------------------------------------------------------------

interface BatteryInfo {
  percent: number | null
  charging: boolean
}

function readBattery(): BatteryInfo {
  try {
    if (PLATFORM === "darwin") {
      return readBatteryMacOS()
    }
    if (PLATFORM === "linux") {
      return readBatteryLinux()
    }
    if (PLATFORM === "win32") {
      return readBatteryWindows()
    }
  } catch {
    // 读取失败不影响面板渲染
  }
  return { percent: null, charging: false }
}

function readBatteryMacOS(): BatteryInfo {
  // 语义：「插着电即闪烁，拔线即停」——涵盖真充电与优化充电保持态（IsCharging 在保持态为 No，
  // 若按其判定，优化充电用户插线时永远不闪，功能形同虚设。社区工具 sketchybar 同此语义）。
  // 主路径：ioreg ExternalConnected；grep 管道压缩输出；容量比值兼容 mAh 制老机型。
  try {
    const out = execSync(
      "ioreg -rn AppleSmartBattery | grep -E 'CurrentCapacity|MaxCapacity|ExternalConnected'",
      { timeout: 5000, encoding: "utf-8" },
    )
    const cur = out.match(/"CurrentCapacity"\s*=\s*(\d+)/)
    const max = out.match(/"MaxCapacity"\s*=\s*(\d+)/)
    const charging = /"ExternalConnected"\s*=\s*Yes/.test(out)
    if (cur && max) {
      const percent = Math.round((parseInt(cur[1], 10) / parseInt(max[1], 10)) * 100)
      return { percent, charging }
    }
  } catch {}
  // 降级路径：pmset 文本解析。插电输出必含 'AC Power'（drawing from）或 AC attached；
  // \b 词边界排除 Discharging 误匹配。
  try {
    const out = execSync("pmset -g batt", { timeout: 5000, encoding: "utf-8" })
    const pctMatch = out.match(/(\d+)%/)
    const percent = pctMatch ? parseInt(pctMatch[1], 10) : null
    const charging = /\bAC Power\b|\bAC attached\b/i.test(out)
    return { percent, charging }
  } catch {
    return { percent: null, charging: false }
  }
}

function readBatteryLinux(): BatteryInfo {
  const base = "/sys/class/power_supply"
  const entries = readdirSync(base)
  const batName = entries.find((n: string) => n.startsWith("BAT"))
  if (!batName) return { percent: null, charging: false }
  const dir = `${base}/${batName}`
  const pctRaw = readFileSync(`${dir}/capacity`, "utf-8").trim()
  const percent = parseInt(pctRaw, 10)
  if (!Number.isFinite(percent)) return { percent: null, charging: false }
  const status = readFileSync(`${dir}/status`, "utf-8").trim()
  const charging = status === "Charging"
  return { percent, charging }
}

function readBatteryWindows(): BatteryInfo {
  // Get-WmiObject 在 PowerShell 7 已移除，统一用 Get-CimInstance；BatteryStatus 语义：
  // 1=放电 2=On AC（未放电但不一定在充电→按需求降级不闪）3=充满 6/7/8/9=确认充电系列
  const out = execSync(
    'powershell -NoProfile -Command "$b = Get-CimInstance Win32_Battery; \"{0} {1}\" -f $b.EstimatedChargeRemaining, $b.BatteryStatus"',
    { timeout: 5000, encoding: "utf-8" },
  ).trim().split(/\s+/)
  const percent = parseInt(out[0], 10)
  if (!Number.isFinite(percent)) return { percent: null, charging: false }
  const status = parseInt(out[1], 10)
  // Windows 无法精确区分「充电中/保持」，降级为「接电即闪」：非放电态（1）均视为接电
  return { percent, charging: Number.isFinite(status) && status !== 1 }
}

// ---------------------------------------------------------------------------
// 时间格式化（三态：HH:mm → HH:mm:ss → 周 M/D）
// ---------------------------------------------------------------------------

/** 迷你用量条：0.45 → ▓▓▓░░（cells 可变，窄面板降级用） */
function usageBar(usage: number, cells = METER_CELLS): string {
  const filled = Math.round(Math.min(1, Math.max(0, usage)) * cells)
  return "\u25b0".repeat(filled) + "\u25b1".repeat(cells - filled)
}

/** 动态倒计时：以查询时刻为基准，随时钟修正（65m → 1h05m → 2d04h） */
function fmtResetIn(resetInMs: number, fetchedAt: number, now: number): string {
  const ms = resetInMs - (now - fetchedAt)
  if (ms <= 0) return T.reset
  const min = Math.floor(ms / 60_000)
  const h = Math.floor(min / 60)
  const mm = min % 60
  if (h < 24) return `${h > 0 ? h + "h" : ""}${mm}m`
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`
}

// ---------------------------------------------------------------------------
// 余额查询（通过配置文件定义供应商和查询脚本）
// ---------------------------------------------------------------------------

interface BalanceConfig {
  provider: string
  script: string
}

interface BalanceRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

/**
 * extractor 返回协议（向后兼容）：
 * - string：纯文本，原样显示
 * - { text, usage?, resetIn?, windows? }：结构化返回
 *   usage(0-1) 单窗简写；windows[] 多窗（MiniMax/Kimi 的 5h/7d），存在时优先；
 *   健康度 = 各窗 usage 最大值；倒计时显示所有窗中最近重置者
 */
interface BalanceWindow {
  usage: number
  resetInMs?: number
}

interface BalanceScript {
  request: BalanceRequest
  extractor: (response: any) => string | {
    text: string
    usage?: number
    resetIn?: number
    windows?: BalanceWindow[]
  }
}

interface BalanceState {
  provider: string
  value: string
  error: boolean
  usage?: number
  resetInMs?: number
  windows?: BalanceWindow[]
  fetchedAt?: number
}

/** 行健康度：多窗取最大 usage 分档 */
function healthOf(b: BalanceState, cfg: StatusBarConfig): "ok" | "warn" | "alert" {
  const usages = b.windows?.length ? b.windows.map((w) => w.usage) : b.usage !== undefined ? [b.usage] : []
  const max = usages.length ? Math.max(...usages) : 0
  if (max >= cfg.thresholds.alert) return "alert"
  if (max >= cfg.thresholds.warning) return "warn"
  return "ok"
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_INTERVAL_MS = 80
const METER_CELLS = 5

function parseBalanceResult(raw: unknown): Omit<BalanceState, "provider"> {
  if (raw && typeof raw === "object" && typeof (raw as any).text === "string") {
    const r = raw as { text: string; usage?: unknown; resetIn?: unknown; windows?: unknown }
    let windows: BalanceWindow[] | undefined
    if (Array.isArray(r.windows)) {
      windows = r.windows
        .filter((w): w is BalanceWindow => !!w && typeof w === "object" && typeof (w as BalanceWindow).usage === "number")
        .map((w) => ({ usage: Math.min(1, Math.max(0, w.usage)), resetInMs: typeof w.resetInMs === "number" ? w.resetInMs : undefined }))
    }
    return {
      value: r.text.replace(/\n/g, " "),
      error: false,
      usage: typeof r.usage === "number" ? Math.min(1, Math.max(0, r.usage)) : undefined,
      resetInMs: typeof r.resetIn === "number" ? r.resetIn : undefined,
      windows: windows && windows.length > 0 ? windows : undefined,
      fetchedAt: Date.now(),
    }
  }
  return {
    value: String(raw).replace(/\n/g, " "),
    error: false,
    fetchedAt: Date.now(),
  }
}

const CONFIG_DIR: string = (() => {
  if (typeof process === "undefined") return ""
  if (PLATFORM === "win32") {
    return (process.env.APPDATA ?? `${homedir()}/AppData/Roaming`) + "/opencode"
  }
  return (process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`) + "/opencode"
})()
const STATUS_BAR_CONFIG_PATH = `${CONFIG_DIR}/status-bar.jsonc`

function readBalanceConfig(): BalanceConfig[] {
  try {
    const raw = readFileSync(STATUS_BAR_CONFIG_PATH, "utf-8")
    // JSONC：去掉行注释再解析
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "")
    const parsed = JSON.parse(stripped) as { balances?: BalanceConfig[] }
    if (!parsed.balances || !Array.isArray(parsed.balances)) return []
    return parsed.balances.filter(
      (b) => b && typeof b.provider === "string" && typeof b.script === "string",
    )
  } catch (e) {
    // 配置文件存在但解析失败，写 debug log 帮助排查
    try {
      appendFileSync("/tmp/opencode-status-bar-debug.log",
        `[${new Date().toISOString()}] config parse error: ${e}\n`)
    } catch {}
    return []
  }
}

function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process?.env?.[name] ?? "")
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars)
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) result[k] = substituteEnvVars(v)
    return result
  }
  return obj
}

async function executeBalanceScript(script: string): Promise<Omit<BalanceState, "provider">> {
  // 用 Function 构造器而非 eval，作用域更干净
  const config = new Function(`return (${script})`)() as BalanceScript
  if (!config || !config.request || typeof config.extractor !== "function") {
    throw new Error("invalid script: missing request or extractor")
  }
  const request = substituteEnvVars(config.request) as BalanceRequest
  // 15 秒超时，避免 API 挂起导致状态栏永不更新
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)
  try {
    const resp = await fetch(request.url, {
      method: request.method ?? "GET",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    // 非 2xx 直接抛错（如限流 429 / 服务端 5xx），避免把错误体喂给 extractor 造成误判
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const json = await resp.json()
    return parseBalanceResult(config.extractor(json))
  } finally {
    clearTimeout(timeoutId)
  }
}

// ---------------------------------------------------------------------------
// 布局常量
// ---------------------------------------------------------------------------

const MIN_PANEL_WIDTH = 20
const DEFAULT_PANEL_WIDTH = 26
const KV_PREFIX = "status_bar"

// ---------------------------------------------------------------------------
// 侧边栏面板组件
// ---------------------------------------------------------------------------
function StatusBarPanel(props: {
  theme: TuiThemeCurrent
  api: TuiPluginApi
}): JSX.Element {
  const cfg = readStatusBarConfig(STATUS_BAR_CONFIG_PATH)
  const [nowTick, setNowTick] = createSignal(Date.now())
  const [battery, setBattery] = createSignal<BatteryInfo>({ percent: null, charging: false })
  const [balances, setBalances] = createSignal<BalanceState[]>([])
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH)
  const [open, setOpen] = createSignal(true)
  const [alertPhase, setAlertPhase] = createSignal(0)
  const [chargePhase, setChargePhase] = createSignal(0)
  const [clockPhase, setClockPhase] = createSignal(0)
  const [cacheTick, setCacheTick] = createSignal(0)
  const [sgTick, setSgTick] = createSignal(0)
  let boxEl: any

  // ── 主题色（自动降低饱和度，保持与 opencode 原生面板视觉一致）──
  const pal = createMemo(() => {
    const t = props.theme as Record<string, unknown>
    const sat = (k: string, fb: string) => desaturateTo(t[k], MAX_SAT, fb)
    return {
      primary: sat("primary",   FALLBACK.primary),
      text:    sat("text",      FALLBACK.text),
      muted:   sat("textMuted", FALLBACK.muted),
      success: sat("success",   FALLBACK.success),
      warning: sat("warning",   FALLBACK.warning),
      error:   sat("error",     FALLBACK.error),
      border:  sat("border",    FALLBACK.border),
      accent:  sat("accent",    FALLBACK.accent),
    }
  })

  // ── 电量颜色编码 ──
  const batteryColor = createMemo(() => {
    const b = battery()
    if (b.percent === null) return pal().muted
    if (b.charging) return pal().success
    if (b.percent >= 50) return pal().success
    if (b.percent >= 20) return pal().warning
    return pal().error
  })

  // 内容可用宽度（宿主容器 padding 4 + 余量 2）
  const gutter = 6

  // ── 时间（HH:mm，冒号脉动由 clockPhase 驱动）──
  const clockParts = createMemo(() => {
    nowTick()
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return { hh: pad(now.getHours()), mm: pad(now.getMinutes()) }
  })

  // ── 电量簇（5 格微条 + 百分比；充电时条本体低频闪烁，颜色随电量分档）──
  const batteryDisplay = createMemo(() => {
    const b = battery()
    if (b.percent === null) return null
    const filled = Math.round((b.percent / 100) * 5)
    const bar = "\u25b0".repeat(filled) + "\u25b1".repeat(5 - filled)
    return { bar, pct: `${b.percent}%`, charging: b.charging }
  })

  // ── 当前会话与缓存统计 ──
  const currentSessionID = createMemo(() => {
    const r = props.api.route.current
    return r.name === "session" ? (r.params as { sessionID?: string }).sessionID : undefined
  })
  const cacheStats = createMemo(() => {
    cacheTick()
    return collectCacheStats(props.api, currentSessionID())
  })

  // ── 子代理追踪 ──
  const tracker: SubagentTracker = createSubagentTracker(props.api)
  const subEntries = createMemo(() => {
    sgTick()
    return tracker.entries()
  })
  const runningSubs = createMemo(() => subEntries().filter((e) => e.status === "running").length)

  // ── 余额查询（事件驱动：每轮回复完成后刷新；启动时立即查一次）──
  const balanceConfigs = readBalanceConfig()

  let refreshing = false

  /** 查询单个供应商：成功返回新状态；失败保留上次成功值（对齐 pi balance-status 策略） */
  async function queryOne(cfg0: BalanceConfig, prev?: BalanceState): Promise<BalanceState> {
    try {
      const result = await executeBalanceScript(cfg0.script)
      return { provider: cfg0.provider, ...result }
    } catch (e) {
      try {
        appendFileSync("/tmp/opencode-status-bar-debug.log",
          `[${new Date().toISOString()}] balance error [${cfg0.provider}]: ${e}\n`)
      } catch {}
      if (prev && !prev.error) return prev
      return { provider: cfg0.provider, value: "限额满", error: true }
    }
  }

  /** 行级手动刷新：点击余额行触发，仅更新该行 */
  async function refreshOne(provider: string): Promise<boolean> {
    const cfg0 = balanceConfigs.find((c) => c.provider === provider)
    if (!cfg0) return false
    const cur = balances().find((b) => b.provider === provider)
    const next = await queryOne(cfg0, cur)
    setBalances((list) => list.map((b) => (b.provider === provider ? next : b)))
    return !next.error
  }

  async function refreshBalances() {
    if (refreshing) return
    refreshing = true
    try {
      const prev = new Map(balances().map((b) => [b.provider, b]))
      const results = await Promise.all(
        balanceConfigs.map((cfg0) => queryOne(cfg0, prev.get(cfg0.provider))),
      )
      setBalances(results)
    } finally {
      refreshing = false
    }
  }

  // ── 弹窗（宿主 dialog.replace 已自带全屏遮罩与居中容器，内容直接裸放；传 accessor 保持响应式）──
  function openCacheDialog() {
    props.api.ui.dialog.replace(() => (
      <CacheDialog stats={() => cacheStats()} pal={pal()} />
    ))
  }
  function openSubagentDialog() {
    props.api.ui.dialog.replace(() => (
      <SubagentDialog api={props.api} entries={() => subEntries()} pal={pal()} />
    ))
  }

  // ── 折叠态摘要（健康星座 + 缓存 + 子代理）──
  const collapsedSummary = createMemo(() => {
    sgTick()
    const stars = balances().map((b) => healthOf(b, cfg)).map((h) =>
      h === "alert" ? "\u25cf" : h === "warn" ? "\u25cf" : "\u25cf").join("")
    const parts: string[] = []
    if (cfg.sections.cache && cacheStats().hasData) parts.push(`\u21c4 ${cacheStats().hitRate.toFixed(0)}%`)
    if (cfg.sections.subagent && runningSubs() > 0) parts.push(`\u29d7 ${runningSubs()}run`)
    return { stars, tail: parts.length ? " \u00b7 " + parts.join(" \u00b7 ") : "" }
  })

  onMount(() => {
    setPanelWidth(DEFAULT_PANEL_WIDTH)

    // 恢复折叠状态
    try {
      setOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.open`, true)))
    } catch {}

    // 测量面板宽度
    if (boxEl && typeof boxEl.width === "number" && boxEl.width > 0) {
      setPanelWidth(Math.max(MIN_PANEL_WIDTH, boxEl.width))
    }

    setNowTick(Date.now())
    setBattery(readBattery())

    // 1s 时钟；电池 60s
    const timeTimer = setInterval(() => setNowTick(Date.now()), 1000)
    // 电池轮询：插拔充电线需快速感知（darwin/linux 读取 <5ms 用 5s；win32 powershell 启动重用 15s）
    const battIntervalMs = PLATFORM === "win32" ? 15_000 : 5_000
    const battTimer = setInterval(() => setBattery(readBattery()), battIntervalMs)

    // 动效定时器（全部受配置开关控制；无动画对象时 interval 空转成本可忽略）
    const alertTimer = cfg.animations.alert.enabled
      ? setInterval(() => {
          if (balances().some((b) => !b.error && healthOf(b, cfg) === "alert")) setAlertPhase((p) => (p === 0 ? 1 : 0))
        }, cfg.animations.alert.intervalMs)
      : undefined
    // 充电闪烁：电量条亮/暗交替（频率随 charging.intervalMs 配置）
    const chargeTimer = cfg.animations.charging.enabled
      ? setInterval(() => { if (battery().charging) setChargePhase((p) => (p === 0 ? 1 : 0)) }, cfg.animations.charging.intervalMs)
      : undefined
    const clockTimer = cfg.animations.clock.enabled
      ? setInterval(() => setClockPhase((p) => (p === 0 ? 1 : 0)), cfg.animations.clock.intervalMs)
      : undefined

    // 缓存统计：消息/回合事件驱动重算
    const bumpCache = () => setCacheTick((x) => x + 1)
    const offMsg = props.api.event.on("message.updated", bumpCache)
    const offPart = props.api.event.on("message.part.updated", bumpCache)
    const offCacheIdle = props.api.event.on("session.idle", bumpCache)

    // 余额：首次立即查询 + session.idle 尾沿防抖刷新
    if (balanceConfigs.length > 0) {
      refreshBalances()
      let debounce: ReturnType<typeof setTimeout> | undefined
      const offIdle = props.api.event.on("session.idle", () => {
        clearTimeout(debounce)
        debounce = setTimeout(refreshBalances, 1500)
      })
      onCleanup(() => { offIdle(); clearTimeout(debounce) })
    }

    // 子代理：条目变化 → tick 触发重渲
    const offSg = tracker.onChange(() => setSgTick((x) => x + 1))

    onCleanup(() => {
      clearInterval(timeTimer)
      clearInterval(battTimer)
      if (alertTimer) clearInterval(alertTimer)
      if (chargeTimer) clearInterval(chargeTimer)
      if (clockTimer) clearInterval(clockTimer)
      offMsg(); offPart(); offCacheIdle(); offSg()
      tracker.dispose()
    })
  })

  const healthColor = (h: "ok" | "warn" | "alert") =>
    h === "alert" ? pal().error : h === "warn" ? pal().warning : pal().success

  const toggleOpen = () => {
    const n = !open()
    try { props.api.kv.set(`${KV_PREFIX}.open`, n) } catch {}
    setOpen(n)
  }

  return (
    <box flexDirection="column" gap={0} ref={boxEl} onSizeChange={() => {
      const w = boxEl ? Math.max(MIN_PANEL_WIDTH, boxEl.width ?? 0) : DEFAULT_PANEL_WIDTH
      setPanelWidth((prev) => (prev === w ? prev : w))
    }}>
      {/* 两态互斥渲染：展开态（标题行三分区 + 明细）/ 折叠态（仅摘要单行），修复折叠态双时间双箭头 */}
      <Show when={open()} fallback={
        /* ── 折叠态：健康星座 + 关键指标摘要（点击展开）── */
        <text onMouseUp={toggleOpen}>
          <span style={{ fg: pal().muted }}>{"\u25b6 "}</span>
          <span style={{ fg: pal().text }}><b>{clockParts().hh}</b></span>
          <span style={{ fg: clockPhase() === 0 ? pal().text : pal().muted }}>:</span>
          <span style={{ fg: pal().text }}><b>{clockParts().mm}</b></span>
          <Show when={balances().length > 0}>
            <span style={{ fg: pal().muted }}>{" \u00b7 "}</span>
            <For each={balances()}>
              {(b) => (
                <span style={{ fg: healthColor(healthOf(b, cfg)) }}>{"\u25cf "}</span>
              )}
            </For>
          </Show>
          <span style={{ fg: pal().muted }}>{collapsedSummary().tail}</span>
        </text>
      }>
        {/* ── 标题行：三分区热区（▼时间=折叠 | spacer | 电量 | ⇄缓存=弹窗）── */}
        <box flexDirection="row">
          <text flexShrink={0} onMouseUp={toggleOpen}>
            <span style={{ fg: pal().muted }}>{"\u25bc "}</span>
            <span style={{ fg: pal().text }}><b>{clockParts().hh}</b></span>
            <span style={{ fg: clockPhase() === 0 ? pal().text : pal().muted }}>:</span>
            <span style={{ fg: pal().text }}><b>{clockParts().mm}</b></span>
          </text>
          <Show when={cfg.sections.battery || cfg.sections.cache}>
            <box flexGrow={1} />
            <Show when={cfg.sections.battery}>
              <text flexShrink={0}>
                <Show when={batteryDisplay()} fallback={<span style={{ fg: pal().muted }}>--</span>}>
                  {/* 充电时条本体低频闪烁（分档色↔accent 蓝），百分比常亮 */}
                  <span style={{ fg: battery().charging && chargePhase() === 1 ? pal().accent : batteryColor() }}>
                    {batteryDisplay()!.bar}
                  </span>
                  <span style={{ fg: batteryColor() }}> {batteryDisplay()!.pct}</span>
                </Show>
              </text>
            </Show>
            <Show when={cfg.sections.cache}>
              <text flexShrink={0} onMouseUp={openCacheDialog}>
                <span style={{ fg: pal().muted }}>{cfg.sections.battery ? " \u00b7 " : ""}</span>
                <span style={{ fg: cacheStats().hasData ? pal().accent : pal().muted }}>
                  {"\u21c4 " + (cacheStats().hasData ? cacheStats().hitRate.toFixed(0) + "%" : "--")}
                </span>
              </text>
            </Show>
          </Show>
        </box>

        {/* ── 余额行（• 状态点 + 名称 + 粗体语义值，单行）── */}
        <For each={balances()}>
          {(bal) => (
            <BalanceRow
              bal={bal}
              pal={pal()}
              panelWidth={panelWidth()}
              cfg={cfg}
              alertPhase={alertPhase()}
              nowTick={nowTick()}
              onRefresh={refreshOne}
            />
          )}
        </For>

        {/* ── 子代理行（有活动才显示；点击开列表弹窗）── */}
        <Show when={cfg.sections.subagent && subEntries().length > 0}>
          <text onMouseUp={openSubagentDialog}>
            <span style={{ fg: pal().accent }}>{"\u25c6 "}</span>
            <span style={{ fg: pal().text }}>task</span>
            <span>{" ".repeat(Math.max(1, panelWidth() - 4 - visualWidth("task") - visualWidth(sgSummaryText(subEntries()))))}</span>
            <span style={{ fg: pal().muted }}>{sgSummaryText(subEntries())}</span>
          </text>
        </Show>
      </Show>
    </box>
  )
}

/** 子代理行右侧摘要：⠋2 run · 1 done · 8.2k tok */
function sgSummaryText(entries: SubEntry[]): string {
  const run = entries.filter((e) => e.status === "running").length
  const done = entries.filter((e) => e.status === "done").length
  const err = entries.filter((e) => e.status === "error").length
  const tok = entries.reduce((acc, e) => acc + (e.tokens ?? 0), 0)
  const parts: string[] = []
  if (run > 0) parts.push(`${run} run`)
  if (done > 0) parts.push(`${done} done`)
  if (err > 0) parts.push(`${err} failed`)
  if (tok > 0) parts.push(fmtTokens(tok) + " tok")
  return parts.join(" \u00b7 ")
}

// ---------------------------------------------------------------------------
// 余额行组件（v5 信号节奏：• 状态点 + 名称 + 粗体语义值 + 微条，单行铁律）
// ---------------------------------------------------------------------------

/** 视觉宽度截断（保头部，尾部 …），用于超长 provider 名 */
function truncateVisual(s: string, max: number): string {
  let w = 0
  let out = ""
  for (const c of s) {
    const cw = charColumns(c)
    if (w + cw > max - 1) return out + "\u2026"
    out += c
    w += cw
  }
  return s
}

/** provider 名上限（列）：超出截断，保证值区域最小可用宽度 */
const NAME_MAX = 14

function BalanceRow(props: {
  bal: BalanceState
  pal: { primary: string; text: string; muted: string; success: string; warning: string; error: string; accent: string; border: string }
  panelWidth: number
  cfg: StatusBarConfig
  alertPhase: number
  nowTick: number
  onRefresh: (provider: string) => Promise<boolean>
}): JSX.Element {
  const [loading, setLoading] = createSignal(false)
  const [frame, setFrame] = createSignal(0)
  let spinTimer: ReturnType<typeof setInterval> | undefined

  onCleanup(() => { if (spinTimer) clearInterval(spinTimer) })

  async function handleClick() {
    if (loading()) return
    setLoading(true)
    setFrame(0)
    if (props.cfg.animations.spinner.enabled) {
      spinTimer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), props.cfg.animations.spinner.intervalMs)
    }
    try { await props.onRefresh(props.bal.provider) } finally {
      if (spinTimer) clearInterval(spinTimer)
      setLoading(false)
    }
  }

  const health = () => healthOf(props.bal, props.cfg)
  // 告急行呼吸：alert 相位 0=亮 1=暗（muted 替代透明度）
  const dimmed = () => health() === "alert" && props.alertPhase === 1

  /** 值文本组装（单行；降级链：微条 5→3→0 → 双窗丢首窗 → 逐字符保右） */
  const valueText = () => {
    props.nowTick
    const b = props.bal
    const name = visualWidth(b.provider) > NAME_MAX ? truncateVisual(b.provider, NAME_MAX) : b.provider
    const avail = props.panelWidth - 4 - visualWidth(name) - 1
    const hasWindows = !!b.windows?.length
    const usages = hasWindows ? b.windows! : b.usage !== undefined ? [{ usage: b.usage, resetInMs: b.resetInMs }] : []

    // 纯文本余额（无 usage 数据）：超宽保右截断
    if (usages.length === 0) {
      if (visualWidth(b.value) <= avail) return b.value
      let out = b.value
      while (out.length > 1 && visualWidth(out) > avail) out = out.slice(1)
      return "\u2026" + out
    }

    // 倒计时：所有窗中最近重置者（动态修正）
    const resets = usages.map((w) => w.resetInMs).filter((r): r is number => typeof r === "number")
    const fetchedAt = b.fetchedAt ?? Date.now()
    const countdown = resets.length
      ? " \u00b7 " + fmtResetIn(Math.min(...resets), fetchedAt, Date.now())
      : ""

    const build = (cells: number, list = usages): string => {
      const segs = list.map((w) => {
        const pct = `${Math.round(w.usage * 100)}%`
        return cells > 0 ? `${pct} ${usageBar(w.usage, cells)}` : pct
      })
      return segs.join(" ") + countdown
    }
    if (visualWidth(build(5)) <= avail) return build(5)
    if (visualWidth(build(3)) <= avail) return build(3)
    if (visualWidth(build(0)) <= avail) return build(0)
    // 双窗仍超宽：丢首窗，只留最后一窗（最近重置窗）
    if (usages.length > 1) {
      const last = usages[usages.length - 1]
      const s3 = build(3, [last])
      if (visualWidth(s3) <= avail) return s3
      const s0 = build(0, [last])
      if (visualWidth(s0) <= avail) return s0
    }
    // 保底：逐字符左删（保右端数值）
    let out = build(0)
    while (out.length > 1 && visualWidth(out) > avail) out = out.slice(1)
    return "\u2026" + out
  }

  const displayName = visualWidth(props.bal.provider) > NAME_MAX ? truncateVisual(props.bal.provider, NAME_MAX) : props.bal.provider

  return (
    <text onMouseUp={handleClick}>
      <span style={{ fg: dimmed() ? props.pal.muted : healthColorOf(health(), props.pal) }}>{"\u2022 "}</span>
      <span style={{ fg: props.pal.text }}>{displayName}</span>
      <span>{" ".repeat(Math.max(1, props.panelWidth - 4 - visualWidth(displayName) - visualWidth(valueText())))}</span>
      <Show when={loading()} fallback={
        <span style={{ fg: dimmed() ? props.pal.muted : valueColorOf(health(), props.bal, props.pal) }}><b>{valueText()}</b></span>
      }>
        <span style={{ fg: props.pal.accent }}>{SPINNER_FRAMES[frame()]}</span>
      </Show>
    </text>
  )
}

function healthColorOf(h: "ok" | "warn" | "alert", pal: { success: string; warning: string; error: string }): string {
  return h === "alert" ? pal.error : h === "warn" ? pal.warning : pal.success
}

function valueColorOf(h: "ok" | "warn" | "alert", b: BalanceState, pal: { success: string; warning: string; error: string; text: string }): string {
  if (b.error) return pal.error
  // 有 usage 数据 → 健康语义色；纯文本余额 → success（余额存在即健康）
  return (b.usage !== undefined || b.windows?.length) ? healthColorOf(h, pal) : pal.success
}


function createSidebarSlot(api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 90,
    slots: {
      sidebar_content(ctx: TuiSlotContext): JSX.Element {
        return <StatusBarPanel theme={ctx.theme.current} api={api} />
      },
    },
  }
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // 调试日志 — 写文件确认插件被加载
  try { appendFileSync("/tmp/opencode-status-bar-debug.log", `[${new Date().toISOString()}] TUI plugin loaded\n`) } catch {}
  api.slots.register(createSidebarSlot(api))
}

const mod: TuiPluginModule & { id: string } = {
  id: "opencode-status-bar",
  tui,
}

export default mod
