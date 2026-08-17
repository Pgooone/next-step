import type { Artifact, ArtifactService } from "../domain/artifact-service";
import {
  PendingChangeError,
  PendingChangeStore,
  buildReplacePendingChange,
  computeReplaceDiffBlocks,
  type PendingChange,
} from "../domain/pending-change-service";
import {
  buildApprovalRequest,
  buildApprovalResponse,
  buildApprovalResponseDiscarded,
  buildArtifactProposed,
  buildArtifactResolved,
  buildArtifactRollback,
} from "../audit/entries";
import {
  buildApprovalRequestPresentation,
  buildApprovalResponseDiscardedPresentation,
  buildApprovalResponseResolvedPresentation,
  buildDiffRefFromChange,
  buildProposalPresentation,
  buildResolvedPresentation,
} from "../presentation/builders";
import type { AuditPort, DecisionPort, DecisionRequest } from "./ports";

/**
 * L1 闸门编排（详细设计 §3，T1-05）：「提案 → 确认 → 物化」十步序列收敛为本服务，
 * CLI / Web 两壳共用；旧仓确认逻辑散在 Web 路由层，v2.0 以 GateDeps 全注入保证
 * L1 纯单测可跑通整条确认链（stub DecisionPort + stub AuditPort + 内存临时目录后端，
 * 不碰 pi）。本文件零 pi import、零 UI 依赖（§2.1 红线，由本卡测试 grep 断言）。
 */

/** 裁决通道（S1⑤「每次裁决落入 append-only 日志」按来源可检视）。 */
export type Via = "cli-keyboard" | "web-panel";

/**
 * 闸门自身的拒绝错误（区别于 ArtifactService / PendingChangeStore 的领域错误，
 * 那两类的 code 枚举不归本卡改动）。P1-2①：回滚守卫——有未决提案时拒绝回滚，
 * 文案对齐原型「有待确认提案未处理，暂不可回滚」。
 */
export class GateError extends Error {
  constructor(
    public readonly code: "PENDING_EXISTS",
    message: string,
  ) {
    super(message);
    this.name = "GateError";
  }
}

/** 闸门依赖：全部可注入（L1 单测 = stub 端口 + 内存临时目录后端即可全链路验证）。 */
export type GateDeps = {
  artifactService: ArtifactService;
  pendingStore: PendingChangeStore;
  decisionPort: DecisionPort;
  auditPort: AuditPort;
  /** 裁决通道注记（写入 approval_response.via；S1⑤）。 */
  via: Via;
};

/**
 * proposeWithGate 的结果（详细设计 §3 返回 { changeId, diffBlockCount, materialized, newVersion }，
 * 按 L2 工具表（§4）「changeId | null + note」的契约分支化）：
 * - materialized：全决并物化出新版（newVersion 附带）。
 * - unconfirmed：用户取消（P1-1① cancelled）——pending 保留，返回「已提案未确认，changeId=…」。
 * - deferred：Entry 端口语义（第一期不接线）——pending 保留，等待 Web 面板处理。
 * - pending_exists：查未决拦截（旧仓 doc-tools.ts:178-186 语义），未创建新提案。
 * - no_change：空块（内容无变化），未落 pending。
 */
export type ProposalOutcome =
  | {
      status: "materialized";
      changeId: string;
      diffBlockCount: number;
      materialized: true;
      newVersion: number;
      message: string;
    }
  | {
      status: "unconfirmed";
      changeId: string;
      diffBlockCount: number;
      materialized: false;
      message: string;
    }
  | {
      status: "deferred";
      changeId: string;
      diffBlockCount: number;
      materialized: false;
      message: string;
    }
  | {
      status: "pending_exists";
      /** 已存在的未决提案 id（引导先处理；L2 工具层按 §4 契约对外映射为 changeId: null）。 */
      existingChangeId: string;
      diffBlockCount: number;
      materialized: false;
      message: string;
    }
  | {
      status: "no_change";
      diffBlockCount: 0;
      materialized: false;
      message: string;
    };

