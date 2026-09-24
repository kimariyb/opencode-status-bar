// ---------------------------------------------------------------------------
// 子代理调用监控（V2 迁移版）
// 数据源：assistant 消息 content[] 中的 tool 项（type=tool 且 name ∈ SUBAGENT_TOOLS）。
//   V2 无 subtask content type，且无 todo 数据源（待办展示已移除）。
// 兜底① scan：会话切换 + 500ms 轮询时从消息 content 重建/刷新条目
//   （tool 项含 id/name/state.{status,input,metadata}，单点完整 → 扫描即权威，
//    故无需 V1 的 message.part.updated / tool.* 事件组合，≤500ms 延迟可接受）
// 兜底② 500ms 轮询：running 条目 tokens/model 实时刷新 + reconcile 自愈 + 僵尸回收
// 兜底③ 30min 僵尸回收：无 sessionId / 子会话已不存在的 running 强制终态
// 持久化：storage.store（V2 磁盘持久化，key 自动前缀 plugin.<id>.）
//   · sameEntry 幂等：无变化不落盘不重渲（scan 每 500ms 跑也无副作用）
//   · running→终态迁移立即 flush，常规变更 200ms debounce
// 事件：session.idle → 子会话 done；session.execution.failed → error
// child sessionID 取自 tool state.metadata（session_id/sessionId），取不到走 30min 回收
// 状态机：running →（子会话 idle → done）/（子会话 error → error）
// debug 埋点：/tmp/opencode-status-bar-debug.log（[subagent] 前缀）
// ---------------------------------------------------------------------------

import type { Plugin } from "@opencode/plugin/tui"
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
}

/** 会派生子代理的内置工具名 */
const SUBAGENT_TOOLS = new Set(["task", "subagent", "delegate", "call_omo_agent"])

// ── 层1 模块级缓存：跨 tracker 实例（组件卸载/重建）存活，按所属会话分桶 ──
// 注意：不属于任何 tracker 实例，dispose 不清除
const globalEntryCache = new Map<string, Map<string, SubEntry>>()

// ── 层2 持久化 key（storage.store 自动前缀 plugin.opencode-status-bar.）──
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
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** 子会话 token 明细（总量 + in/out 拆分；V2 reasoning 归入输出） */
function readChildTokenDetail(
  context: Plugin.Context,
  sid?: string,
): { total: number; input: number; output: number } | undefined {
  if (!sid) return undefined
  try {
    const t = context.data.session.get(sid)?.tokens as MsgTokens | undefined
    if (!t) return undefined
    const input = t.input ?? 0
    const output = (t.output ?? 0) + (t.reasoning ?? 0)
    const total = input + output + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    return total > 0 ? { total, input, output } : undefined
  } catch {
    return undefined
  }
}

function readChildTokens(context: Plugin.Context, sid?: string): number | undefined {
  return readChildTokenDetail(context, sid)?.total
}

/** 子会话最后一条 assistant 消息的模型（V2 取 model.id，无顶层 modelID） */
function readChildModel(context: Plugin.Context, sid?: string): string | undefined {
  if (!sid) return undefined
  try {
    const msgs = context.data.session.message.list(sid) as unknown as Array<{
      type?: string
      model?: { id?: string }
    }>
    for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.type !== "assistant") continue
      return m.model?.id ? String(m.model.id) : undefined
    }
  } catch {}
  return undefined
}

/** 子会话是否已结束（reconcile 兜底依据） */
function isSessionIdle(context: Plugin.Context, sid: string): boolean {
  try {
    return context.data.session.status(sid) === "idle"
  } catch {
    return false
  }
}

/** 会话是否可查（KV 恢复条目的子会话可能已不存在，如重启/跨项目） */
function sessionExists(context: Plugin.Context, sid: string): boolean {
  try {
    return context.data.session.get(sid) !== undefined
  } catch {
    return false
  }
}

/** 会话的 agent 名（settle 兜底匹配依据） */
function sessionAgentOf(context: Plugin.Context, sid: string): string | undefined {
  try {
    return context.data.session.get(sid)?.agent
  } catch {
    return undefined
  }
}

/** 会话的父会话 ID（跨视图路由依据：子代理事件归属到派生它的会话） */
function parentOf(context: Plugin.Context, sid: string): string | undefined {
  try {
    return context.data.session.get(sid)?.parentID
  } catch {
    return undefined
  }
}

