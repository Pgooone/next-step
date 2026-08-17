# T1-08 · SPIKE：CLI 汇总卡交互（execute 内 ctx.ui 能力边界实证）

> 柱子：**可控**（F1 闸门交互实证——P1-1 评审核心质疑；spike 先行防实现返工）
> 让哪条变绿：S5（CLI 汇总卡 + 快捷键逐块/全收）；P1-1②（H7 假设 + D6 B 保底路径）
> 层：L2（实证）｜ **spike**（可丢弃代码，不并入实现）

## 依赖
- 前置卡：T1-01（monorepo 可跑 pi devDependency）；**先于 T1-09（CliDecisionPort）与 T1-10（propose_edit 装配）完成**

## 要实证的问题（P1-1 评审原文转任务）
设计把确认放在**工具 execute 内部**（proposeWithGate 在 execute 里 await ask），交互模型是「汇总卡 + 快捷键反复翻转 + 即时上屏」；而正本 §5.4 实证的 permission-gate 是 **tool_call 拦截器事件处理器内** await `ctx.ui.confirm`（单次确认）。execute 内多轮状态交互从未实证。spike 回答：
1. **execute 内 `ctx.ui`（select/confirm/input）可用性**：工具 execute 的 ctx 是否携带可用的 ui 对象？await 后用户输入如何返回？**多轮交互**（先看 5 块、逐块翻转、最后提交）能否用现有原语组合实现（如 input 收命令串 + 循环）？
2. **取消/中断可感知性**：阻塞 ask 期间用户 Ctrl+C / 会话 abort → AbortSignal 是否触发？工具能否感知并返回 cancelled（P1-1① 的分支是否可达）？
3. **D6 B 保底路径（逐块 confirm 序列）**：若多轮交互不成立，退化为「逐块 confirm 序列」（每块一次 confirm）是否可实施、F1 是否不丢——给出可用性结论。
4. 汇总卡的呈现能力：execute 内能否向终端输出结构化卡片（表格/分色）后再进入输入循环。

## 产出（spike 交付物）
- 报告落盘 `docs/rounds/round-1/qa/cli-gate-interaction-spike.md`：上述 4 问逐条实证结论 + 可复现代码路径（example 或最小扩展）+ **T1-09 的接口形态建议**（选 A 汇总卡 or 退 B 逐块 confirm，或混合）。
- **H7 假设落档**：把「execute 内 ctx.ui 可用性与多轮交互能力边界」正式登记为 H7（若 spike 证明可用 → 假设解除；若受限 → 标 D6 B 保底为第一期实现形态）。
- spike 代码可留作 T1-09 的实现种子或删除（实现者自决，不并入验收）。

## 验收断言（可执行）
- [ ] 报告落盘且 4 问均有实证结论（代码路径/输出证据，非推测）
- [ ] H7 结论明确：A 路径（汇总卡多轮）可用 / 不可用 / 需退化 B，并给出理由与证据
- [ ] 结论里含「取消/abort 可感知 → cancelled 分支可达」或「不可感知 → 保底方案」的明示

## 完成判据
报告 + H7 落档 + 结论被 T1-09 采纳（实现卡写清采纳形态）。spike 单独 commit。