/** ask 的问询分档（D6）：hitlMode whole → 整块；per_block（默认）/ auto → 逐块。 */
function modeOf(change: PendingChange): "block" | "whole" {
  return change.hitlMode === "whole" ? "whole" : "block";
}

/** 问询发起方（详设 §1.3 approval_request.requester）：CLI 键盘 → cli；Web 面板 → entry。 */
function requesterOf(via: Via): "cli" | "entry" {
  return via === "cli-keyboard" ? "cli" : "entry";
}

/**
 * propose_edit 工具的执行体（详细设计 §3 十步流程，P1-3 修订后）：
 *
 * 1. 查未决：该 artifact 已有 pending → 返回引导先处理（旧仓 doc-tools.ts:178-186 语义原样保留）。
 * 2. readCurrentContent → computeReplaceDiffBlocks 切块。
 * 3. 空块 → 「内容无变化」，不落 pending、不产生幽灵版本。
 * 4. buildReplacePendingChange（baseVersion = artifact.currentVersion）→ pendingStore.save。
 * 5. auditPort.append(artifact_proposed)。
 * 6. auditPort.append(approval_request status:"pending")——**P1-3：由 gate 在 ask 前统一写入，
 *    端口只返回 Decision、不写审计**；仅在 ask 路径产生，Web 面板直接写回无问询 → 不产生
 *    request 条目。
 * 7. decisionPort.ask → 三路分支：
 *    - resolved → 逐块 resolveAndMaterialize（baseVersion 校验在内）→ append(approval_response)
 *      → append(artifact_resolved，含 buildSourceRefs 的 sourceRefs 随条目落盘)。
 *    - cancelled（P1-1①）→ pending 保留，返回「已提案未确认，changeId=…，可用 Web 面板或
 *      重试处理」（工具结果文本语义由 T1-10 承接）。
 *    - deferred（Entry 端口，本期不接线）→ pending 保留，等待 Web 面板处理。
 *
 * resolved 但物化未发生（decisions 未覆盖全部块，端口协议违约）→ 抛 INVALID，不猜、不静默。
 */
