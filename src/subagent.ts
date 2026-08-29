// ---------------------------------------------------------------------------
// 子代理调用监控（移植自 opencode-subagent-magazine，含三层兜底修复版）
// 主检测：message.part.updated 中 subtask part + task/delegate 类 ToolPart
// 兜底①scan+merge：插件加载/会话切换时从消息 parts 重建条目（事件错过不丢数据）
// 兜底②500ms 轮询：running 条目的 tokens/model/todo 实时刷新 + reconcile 自愈
// 兜底③僵尸回收：无 sessionId / 子会话已不存在的 running 超 30min 强制终态
// ── 持久化（跨视图切换 / 组件重建 / 重启存活）──
// 层1 globalEntryCache：模块级内存缓存，按所属会话分桶，组件卸载不清
// 层2 KV（api.kv）：磁盘持久化，Record<sid, { ts, entries }>
//   · 事件驱动变更才落盘：running→终态迁移立即 flush，常规变更 200ms debounce
//   · scan 重建不落盘（启发式状态不持久化，重启后重新评估）
//   · TTL 默认 3 天（config subagent.ttlDays，0 = 永久），会话访问自动续期
// 事件路由：按 part.sessionID 精确归属到派生会话的桶（后台任务跨视图更新）
// child sessionID 取自 ToolState.metadata（ToolPart.sessionID 是父会话）
// 状态机：running →（子会话 idle → done）/（子会话 error → error）
// debug 埋点：/tmp/opencode-status-bar-debug.log（[subagent] 前缀）
// ---------------------------------------------------------------------------

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { untrack } from "solid-js"
import { appendFileSync } from "node:fs"

export type SubStatus = "running" | "done" | "error"

export interface SubEntry {
  id: string
  agent: string
  title: string
  prompt?: string // 完整 prompt（渲染时截断，详情展开用）
  status: SubStatus
  sessionId?: string
  tokens?: number
  tokensIn?: number
  tokensOut?: number
  startedAt: number
  endedAt?: number
  model?: string
  todoDone?: number
  todoTotal?: number
}

/** 会派生子代理的内置工具名（与 magazine 同源） */
const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])

// ── 层1 模块级缓存：跨 tracker 实例（组件卸载/重建）存活，按所属会话分桶 ──
// 注意：不属于任何 tracker 实例，dispose 不清除
const globalEntryCache = new Map<string, Map<string, SubEntry>>()

// ── 层2 KV 持久化（key 与 index.tsx 的 KV_PREFIX 保持一致）──
const KV_SESSION_KEY = "status_bar.subagent.sessions"

interface SessionRecord {
  ts: number // 最后访问时间（TTL 续期依据）
  entries: SubEntry[]
}

const DEBUG_LOG = "/tmp/opencode-status-bar-debug.log"