export interface SubagentTracker {
  /** 当前面条目快照（running 优先，其余按启动时间倒序） */
  entries: () => SubEntry[]
  /**
   * 从指定会话的消息 content 重建/刷新条目（会话切换与 500ms 轮询时调用）。
   * forcePreload：强制重新预载持久化条目（重启/热重载后 store 水合竞态自愈用）
   */
  scan: (sessionID?: string, opts?: { forcePreload?: boolean }) => void
  /** 条目变化订阅（面板据此触发重渲），返回退订函数 */
  onChange: (fn: () => void) => () => void
  dispose: () => void
}

/** 条目全字段相等判定（scan 幂等：无变化不落盘不重渲） */
function sameEntry(a: SubEntry, b: SubEntry): boolean {
  return (
    a.agent === b.agent && a.title === b.title && a.prompt === b.prompt &&
    a.status === b.status && a.sessionId === b.sessionId &&
    a.tokens === b.tokens && a.tokensIn === b.tokensIn && a.tokensOut === b.tokensOut &&
    a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.model === b.model
  )
}

export function createSubagentTracker(context: Plugin.Context, opts?: { ttlDays?: number }): SubagentTracker {
  const ttlDays = opts?.ttlDays ?? 3
  const TTL_MS = ttlDays > 0 ? ttlDays * 24 * 60 * 60_000 : 0
  dbg("tracker created (v2 storage.store)")

  // 当前视图的桶及其归属会话；切换会话时整体换引用（各会话状态独立，不互相污染）
  let currentSid: string | undefined
  let entries = new Map<string, SubEntry>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())

  // ── 层2 持久化（storage.store；JSON 往返得到纯对象，改动经 mutate 落盘）──
  const [kvStore, mutateKV] = context.storage.store(KV_SESSION_KEY, {
    initial: { sessions: {} as Record<string, SessionRecord> },
  })
  const loadAll = (): Record<string, SessionRecord> => {
    try {
      const v = JSON.parse(JSON.stringify(kvStore.sessions ?? {}))
      return v && typeof v === "object" ? (v as Record<string, SessionRecord>) : {}
    } catch {
      return {}
    }
  }
  const saveAll = (data: Record<string, SessionRecord>): void => {
    try { void mutateKV((d) => { d.sessions = data }) } catch {}
  }
  const loadFromKV = (sid: string): Map<string, SubEntry> => {
    const m = new Map<string, SubEntry>()
    const rec = sid ? loadAll()[sid] : undefined
    if (rec?.entries) for (const e of rec.entries) if (e?.id) m.set(e.id, e)
    return m
  }

  // ── bootstrap：无归属会话时预载「KV 中最近访问」的会话桶 ──
  // 覆盖重启/热重载后停留在 home 视图的场景：此时路由无 sessionID，
  // scan(undefined) 恒空操作，面板将无数据——以最近会话兜底展示
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
    // 终态时间戳：仅「状态首次迁移到终态」时打点，重复 upsert 相同状态保留原值
    endedAt:
      e.endedAt ??
      (e.status && e.status !== "running"
        ? prev?.status === e.status
          ? prev?.endedAt
          : Date.now()
        : prev?.endedAt),
    model: e.model ?? prev?.model,
  })

  /** upsert 到当前视图桶；无变化则跳过（scan 每 500ms 幂等重放） */
  function upsert(e: Partial<SubEntry> & { id: string }): void {
    const prev = entries.get(e.id)
    const next = mergeEntry(prev, e)
    if (prev && sameEntry(prev, next)) return
    entries.set(e.id, next)
    if (!currentSid) {
      notify() // 归属会话未定：仅进内存，待首次 scan 归位
      return
    }
    globalEntryCache.set(currentSid, new Map(entries))
    // running→终态迁移立即落盘（防 debounce 间隙丢终态）；常规变更 200ms debounce
    if (prev?.status === "running" && next.status !== "running") {
      clearTimeout(persistTimer)
      flushSid(currentSid, entries)
    } else {
      scheduleFlush()
    }
    notify()
  }

  // ── tool content item 解析（scan 唯一路径；V2 无 subtask type，无 meta.model）──
  function parseTool(item: Record<string, unknown>): boolean {
    if (item.type !== "tool") return false
    const tool = String(item.name ?? "")
    if (!SUBAGENT_TOOLS.has(tool)) return false

    const st = item.state as Record<string, unknown> | undefined
    const rawStatus = String(st?.status ?? "")
    // streaming 的 input 是字符串（流式 JSON）；running/completed/error 才是对象
    const rawInput = st?.input
    const input = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : undefined
    const meta = st?.metadata as Record<string, unknown> | undefined
    // child sessionID：state metadata（running 态即可出现）
    const subSid =
      meta?.session_id !== undefined ? String(meta.session_id)
        : meta?.sessionId !== undefined ? String(meta.sessionId)
        : undefined
    const id = `tool:${String(item.id ?? "")}`

    // streaming（≈V1 pending）：状态未知。不新建，仅做超时收敛
    if (rawStatus === "streaming" || rawStatus === "") {
      const existing = entries.get(id)
      if (existing?.status === "running" && Date.now() - existing.startedAt > STALE_MS) {
        upsert({ id, status: "done", endedAt: Date.now() })
        dbg(`scan heuristic: ${id.slice(-16)} streaming stale >${STALE_MS / 60_000}min → done`)
      }
      return true
    }

    // error：工具调用失败（子代理未派生）。只更新已存在条目，绝不新建
    if (rawStatus === "error") {
      if (item.id && entries.has(id)) upsert({ id, status: "error" })
      return true
    }

    let status: SubStatus = rawStatus === "completed" ? "done" : "running"
    // 后台任务：工具完成 ≠ 代理完成——metadata 确认有子会话则保持 running
    if (status === "done" && (input?.run_in_background === true || input?.background === true)) {
      if (meta?.session_id !== undefined || meta?.sessionId !== undefined) status = "running"
    }

    // agent 链：input.agent → subagent_type → category → 工具名
    const agent = String(input?.agent ?? input?.subagent_type ?? input?.category ?? tool)
    const prompt = String(input?.prompt ?? "")
    const desc = input?.description !== undefined ? String(input.description) : ""
    const title = truncate(desc || oneLine(prompt), 40)

    upsert({
      id,
      agent,
      title,
      prompt: oneLine(prompt) || undefined,
      sessionId: subSid,
      status,
      // 模型：V2 无 tool metadata.model，靠轮询 readChildModel 补
      tokens: status === "running" ? readChildTokens(context, subSid) : undefined,
    })
    return true
  }

  // ── 兜底① scan：遍历会话消息 content 重建/刷新条目 ──
  // untrack：隔离对 data.* 的读取，确保外层 createEffect 只依赖 sessionID
  function scan(sessionID?: string, opts?: { forcePreload?: boolean }): void {
    if (!sessionID) return
    untrack(() => {
      const isSwitch = Boolean(opts?.forcePreload || sessionID !== currentSid)
      if (isSwitch) {
        currentSid = sessionID
        if (opts?.forcePreload) {
          // store 可能只是窗口期写入的残缺桶：按 id 合并、cache 条目优先，
          // 防止持久化历史被残缺 cache 遮蔽
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
        const msgs = context.data.session.message.list(sessionID) as unknown as Array<{
          type?: string
          content?: Array<Record<string, unknown>>
        }>
        let found = 0
        for (const msg of msgs ?? []) {
          if (msg?.type !== "assistant") continue
          for (const item of msg.content ?? []) {
            if (parseTool(item)) found++
          }
        }
        // 仅切换时打点（轮询每 500ms 会刷屏）
        if (isSwitch) {
          dbg(`scan sid=${sessionID.slice(-8)} assistant=${msgs?.length ?? 0} subItems=${found} entries=${entries.size}`)
        }
      } catch (e) {
        dbg(`scan error sid=${sessionID.slice(-8)}: ${e}`)
      }
    })
  }

  // ── 子会话 idle/error → 回填终态（延迟 150ms 等 data 同步追平再取最终 tokens）──
  // settle 匹配：精确 sessionId 优先；未关联时按 agent 名归一化互含兜底，
  // 再退到「无 sessionId 的最老 running」
  function pickSettleTargets(list: Map<string, SubEntry>, targetSid: string): SubEntry[] {
    const exact = [...list.values()].filter((e) => e.sessionId === targetSid && e.status === "running")
    if (exact.length > 0) return exact
    const sAgent = sessionAgentOf(context, targetSid)
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
        const detail = readChildTokenDetail(context, sid)
        return {
          id: e.id,
          status,
          sessionId: sid,
          tokens: detail?.total,
          tokensIn: detail?.input,
          tokensOut: detail?.output,
          model: e.model ?? readChildModel(context, sid),
          endedAt: Date.now(),
        }
      }

      // A. 当前视图桶：精确匹配 + agent 名兜底
      const targets = pickSettleTargets(entries, sid)
      for (const t of targets) {
        upsert(settleOne(t))
        dbg(`sessionEnd ${status} sid=${sid.slice(-8)} matched=${t.id} bucket=current`)
      }

      // B. 跨视图：子代理派生自其他会话（后台任务）时，在其所属桶内同样收敛并落盘
      const ownerSid = parentOf(context, sid)
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

  // ── 兜底② 轮询：scan 刷新工具状态 + running 条目 tokens/model + reconcile + ③僵尸回收 ──
  const POLL_MS = 500
  const STALE_MS = 30 * 60_000
  // ── 启动自愈（前 30s，每 2s 一次）：store 水合竞态下 effect 可能漏扫/预载落空 ──
  let healTicks = 0
  const pollTimer = setInterval(() => {
    try {
      // scan 刷新：捕获 spawn/进度/完成（sameEntry 幂等，无变化不重渲）
      if (currentSid) scan(currentSid)

      if (healTicks < 60 && ++healTicks % 4 === 0) {
        if (!currentSid) {
          bootstrapLatest()
        } else if (entries.size === 0) {
          try {
            // V2 无 kv.ready：store 水合后即有数据 → force 重预载
            if ((loadAll()[currentSid]?.entries?.length ?? 0) > 0) {
              dbg(`self-heal: sid=${currentSid.slice(-8)} empty in-memory but store has data → force preload`)
              scan(currentSid, { forcePreload: true })
            }
          } catch {}
        }
      }

      for (const e of entries.values()) {
        if (e.status !== "running") continue
        // ③ 僵尸回收：无 sessionId，或子会话已不存在（KV 恢复场景）且超时 → 强制收敛
        if (!e.sessionId || !sessionExists(context, e.sessionId)) {
          if (Date.now() - e.startedAt > STALE_MS) {
            upsert({ id: e.id, status: "done", endedAt: Date.now() })
            dbg(`stale recycle: ${e.id.slice(-16)} ${e.sessionId ? "session-gone" : "no-sid"} >30min → done`)
          }
          continue
        }
        const sid = e.sessionId
        // reconcile：子会话实际已 idle 但 idle 事件丢失 → 补终态
        if (isSessionIdle(context, sid)) {
          const detail = readChildTokenDetail(context, sid)
          upsert({
            id: e.id,
            status: "done",
            tokens: detail?.total,
            tokensIn: detail?.input,
            tokensOut: detail?.output,
            model: e.model ?? readChildModel(context, sid),
            endedAt: Date.now(),
          })
          dbg(`reconcile: ${e.id.slice(-16)} sid=${sid.slice(-8)} idle → done`)
          continue
        }
        // 数据刷新：tokens 拆分 / model（scan 已刷 total，这里补 in/out + model）
        const detail = readChildTokenDetail(context, sid)
        const model = e.model ?? readChildModel(context, sid)
        if (
          (detail !== undefined &&
            (detail.total !== e.tokens || detail.input !== e.tokensIn || detail.output !== e.tokensOut)) ||
          (model !== undefined && model !== e.model)
        ) {
          upsert({ id: e.id, tokens: detail?.total, tokensIn: detail?.input, tokensOut: detail?.output, model })
        }
      }
    } catch {}
  }, POLL_MS)

  // 事件：V2 无 message.part.updated / session.error；
  // spawn/进度/完成靠上方 scan 捕获，这里只管子会话终态收敛
  const offIdle = context.data.on("session.idle", (e) => {
    const sid = e.data.sessionID
    if (sid) onSessionEnd(sid, "done")
  })
  const offErr = context.data.on("session.execution.failed", (e) => {
    const sid = e.data.sessionID
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
      offIdle(); offErr()
      listeners.clear()
    },
  }
}
