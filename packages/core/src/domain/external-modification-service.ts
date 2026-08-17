import { readFileSync } from "node:fs";
import { ArtifactError, ArtifactService, detectExternalModification } from "./artifact-service";
import { buildArtifactExternalResolved } from "../audit/entries";
import {
  proposeWithGate,
  type GateDeps,
  type ProposalOutcome,
  type Via,
} from "../gate/pending-gate-service";

/**
 * 外部手改处理三动作（T1-06，S4 / P1-7 / H3 / H4）：check（检测）/ reject（拒绝采纳，
 * 覆盖式物化恢复系统版本）/ merge（以提案方式合并，外部改动转 propose 提案走逐块确认通道）。
 *
 * 比对逻辑不复刻：检测统一走 {@link detectExternalModification}（从旧仓
 * assertNotExternallyModified 抽取的公共纯函数），与 submit/rollback 的写盘前断言共用同一实现。
 * 本文件零 pi import、零 UI 依赖（§2.1 红线）。
 */

/** check 只消费 ArtifactService（读当前版快照 + 物化文件现状）。 */
export type ExternalModificationDeps = Pick<GateDeps, "artifactService">;

/** checkExternalModification 的返回（详设 §6）：modified + 面板预览用的磁盘现状摘录。 */
export type ExternalModificationStatus = { modified: boolean; onDiskExcerpt?: string };

/**
 * 检测物化真实文件是否被外部手改：读文件现状 vs 当前版快照 content 逐字节比对
 * （{@link detectExternalModification}，旧仓 :130-144 语义原样）。文件不存在（被外部删）
 * → 未修改（:136 放行语义保持）。第一期由面板「打开时 + 每次渲染前」调用（显示层检测；
 * submit/rollback 写盘前检测原样保留，两处共用同一比对实现）。artifact 不存在抛 NOT_FOUND。
 */
export function checkExternalModification(
  deps: ExternalModificationDeps,
  projectId: string,
  artifactId: string,
): ExternalModificationStatus {
  const artifact = deps.artifactService.getArtifact(projectId, artifactId); // NOT_FOUND + 当前版 content
  const abs = deps.artifactService.materializedAbsPath(projectId, artifactId);
  return detectExternalModification(abs, artifact.content);
}

/**
 * 拒绝采纳外部手改（P1-7 核心）：**覆盖式物化**——把当前版 content 原子写回物化文件
 * （ArtifactService.rematerializeCurrentVersion，tmp+rename），丢弃外部改动、恢复系统版本。
 *
 * **明示语义：这是用户指令路径，绕过 assertNotExternallyModified**——旧仓该检测挡的是
 * 「AI 静默覆盖」；此处覆盖是用户显式选择「拒绝采纳，恢复系统版本」，走检测会把自己挡死。
 * （故实现**不调 submitVersion/rollback**：两者都会先过外部检测且出新版。）
 *
 * **不生成新版本（H4 定案）**：内容未变（= 当前版 content），生成 v{n+1}=v{n} 是幽灵版本，
 * 污染 get_artifact_history；artifact.json 也不动。有未决 pending 时不受影响：pending 针对的
 * 基底内容仍是当前版，baseVersion 校验继续兜底。
 *
 * 动作成功后写审计 `artifact_external_resolved` {action:"reject"}（H3 第六类；条目 schema
 * v1 冻结无 via 字段，via 记入 note 供 S1⑤ 按来源检视）。返回恢复后的 Artifact 元数据。
 */
export async function rejectExternalModification(
  deps: GateDeps,
  projectId: string,
  artifactId: string,
  input?: { via?: Via },
): Promise<ReturnType<ArtifactService["rematerializeCurrentVersion"]>> {
  // 用户指令路径的合法覆盖写（明示绕过外部检测，语义标注在 rematerializeCurrentVersion）。
  const artifact = deps.artifactService.rematerializeCurrentVersion(projectId, artifactId);
  const via = input?.via ?? deps.via;
  await deps.auditPort.append(
    buildArtifactExternalResolved({
      artifactId,
      action: "reject",
      note: `拒绝采纳外部手改，恢复系统版本 v${artifact.currentVersion}（via ${via}）`,
    }),
  );
  return artifact;
}

