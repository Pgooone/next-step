import type { DiffBlock, PendingChange } from "../domain/pending-change-service";
import type { Presentation } from "../presentation/types";
import { buildSourceRefs, type SourceRef } from "./source-refs";

/**
 * 审计条目族 **v1（冻结）** —— 详细设计 §1.3 + 评审裁决 H3 定案：六类冻结，
 * 后续加类型走扩展流程（新增 payload 类型 + 复用 PresentationBlock 组合，两壳渲染器零改动，
 * 正本 §5.2 规约 2）。所有条目经 AuditPort（appendEntry 的自定义条目载荷）写入会话
 * JSONL：`type: "custom"`、持久化、不进 LLM 上下文。
 *
 * 本模块零 pi import、零 IO——落盘走 AuditPort 注入（L2 提供 pi 实现，T1-07）。
 */

/** 条目类型标识（v1 冻结，H3）。 */
export type AuditKind =
  | "artifact_proposed" // propose_edit 落盘 PendingChange 时
  | "artifact_resolved" // PendingChange 全决物化出新版时（含 sourceRefs）
  | "artifact_rollback" // 回滚 / 撤销回滚（= 又一次回滚）时
  | "approval_request" // DecisionPort.ask 发起问询时（status: pending）
  | "approval_response" // 用户裁决落定时（含逐块明细；discard 亦走此类）
  | "artifact_external_resolved"; // 外部手改三动作的裁决（H3 第六类：merge | reject）

/** propose_edit 落盘 PendingChange 时写入。 */
type ArtifactProposed = {
  kind: "artifact_proposed";
  changeId: string;
  artifactId: string;
  /** 提案创建时的基底版本快照（详设 §1.1，调查缺口②）。 */
  baseVersion: number;
  diffBlockCount: number;
  sourceActor: string;
  /** 块类型统计（「1 修改 / 1 新增 / 1 删除…」，按首次出现顺序）。 */
  diffSummary: { kind: DiffBlock["kind"]; count: number }[];
};

/** PendingChange 全决物化出新版时写入（confirmed 块 → sourceRefs 随本条目落盘，M2a）。 */
type ArtifactResolved = {
  kind: "artifact_resolved";
  changeId: string;
  artifactId: string;
  newVersion: number;
  acceptedBlocks: string[]; // confirmed 块 id
  rejectedBlocks: string[]; // rejected 块 id
  sourceRefs: SourceRef[];
};

/** 回滚 / 撤销回滚时写入（撤销回滚 = 以恢复目标版再回滚一次，undoing: true）。 */
type ArtifactRollback = {
  kind: "artifact_rollback";
  artifactId: string;
  fromVersion: number; // 回滚前 currentVersion
  toVersion: number; // 用户点选的目标版（撤销回滚 = 恢复目标版，P2-8）
  newVersion: number; // 追加生成的新版本号（= fromVersion + 1）
  undoing: boolean; // true = 撤销回滚（再回滚一次）
  note: string; // "rollback to v{n}" / "undo rollback to v{n}"
};

/**
 * DecisionPort.ask 发起问询时写入（status 恒为 pending）。
 * P1-3 定案：写入责任归 **gate 编排**（T1-05，ask 前 append）——端口只返回 Decision；
 * 仅在 ask 路径产生，Web 面板直接写回无问询 → 不产生 request 条目。
 */
type ApprovalRequest = {
  kind: "approval_request";
  changeId: string;
  artifactId: string;
  status: "pending";
  mode: "block" | "whole"; // 问询分档（D6：逐块 / 整块）
  requester: "cli" | "entry"; // 哪个端口实现发起（审计可检视）
};

/**
 * 用户裁决落定时写入。status 扩展 "discarded" 是 P1-2 discard 审计的承接：
 * discarded 时 decisions=[]、note 说明放弃原因（如「上游版本已变更，提案作废」）。
 */
