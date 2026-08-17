# design · 设计文档

环节④产物。D1–D10 拍板结论（正本 §9）为既定事实；H1–H6 假设已由评审定案。

> ⚠️ **ADR-001 B 重组后（2026-08-17）**：本文档中的 `packages/core` / `packages/pi-ext` 双包路径与 HarnessAdapter 显式接口为设计时历史——物理结构已合并为单包 `packages/next-step-pi`（src/domain｜src/pi｜src/ports），契约接口已废除（类型内联至 pi 实现）。逻辑设计（schema/流程/断言）不受影响，路径以仓库现状为准。

| 文件 | 内容 | 状态 |
|---|---|---|
| `high-level-design.md` | 模块划分（五模块三连问）/ L0–L3 分层映射 / 承重墙点名 / HarnessAdapter 6 动作签名 / monorepo 布局 | DRAFTED |
| `detailed-design.md` | 数据 schema（PendingChange+baseVersion / sourceRef / 审计条目族 / presentation）/ DecisionPort 两实现 / 六工具注册表 / 薄 server 端点 / 测试计划 / H1–H6 | DRAFTED |
| `design-review.md` | 独立评审：三挑战点裁决、硬约束核对、H 裁决、15 项盲区；**STATUS: PASS（P0=0，P1×7 均落卡）** | ✅ |