export async function proposeWithGate(
  deps: GateDeps,
  projectId: string,
  input: { artifactId: string; newContent: string; sourceActor: string },
): Promise<ProposalOutcome> {
  const artifactId = input.artifactId;

  // ① 查未决：已有待确认变更则拒绝、引导先处理（避免叠加多份 pending 难对账，D-V2-05）。
  const existing = deps.pendingStore.listPendingChanges(projectId, artifactId);
  if (existing.length > 0) {
    return {
      status: "pending_exists",
      existingChangeId: existing[0].id,
      diffBlockCount: 0,
      materialized: false,
      message: `该文档已有 ${existing.length} 处待确认变更（changeId=${existing[0].id}），请先处理（确认/拒绝）后再提议修改。`,
    };
  }

  // ② 切块：空块（与当前版逐字相同 → 无变化）不落 pending。
  const artifact = deps.artifactService.getArtifact(projectId, artifactId);
  const diffBlocks = computeReplaceDiffBlocks(artifact.content, input.newContent);
  if (diffBlocks.length === 0) {
    return {
      status: "no_change",
      diffBlockCount: 0,
      materialized: false,
      message: "内容无变化，未创建待确认变更。",
    };
  }

  // ③~④ 组装并落盘 PendingChange（不写真实文件/不出新版本——等用户按块确认；
  // baseVersion = 提案创建时 currentVersion 的显式快照，详设 §1.1）。
  const change = deps.pendingStore.save(
    projectId,
    buildReplacePendingChange({
      artifactId,
      sourceActor: input.sourceActor,
      oldContent: artifact.content,
      newContent: input.newContent,
      baseVersion: artifact.currentVersion,
    }),
  );

  // ⑤ 审计：提案落盘。
  await deps.auditPort.append(
    buildArtifactProposed(change, {
      presentation: buildProposalPresentation(change, artifact),
    }),
  );

  // ⑥ 审计：approval_request 由 gate 在 ask 前统一写入（P1-3；端口只返回 Decision）。
  await deps.auditPort.append(
    buildApprovalRequest(
      {
        changeId: change.id,
        artifactId,
        mode: modeOf(change),
        requester: requesterOf(deps.via),
      },
      { presentation: buildApprovalRequestPresentation(change, artifact) },
    ),
  );

  // ⑦ 问询（blocks 与 presentation 同源：buildDiffRefFromChange 的锚信息重放）。
  const req: DecisionRequest = {
    kind: "approve_blocks",
    changeId: change.id,
    artifactId,
    title: `${artifact.title} v${change.baseVersion} → v${change.baseVersion + 1}`,
    blocks: buildDiffRefFromChange(change).blocks,
    mode: modeOf(change),
  };
  const decision = await deps.decisionPort.ask(req);

  if (decision.status === "resolved") {
    // ⑧ 逐块 resolveAndMaterialize：accept → confirm / reject → reject；
    // 最后一块全决时触发 baseVersion 校验 → applyResolvedBlocks → submitVersion → 删 pending。
    // BASE_VERSION_CONFLICT 在此传播（pending 保留现场，出口 = discardWithAudit，P1-2）。
    let last: { change: PendingChange; materialized: boolean; artifact?: Artifact } | undefined;
    for (const d of decision.decisions) {
      last = deps.pendingStore.resolveAndMaterialize(projectId, artifactId, change.id, {
        blockId: d.blockId,
        action: d.decision === "accept" ? "confirm" : "reject",
      });
    }
    if (!last?.materialized || !last.artifact) {
      throw new PendingChangeError(
        "INVALID",
        "DecisionPort 返回 resolved 但 decisions 未覆盖全部 diff 块，存在未决块、未物化",
      );
    }
    const newVersion = last.artifact.currentVersion;
    // ⑨~⑩ 审计：裁决落定（含逐块明细，记账永远块级）→ 物化结果（含 sourceRefs）。
    await deps.auditPort.append(
      buildApprovalResponse(
        { changeId: change.id, artifactId, decisions: decision.decisions, via: deps.via },
        { presentation: buildApprovalResponseResolvedPresentation(last.change, artifact, newVersion) },
      ),
    );
    await deps.auditPort.append(
      buildArtifactResolved(last.change, newVersion, {
        presentation: buildResolvedPresentation(last.change, artifact, newVersion),
      }),
    );
    return {
      status: "materialized",
      changeId: change.id,
      diffBlockCount: change.diffBlocks.length,
      materialized: true,
      newVersion,
      message: `已确认并物化为 v${newVersion}。`,
    };
  }

  if (decision.status === "cancelled") {
    // P1-1①：取消 → pending 保留（不死锁；重新提案被「查未决」挡时的出口是 discard，P1-2）。
    return {
      status: "unconfirmed",
      changeId: change.id,
      diffBlockCount: change.diffBlocks.length,
      materialized: false,
      message: `已提案未确认，changeId=${change.id}，可用 Web 面板或重试处理。`,
    };
  }

  // deferred（EntryDecisionPort 第一期语义：ask 返回挂起，Web 面板稍后直接调 resolve 写回）。
  return {
    status: "deferred",
    changeId: change.id,
    diffBlockCount: change.diffBlocks.length,
    materialized: false,
    message: `提案已落盘（changeId=${change.id}），等待 Web 面板处理。`,
  };
}

