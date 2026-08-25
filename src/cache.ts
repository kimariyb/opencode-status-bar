// ---------------------------------------------------------------------------
// 缓存命中率统计（移植自 opencode-visual-cache，精简为面板所需最小集）
// 口径：hitRate = cacheRead / (input + cacheRead + cacheWrite)（业界总命中率，
// 分母含缓存写）。数据优先取 Session 聚合字段（数据库级，不受 sync 层截断），
// 旧版 SDK 无聚合字段时降级为 assistant 消息遍历累加。
// ---------------------------------------------------------------------------

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export interface CacheStats {
  hitRate: number // 0-100
  input: number
  read: number
  write: number
  output: number
  saved: number // 货币节省估算（依赖模型定价，取不到为 0）
  hasData: boolean
}

const EMPTY: CacheStats = { hitRate: 0, input: 0, read: 0, write: 0, output: 0, saved: 0, hasData: false }

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export function collectCacheStats(api: TuiPluginApi, sessionID?: string): CacheStats {
  if (!sessionID) return EMPTY
  try {
    const session = api.state.session.get(sessionID) as
      | { tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }; cost?: number; model?: { providerID?: string; id?: string } }
      | undefined

    let input = num(session?.tokens?.input)
    let read = num(session?.tokens?.cache?.read)
    let write = num(session?.tokens?.cache?.write)
    let output = num(session?.tokens?.output)
    const fallback = session?.tokens == null

    if (fallback) {
      input = read = write = output = 0
      const msgs = api.state.session.messages(sessionID) as unknown as Array<{
        role?: string
        tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
      }>
      for (const msg of msgs ?? []) {
        if (msg?.role !== "assistant") continue
        const t = msg.tokens
        if (!t) continue
        input += num(t.input)
        read += num(t.cache?.read)
        write += num(t.cache?.write)
        output += num(t.output)
      }
    }

    const total = input + read + write
    const hasData = total > 0 || output > 0
    if (!hasData) return EMPTY

    // 节省估算：read * (input 单价 - cacheRead 单价) / 1M（取不到定价则为 0）
    let saved = 0
    const pid = session?.model?.providerID
    const mid = session?.model?.id
    if (read > 0 && pid && mid) {
      for (const provider of api.state.provider as unknown as Array<{
        id?: string
        models?: Record<string, { cost?: { input?: number; cache?: { read?: number } } }>
      }>) {
        if (provider?.id !== pid) continue
        const model = provider.models?.[mid]
        const inRate = num(model?.cost?.input)
        const crRate = num(model?.cost?.cache?.read)
        if (inRate > crRate) saved = (read * (inRate - crRate)) / 1_000_000
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
    }
  } catch {
    return EMPTY
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(Math.round(n))
}