function dbg(msg: string): void {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [subagent] ${msg}\n`)
  } catch {}
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

interface MsgTokens {
  input?: number
  output?: number
  cache?: { read?: number; write?: number }
}

/** 子会话 token 明细（总量 + in/out 拆分，供详情展示） */
function readChildTokenDetail(
  api: TuiPluginApi,
  sid?: string,
): { total: number; input: number; output: number } | undefined {
  if (!sid) return undefined
  try {
    const t = (api.state.session.get(sid) as { tokens?: MsgTokens } | undefined)?.tokens
    if (!t) return undefined
    const input = t.input ?? 0
    const output = t.output ?? 0
    const total = input + output + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    return total > 0 ? { total, input, output } : undefined
  } catch {
    return undefined
  }
}

function readChildTokens(api: TuiPluginApi, sid?: string): number | undefined {
  return readChildTokenDetail(api, sid)?.total
}

function readChildModel(api: TuiPluginApi, sid?: string): string | undefined {
  if (!sid) return undefined
  try {
    const msgs = api.state.session.messages(sid) as unknown as Array<{ role?: string; modelID?: string }>
    for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.role !== "assistant") continue
      return m.modelID ? String(m.modelID) : undefined
    }
  } catch {}
  return undefined
}

function readChildTodo(api: TuiPluginApi, sid?: string): { done: number; total: number } | undefined {
  if (!sid) return undefined
  try {
    const todos = api.state.session.todo(sid) as unknown as Array<{ status?: string }> | undefined
    if (!todos || todos.length === 0) return undefined
    return { done: todos.filter((t) => t.status === "completed").length, total: todos.length }
  } catch {
    return undefined
  }
}

/** 子会话是否已结束（reconcile 兜底依据） */
function isSessionIdle(api: TuiPluginApi, sid: string): boolean {
  try {
    return String((api.state.session.status(sid) as { type?: string } | undefined)?.type ?? "") === "idle"
  } catch {
    return false
  }
}

/** 会话是否可查（KV 恢复条目的子会话可能已不存在，如重启/跨项目） */
function sessionExists(api: TuiPluginApi, sid: string): boolean {
  try {
    return api.state.session.get(sid) !== undefined
  } catch {
    return false
  }
}

/** 会话的 agent 名（settle 兜底匹配依据） */
function sessionAgentOf(api: TuiPluginApi, sid: string): string | undefined {
  try {
    return (api.state.session.get(sid) as { agent?: string } | undefined)?.agent
  } catch {
    return undefined
  }
}

/** 会话的父会话 ID（跨视图路由依据：子代理事件归属到派生它的会话） */
function parentOf(api: TuiPluginApi, sid: string): string | undefined {
  try {
    return (api.state.session.get(sid) as { parentID?: string } | undefined)?.parentID
  } catch {
    return undefined
  }
}

export interface SubagentTracker {
  /** 当前面条目快照（running 优先，其余按启动时间倒序） */
  entries: () => SubEntry[]
  /**
   * 从指定会话的消息历史重建条目（事件错过兜底；初始/切会话时调用）。
   * forcePreload：强制重新预载持久化条目（重启后 kv/state ready 时重跑用——
   * 此时 sessionID 未变，默认「会话切换才预载」的条件不会触发，KV 数据进不来）
   */
  scan: (sessionID?: string, opts?: { forcePreload?: boolean }) => void
  /** 条目变化订阅（面板据此触发重渲），返回退订函数 */
  onChange: (fn: () => void) => () => void
  dispose: () => void
}

export function createSubagentTracker(api: TuiPluginApi, opts?: { ttlDays?: number }): SubagentTracker {
  const ttlDays = opts?.ttlDays ?? 3
  const TTL_MS = ttlDays > 0 ? ttlDays * 24 * 60 * 60_000 : 0
  dbg(`tracker created (kv.ready=${String((api.kv as { ready?: boolean })?.ready)} state.ready=${String((api.state as { ready?: boolean })?.ready)})`)

  // 当前视图的桶及其归属会话；切换会话时整体换引用（各会话状态独立，不互相污染）
  let currentSid: string | undefined
  let entries = new Map<string, SubEntry>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())

  // ── 层2 KV 持久化 ──
  const loadAll = (): Record<string, SessionRecord> => {
    try {
      const parsed = JSON.parse(String(api.kv.get(KV_SESSION_KEY, "{}")))
      return parsed && typeof parsed === "object" ? (parsed as Record<string, SessionRecord>) : {}
    } catch {
      return {}
    }
  }
  const saveAll = (data: Record<string, SessionRecord>): void => {
    try {
      api.kv.set(KV_SESSION_KEY, JSON.stringify(data))
    } catch {}
  }
  const loadFromKV = (sid: string): Map<string, SubEntry> => {
    const m = new Map<string, SubEntry>()
    const rec = sid ? loadAll()[sid] : undefined
    if (rec?.entries) for (const e of rec.entries) if (e?.id) m.set(e.id, e)
    return m
  }

  // ── bootstrap：无归属会话时预载「KV 中最近访问」的会话桶 ──
  // 覆盖重启/热重载后停留在 home 视图的场景：此时路由无 sessionID，
  // scan(undefined) 恒空操作，面板将无数据——以最近会话兜底展示（与切走会话后的行为一致）
  function bootstrapLatest(): boolean {
    if (currentSid) return false
    try {
      const latest = Object.entries(loadAll())
        .filter(([, r]) => (r?.entries?.length ?? 0) > 0)
        .sort((a, b) => (b[1].ts ?? 0) - (a[1].ts ?? 0))[0]
      if (!latest) return false
      currentSid = latest[0]
      entries = new Map(latest[1].entries.filter((e) => e?.id).map((e) => [e.id as string, e]))
      notify()
      dbg(`bootstrap: preload latest sid=${currentSid.slice(-8)} entries=${entries.size}`)
      return true
    } catch {
      return false
    }
  }

  // TTL 清理（tracker 创建时执行一次；0 = 永久跳过）
  if (TTL_MS > 0) {
    try {
      const data = loadAll()
      const cutoff = Date.now() - TTL_MS
      let changed = false
      for (const sid of Object.keys(data)) {
        if ((data[sid]?.ts ?? 0) < cutoff) {
          delete data[sid]
          changed = true
        }
      }
      if (changed) saveAll(data)
    } catch {}
  }
  // kv 已就绪（热重载场景）时立即预载最近会话；未就绪（重启）由兜底④自愈补做
  bootstrapLatest()

  let persistTimer: ReturnType<typeof setTimeout> | undefined
  const flushSid = (sid: string, list: Map<string, SubEntry>): void => {
    if (!sid) return
    try {
      const data = loadAll()
      data[sid] = { ts: Date.now(), entries: [...list.values()] }
      saveAll(data)
    } catch {}
  }
  const scheduleFlush = (): void => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      if (currentSid) flushSid(currentSid, entries)
    }, 200)
  }

  // ── 条目合并（当前视图 upsert 与跨桶更新共用）──
  const mergeEntry = (prev: SubEntry | undefined, e: Partial<SubEntry> & { id: string }): SubEntry => ({
    id: e.id,
    agent: e.agent ?? prev?.agent ?? "?",
    title: e.title ?? prev?.title ?? "",
    prompt: e.prompt ?? prev?.prompt,
    status: e.status ?? prev?.status ?? "running",
    sessionId: e.sessionId ?? prev?.sessionId,
    tokens: e.tokens ?? prev?.tokens,
    tokensIn: e.tokensIn ?? prev?.tokensIn,
    tokensOut: e.tokensOut ?? prev?.tokensOut,
    // startedAt 首建打点后永不覆盖 → KV 恢复后时间排序保真
    startedAt: prev?.startedAt ?? Date.now(),
    // 终态时间戳：仅「状态首次迁移到终态」时打点，重复 upsert 相同状态保留原值（防 scan 刷新虚增速时）
    endedAt:
      e.endedAt ??
      (e.status && e.status !== "running"
        ? prev?.status === e.status
          ? prev?.endedAt
          : Date.now()
        : prev?.endedAt),
    model: e.model ?? prev?.model,
    todoDone: e.todoDone ?? prev?.todoDone,
    todoTotal: e.todoTotal ?? prev?.todoTotal,
  })

  /** upsert 到当前视图桶；persist=false 用于 scan 重建（启发式状态不落盘） */
  function upsert(e: Partial<SubEntry> & { id: string }, pOpts?: { persist?: boolean }): void {
    const prev = entries.get(e.id)
    const next = mergeEntry(prev, e)
    entries.set(e.id, next)
    if (!currentSid) {
      notify() // 归属会话未定（mount 前的早期事件）：仅进内存，待首次 scan 归位
      return
    }
    globalEntryCache.set(currentSid, new Map(entries))
    if (pOpts?.persist !== false) {
      // running→终态迁移立即落盘（防 debounce 间隙丢终态）；常规变更 200ms debounce
      if (prev?.status === "running" && next.status !== "running") {
        clearTimeout(persistTimer)
        flushSid(currentSid, entries)
      } else {
        scheduleFlush()
      }
    }
    notify()
  }

  /** 跨桶更新：后台会话的事件路由到其所属会话的桶（cache ?? KV），更新后写回并落盘 */
  const upsertRouted = (ownerSid: string, e: Partial<SubEntry> & { id: string }): void => {
    if (!ownerSid || ownerSid === currentSid) {
      upsert(e)
      return
    }
    const bucket = globalEntryCache.get(ownerSid) ?? loadFromKV(ownerSid)
    bucket.set(e.id, mergeEntry(bucket.get(e.id), e))
    globalEntryCache.set(ownerSid, bucket)
    flushSid(ownerSid, bucket)
  }

  // ── part 解析（事件与 scan 共用）──
  // ownerSid：part 所属会话（事件取 part.sessionID 精确路由；scan 为扫描目标会话）
  // 返回值：是否为子代理相关 part（供 scan 统计）
  function parsePart(part: Record<string, unknown>, opts: { source: "event" | "scan"; ownerSid: string }): boolean {
    const routed = Boolean(opts.ownerSid) && opts.ownerSid !== currentSid
    const persist = opts.source === "event" // scan 重建不落盘：启发式状态不持久化，重启后重新评估
    // 路由目标桶：非当前视图时从 cache ?? KV 取（后台会话的桶）
    const bucket = routed ? (globalEntryCache.get(opts.ownerSid) ?? loadFromKV(opts.ownerSid)) : entries
    const put = (e: Partial<SubEntry> & { id: string }): void => {
      if (routed) upsertRouted(opts.ownerSid, e)
      else upsert(e, { persist })
    }

    // SubtaskPart（原生子任务派发，只在 spawn 时出现 → 无条件建 running）
    if (part.type === "subtask") {
      if (!part.id) return true
      const id = `sub:${String(part.id)}`
      // 终态保护：scan 重放历史 / 迟到事件不得把 done/error 条目拉回 running
      const prevSub = bucket.get(id)
      if (prevSub && prevSub.status !== "running") return true
      const prompt = oneLine(String(part.prompt ?? ""))
      put({
        id,
        agent: String(part.agent ?? "?"),
        title: truncate(String(part.description || prompt), 40),
        prompt: prompt || undefined,
        sessionId: part.sessionID !== undefined ? String(part.sessionID) : undefined,
        status: "running",
        model: (part.model as { modelID?: string } | undefined)?.modelID
          ? String((part.model as { modelID?: string }).modelID)
          : undefined,
      })
      dbg(`part[${opts.source}] type=subtask id=${String(part.id).slice(-12)} agent=${String(part.agent ?? "?")} action=upsert routed=${routed}`)
      return true
    }

    // ToolPart（task / delegate / call_omo_agent）
    if (part.type !== "tool") return false
    const tool = String(part.tool ?? "")
    if (!SUBAGENT_TOOLS.has(tool)) return false

    const st = part.state as Record<string, unknown> | undefined
    const rawStatus = String(st?.status ?? "")
    const input = st?.input as Record<string, unknown> | undefined
    const meta = st?.metadata as Record<string, unknown> | undefined
    // child sessionID：state-level metadata 注入（running 态即可出现）
    const subSid =
      meta?.session_id !== undefined ? String(meta.session_id)
        : meta?.sessionId !== undefined ? String(meta.sessionId)
        : undefined
    const id = `tool:${String(part.id ?? "")}`
    dbg(`part[${opts.source}] type=tool tool=${tool} status=${rawStatus || "(empty)"} id=${String(part.id ?? "").slice(-12)} sid=${subSid ? subSid.slice(-8) : "-"} routed=${routed}`)

    // pending/空：状态未知。事件流等待下一次 update；scan 时仅做超时收敛
    // （不做消息级 token 启发式：一条 assistant 消息含多个 parts，消息有消耗不代表该 task 已完成，
    //   活跃任务会被误判；漏事件的终态收敛由轮询 reconcile 覆盖）
    if (rawStatus === "pending" || rawStatus === "") {
      if (opts.source !== "scan") return true
      const existing = bucket.get(id)
      if (existing?.status === "running" && Date.now() - existing.startedAt > STALE_MS) {
        put({ id, status: "done", endedAt: Date.now() })
        dbg(`scan heuristic: ${id.slice(-16)} pending stale >${STALE_MS / 60_000}min → done`)
      }
      return true
    }

    // error：工具调用失败（子代理未派生）。只更新已存在条目，绝不新建
    if (rawStatus === "error") {
      if (!part.id) return true
      if (bucket.has(id)) put({ id, status: "error" })
      return true
    }

    let status: SubStatus = rawStatus === "completed" ? "done" : "running"
    // 后台任务：工具完成 ≠ 代理完成——metadata 确认有子会话则保持 running
    if (status === "done" && (input?.run_in_background === true || input?.background === true)) {
      if (meta?.session_id !== undefined || meta?.sessionId !== undefined) status = "running"
    }

    const agent = String((part as Record<string, unknown>).subagent_type ?? input?.subagent_type ?? input?.category ?? tool)
    const prompt = String(input?.prompt ?? (part as Record<string, unknown>).description ?? "")
    const desc = input?.description !== undefined ? String(input.description) : ""
    const title = truncate(desc || oneLine(prompt), 40)
    const model = (meta as Record<string, unknown> | undefined)?.model as { modelID?: string } | undefined
      ? String(((meta as Record<string, unknown>).model as { modelID?: string }).modelID)
      : undefined

    put({
      id,
      agent,
      title,
      prompt: oneLine(prompt) || undefined,
      sessionId: subSid,
      status,
      model,
      tokens: status === "running" ? readChildTokens(api, subSid) : undefined,
    })
    return true
  }

  // ── 兜底① scan+merge：遍历会话消息 parts 重建条目 ──
  // untrack：隔离对 api.state.* 的读取，确保外层 createEffect 只依赖 sessionID
  // 会话切换时先预载该会话的持久化条目（cache 优先，KV 兜底），startedAt/终态保真
  function scan(sessionID?: string, opts?: { forcePreload?: boolean }): void {
    if (!sessionID) return
    untrack(() => {
      if (opts?.forcePreload || sessionID !== currentSid) {
        currentSid = sessionID
        if (opts?.forcePreload) {
          // ready 重扫：KV 为权威历史源；cache 可能只是窗口期事件写入的残缺桶
          // （早期 scan 在 kv ready 前执行时，upsert 会把空桶提升进 cache），
          // 故按 id 合并、cache 条目优先（保留更新的运行时状态），防止 KV 历史被残缺 cache 遮蔽
          const merged = new Map(loadFromKV(sessionID))
          for (const [id, e] of globalEntryCache.get(sessionID) ?? []) merged.set(id, e)
          entries = merged
        } else {
          entries = new Map(globalEntryCache.get(sessionID) ?? loadFromKV(sessionID))
        }
        // TTL 续期：有历史条目时刷新该会话访问时间
        try {
          const data = loadAll()
          if (data[sessionID]?.entries?.length) {
            data[sessionID].ts = Date.now()
            saveAll(data)
          }
        } catch {}
        notify()
        dbg(`switch sid=${sessionID.slice(-8)} force=${opts?.forcePreload ?? false} preload entries=${entries.size}`)
      }
      try {
        const msgs = api.state.session.messages(sessionID) as unknown as Array<{ id?: string }>
        let found = 0
        for (const msg of msgs ?? []) {
          if (!msg?.id) continue
          let parts: Array<Record<string, unknown>> | undefined
          try {
            parts = api.state.part(String(msg.id)) as unknown as Array<Record<string, unknown>>
          } catch {
            continue
          }
          for (const part of parts ?? []) {
            if (parsePart(part, { source: "scan", ownerSid: sessionID })) found++
          }
        }
        dbg(`scan sid=${sessionID.slice(-8)} messages=${msgs?.length ?? 0} subParts=${found} entries=${entries.size}`)
      } catch (e) {
        dbg(`scan error sid=${sessionID.slice(-8)}: ${e}`)
      }
    })
  }

  // ── 子会话 idle/error → 回填终态（延迟 150ms 等 state sync 追平再取最终 tokens）──
  // settle 匹配（magazine 同源策略）：精确 sessionId 优先；
  // 未关联时按 agent 名归一化互含兜底，再退到「无 sessionId 的最老 running」
  function pickSettleTargets(list: Map<string, SubEntry>, targetSid: string): SubEntry[] {
    const exact = [...list.values()].filter((e) => e.sessionId === targetSid && e.status === "running")
    if (exact.length > 0) return exact
    const sAgent = sessionAgentOf(api, targetSid)
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "")
    let best: SubEntry | undefined
    if (sAgent) {
      const sn = norm(sAgent)
      for (const e of list.values()) {
        if (e.status !== "running") continue
        const en = norm(e.agent)
        if (!en || !sn) continue
        if (!en.includes(sn) && !sn.includes(en)) continue
        if (!best || e.startedAt < best.startedAt) best = e
      }
    }
    if (!best) {
      for (const e of list.values()) {
        if (e.status !== "running" || e.sessionId) continue
        if (!best || e.startedAt < best.startedAt) best = e
      }
    }
    return best ? [best] : []
  }

  function onSessionEnd(sid: string, status: SubStatus): void {
    setTimeout(() => {
      const settleOne = (e: SubEntry): Partial<SubEntry> & { id: string } => {
        const todo = readChildTodo(api, sid)
        const detail = readChildTokenDetail(api, sid)
        return {
          id: e.id,
          status,
          sessionId: sid,
          tokens: detail?.total,
          tokensIn: detail?.input,
          tokensOut: detail?.output,
          model: e.model ?? readChildModel(api, sid),
          todoDone: todo?.done,
          todoTotal: todo?.total,
          endedAt: Date.now(),
        }
      }

      // A. 当前视图桶：精确匹配 + agent 名兜底
      const targets = pickSettleTargets(entries, sid)
      for (const t of targets) {
        upsert(settleOne(t))
        dbg(`sessionEnd ${status} sid=${sid.slice(-8)} matched=${t.id} bucket=current`)
      }
      if (targets.length > 0) notify()

      // B. 跨视图：子代理派生自其他会话（后台任务）时，在其所属桶内同样收敛并落盘
      const ownerSid = parentOf(api, sid)
      if (ownerSid && ownerSid !== currentSid) {
        try {
          const bucket = globalEntryCache.get(ownerSid) ?? loadFromKV(ownerSid)
          const cross = pickSettleTargets(bucket, sid)
          for (const t of cross) bucket.set(t.id, mergeEntry(t, settleOne(t)))
          if (cross.length > 0) {
            globalEntryCache.set(ownerSid, bucket)
            flushSid(ownerSid, bucket)
            dbg(`sessionEnd ${status} sid=${sid.slice(-8)} cross-owner=${ownerSid.slice(-8)} n=${cross.length}`)
          }
        } catch {}
      }
    }, 150)
  }

  // ── 兜底② 轮询：running 条目实时刷新 + reconcile 自愈 + ③僵尸回收 ──
  const POLL_MS = 500
  const STALE_MS = 30 * 60_000
  // ── 兜底④ 启动自愈（前 30s，每 2s 一次）：重启/热重载时序竞态下 effect 可能漏扫
  // （实证：插件热重载风暴后新实例无 scan，内存空而 KV 有数据，面板 item 消失）——
  // ④a 无归属会话（home 视图期间重建）→ bootstrap 预载最近会话桶；
  // ④b scan 过但预载落空（kv ready 前的窗口期）→ KV 就绪后 force 重预载。30s 后停止
  let healTicks = 0
  const pollTimer = setInterval(() => {
    try {
      if (healTicks < 60 && ++healTicks % 4 === 0) {
        if (!currentSid) {
          bootstrapLatest()
        } else if (entries.size === 0) {
          try {
            if (api.kv.ready && (loadAll()[currentSid]?.entries?.length ?? 0) > 0) {
              dbg(`self-heal: sid=${currentSid.slice(-8)} empty in-memory but KV has data → force preload`)
              scan(currentSid, { forcePreload: true })
            }
          } catch {}
        }
      }
      let changed = false
      for (const e of entries.values()) {
        if (e.status !== "running") continue
        // ③ 僵尸回收：无 sessionId，或子会话已不存在（KV 恢复场景）且超时 → 强制收敛
        // （正常任务 metadata 很快写入；state sync 未就绪时查不到会话，有 30min 保护不会误杀）
        if (!e.sessionId || !sessionExists(api, e.sessionId)) {
          if (Date.now() - e.startedAt > STALE_MS) {
            upsert({ id: e.id, status: "done", endedAt: Date.now() })
            changed = true
            dbg(`stale recycle: ${e.id.slice(-16)} ${e.sessionId ? "session-gone" : "no-sid"} >30min → done`)
          }
          continue
        }
        const sid = e.sessionId
        // reconcile：子会话实际已 idle 但 idle 事件丢失 → 补终态
        if (isSessionIdle(api, sid)) {
          const detail = readChildTokenDetail(api, sid)
          upsert({
            id: e.id,
            status: "done",
            tokens: detail?.total,
            tokensIn: detail?.input,
            tokensOut: detail?.output,
            model: e.model ?? readChildModel(api, sid),
            endedAt: Date.now(),
          })
          changed = true
          dbg(`reconcile: ${e.id.slice(-16)} sid=${sid.slice(-8)} idle → done`)
          continue
        }
        // 数据刷新：tokens / todo / model
        const detail = readChildTokenDetail(api, sid)
        const todo = readChildTodo(api, sid)
        const model = e.model ?? readChildModel(api, sid)
        if (
          (detail !== undefined && detail.total !== e.tokens) ||
          (todo && (todo.done !== e.todoDone || todo.total !== e.todoTotal)) ||
          (model && model !== e.model)
        ) {
          upsert({ id: e.id, tokens: detail?.total, tokensIn: detail?.input, tokensOut: detail?.output, model, todoDone: todo?.done, todoTotal: todo?.total })
          changed = true
        }
      }
      if (changed) notify()
    } catch {}
  }, POLL_MS)

  // 事件路由：part.sessionID = 派生该子代理的会话（Part 类型自带字段，SDK 确认）。
  // 后台任务的事件精确归属到其会话的桶，不污染当前视图；取不到时落当前视图兜底
  const offPart = api.event.on("message.part.updated", (e: { properties?: { part?: Record<string, unknown> } }) => {
    const part = (e.properties as Record<string, unknown> | undefined)?.part as Record<string, unknown> | undefined
    if (!part) return
    const ownerSid = String(part.sessionID ?? currentSid ?? "")
    parsePart(part, { source: "event", ownerSid })
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
    entries: () =>
      Array.from(entries.values()).sort((a, b) => {
        const ar = a.status === "running" ? 1 : 0
        const br = b.status === "running" ? 1 : 0
        if (ar !== br) return br - ar // running 优先
        return b.startedAt - a.startedAt
      }),
    scan,
    onChange: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    dispose: () => {
      // 退出前冲刷未落盘变更；模块级 globalEntryCache 不清除（跨组件重建存活）
      if (currentSid) flushSid(currentSid, entries)
      clearTimeout(persistTimer)
      clearInterval(pollTimer)
      offPart(); offIdle(); offErr()
      listeners.clear()
    },
  }
}
