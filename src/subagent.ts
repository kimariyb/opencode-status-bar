// ---------------------------------------------------------------------------
// 子代理调用监控（移植自 opencode-subagent-magazine，精简为面板所需最小集）
// 检测：subtask part（原生子任务）+ task/delegate 类 ToolPart（进入执行态才建档）
// child sessionID 取自 ToolStateCompleted.metadata（ToolPart.sessionID 是父会话）
// 状态机：running →（子会话 idle → done）/（子会话 error → error）
// ---------------------------------------------------------------------------

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export type SubStatus = "running" | "done" | "error"

export interface SubEntry {
  id: string
  agent: string
  title: string
  status: SubStatus
  sessionId?: string
  tokens?: number
  startedAt: number
  endedAt?: number
}

/** 会派生子代理的内置工具名（与 magazine 同源） */
const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function readChildTokens(api: TuiPluginApi, sid?: string): number | undefined {
  if (!sid) return undefined
  try {
    const s = api.state.session.get(sid) as { tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } } } | undefined
    const t = s?.tokens
    if (!t) return undefined
    const total = (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    return total > 0 ? total : undefined
  } catch {
    return undefined
  }
}

export interface SubagentTracker {
  /** 当前面条目快照（按启动时间倒序） */
  entries: () => SubEntry[]
  /** 条目变化订阅（面板据此触发重渲），返回退订函数 */
  onChange: (fn: () => void) => () => void
  dispose: () => void
}

export function createSubagentTracker(api: TuiPluginApi): SubagentTracker {
  const entries = new Map<string, SubEntry>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())

  function upsert(e: Partial<SubEntry> & { id: string }) {
    const prev = entries.get(e.id)
    entries.set(e.id, {
      id: e.id,
      agent: e.agent ?? prev?.agent ?? "?",
      title: e.title ?? prev?.title ?? "",
      status: e.status ?? prev?.status ?? "running",
      sessionId: e.sessionId ?? prev?.sessionId,
      tokens: e.tokens ?? prev?.tokens,
      startedAt: prev?.startedAt ?? Date.now(),
      endedAt: e.endedAt ?? (e.status && e.status !== "running" ? Date.now() : prev?.endedAt),
    })
    notify()
  }

  function onPart(props: Record<string, unknown> | undefined) {
    const part = props?.part as Record<string, unknown> | undefined
    if (!part) return

    // SubtaskPart（原生子任务派发）
    if (part.type === "subtask") {
      const id = `sub:${String(part.id ?? "")}`
      if (!part.id) return
      upsert({
        id,
        agent: String(part.agent ?? "?"),
        title: truncate(String(part.description || part.prompt || "").replace(/\s+/g, " "), 40),
        sessionId: part.sessionID !== undefined ? String(part.sessionID) : undefined,
        status: "running",
      })
      return
    }

    // ToolPart（task / delegate / call_omo_agent）
    if (part.type === "tool") {
      const tool = String(part.tool ?? "")
      if (!SUBAGENT_TOOLS.has(tool)) return
      const st = part.state as Record<string, unknown> | undefined
      const rawStatus = String(st?.status ?? "")
      if (rawStatus === "pending" || rawStatus === "") return

      const id = `tool:${String(part.id ?? "")}`
      if (rawStatus === "error") {
        // 工具调用失败：只更新已存在的条目（此前 running），不新建
        if (part.id && entries.has(id)) upsert({ id, status: "error" })
        return
      }

      let status: SubStatus = rawStatus === "completed" ? "done" : "running"
      const input = st?.input as Record<string, unknown> | undefined
      // 后台任务：工具完成 ≠ 代理完成——metadata 确认有子会话则保持 running
      if (status === "done" && (input?.run_in_background === true || input?.background === true)) {
        const meta = st?.metadata as Record<string, unknown> | undefined
        if (meta?.session_id !== undefined || meta?.sessionId !== undefined) status = "running"
      }

      const agent = String((part as Record<string, unknown>).subagent_type ?? input?.subagent_type ?? input?.category ?? tool)
      const prompt = String(input?.prompt ?? (part as Record<string, unknown>).description ?? "")
      const desc = input?.description !== undefined ? String(input.description) : ""
      const title = truncate((desc || prompt).replace(/\s+/g, " "), 40)

      const meta = st?.metadata as Record<string, unknown> | undefined
      const subSid = meta?.session_id !== undefined ? String(meta.session_id)
        : meta?.sessionId !== undefined ? String(meta.sessionId)
        : undefined

      upsert({ id, agent, title, sessionId: subSid, status })
    }
  }

  // 子会话 idle/error → 回填终态与 token 统计
  function onSessionEnd(sid: string, status: SubStatus) {
    let touched = false
    for (const e of entries.values()) {
      if (e.sessionId === sid && e.status === "running") {
        upsert({ id: e.id, status, tokens: readChildTokens(api, sid), endedAt: Date.now() })
        touched = true
      }
    }
    if (touched) notify()
  }

  const offPart = api.event.on("message.part.updated", (e: { properties?: { part?: Record<string, unknown> } }) => {
    onPart(e.properties as Record<string, unknown> | undefined)
  })
  const offIdle = api.event.on("session.idle", (e: { properties?: { sessionID?: string } }) => {
    const sid = String(e.properties?.sessionID ?? "")
    if (sid) onSessionEnd(sid, "done")
  })
  const offErr = api.event.on("session.error", (e: { properties?: { sessionID?: string } }) => {
    const sid = String(e.properties?.sessionID ?? "")
    if (sid) onSessionEnd(sid, "error")
  })

  return {
    entries: () => Array.from(entries.values()).sort((a, b) => b.startedAt - a.startedAt),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    dispose: () => { offPart(); offIdle(); offErr(); listeners.clear() },
  }
}