type ApprovalResponse = {
  kind: "approval_response";
  changeId: string;
  artifactId: string;
  status: "resolved" | "discarded";
  /** 记账永远块级（D6 红线）；discarded 时为空数组。 */
  decisions: { blockId: string; decision: "accept" | "reject" }[];
  /** 裁决通道（S1⑤「每次裁决落入 append-only 日志」按来源可检视）。 */
  via: "cli-keyboard" | "web-panel";
  /** discarded 时的放弃原因说明。 */
  note?: string;
};

/**
 * 外部手改处理三动作的裁决（H3 定案第六类）：拒绝采纳不是 PendingChange 全决
 * （无 diffBlocks、无新版本，H4：不生成幽灵版本），不并入 artifact_resolved，
 * 避免污染其 acceptedBlocks / sourceRefs；第三期归因不解析 note 字符串。
 */
type ArtifactExternalResolved = {
  kind: "artifact_external_resolved";
  artifactId: string;
  action: "merge" | "reject"; // 以提案方式合并 / 拒绝采纳恢复系统版
  note: string;
};

/** 顶层统一壳字段（appendEntry 的自定义条目载荷公共部分，ns 区分第三方扩展条目）。 */
type AuditEntryShell = {
  ns: "next-step";
  ts: string; // ISO-8601
  /** 纯数据呈现（§1.4），两壳通用渲染器消费。 */
  presentation?: Presentation;
};

/** 六类完整条目（壳 + 专属字段）；构建函数的返回类型（比联合更窄，便于消费方取字段）。 */
export type ArtifactProposedEntry = AuditEntryShell & ArtifactProposed;
export type ArtifactResolvedEntry = AuditEntryShell & ArtifactResolved;
export type ArtifactRollbackEntry = AuditEntryShell & ArtifactRollback;
export type ApprovalRequestEntry = AuditEntryShell & ApprovalRequest;
export type ApprovalResponseEntry = AuditEntryShell & ApprovalResponse;
export type ArtifactExternalResolvedEntry = AuditEntryShell & ArtifactExternalResolved;

/**
 * 顶层统一壳：壳字段分配进六类条目（等价于「壳 & 联合」，写成分配式使 kind 成为
 * 判别字段，消费方可按 entry.kind 窄化取专属字段）。
 */
export type AuditEntryPayload =
  | ArtifactProposedEntry
  | ArtifactResolvedEntry
  | ArtifactRollbackEntry
  | ApprovalRequestEntry
  | ApprovalResponseEntry
  | ArtifactExternalResolvedEntry;

/** 构建可选项：ts 可注入（默认当前时间）便于测试确定性；presentation 由调用方构建挂入。 */
export type AuditEntryOptions = { ts?: string; presentation?: Presentation };

/** 壳字段构建（ts 缺省当前时间；presentation 可选挂入）。 */
function shell(opts?: AuditEntryOptions): AuditEntryShell {
  return {
    ns: "next-step",
    ts: opts?.ts ?? new Date().toISOString(),
    ...(opts?.presentation !== undefined ? { presentation: opts.presentation } : {}),
  };
}

/** diffSummary 统计：按块首次出现顺序累计各 kind 数量（稳定可断言）。 */
export function summarizeBlocks(blocks: DiffBlock[]): { kind: DiffBlock["kind"]; count: number }[] {
  const order: DiffBlock["kind"][] = [];
  const counts = new Map<DiffBlock["kind"], number>();
  for (const b of blocks) {
    if (!counts.has(b.kind)) {
      order.push(b.kind);
      counts.set(b.kind, 0);
    }
    counts.set(b.kind, counts.get(b.kind)! + 1);
  }
  return order.map((kind) => ({ kind, count: counts.get(kind)! }));
}

