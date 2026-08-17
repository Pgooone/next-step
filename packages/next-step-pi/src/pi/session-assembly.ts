import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { ArtifactService } from "../domain/domain/artifact-service";
import { createCliDecisionPort } from "../ports/cli-decision-port";
import { createEntryAuditPort, type AuditSessionManager } from "../ports/audit-port";
import type { AuditPort, DecisionPort } from "../domain/gate/ports";
import { buildDocTools, type DocToolDeps } from "./doc-tools";
import type { NextStepToolDef } from "./harness-adapter";

/**
 * T1-10 · doc 会话装配（详细设计 §5，D10 默认 doc = 最小权限）——
 * 第一期单 Agent 会话 = doc 会话，能力层物理禁用 write/edit/bash（非 prompt）：
 *
 * 1. **能力层白名单**（AC-1.3 直接落点）：DOC_TOOLS_WHITELIST = 六工具 + read/grep/glob/list，
 *    物理不含 write/edit/bash。
 * 2. **双保险 excludeTools**：DOC_TOOLS_EXCLUDE = ["write","edit","bash"]（防白名单漏网）。
 * 3. **受管路径 tool_call 守卫**（详设 §5.3，protected-paths 范式）：拦截任何工具调用的
 *    目标路径参数，命中受管集合（物化文件）→ `{ block: true, reason: "受管文档禁止直写，请用 propose_edit" }`。
 *    doc 模式无 write/edit/bash，本守卫是防御纵深 + S5④「受管路径直写被硬挡」的可断言载体。
 * 4. EXTERNAL_MODIFIED 兜底（D10，第四层）在 L1 物化路径内（artifact-service），本文件不涉及。
 *
 * 闭包注入 projectId / sourceActor（旧仓 :44-51 DocToolDeps 范式）；
 * decisionPort = CliDecisionPort（T1-09 惰性 getContext——工具 execute 的 ctx 经
 * onToolContext 喂入）；auditPort = createEntryAuditPort(sessionManager)（T1-07）。
 */

/** doc 会话能力层白名单（详设 §5.1）：六工具 + 4 只读内置，物理不含 write/edit/bash。 */
export const DOC_TOOLS_WHITELIST = [
  "create_artifact",
  "propose_edit",
  "list_artifacts",
  "get_artifact_diff",
  "list_my_artifacts",
  "get_artifact_history",
  "read",
  "grep",
  "glob",
  "list",
] as const;

/** 双保险 excludeTools（防白名单漏网；能力层物理禁写，非 prompt 引导）。 */
export const DOC_TOOLS_EXCLUDE = ["write", "edit", "bash"] as const;

/** 受管路径守卫的拦截文案（S5④ / 测试断言锚点）。 */
export const MANAGED_PATH_BLOCK_REASON = "受管文档禁止直写，请用 propose_edit";

/**
 * 装配依赖：DocToolDeps 去掉闸门端口（默认 decisionPort = CliDecisionPort 惰性注入、
 * auditPort = createEntryAuditPort(sessionManager)、onToolContext 均由本装配内部接线；
 * decisionPort/auditPort 可覆盖——集成测试注入 stub 端口，生产省略走默认）+ 会话载体。
 */
export type DocSessionAssemblyDeps = Omit<DocToolDeps, "decisionPort" | "auditPort" | "onToolContext"> & {
  /** 会话 cwd = projectRoot（createAgentSession 的 cwd；守卫用它 resolve 相对路径）。 */
  cwd: string;
  /**
   * 会话存储（T1-07 createEntryAuditPort 的落点；inMemory 供集成测试；
   * 真 CLI 扩展侧可传 { appendCustomEntry } 轻量适配——pi.appendEntry）。
   */
  sessionManager: AuditSessionManager;
  /** 覆盖默认 CliDecisionPort（测试注入 stub；生产省略 = CliDecisionPort 惰性 ctx 形态）。 */
  decisionPort?: DecisionPort;
  /** 覆盖默认 createEntryAuditPort(sessionManager)（测试可注入记录型 stub）。 */
  auditPort?: AuditPort;
};

/** 装配结果：可直接展开进 HarnessAdapter.startSession 的 SessionStartOptions。 */
export type DocSessionAssembly = {
  tools: NextStepToolDef[];
  toolsWhitelist: string[];
  excludeTools: string[];
  toolCallGuard: (event: ToolCallEvent) => ToolCallEventResult;
};

/**
 * doc 会话装配：产出六工具 + 白名单 + excludeTools + 受管路径守卫。
 * decisionPort 经惰性 getContext（T1-09 形态）——execute 的 ctx 由 propose_edit 经
 * onToolContext 喂入；auditPort 落在注入的 sessionManager 上（与 CLI 壳共用同一会话文件）。
 */
export function assembleDocSession(deps: DocSessionAssemblyDeps): DocSessionAssembly {
  const ctxHolder: { current: ExtensionContext | undefined } = { current: undefined };
  const decisionPort = deps.decisionPort ?? createCliDecisionPort(() => ctxHolder.current!);
  const auditPort = deps.auditPort ?? createEntryAuditPort(deps.sessionManager);
  return {
    tools: buildDocTools({
      ...deps,
      decisionPort,
      auditPort,
      onToolContext: (ctx) => {
        ctxHolder.current = ctx;
      },
    }),
    toolsWhitelist: [...DOC_TOOLS_WHITELIST],
    excludeTools: [...DOC_TOOLS_EXCLUDE],
    toolCallGuard: createManagedPathGuard({
      cwd: deps.cwd,
      projectId: deps.projectId,
      artifactService: deps.artifactService ?? new ArtifactService(),
    }),
  };
}

/**
 * 受管路径 tool_call 守卫（详设 §5.3，protected-paths 范式）：
 * 拦截**写类工具**（write/edit；read/grep 等读类放行——list_artifacts 契约明示
 * 「可用 read 工具读该文档正文」）的目标路径参数，命中受管集合（物化文件绝对路径）
 * → `{ block: true, reason: "受管文档禁止直写，请用 propose_edit" }`。
 *
 * 受管集合每次调用时现取（listArtifacts → materializedAbsPath）：create_artifact
 * 后新物化文件即刻入集；集合为空（无 artifact）→ 无拦截。相对路径按 cwd resolve。
 * 非 write/edit 工具或参数不含 path → 放行（返回空对象）。
 */
export function createManagedPathGuard(deps: {
  cwd: string;
  projectId: string;
  artifactService: ArtifactService;
}): (event: ToolCallEvent) => ToolCallEventResult {
  return (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return {};
    const raw = event.input.path;
    if (typeof raw !== "string" || raw.trim() === "") return {};
    const abs = resolve(deps.cwd, raw);
    const managed = new Set<string>();
    for (const artifact of deps.artifactService.listArtifacts(deps.projectId)) {
      const absPath = deps.artifactService.materializedAbsPath(deps.projectId, artifact.id);
      if (absPath !== undefined) managed.add(absPath);
    }
    if (managed.has(abs)) return { block: true, reason: MANAGED_PATH_BLOCK_REASON };
    return {};
  };
}
