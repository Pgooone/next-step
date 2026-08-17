# T1-09 · CliDecisionPort（ctx.ui 汇总卡 + 快捷键 + 取消分支）

> 柱子：**可控**（F1 闸门 CLI 实现；承重墙 2）
> 让哪条变绿：S5（CLI 侧主路径：汇总卡呈现 5 块 → 快捷键逐块/全收 → 物化留版）、F1 纯 CLI 端到端；P1-1 ①② 全部
> 层：L2｜ **新写**（`packages/pi-ext/src/ports/cli-decision-port.ts`）

## 依赖
- 前置卡：**T1-08（spike，H7 结论必须已采纳——实现形态以 spike 报告为准）**、T1-05（Decision 语义 + GateDeps）、T1-07（pi 接线基建）

## 实现要点
- 实现 `DecisionPort.ask(req)`，交互形态 = **spike 报告定案形态**（默认目标：D6 CLI 方案 A 汇总卡；spike 判不可行则退化 D6 方案 B 逐块 confirm 序列，**退化不丢 F1**）：
  - 一次呈现全部块（title + 块编号 + kind + 首行摘要，对齐 L1 presentation 数据——CliDecisionPort 只画数据、不重算）
  - 快捷键协议：`y<n>`/`n<n>` 逐块 ✓/✗（可翻转）；`a` 全部接受、`r` 全部拒绝（D6 分档）；`b<n>` 混合档打回单块（全收后）；回车提交；**存在 pending 块时拒绝提交并提示**
  - 每块状态即时上屏（对齐原型「状态即时变色、进度实时更新」的 CLI 版，进度计数由 presentation 数据驱动）
- **取消分支（P1-1①）**：用户输入取消（`q`/`x` 或 Ctrl+C 经 spike 实证的路径）→ 返回 `{ status: "cancelled" }`；**不清理任何领域状态**（pending 保留由 gate 负责，T1-05 已实现）
- **记账永远块级（D6 红线）**：返回的 decisions 逐块，含拒绝的块（不接受即记录 reject 或缺失即 pending——以 T1-05 契约为准：全决才提交，decisions 覆盖全部块）
- 交互实现仅用 `ctx.ui` 原语组合（spike 结论），**不写任何 L1 判断**（L1 只认 Decision 返回值）

## 验收断言（可执行）
- [ ] 集成测试（stub ui 模拟按键序列）：5 块场景 `y1 y2 n3 y4 n5 回车` → Decision resolved、decisions 与按键一致（3 收 2 拒）
- [ ] `a` 全收 → 5 块全 accepted；随后 `n2` 打回 → decisions 4 收 1 拒（混合档）
- [ ] 存在 pending 块时提交被拒（stub 断言提交前有 pending 计数非零）
- [ ] 取消输入 → Decision cancelled、无任何领域副作用（pending 文件原样）
- [ ] 保底路径（若 spike 判退化）：逐块 confirm 序列仍产出等价 decisions（F1 不丢断言）
- [ ] 呈现数据 = L1 presentation 传入原样消费（无领域重算——代码审查项）

## 完成判据
集成测试绿 + spike 结论采纳记录（卡注释或报告引用）+ 逐卡 commit。