/** propose_edit 落盘后写入（领域字段全部取自 PendingChange，无 IO）。 */
export function buildArtifactProposed(
  change: PendingChange,
  opts?: AuditEntryOptions,
): ArtifactProposedEntry {
  return {
    ...shell(opts),
    kind: "artifact_proposed",
    changeId: change.id,
    artifactId: change.artifactId,
    baseVersion: change.baseVersion,
    diffBlockCount: change.diffBlocks.length,
    sourceActor: change.sourceActor,
    diffSummary: summarizeBlocks(change.diffBlocks),
  };
}

/** 全决物化成功后写入（含 sourceRefs：confirmed 块 → buildSourceRefs）。 */
export function buildArtifactResolved(
  change: PendingChange,
  newVersion: number,
  opts?: AuditEntryOptions,
): ArtifactResolvedEntry {
  return {
    ...shell(opts),
    kind: "artifact_resolved",
    changeId: change.id,
    artifactId: change.artifactId,
    newVersion,
    acceptedBlocks: change.diffBlocks.filter((b) => b.state === "confirmed").map((b) => b.id),
    rejectedBlocks: change.diffBlocks.filter((b) => b.state === "rejected").map((b) => b.id),
    sourceRefs: buildSourceRefs(change, newVersion),
  };
}

/** 回滚 / 撤销回滚后写入；newVersion = fromVersion + 1，note 对齐版本链 note 格式（详设 §1.3）。 */
export function buildArtifactRollback(
  args: { artifactId: string; fromVersion: number; toVersion: number; undoing: boolean },
  opts?: AuditEntryOptions,
): ArtifactRollbackEntry {
  return {
    ...shell(opts),
    kind: "artifact_rollback",
    artifactId: args.artifactId,
    fromVersion: args.fromVersion,
    toVersion: args.toVersion,
    newVersion: args.fromVersion + 1,
    undoing: args.undoing,
    note: args.undoing
      ? `undo rollback to v${args.toVersion}`
      : `rollback to v${args.toVersion}`,
  };
}

/** gate 编排在 ask 前写入（P1-3：写入责任归 gate 编排，端口只返回 Decision）。 */
export function buildApprovalRequest(
  args: { changeId: string; artifactId: string; mode: "block" | "whole"; requester: "cli" | "entry" },
  opts?: AuditEntryOptions,
): ApprovalRequestEntry {
  return {
    ...shell(opts),
    kind: "approval_request",
    changeId: args.changeId,
    artifactId: args.artifactId,
    status: "pending",
    mode: args.mode,
    requester: args.requester,
  };
}

/** 用户裁决落定（status: resolved，decisions 逐块记账）。 */
export function buildApprovalResponse(
  args: {
    changeId: string;
    artifactId: string;
    decisions: { blockId: string; decision: "accept" | "reject" }[];
    via: "cli-keyboard" | "web-panel";
  },
  opts?: AuditEntryOptions,
): ApprovalResponseEntry {
  return {
    ...shell(opts),
    kind: "approval_response",
    changeId: args.changeId,
    artifactId: args.artifactId,
    status: "resolved",
    decisions: args.decisions,
    via: args.via,
  };
}

/** 提案放弃（status: discarded，P1-2）：decisions=[]，note 说明放弃原因。 */
export function buildApprovalResponseDiscarded(
  args: {
    changeId: string;
    artifactId: string;
    note: string;
    via: "cli-keyboard" | "web-panel";
  },
  opts?: AuditEntryOptions,
): ApprovalResponseEntry {
  return {
    ...shell(opts),
    kind: "approval_response",
    changeId: args.changeId,
    artifactId: args.artifactId,
    status: "discarded",
    decisions: [],
    via: args.via,
    note: args.note,
  };
}

/** 外部手改处理裁决（H3 第六类）。 */
export function buildArtifactExternalResolved(
  args: { artifactId: string; action: "merge" | "reject"; note: string },
  opts?: AuditEntryOptions,
): ArtifactExternalResolvedEntry {
  return {
    ...shell(opts),
    kind: "artifact_external_resolved",
    artifactId: args.artifactId,
    action: args.action,
    note: args.note,
  };
}
