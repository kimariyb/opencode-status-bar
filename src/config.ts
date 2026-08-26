// ---------------------------------------------------------------------------
// 配置读取：~/.config/opencode/status-bar.jsonc
// 在 balances 之外支持 sections（模块开关）/ animations（动效开关与频率）/
// thresholds（健康度分档），全部带默认值，缺省行为与 v0.3 兼容。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs"

export interface AnimConfig {
  enabled: boolean
  intervalMs: number
}

export interface StatusBarConfig {
  sections: {
    clock: boolean
    battery: boolean
    cache: boolean
    subagent: boolean
  }
  animations: {
    alert: AnimConfig
    charging: AnimConfig
    clock: AnimConfig
    spinner: AnimConfig
  }
  thresholds: {
    warning: number
    alert: number
  }
  subagent: {
    ttlDays: number // 子代理记录 KV 保留天数（0 = 永久，访问自动续期）
  }
}

export const DEFAULT_CONFIG: StatusBarConfig = {
  sections: { clock: true, battery: true, cache: true, subagent: true },
  animations: {
    alert: { enabled: true, intervalMs: 600 },
    charging: { enabled: true, intervalMs: 1200 },
    clock: { enabled: true, intervalMs: 2000 },
    spinner: { enabled: true, intervalMs: 80 },
  },
  thresholds: { warning: 0.7, alert: 0.9 },
  subagent: { ttlDays: 3 },
}

function mergeAnim(raw: unknown, def: AnimConfig): AnimConfig {
  if (!raw || typeof raw !== "object") return def
  const o = raw as Record<string, unknown>
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : def.enabled,
    intervalMs: typeof o.intervalMs === "number" && o.intervalMs >= 100 ? o.intervalMs : def.intervalMs,
  }
}

export function readStatusBarConfig(configPath: string): StatusBarConfig {
  try {
    const raw = readFileSync(configPath, "utf-8")
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "")
    const parsed = JSON.parse(stripped) as Record<string, unknown>
    const cfg: StatusBarConfig = {
      sections: { ...DEFAULT_CONFIG.sections },
      animations: { ...DEFAULT_CONFIG.animations },
      thresholds: { ...DEFAULT_CONFIG.thresholds },
      subagent: { ...DEFAULT_CONFIG.subagent },
    }
    const sec = parsed.sections
    if (sec && typeof sec === "object") {
      const s = sec as Record<string, unknown>
      for (const k of ["clock", "battery", "cache", "subagent"] as const) {
        if (typeof s[k] === "boolean") cfg.sections[k] = s[k] as boolean
      }
    }
    const anim = parsed.animations
    if (anim && typeof anim === "object") {
      const a = anim as Record<string, unknown>
      cfg.animations.alert = mergeAnim(a.alert, DEFAULT_CONFIG.animations.alert)
      cfg.animations.charging = mergeAnim(a.charging, DEFAULT_CONFIG.animations.charging)
      cfg.animations.clock = mergeAnim(a.clock, DEFAULT_CONFIG.animations.clock)
      cfg.animations.spinner = mergeAnim(a.spinner, DEFAULT_CONFIG.animations.spinner)
    }
    const th = parsed.thresholds
    if (th && typeof th === "object") {
      const t = th as Record<string, unknown>
      if (typeof t.warning === "number") cfg.thresholds.warning = Math.min(1, Math.max(0, t.warning))
      if (typeof t.alert === "number") cfg.thresholds.alert = Math.min(1, Math.max(0, t.alert))
    }
    const sg = parsed.subagent
    if (sg && typeof sg === "object") {
      const s = sg as Record<string, unknown>
      if (typeof s.ttlDays === "number" && s.ttlDays >= 0) cfg.subagent.ttlDays = s.ttlDays
    }
    return cfg
  } catch {
    return DEFAULT_CONFIG
  }
}
