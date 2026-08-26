# AGENTS.md — opencode-status-bar 协作准则

本文件约束所有 agent 在本仓库中的行为。除本文件外，遵循全局 AGENTS.md。

## 版本管理（强制）

**任何代码变更必须同步 bump npm 版本，禁止只改代码不动版本号。**

### 版本升级分级（semver）

| 变更类型 | 升级方式 | 示例 |
|---------|---------|------|
| Bug 修复 / 小调整 | patch | 0.5.0 → 0.5.1 |
| 新功能 / 向后兼容的重构 | minor | 0.5.0 → 0.6.0 |
| 破坏性变更（配置格式 / 导出接口） | major | 0.5.0 → 1.0.0 |
| 纯文档 / 注释 / 构建脚本调整 | 不升版 | — |

### 版本同步流程

版本号存在两处，同步靠脚本，禁止手工编辑 `src/_version.ts`：

1. 修改 `package.json` 的 `version` 字段
2. 执行 `npm run version` —— 自动将版本号写入 `src/_version.ts`（该文件头部有 auto-generated 标记）
3. `package.json` 与 `src/_version.ts` 必须与代码变更在**同一个 commit** 中提交

## 变更验证（强制）

提交前必须通过：

```bash
npm run typecheck && npm run build
```

TUI 插件相关改动需重启 opencode 后才能实际生效，验证时注意提示。

## 发布

- `npm publish` 属不可逆操作，仅在用户明确要求时执行
- 发布后必须提醒用户已知问题（opencode#6774）：插件缓存锁死在首次安装时的版本，
  拿新版本需先清除缓存再重装：

  ```bash
  mv ~/.cache/opencode/packages/opencode-status-bar@latest ~/.Trash/
  # 然后在 opencode 中 Ctrl+P → install plugin → opencode-status-bar@latest
  ```
