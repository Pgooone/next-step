// @pgooone/next-step-pi 公共面（ADR-001 B 单包：src/domain 零 pi import + src/pi 与 src/ports 接线，B1 红线）。
// T1-07：HarnessAdapter 6 动作 + AuditPort 的 pi 实现。
// T1-09：CliDecisionPort（ctx.ui 汇总卡）。T1-10：六工具注册表 + doc 会话装配。
export { createHarnessAdapter } from "./pi/harness-adapter";
export type { HarnessAdapterDeps } from "./pi/harness-adapter";
export { buildDocTools } from "./pi/doc-tools";
export type { DocToolDeps } from "./pi/doc-tools";
export { assembleDocSession, createManagedPathGuard, DOC_TOOLS_WHITELIST, DOC_TOOLS_EXCLUDE } from "./pi/session-assembly";
export type { DocSessionAssembly, DocSessionAssemblyDeps } from "./pi/session-assembly";
export { createEntryAuditPort } from "./ports/audit-port";
