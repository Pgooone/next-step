// @pgoone/next-step-pi 公共面（L2，全仓唯一 import pi 的包，B1 红线）。
// T1-07：HarnessAdapter 6 动作 + AuditPort 的 pi 实现。
// 后续卡：工具注册表/doc 会话装配（T1-10）、CliDecisionPort（T1-09）、web-panel 审计通道（T1-11）。
export { createHarnessAdapter } from "./harness-adapter";
export type { HarnessAdapterDeps } from "./harness-adapter";
export { createEntryAuditPort } from "./ports/audit-port";