/** merge 提案的 sourceActor：标识「这条提案来自外部手改合并」（区别于 agent 发起的 propose_edit）。 */
export const EXTERNAL_MERGE_SOURCE_ACTOR = "external-merge";

/**
 * 以提案方式合并外部手改（原型 extMerge 语义）：读外部内容 → 以其为 newContent 调
 * {@link proposeWithGate}，走同一条逐块确认通道（T1-05 复用，本卡只做接线，不另造机制；
 * baseVersion = 提案创建时 currentVersion，由 proposeWithGate 内部落盘）。
 *
 * **物化基底处理（P1-7 的 merge 侧落点）**：外部内容此刻在磁盘上 ≠ 当前版，若直接进提案，
 * 全决物化时 submitVersion 的外部检测（磁盘 vs 上一当前版）会把合并自己挡死。故在进入
 * 提案通道**前**先把物化文件恢复系统版（rematerializeCurrentVersion 的用户指令路径——
 * 用户点「以提案方式合并」即明示）：外部内容起以提案 newContent 为唯一载体（diff 里有完整
 * 新旧全文，不会丢），整条 propose→确认→物化走干净基底，**无需绕过任何检测**（D10 红线完整）。
 * 取消/挂起时磁盘保持系统版、pending 保留完整外部内容，面板可继续处理。
 *
 * 先决分支（均不动磁盘）：外部内容与当前版逐字相同 → 直接透传（no_change）；已有未决提案 →
 * pending_exists 引导先处理（此时外部内容只存在于磁盘，恢复系统版会把它清掉，必须拦截）。
 *
 * 提案产生（materialized / unconfirmed / deferred）→ 写审计 `artifact_external_resolved`
 * {action:"merge"}（H3 第六类，标记提案来源是外部合并裁决）。物化文件不存在 → NOT_FOUND
 * （check 对文件不存在报 modified:false，正常链路到不了这里，防御分支）。
 */
export async function mergeExternalAsProposal(
  deps: GateDeps,
  projectId: string,
  artifactId: string,
  input?: { via?: Via },
): Promise<ProposalOutcome> {
  const abs = deps.artifactService.materializedAbsPath(projectId, artifactId);
  if (!abs) {
    throw new ArtifactError("NOT_FOUND", `物化文件不存在，无可合并的外部内容: ${artifactId}`);
  }
  const external = readFileSync(abs, "utf-8");
  const artifact = deps.artifactService.getArtifact(projectId, artifactId);

  if (external === artifact.content) {
    // 磁盘现状即当前版：无外部改动，直接透传（proposeWithGate 判 no_change，零副作用）。
    return proposeWithGate(deps, projectId, {
      artifactId,
      newContent: external,
      sourceActor: EXTERNAL_MERGE_SOURCE_ACTOR,
    });
  }

  const existing = deps.pendingStore.listPendingChanges(projectId, artifactId);
  if (existing.length > 0) {
    // 查未决语义与 proposeWithGate ①一致（D-V2-05）；此处必须前置——磁盘恢复不可逆于
    // 未转入提案的外部内容。
    return {
      status: "pending_exists",
      existingChangeId: existing[0].id,
      diffBlockCount: 0,
      materialized: false,
      message: `该文档已有 ${existing.length} 处待确认变更（changeId=${existing[0].id}），请先处理（确认/拒绝）后再合并外部改动。`,
    };
  }

  // 用户指令路径的合法恢复写（语义标注在 rematerializeCurrentVersion）：磁盘回系统版，
  // 外部内容自此由提案 diff 承载。
  deps.artifactService.rematerializeCurrentVersion(projectId, artifactId);

  const outcome = await proposeWithGate(deps, projectId, {
    artifactId,
    newContent: external,
    sourceActor: EXTERNAL_MERGE_SOURCE_ACTOR,
  });

  if (outcome.status !== "pending_exists" && outcome.status !== "no_change") {
    const via = input?.via ?? deps.via;
    await deps.auditPort.append(
      buildArtifactExternalResolved({
        artifactId,
        action: "merge",
        note: `外部手改转为提案（changeId=${outcome.changeId}，${outcome.status}，via ${via}）`,
      }),
    );
  }
  return outcome;
}
