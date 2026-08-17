// @pgoone/next-step-pi 公共面（ADR-001 B 单包：src/domain 零 pi import + src/pi 与 src/ports 接线，B1 红线）。
// T1-07：HarnessAdapter 6 动作 + AuditPort 的 pi 实现。
// 后续卡：工具注册表/doc 会话装配（T1-10）、CliDecisionPort（T1-09）、web-panel 审计通道（T1-11）。
export { createHarnessAdapter } from "./pi/harness-adapter";
export type { HarnessAdapterDeps } from "./pi/harness-adapter";
export { createEntryAuditPort } from "./ports/audit-port";
