# T1-07 · HarnessAdapter 6 动作 pi 实现 + AuditPort pi 实现（L2 适配层）

> 柱子：**产能**（会话能力适配 = 两壳共用通道）+ **可控**（唯一 import pi 的包，B1 红线载体）
> 让哪条变绿：全部 AC 的 L2 运行载体；HarnessAdapter 恰好 6 动作纪律（正本 §5.1）；P2-6/P2-7 落点
> 层：L2｜ **新写**（`packages/pi-ext/`）；接口类型沿用 T1-01 建仓时 L1 侧 `adapter/harness-adapter.ts` 定义

## 依赖
- 前置卡：T1-01（接口类型与包结构）、T1-04（AuditEntryPayload 类型）；pi 内核可用（fork 占位或 `@earendil-works/pi-coding-agent` 0.84.x devDependency，spike T1-08 可共用同一安装）

## 实现要点
- `packages/pi-ext` 声明 `@earendil-works/pi-coding-agent` 为**唯一运行时依赖**（L2 = 只有这层 import pi 的包级保证，B1）。
- **6 动作全部实现**（pi 官方 1:1 落点，正本 §5.1）：
  1. `startSession` → `createAgentSession()`（含 toolsWhitelist / excludeTools / systemPrompt / agentDir 透传）
  2. `sendMessage` → `session.prompt()`
  3. `registerTool` → `pi.registerTool()`（NextStepToolDef → ToolDefinition 翻译，TypeBox schema）
  4. `readSessionStream` → `session.subscribe()` + `ctx.sessionManager.getEntries()`（直播 + 回放同通道）
  5. `spawnSubagent` → 官方 `examples/extensions/subagent` 范式（**实现 + 单测，不接线**——第二期 M4 消费；P2-6 补断言）
  6. `getContextUsage` → `context` 事件（**实现 + 单测，无消费点**——第三期消费，P2-7 明示）
- **AuditPort pi 实现**：`createEntryAuditPort(sessionManager)` → `appendEntry` 自定义条目（ns:"next-step"，持久化、不进 LLM 上下文——用 stub 模型断言「模型消息流中无自定义条目内容」）；**供 CLI 扩展与 Web server 共用**（Web 不直接 import pi）。
- 翻译层边界：L2 只做「pi 对象 ↔ L1 类型」翻译 + 接线，**零领域判断**（判断全在 L1）。
- inMemory 测试基建：`SessionManager.inMemory()` + stub 模型可跑（正本 §5 分层表 L2 测试方式）。

## 验收断言（可执行）
- [ ] 6 动作逐一在 `SessionManager.inMemory()` + stub 模型下可调用并返回预期（含 spawnSubagent 的 spawn/回收/结果聚合断言、getContextUsage 的 usage 字段断言）
- [ ] `createEntryAuditPort().append(...)` 后：会话 JSONL 出现 `type:"custom"` 且 ns:"next-step" 条目；**stub 模型收到的 messages 中无该条目内容**（不进 LLM 上下文，§5.3 实证语义）
- [ ] `grep -rn "@earendil-works" packages/pi-ext/` 命中仅限其 package.json 与 src（L2 是唯一 import pi 的包）；`packages/core/` 继续零命中（B1 双向保证）
- [ ] 6 动作接口与 L1 定义逐字一致（无第 7 个动作，无签名漂移）

## 完成判据
集成测试绿 + 分层红线 grep 过 + 逐卡 commit。
