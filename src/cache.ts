// ---------------------------------------------------------------------------
// 缓存命中率统计（移植自 opencode-visual-cache，弹窗增强版）
// 口径：hitRate = cacheRead / (input + cacheRead + cacheWrite)（业界总命中率，
// 分母含缓存写）。总量优先取 Session 聚合字段（数据库级，不受 sync 层截断），
// 旧版 SDK 无聚合字段时降级为 assistant 消息遍历累加。
// 弹窗指标：会话/单消息双命中率、趋势 delta、步数、成本与模型单价。
// ---------------------------------------------------------------------------

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export interface ModelPricing {
  in: number // $ / Mtok
  read: number
  write: number
}

export interface CacheStats {
  hitRate: number // 会话累计命中率 0-100
  input: number
  read: number
  write: number
  output: number
  saved: number // 货币节省估算（依赖模型定价，取不到为 0）
  hasData: boolean
  // ── 弹窗增强字段（取不到为 undefined）──
  lastHitRate?: number // 最后一条有效消息命中率
  trend?: number // last − prev 命中率差（|Δ|<0.5 视为无趋势，undefined）
  stepCount?: number // assistant 消息数（近似步数）
  lastCost?: number // 最后一条消息成本
  cost?: number // session 聚合总成本
  providerID?: string
  modelID?: string
  pricing?: ModelPricing
}

const EMPTY: CacheStats = { hitRate: 0, input: 0, read: 0, write: 0, output: 0, saved: 0, hasData: false }

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/** 单条命中率；分母含 write（业界口径），分母为 0 返回 undefined */
function hitOf(t: { input?: number; output?: number; cache?: { read?: number; write?: number } }): number | undefined {
  const denom = num(t.input) + num(t.cache?.read) + num(t.cache?.write)
  if (denom <= 0) return undefined
  return (num(t.cache?.read) / denom) * 100
}

export function collectCacheStats(api: TuiPluginApi, sessionID?: string): CacheStats {
  if (!sessionID) return EMPTY
  try {
    const session = api.state.session.get(sessionID) as
      | {
          tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
          cost?: number
          model?: { providerID?: string; id?: string }
        }
      | undefined

    let input = num(session?.tokens?.input)
    let read = num(session?.tokens?.cache?.read)
    let write = num(session?.tokens?.cache?.write)
    let output = num(session?.tokens?.output)
    const fallback = session?.tokens == null

    // 消息遍历：fallback 时累加总量；同时收集单消息指标（last/trend/steps/lastCost）
    let stepCount = 0
    let lastHit: number | undefined
    let prevHit: number | undefined
    let lastCost: number | undefined
    if (fallback) input = read = write = output = 0
    const msgs = api.state.session.messages(sessionID) as unknown as Array<{
      role?: string
      cost?: number
      tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
    }>
    for (const msg of msgs ?? []) {
      if (msg?.role !== "assistant") continue
      stepCount++
      if (typeof msg.cost === "number") lastCost = msg.cost
      const t = msg.tokens
      if (!t) continue
      if (fallback) {
        input += num(t.input)
        read += num(t.cache?.read)
        write += num(t.cache?.write)
        output += num(t.output)
      }
      const hit = hitOf(t)
      if (hit !== undefined) {
        prevHit = lastHit
        lastHit = hit
      }
    }

    const total = input + read + write
    const hasData = total > 0 || output > 0
    if (!hasData) return EMPTY

    // 趋势死区：<0.5pp 视为平稳
    let trend: number | undefined
    if (lastHit !== undefined && prevHit !== undefined) {
      const d = lastHit - prevHit
      trend = Math.abs(d) < 0.5 ? undefined : d
    }

    // 节省估算：read * (input 单价 - cacheRead 单价) / 1M（取不到定价则为 0）
    let saved = 0
    let pricing: ModelPricing | undefined
    const pid = session?.model?.providerID
    const mid = session?.model?.id
    if (pid && mid) {
      for (const provider of api.state.provider as unknown as Array<{
        id?: string
        models?: Record<string, { cost?: { input?: number; cache?: { read?: number; write?: number } } }>
      }>) {
        if (provider?.id !== pid) continue
        const cost = provider.models?.[mid]?.cost
        if (cost) {
          pricing = { in: num(cost.input), read: num(cost.cache?.read), write: num(cost.cache?.write) }
          if (pricing.in > pricing.read && read > 0) {
            saved = (read * (pricing.in - pricing.read)) / 1_000_000
          }
        }
        break
      }
    }

    return {
      hitRate: total > 0 ? (read / total) * 100 : 0,
      input,
      read,
      write,
      output,
      saved,
      hasData: true,
      lastHitRate: lastHit,
      trend,
      stepCount: stepCount > 0 ? stepCount : undefined,
      lastCost,
      cost: num(session?.cost) > 0 ? session!.cost : undefined,
      providerID: pid,
      modelID: mid,
      pricing: pricing && pricing.in > 0 ? pricing : undefined,
    }
  } catch {
    return EMPTY
  }
}

/** 成本分级精度：≥1 → 2 位小数；≥0.01 → 3 位；更小 → 4 位（避免小额抹成 0.00） */
export function fmtCost(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1) return "$" + n.toFixed(2)
  if (abs >= 0.01) return "$" + n.toFixed(3)
  return "$" + n.toFixed(4)
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(Math.round(n))
}
