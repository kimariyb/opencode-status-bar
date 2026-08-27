# v0.6 用量统计面板 · 设计文档

## 需求

状态栏新增数据统计入口（独立一行 `∑ 用量`），点击弹出用量统计面板：
- **指标区域**：总消耗 token、总输入、总输出、缓存命中、缓存命中率
- **明细区域**：按模型维度统计（模型名称、请求数、Token 数），预设筛选 今天/7天/30天（默认今天）

硬性要求：① 面板宽高足够容纳数据 ② 查询必须考虑性能 ③ 全链路托底降级。

## 数据源（参考 cc-switch `session_usage_opencode.rs`）

直读 opencode 本地 SQLite：`~/.local/share/opencode/opencode.db`（只读）。
插件运行在 opencode 进程内，opencode 必然在运行，打开弹窗时实时查询即可，
无需 cc-switch 的同步水位/去重/持久化层（那是跨进程独立 App 的需求）。

- 引擎适配：`bun:sqlite`（主，opencode 用 bun 运行）→ `node:sqlite`（降级）
- 路径解析：`usage.dbPath` 配置 > `OPENCODE_DB` 环境变量 > `XDG_DATA_HOME` > `~/.local/share/opencode`
- 消息过滤（对齐 cc-switch 口径）：`role=assistant` 且 `tokens` 存在且
  `time.completed` 存在（丢弃半截消息）且非全零

## 指标口径

| 指标 | 口径 |
|------|------|
| 总消耗 | input + (output + reasoning) + cache.read + cache.write |
| 总输入 | input（新鲜输入，不含缓存） |
| 总输出 | output + reasoning（思考 token 归入输出） |
| 缓存命中 | cache.read |
| 命中率 | read / (input + read + write)，与缓存按钮同口径 |
| 请求数 | 已完成 assistant 消息数 |

## 性能（三层防护）

实测基线：30 天窗口聚合 91ms（3 万条消息、10GB 库）。

1. **mtime 缓存**：cache key = window + max(mtime(db), mtime(db-wal))；
   WAL 模式下新提交先落 -wal，只看主库会漏数据（cc-switch 教训）
2. **事件防抖**：入口行当日摘要走 `session.idle` + 1.5s 防抖（对齐余额行模式）
3. **连接单例**：模块级懒加载，异常丢弃重建（自愈）

## 托底（状态机）

`ok → empty → engine-missing → db-missing → query-error` 五态，
任何状态不崩面板、不影响其他功能。查询失败丢弃连接重试 1 次。

## UI

v2（TUI 原生布局，参考 docs/proto/usage-dialog-v2.html）：对齐全部交给 opentui
布局原语（固定宽 cell + flexGrow/marginLeft auto），零 ASCII 拼接——CJK 测宽偏差
只整体平移不错行。无外框/点阵大字/进度条（宿主 dialog 自带面板底色；bg 色块
点阵在真实终端碎裂，vision 验证）。原型：docs/proto/usage-dialog-v2.html。

```
用量统计  // USAGE                ‹今天› [7天] [30天]   ← flexGrow 占位
────────────────────────────────────────────
5.1G token 总消耗                             ← bold+accent
25,254 次请求 · 16 个模型
总输入      72.1M        总输出      16.2M     ← 2×2：label+auto 右对齐
缓存命中    5.0G  98%     缓存写入     4.6M     ← 命中率分档色
模型                        请求数      Token   ← 模型列 flexGrow（长名不截断）
deepseek-v4-flash-vision-exp   599    131.6M
其他模型 · 6                    781     50.6M   ← dim 聚合行
```

- 命中率分档：≥85 绿 / ≥70 黄 / <70 红（与 CacheDialog 一致）
- 渲染纪律（v1 教训）：style 不能传 undefined；Show children 不放组件调用表达式；
  列表必须对象引用 For / 内联表达式——索引 For + 回调体内提前取值会导致切窗口
  不重算（v1 bug：只刷明细表不刷指标，已修复）
- 空态：该时间范围内暂无用量数据

## 文件变更

| 文件 | 说明 |
|------|------|
| `src/usage.ts` | 新增：数据层全套 |
| `src/dialogs.tsx` | 修改：UsageDialog |
| `src/index.tsx` | 修改：入口行 + 弹窗接入 |
| `src/config.ts` | 修改：sections.usage / usage.dbPath |
| `README.md` | 功能与配置说明 |

版本：0.5.0 → 0.6.0（minor，新功能）。
