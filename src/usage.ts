// ---------------------------------------------------------------------------
// 用量统计（数据层）：跨模型用量聚合，直读 opencode SQLite（只读）。
// 参考 cc-switch session_usage_opencode.rs 的提取口径；因插件运行在
// opencode 进程内，打开面板时实时查询即可，无需其同步水位/去重层。
//
// 性能三层防护：
//   ① mtime 复合缓存（db + db-wal，WAL 模式新提交先落 -wal，只看主库会漏）
//   ② 连接单例懒加载，异常丢弃重建（自愈）
//   ③ 查询失败自动重试一次（换新连接）
// 托底状态机：ok / empty / engine-missing / db-missing / query-error，
// 任何状态不抛异常，不崩宿主面板。
// ---------------------------------------------------------------------------

import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import { fmtTokens } from "./cache"

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type UsageWindow = "today" | "7d" | "30d"

export const USAGE_WINDOWS: readonly UsageWindow[] = ["today", "7d", "30d"]

export interface UsageModelRow {
  model: string
  requests: number
  input: number
  output: number // output + reasoning（思考 token 归入输出，与 cc-switch 一致）
  read: number
  write: number
  total: number // 全口径：input + output + read + write
}

export interface UsageTotals {
  tokens: number
  input: number
  output: number
  read: number
  write: number
  requests: number
  models: number
}

export type UsageStatus = "ok" | "empty" | "engine-missing" | "db-missing" | "query-error"

export interface UsageStats {
  status: UsageStatus
  window: UsageWindow
  sinceMs: number
  rows: UsageModelRow[]
  totals: UsageTotals
  hitRate: number // 0-100；read / (input + read + write)，与缓存按钮同口径
  error?: string
  dbPath?: string
}

// ---------------------------------------------------------------------------
// 窗口起点（ms）
// ---------------------------------------------------------------------------

export function windowSinceMs(win: UsageWindow, now = Date.now()): number {
  switch (win) {
    case "today": {
      // 本地时区当日 00:00 起
      const d = new Date(now)
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    }
    case "7d":
      return now - 7 * 24 * 3600_000
    case "30d":
      return now - 30 * 24 * 3600_000
  }
}

// ---------------------------------------------------------------------------
// SQLite 引擎适配：bun:sqlite（主，opencode TUI 运行于 bun）→ node:sqlite（降级）
// ---------------------------------------------------------------------------

interface SqliteConn {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}

let cachedRequire: ((id: string) => unknown) | null | undefined

/** require 加载器：全局 require（bun ESM 内置）→ createRequire（node ESM） */
function loadRequire(): ((id: string) => unknown) | null {
  if (cachedRequire !== undefined) return cachedRequire
  try {
    // bun 运行时在 ESM 下也暴露全局 require
    const g = globalThis as { require?: unknown }
    if (typeof g.require === "function") {
      cachedRequire = (id) => (g.require as (i: string) => unknown)(id)
      return cachedRequire
    }
  } catch {}
  try {
    const req = createRequire(import.meta.url)
    cachedRequire = (id) => req(id) as unknown
    return cachedRequire
  } catch {}
  cachedRequire = null
  return null
}

let engineChecked = false
let openWith: ((path: string) => SqliteConn) | null = null

/** 引擎探测（一次），返回打开函数；两引擎都不可用返回 null */
function resolveEngine(): ((path: string) => SqliteConn) | null {
  if (engineChecked) return openWith
  engineChecked = true
  const req = loadRequire()
  if (req) {
    // ① bun:sqlite — 选项名 readonly（全小写）
    try {
      const mod = req("bun:sqlite") as { Database?: new (p: string, o: object) => SqliteConn }
      if (mod?.Database) {
        const Database = mod.Database
        openWith = (p) => new Database(p, { readonly: true })
        return openWith
      }
    } catch {}
    // ② node:sqlite（Node 22.5+）— 选项名 readOnly（驼峰）
    try {
      const mod = req("node:sqlite") as { DatabaseSync?: new (p: string, o: object) => SqliteConn }
      if (mod?.DatabaseSync) {
        const DatabaseSync = mod.DatabaseSync
        openWith = (p) => new DatabaseSync(p, { readOnly: true })
        return openWith
      }
    } catch {}
  }
  return null
}

// ---------------------------------------------------------------------------
// db 路径解析：配置覆盖 > OPENCODE_DB 环境变量 > XDG_DATA_HOME > 默认数据目录
// （与 cc-switch get_opencode_db_path 同优先级链；opencode 遵循 XDG，
//  所有平台默认都落在 ~/.local/share/opencode）
// ---------------------------------------------------------------------------

export function resolveDbPath(configured?: string): string {
  if (configured && configured.trim()) return configured
  const env = typeof process !== "undefined" ? process.env : undefined
  const custom = env?.OPENCODE_DB
  if (custom) {
    return custom.startsWith("/") ? custom : defaultDataDir() + "/" + custom
  }
  return defaultDataDir() + "/opencode.db"
}

function defaultDataDir(): string {
  const env = typeof process !== "undefined" ? process.env : undefined
  const xdg = env?.XDG_DATA_HOME
  if (xdg) return xdg + "/opencode"
  return homedir() + "/.local/share/opencode"
}

// ---------------------------------------------------------------------------
// 连接单例 + mtime 复合缓存
// ---------------------------------------------------------------------------

let conn: { db: SqliteConn; path: string } | undefined

function getConnection(path: string): SqliteConn {
  if (conn && conn.path === path) return conn.db
  if (conn) {
    try { conn.db.close() } catch {}
  }
  const open = resolveEngine()
  if (!open) throw new Error("no sqlite engine")
  const db = open(path)
  conn = { db, path }
  return db
}

