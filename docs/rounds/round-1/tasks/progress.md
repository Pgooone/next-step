# 进度 · round-1（第一期 · 北极星闭环）

> 每卡完成 = 实现 agent 交付 + 独立 verifier 复跑通过 + lead 复核 git 实盘 + commit
> 卡文件：`tasks/T1-xx-*.md`；设计依据：`design/high-level-design.md` + `design/detailed-design.md`（评审 PASS，P0=0，P1 七条均已落卡）
> P1 修复落点速查：P1-1→T1-04/T1-08/T1-09；P1-2→T1-03/T1-05/T1-11；P1-3→T1-04/T1-05；P1-4→T1-12；P1-5→T1-04/T1-12；P1-6→T1-10；P1-7→T1-06/T1-11。H 裁决：H1→T1-01；H2→T1-11（P2-1 裁量登记）；H3→T1-04/T1-06；H4→T1-06/T1-11；H5→T1-11；H6→T1-04

**质量门禁**：逻辑层 verifier 独立复跑通过；端到端层（UI 走真浏览器）验证通过；逐卡单独 commit。

## 任务卡（依赖顺序）

| 卡号 | 名称 | 层 | 依赖 | 状态 | 验收 |
|---|---|---|---|---|---|
| [T1-01](T1-01-monorepo骨架与路径常量.md) | monorepo 骨架与 .nextstep 路径常量（H1） | L1 基座 | — | 已完成 | 已过 |
| [T1-02](T1-02-L1三服务原样搬与迁移回归.md) | L1 三服务原样搬 + 迁移回归（承重墙 1） | L1 | T1-01 | 已完成 | 已过 |
| [T1-03](T1-03-baseVersion与冲突恢复路径.md) | PendingChange.baseVersion 与冲突校验 | L1 | T1-02 | 已完成 | 已过 |
| [T1-04](T1-04-审计条目族与端口接口.md) | 审计条目族 v1 + presentation + 端口接口 + sourceRef | L1 | T1-02, T1-03 | 待开始 | 未过 |
| [T1-05](T1-05-pending-gate-service.md) | pending-gate-service（闸门编排 + 守卫 + discard） | L1 | T1-03, T1-04 | 待开始 | 未过 |
| [T1-06](T1-06-外部手改处理与sourceRef写入.md) | 外部手改处理（check/reject/merge） | L1 | T1-04, T1-05 | 待开始 | 未过 |
| [T1-07](T1-07-HarnessAdapter与AuditPort.md) | HarnessAdapter 6 动作 + AuditPort pi 实现 | L2 | T1-01, T1-04 | 待开始 | 未过 |
| [T1-08](T1-08-SPIKE-CLI汇总卡交互.md) | **SPIKE**：CLI 汇总卡交互（execute 内 ctx.ui 实证，H7） | L2 实证 | T1-01；先于 T1-09/T1-10 | 待开始 | 未过 |
| [T1-09](T1-09-CliDecisionPort.md) | CliDecisionPort（汇总卡 + 快捷键 + 取消分支） | L2 | T1-08, T1-05, T1-07 | 待开始 | 未过 |
| [T1-10](T1-10-工具注册表与doc会话装配.md) | 六工具注册表 + doc 会话装配（AC-1.1~1.4 主战场） | L2 | T1-05, T1-06, T1-07, T1-09 | 待开始 | 未过 |
| [T1-11](T1-11-薄server.md) | 薄 server（10 端点 + web-panel.jsonl 审计） | L3 | T1-05, T1-06, T1-07 | 待开始 | 未过 |
| [T1-12](T1-12-Web通用渲染器与受管文档面板.md) | Web 通用渲染器 + 受管文档面板（S1–S4） | L3 | T1-11, T1-04 | 待开始 | 未过 |
| [T1-13](T1-13-WebE2E与出口判据收官.md) | Web E2E + 出口判据收官（真浏览器 + 通道①） | L3 验收 | T1-10, T1-11, T1-12 | 待开始 | 未过 |

**执行顺序建议**：T1-01 → T1-02 → T1-03 → T1-04 → T1-05 → T1-06（L1 承重墙先立）→ T1-07 → **T1-08（spike，须先于 T1-09/T1-10）** → T1-09 → T1-10（L2 工具与闸门）→ T1-11 → T1-12（L3 Web）→ T1-13（收官验收）。

> 状态列更新当前进度；验收列仅在双层验收全过后标「已过」。卡号对应 `tasks/` 下的任务卡文件。