/**
 * 回滚共用体（详细设计 §3：rollbackWithAudit / 撤销回滚 = 同一入口 undoing: true）：
 * 守卫（P1-2①）→ ArtifactService.rollback → 审计 artifact_rollback。
 *
 * 守卫：pendingStore.listPendingChanges 非空 → 抛 GateError("PENDING_EXISTS")
 * 「有待确认提案未处理，暂不可回滚」（文案对齐原型）——挂起提案的 baseVersion 指向
 * 回滚前的版本链，先回滚会让该提案必然 BASE_VERSION_CONFLICT，故在源头拒绝。
 *
 * via 参数保持 gate 动作签名统一（discardWithAudit 用它写 approval_response.via）；
 * artifact_rollback 条目 schema（v1 冻结，T1-04）不含 via 字段，本期不落条目。
 * 条目不挂 presentation：P1-4 定案方案 a——「确认过 N 块」需审计回放取数，
 * gate 的 AuditPort 只有 append 无读取，待渲染/回放侧（T1-10 及之后）组合。
 */
async function rollbackInternal(
  deps: GateDeps,
  projectId: string,
  artifactId: string,
  input: { version: number; undoing: boolean; via?: Via },
): Promise<{ fromVersion: number; toVersion: number; newVersion: number }> {
  const pending = deps.pendingStore.listPendingChanges(projectId, artifactId);
  if (pending.length > 0) {
    throw new GateError("PENDING_EXISTS", "有待确认提案未处理，暂不可回滚");
  }

  const before = deps.artifactService.getArtifact(projectId, artifactId);
  const next = deps.artifactService.rollback(projectId, artifactId, { version: input.version });
  await deps.auditPort.append(
    buildArtifactRollback({
      artifactId,
      fromVersion: before.currentVersion,
      toVersion: input.version,
      undoing: input.undoing,
    }),
  );
  return { fromVersion: before.currentVersion, toVersion: input.version, newVersion: next.currentVersion };
}

/** 回滚到目标版（校验 + 物化 + 审计，两壳共用；artifact_rollback undoing: false）。 */
export async function rollbackWithAudit(
  deps: GateDeps,
  projectId: string,
  artifactId: string,
  input: { version: number; via?: Via },
): Promise<{ fromVersion: number; toVersion: number; newVersion: number }> {
  return rollbackInternal(deps, projectId, artifactId, { ...input, undoing: false });
}

/**
 * 撤销回滚（P2-8 契约）= 以恢复目标版再回滚一次：撤销「回滚到 v2」（当时 fromVersion=v4）
 * → 调用方传 version=v4（= 原回滚的 fromVersion），内容回到 v4、undoing: true。
 * 守卫同 rollbackWithAudit（有 pending 拒绝）。
 */
export async function rollbackUndoWithAudit(
  deps: GateDeps,
  projectId: string,
  artifactId: string,
  input: { version: number; via?: Via },
): Promise<{ fromVersion: number; toVersion: number; newVersion: number }> {
  return rollbackInternal(deps, projectId, artifactId, { ...input, undoing: true });
}

/**
 * 放弃一条未决提案（P1-2② 冲突闭环的出口）：BASE_VERSION_CONFLICT 后 pending 无法物化、
 * 「查未决」又挡住重新提案——discard 删 pending + 审计 approval_response（status:
 * "discarded"、decisions: []）闭环，之后重新 proposeWithGate 不再被挡。
 * changeId 不存在 → PendingChangeError NOT_FOUND 传播（不写假审计）。
 */
export async function discardWithAudit(
  deps: GateDeps,
  projectId: string,
  artifactId: string,
  changeId: string,
  input: { via?: Via; reason: string },
): Promise<void> {
  const change = deps.pendingStore.get(projectId, artifactId, changeId);
  deps.pendingStore.remove(projectId, artifactId, changeId);
  const via = input.via ?? deps.via;
  await deps.auditPort.append(
    buildApprovalResponseDiscarded(
      { changeId, artifactId, note: input.reason, via },
      {
        presentation: buildApprovalResponseDiscardedPresentation(
          change,
          deps.artifactService.getArtifact(projectId, artifactId),
          input.reason,
        ),
      },
    ),
  );
}