function dropConnection(): void {
  if (conn) {
    try { conn.db.close() } catch {}
    conn = undefined
  }
}

/** mtime 复合 key（ms）：db 与 db-wal 取最大；文件缺失返回 0 */
function dataFingerprint(path: string): number {
  let mtime = 0
  for (const p of [path, path + "-wal"]) {
    try {
      const m = statSync(p).mtimeMs
      if (m > mtime) mtime = m
    } catch {}
  }
  return mtime
}

interface CacheEntry {
  key: string
  stats: UsageStats
}
const cache = new Map<UsageWindow, CacheEntry>()

// ---------------------------------------------------------------------------
// SQL：db 内完成聚合，只回传模型级行（≤ 数十行）
// V2 表结构：session_message（非 message）；assistant 走 type 列（非 $.role）；
//   模型取 $.model.id（V2 无顶层 $.modelID）；time_created 毫秒
// 过滤口径（对齐 cc-switch）：assistant + 已完成（time.completed 存在）+ 非全零
// ---------------------------------------------------------------------------

const AGG_SQL = `
  SELECT
    COALESCE(json_extract(data, '$.model.id'), 'unknown') AS model,
    COUNT(*) AS requests,
    SUM(COALESCE(json_extract(data, '$.tokens.input'), 0))     AS tin,
    SUM(COALESCE(json_extract(data, '$.tokens.output'), 0))    AS tout,
    SUM(COALESCE(json_extract(data, '$.tokens.reasoning'), 0)) AS treason,
    SUM(COALESCE(json_extract(data, '$.tokens.cache.read'), 0))  AS cread,
    SUM(COALESCE(json_extract(data, '$.tokens.cache.write'), 0)) AS cwrite
  FROM session_message
  WHERE time_created > ?
    AND type = 'assistant'
    AND json_extract(data, '$.time.completed') IS NOT NULL
    AND ( COALESCE(json_extract(data, '$.tokens.input'), 0)
        + COALESCE(json_extract(data, '$.tokens.output'), 0)
        + COALESCE(json_extract(data, '$.tokens.reasoning'), 0)
        + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
        + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) ) > 0
  GROUP BY model`

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function buildStats(win: UsageWindow, sinceMs: number, raw: unknown[]): UsageStats {
  const rows: UsageModelRow[] = raw.map((r) => {
    const o = r as Record<string, unknown>
    const input = num(o.tin)
    const output = num(o.tout) + num(o.treason)
    const read = num(o.cread)
    const write = num(o.cwrite)
    return {
      model: typeof o.model === "string" ? o.model : "unknown",
      requests: num(o.requests),
      input,
      output,
      read,
      write,
      total: input + output + read + write,
    }
  })
  rows.sort((a, b) => b.total - a.total || b.requests - a.requests)

  const totals: UsageTotals = { tokens: 0, input: 0, output: 0, read: 0, write: 0, requests: 0, models: rows.length }
  for (const r of rows) {
    totals.tokens += r.total
    totals.input += r.input
    totals.output += r.output
    totals.read += r.read
    totals.write += r.write
    totals.requests += r.requests
  }
  const denom = totals.input + totals.read + totals.write
  return {
    status: rows.length > 0 ? "ok" : "empty",
    window: win,
    sinceMs,
    rows,
    totals,
    hitRate: denom > 0 ? (totals.read / denom) * 100 : 0,
  }
}

function errorStats(win: UsageWindow, sinceMs: number, status: UsageStatus, error: string, dbPath?: string): UsageStats {
  return {
    status,
    window: win,
    sinceMs,
    rows: [],
    totals: { tokens: 0, input: 0, output: 0, read: 0, write: 0, requests: 0, models: 0 },
    hitRate: 0,
    error,
    dbPath,
  }
}

/**
 * 查询指定窗口用量（带 mtime 缓存；任何失败返回错误态，不抛异常）。
 * 性能：未变更数据直接回缓存；变更时单条 GROUP BY（实测 3 万条 ~91ms）。
 */
export function collectUsageStats(win: UsageWindow, opts?: { dbPath?: string }): UsageStats {
  const dbPath = resolveDbPath(opts?.dbPath)

  if (!existsSync(dbPath)) {
    return errorStats(win, windowSinceMs(win), "db-missing", "未找到 opencode.db", dbPath)
  }
  if (!resolveEngine()) {
    return errorStats(win, windowSinceMs(win), "engine-missing", "当前运行时不支持 SQLite")
  }

  const sinceMs = windowSinceMs(win)
  const key = `${dbPath}:${dataFingerprint(dbPath)}:${sinceMs}`
  const hit = cache.get(win)
  if (hit && hit.key === key) return hit.stats

  // 查询失败丢弃连接重试一次（自愈：坏连接/旧句柄不sticky）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const db = getConnection(dbPath)
      const raw = db.prepare(AGG_SQL).all(sinceMs)
      const stats = buildStats(win, sinceMs, raw)
      cache.set(win, { key, stats })
      return stats
    } catch (e) {
      dropConnection()
      if (attempt === 1) {
        const msg = e instanceof Error ? e.message : String(e)
        return errorStats(win, sinceMs, "query-error", msg, dbPath)
      }
    }
  }
  return errorStats(win, sinceMs, "query-error", "unreachable", dbPath)
}

/** token 缩写（fmtTokens 扩展 G 档：30 天窗口总量常超 1B） */
export function fmtUsageTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "G"
  return fmtTokens(n)
}
