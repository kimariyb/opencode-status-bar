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
  ? { title: "状态", time: "时间", battery: "电量" }
  : { title: "Status", time: "Time", battery: "Battery" }

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
  // pmset -g batt 返回极快（<5ms），execSync 不会阻塞 TUI
  const out = execSync("pmset -g batt", { timeout: 5000, encoding: "utf-8" })
  const pctMatch = out.match(/(\d+)%/)
  const percent = pctMatch ? parseInt(pctMatch[1], 10) : null
  const charging = /AC Power|charged|charging/i.test(out)
  return { percent, charging }
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
  const out = execSync(
    'powershell -NoProfile -Command "(Get-WmiObject Win32_Battery).EstimatedChargeRemaining"',
    { timeout: 5000, encoding: "utf-8" },
  ).trim()
  const percent = parseInt(out, 10)
  if (!Number.isFinite(percent)) return { percent: null, charging: false }
  return { percent, charging: false }
}

// ---------------------------------------------------------------------------
// 时间格式化
// ---------------------------------------------------------------------------

function formatTime(): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, "0")
  const mm = String(now.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
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

interface BalanceScript {
  request: BalanceRequest
  extractor: (response: any) => string
}

interface BalanceState {
  provider: string
  value: string
  error: boolean
}

const BALANCE_REFRESH_INTERVAL = 300_000 // 5 分钟
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

async function executeBalanceScript(script: string): Promise<string> {
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
    const json = await resp.json()
    const result = config.extractor(json)
    return typeof result === "string" ? result : String(result)
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
  const [time, setTime] = createSignal(formatTime())
  const [battery, setBattery] = createSignal<BatteryInfo>({ percent: null, charging: false })
  const [balances, setBalances] = createSignal<BalanceState[]>([])
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH)
  const [open, setOpen] = createSignal(true)
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

  // ── 分隔线 ──
  const gutter = 6 // border(2) + padding(4)
  const sep = createMemo(() => "\u2500".repeat(Math.max(1, panelWidth() - gutter)))

  // ── 计算标签与值之间的填充空格（左标签右值对齐）──
  function padBetween(label: string, value: string): number {
    const gauge = panelWidth() - gutter
    const used = visualWidth(label) + visualWidth(value)
    return Math.max(1, gauge - used)
  }

  // ── 截断值字符串，从左侧截断保留右侧（右对齐不换行）──
  function truncateValue(label: string, value: string, pw: number, gut: number): string {
    const gauge = pw - gut
    const maxValWidth = gauge - visualWidth(label) - 1 // 至少留1个空格间隔
    if (visualWidth(value) <= maxValWidth) return value
    // 从右侧逐字符取，直到达到 limit（省略号占1列）
    let result = ""
    let w = 0
    const limit = maxValWidth - 1
    for (let i = value.length - 1; i >= 0 && w < limit; i--) {
      const c = value[i]
      const cw = charColumns(c)
      if (w + cw > limit) break
      result = c + result
      w += cw
    }
    return "\u2026" + result // … 省略号
  }

  const batteryText = createMemo(() => {
    const b = battery()
    if (b.percent === null) return "--"
    return `${b.percent}%`
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

    // 立即更新一次
    setTime(formatTime())
    setBattery(readBattery())

    // 定时刷新（时间 5s 确保分钟切换及时；电池 60s 足够）
    const timeTimer = setInterval(() => setTime(formatTime()), 5000)
    const battTimer = setInterval(() => setBattery(readBattery()), 60000)

    // 余额查询（独立定时器，5 分钟刷新）
    const balanceConfigs = readBalanceConfig()
    let balanceTimer: ReturnType<typeof setInterval> | undefined

    async function refreshBalances() {
      const results = await Promise.all(
        balanceConfigs.map(async (cfg) => {
          try {
            const raw = await executeBalanceScript(cfg.script)
            // 多行字符串压缩为单行（换行符替换为空格）
            const value = raw.replace(/\n/g, " ")
            return { provider: cfg.provider, value, error: false }
          } catch (e) {
            try {
              appendFileSync("/tmp/opencode-status-bar-debug.log",
                `[${new Date().toISOString()}] balance error [${cfg.provider}]: ${e}\n`)
            } catch {}
            return { provider: cfg.provider, value: "限额满", error: true }
          }
        }),
      )
      setBalances(results)
    }

    if (balanceConfigs.length > 0) {
      refreshBalances() // 首次立即查询
      balanceTimer = setInterval(refreshBalances, BALANCE_REFRESH_INTERVAL)
    }

    onCleanup(() => {
      clearInterval(timeTimer)
      clearInterval(battTimer)
      if (balanceTimer) clearInterval(balanceTimer)
    })
  })

  return (
    <box
      border={true}
      borderColor={pal().border}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="column"
      gap={0}
      ref={boxEl}
      onSizeChange={() => {
        const w = boxEl ? Math.max(MIN_PANEL_WIDTH, boxEl.width ?? 0) : DEFAULT_PANEL_WIDTH
        setPanelWidth((prev) => (prev === w ? prev : w))
      }}
    >
      {/* 可折叠标题 */}
      <text onMouseUp={() => {
        const n = !open()
        try { props.api.kv.set(`${KV_PREFIX}.open`, n) } catch {}
        setOpen(n)
      }}>
        <span style={{ fg: pal().muted }}>{open() ? "\u25bc " : "\u25b6 "}</span>
        <span style={{ fg: pal().primary }}><b>{T.title}</b></span>
      </text>

      <Show when={open()}>
        <text fg={pal().muted}>{sep()}</text>

        {/* 时间 */}
        <text>
          <span style={{ fg: pal().muted }}>{T.time}</span>
          <span>{" ".repeat(padBetween(T.time, time()))}</span>
          <span style={{ fg: pal().success }}>{time()}</span>
        </text>

        {/* 电池 */}
        <text>
          <span style={{ fg: pal().muted }}>{T.battery}</span>
          <span>{" ".repeat(padBetween(T.battery, batteryText()))}</span>
          <span style={{ fg: batteryColor() }}>{batteryText()}</span>
        </text>

        {/* 余额查询（每个配置项一行） */}
        <For each={balances()}>
          {(bal) => {
            const displayValue = truncateValue(bal.provider, bal.value, panelWidth(), gutter)
            return (
              <text>
                <span style={{ fg: pal().muted }}>{bal.provider}</span>
                <span>{" ".repeat(padBetween(bal.provider, displayValue))}</span>
                <span style={{ fg: bal.error ? pal().warning : pal().success }}>{displayValue}</span>
              </text>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

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
