/**
 * pending-gate-service 闸门编排单测（T1-05 验收断言，详细设计 §3 十步流程）：
 * 全注入 GateDeps（stub DecisionPort + stub AuditPort 收集数组 + 内存临时目录后端）
 * 在 L1 跑通整条确认链，不碰 pi。
 *
 * P1-3 断言纪律：**断言门控的是 gate 编排，不是 stub**——stub DecisionPort 是独立对象，
 * 不持有 auditLog 引用、从不调 auditPort.append（结构上写不了审计）；auditLog 数组只经
 * gate 的 auditPort 注入，落入的每一条都是 gate 编排写出的。
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactService, ArtifactError } from "../domain/artifact-service";
import { PendingChangeStore } from "../domain/pending-change-service";
import { ProjectRegistry } from "../domain/project-registry";
import type { AuditEntryPayload } from "../audit/entries";
import {
  discardWithAudit,
  proposeWithGate,
  rollbackUndoWithAudit,
  rollbackWithAudit,
  GateError,
  type GateDeps,
} from "./pending-gate-service";
import type { AuditPort, Decision, DecisionPort, DecisionRequest } from "./ports";

// ---------------------------------------------------------------------------
// fixture：stub 端口 + 内存临时目录后端
// ---------------------------------------------------------------------------

/** stub DecisionPort：按需换响应策略（默认全收）；只返回 Decision、零审计副作用（P1-3）。 */
class StubDecisionPort implements DecisionPort {
  respond: (req: DecisionRequest) => Decision = (req) => ({
    status: "resolved",
    decisions: req.blocks.map((b) => ({ blockId: b.blockId, decision: "accept" as const })),
  });
  requests: DecisionRequest[] = [];

  async ask(req: DecisionRequest): Promise<Decision> {
    this.requests.push(req);
    return this.respond(req);
  }
}

let dir: string;
let registry: ProjectRegistry;
let artifactService: ArtifactService;
let pendingStore: PendingChangeStore;
let projectId: string;
let stubDecision: StubDecisionPort;
let auditLog: AuditEntryPayload[];
let auditPort: AuditPort;
let deps: GateDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ns-t105-gate-"));
  registry = new ProjectRegistry(join(dir, "projects.json"));
  projectId = registry.create({ name: "proj", root: dir }).id;
  artifactService = new ArtifactService(registry);
  pendingStore = new PendingChangeStore(registry);
  stubDecision = new StubDecisionPort();
  auditLog = [];
  auditPort = { append: async (entry) => { auditLog.push(entry); } };
  deps = { artifactService, pendingStore, decisionPort: stubDecision, auditPort, via: "cli-keyboard" };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 审计条目的 kind 序列（顺序断言用）。 */
function kinds(): string[] {
  return auditLog.map((e) => e.kind);
}

/** 造一个 5 块 mod 的提案场景：建 artifact 直推到 v3，返回 { artifactId, v3, next }。 */
function setupArtifactAtV3(): { artifactId: string; v3: string; next: string } {
  const v1 = "# 设计文档\n开局";
  const artifact = artifactService.createArtifact(projectId, {
    kind: "design",
    title: "设计文档.md",
    content: v1,
  });
  const v3 = [
    "# 设计文档",
    "## §1 内核策略",
    "A1 旧行一",
    "## §2 存储选型",
    "A2 旧行二",
    "## §3 交互设计",
    "A3 旧行三",
    "## §4 交付节奏",
    "A4 旧行四",
    "## §5 风险清单",
    "A5 旧行五",
  ].join("\n");
  // v1 → v2 → v3（currentVersion=3，对齐卡内断言的「v3 基底 → v4 物化」口径）
  artifactService.submitVersion(projectId, artifact.id, { content: v1 + "\nv2", note: "to v2" });
  artifactService.submitVersion(projectId, artifact.id, { content: v3, note: "to v3" });
  const next = [
    "# 设计文档",
    "## §1 内核策略",
    "N1 新行一",
    "## §2 存储选型",
    "N2 新行二",
    "## §3 交互设计",
    "N3 新行三",
    "## §4 交付节奏",
    "N4 新行四",
    "## §5 风险清单",
    "N5 新行五",
  ].join("\n");
  return { artifactId: artifact.id, v3, next };
}

/** 造一个未决 pending（stub 返回 cancelled 落盘保留），返回 changeId。 */
async function leavePending(): Promise<{ artifactId: string; changeId: string }> {
  const { artifactId, next } = setupArtifactAtV3();
  stubDecision.respond = () => ({ status: "cancelled" });
  const outcome = await proposeWithGate(deps, projectId, { artifactId, newContent: next, sourceActor: "designer" });
  expect(outcome.status).toBe("unconfirmed");
  if (outcome.status !== "unconfirmed") throw new Error("unreachable");
  return { artifactId, changeId: outcome.changeId };
}

// ---------------------------------------------------------------------------
// 断言 1：全流程——5 块全收 → v4 物化 + 四条目按序（P1-3：gate 编排写入）
// ---------------------------------------------------------------------------
describe("全流程：5 块全收 → v4 物化", () => {
  it("pending 删除、四条目按序落入 stub AuditPort、v4 = 提案全文", async () => {
    const { artifactId, next } = setupArtifactAtV3();

    const outcome = await proposeWithGate(deps, projectId, {
      artifactId,
      newContent: next,
      sourceActor: "designer",
    });

    expect(outcome).toMatchObject({ status: "materialized", materialized: true, newVersion: 4 });
    // pending 已删（物化即清理）
    expect(pendingStore.listPendingChanges(projectId, artifactId)).toEqual([]);
    // v4 物化 = 提案全文
    expect(artifactService.getArtifact(projectId, artifactId).currentVersion).toBe(4);
    expect(artifactService.readCurrentContent(projectId, artifactId)).toBe(next);

    // 四条目按序（顺序即断言：proposed → request → response → resolved，且无其他）
    expect(kinds()).toEqual([
      "artifact_proposed",
      "approval_request",
      "approval_response",
      "artifact_resolved",
    ]);

    // 条目字段：request 由 gate 在 ask 前写入（P1-3），response/resolved 是 gate 编排产物
    const [proposed, request, response, resolved] = auditLog as Extract<
      AuditEntryPayload,
      { changeId: string }
    >[];
    expect(proposed).toMatchObject({ kind: "artifact_proposed", baseVersion: 3, diffBlockCount: 5, sourceActor: "designer" });
    expect(request).toMatchObject({
      kind: "approval_request",
      status: "pending",
      mode: "block",
      requester: "cli", // via=cli-keyboard → requester=cli
    });
    expect(response).toMatchObject({
      kind: "approval_response",
      status: "resolved",
      via: "cli-keyboard",
      decisions: expect.arrayContaining([expect.objectContaining({ decision: "accept" })]),
    });
    if (response.kind !== "approval_response" || resolved.kind !== "artifact_resolved") {
      throw new Error("unreachable");
    }
    expect(response.decisions).toHaveLength(5);
    expect(resolved).toMatchObject({ newVersion: 4 });
    expect(resolved.acceptedBlocks).toHaveLength(5);
    expect(resolved.rejectedBlocks).toEqual([]);
    // sourceRefs：confirmed 块数 = 条数，version = 物化版本（M2a 只写）
    expect(resolved.sourceRefs).toHaveLength(5);
    for (const ref of resolved.sourceRefs) expect(ref.version).toBe(4);

    // ask 请求形状：5 块、title 版本区间、逐块分档
    expect(stubDecision.requests).toHaveLength(1);
    expect(stubDecision.requests[0].blocks).toHaveLength(5);
    expect(stubDecision.requests[0].title).toBe("设计文档.md v3 → v4");
    expect(stubDecision.requests[0].mode).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 断言 2：部分确认——2 收 3 拒 → v4 = v3 + 被收块；acceptedBlocks/rejectedBlocks 与决策一致
// ---------------------------------------------------------------------------
describe("部分确认：2 收 3 拒", () => {
  it("v4 内容 = v3 + 被收块（applyResolvedBlocks 不变量在编排层复验）", async () => {
    const { artifactId, next } = setupArtifactAtV3();
    stubDecision.respond = (req) => ({
      status: "resolved",
      decisions: req.blocks.map((b, i) => ({
        blockId: b.blockId,
        decision: i < 2 ? ("accept" as const) : ("reject" as const),
      })),
    });

    const outcome = await proposeWithGate(deps, projectId, {
      artifactId,
      newContent: next,
      sourceActor: "designer",
    });

    expect(outcome).toMatchObject({ status: "materialized", newVersion: 4 });
    // 期望内容手写字面量（非 applyResolvedBlocks 回算，避免循环论证）：
    // 前 2 处取新行、后 3 处保留旧行
    const expected = [
      "# 设计文档",
      "## §1 内核策略",
      "N1 新行一",
      "## §2 存储选型",
      "N2 新行二",
      "## §3 交互设计",
      "A3 旧行三",
      "## §4 交付节奏",
      "A4 旧行四",
      "## §5 风险清单",
      "A5 旧行五",
    ].join("\n");
    expect(artifactService.readCurrentContent(projectId, artifactId)).toBe(expected);

    // artifact_resolved.acceptedBlocks / rejectedBlocks 与决策一致
    const resolved = auditLog.find((e) => e.kind === "artifact_resolved");
    if (resolved?.kind !== "artifact_resolved") throw new Error("unreachable");
    const askedIds = stubDecision.requests[0].blocks.map((b) => b.blockId);
    expect(resolved.acceptedBlocks).toEqual(askedIds.slice(0, 2));
    expect(resolved.rejectedBlocks).toEqual(askedIds.slice(2));
    expect(resolved.sourceRefs).toHaveLength(2); // 只为 confirmed 块记 sourceRef
  });
});

// ---------------------------------------------------------------------------
// 断言 3：取消路径（P1-1①）——cancelled → pending 保留、无 response/resolved
// ---------------------------------------------------------------------------
describe("取消路径（P1-1①）", () => {
  it("stub 返回 cancelled → pending 文件仍在、审计无 approval_response/artifact_resolved、返回文本含「已提案未确认」与 changeId", async () => {
    const { artifactId, next } = setupArtifactAtV3();
    stubDecision.respond = () => ({ status: "cancelled" });

    const outcome = await proposeWithGate(deps, projectId, {
      artifactId,
      newContent: next,
      sourceActor: "designer",
    });

    expect(outcome.status).toBe("unconfirmed");
    if (outcome.status !== "unconfirmed") throw new Error("unreachable");
    expect(outcome.materialized).toBe(false);
    expect(outcome.message).toContain("已提案未确认");
    expect(outcome.message).toContain(outcome.changeId);
    // pending 文件仍在（落盘保留，不死锁）
    const pending = pendingStore.listPendingChanges(projectId, artifactId);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(outcome.changeId);
    // 版本链不动
    expect(artifactService.getArtifact(projectId, artifactId).currentVersion).toBe(3);
    // 审计只有 proposed + request（request 由 gate 在 ask 前写入，取消不追加 response/resolved）
    expect(kinds()).toEqual(["artifact_proposed", "approval_request"]);
  });
});

// ---------------------------------------------------------------------------
// 断言 4：回滚守卫（P1-2①）——有未决 pending → 拒绝回滚、版本链不变
// ---------------------------------------------------------------------------
describe("回滚守卫（P1-2①）", () => {
  it("存在未决 pending 时 rollbackWithAudit 抛拒绝、版本链不变", async () => {
    const { artifactId } = await leavePending();
    const before = artifactService.getArtifact(projectId, artifactId);
    const chainLen = artifactService.listVersions(projectId, artifactId).length;

    await expect(
      rollbackWithAudit(deps, projectId, artifactId, { version: 2 }),
    ).rejects.toThrowError(GateError);
    const err = await rollbackWithAudit(deps, projectId, artifactId, { version: 2 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GateError);
    expect((err as GateError).code).toBe("PENDING_EXISTS");
    expect((err as GateError).message).toBe("有待确认提案未处理，暂不可回滚");

    // 版本链不变
    const after = artifactService.getArtifact(projectId, artifactId);
    expect(after.currentVersion).toBe(before.currentVersion);
    expect(artifactService.listVersions(projectId, artifactId)).toHaveLength(chainLen);
    // 无 artifact_rollback 条目（拒绝发生在审计前）
    expect(kinds()).not.toContain("artifact_rollback");
  });

  it("rollbackUndoWithAudit 守卫同上（有 pending 拒绝）", async () => {
    const { artifactId } = await leavePending();
    await expect(
      rollbackUndoWithAudit(deps, projectId, artifactId, { version: 3 }),
    ).rejects.toThrowError(/有待确认提案未处理，暂不可回滚/);
    expect(kinds()).not.toContain("artifact_rollback");
  });
});

// ---------------------------------------------------------------------------
// 断言 5：discard 闭环（P1-2③）——baseVersion 冲突 → discard → 重新提案不被「查未决」挡
// ---------------------------------------------------------------------------
describe("discard 闭环（P1-2③）", () => {
  it("冲突 → discardWithAudit 删 pending + 审计 discarded → 重新 proposeWithGate 成功", async () => {
    // 场景搭建：提案 baseVersion=3（cancelled 留 pending）
    const scenario = await leavePending();
    const id = scenario.artifactId;
    const cid = scenario.changeId;

    // 上游回滚（模拟 Web 面板动作，直调 ArtifactService）：v3 → 回滚 v2 → 当前 v4
    artifactService.rollback(projectId, id, { version: 2 });
    expect(artifactService.getArtifact(projectId, id).currentVersion).toBe(4);

    // resolve 撞 BASE_VERSION_CONFLICT（Web 面板直调 resolveAndMaterialize 的等价路径）、pending 保留
    let thrown: unknown;
    try {
      pendingStore.resolveAndMaterialize(projectId, id, cid, { action: "confirm" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ArtifactError);
    expect((thrown as ArtifactError).code).toBe("BASE_VERSION_CONFLICT");
    expect(pendingStore.listPendingChanges(projectId, id)).toHaveLength(1);

    // discard：删 pending + 审计 approval_response（status: "discarded"、decisions: []）
    await discardWithAudit(deps, projectId, id, cid, { reason: "上游版本已变更，提案作废" });
    expect(pendingStore.listPendingChanges(projectId, id)).toEqual([]);
    const discarded = auditLog.find((e) => e.kind === "approval_response" && e.status === "discarded");
    if (!discarded || discarded.kind !== "approval_response") throw new Error("unreachable");
    expect(discarded.status).toBe("discarded");
    expect(discarded.decisions).toEqual([]);
    expect(discarded.note).toBe("上游版本已变更，提案作废");
    expect(discarded.via).toBe("cli-keyboard");

    // 重新提案成功（闭环出口验证：不被「查未决」挡；新基底 = 当前 v4）
    stubDecision.respond = (req) => ({
      status: "resolved",
      decisions: req.blocks.map((b) => ({ blockId: b.blockId, decision: "accept" as const })),
    });
    const outcome = await proposeWithGate(deps, projectId, {
      artifactId: id,
      newContent: "# 全新内容\n重提案",
      sourceActor: "designer",
    });
    expect(outcome.status).toBe("materialized");
    if (outcome.status !== "materialized") throw new Error("unreachable");
    expect(outcome.newVersion).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 断言 6：查未决——有未决时二次 propose 返回引导先处理（旧仓语义回归）
// ---------------------------------------------------------------------------
describe("查未决（旧仓 doc-tools.ts:178-186 语义回归）", () => {
  it("有未决时二次 propose → 返回引导先处理、不落新 pending、不新增审计", async () => {
    const { artifactId, changeId } = await leavePending();
    const kindsBefore = kinds().length;

    const outcome = await proposeWithGate(deps, projectId, {
      artifactId,
      newContent: "# 另一份内容",
      sourceActor: "designer",
    });

    expect(outcome.status).toBe("pending_exists");
    if (outcome.status !== "pending_exists") throw new Error("unreachable");
    expect(outcome.existingChangeId).toBe(changeId);
    expect(outcome.materialized).toBe(false);
    expect(outcome.message).toContain("请先处理");
    // 仍只有原来那 1 条 pending、审计零新增（拦截发生在 append 之前）
    expect(pendingStore.listPendingChanges(projectId, artifactId)).toHaveLength(1);
    expect(kinds()).toHaveLength(kindsBefore);
  });
});

// ---------------------------------------------------------------------------
// 断言 7：撤销回滚——rollbackUndoWithAudit 以 fromVersion 内容生成新版本、undoing:true
// ---------------------------------------------------------------------------
describe("撤销回滚（P2-8 契约）", () => {
  it("回滚 v2 后撤销（恢复目标 = 原回滚 fromVersion=4）→ 新版本 = v4 内容、undoing:true", async () => {
    // 干净链推到 v4（无 pending）
    const { artifactId } = setupArtifactAtV3();
    const v4Content = "# 设计文档\nv4 内容";
    artifactService.submitVersion(projectId, artifactId, { content: v4Content, note: "to v4" });

    // 回滚到 v2：fromVersion=4 → v5 = v2 内容
    const rb = await rollbackWithAudit(deps, projectId, artifactId, { version: 2 });
    expect(rb).toEqual({ fromVersion: 4, toVersion: 2, newVersion: 5 });
    expect(artifactService.readCurrentContent(projectId, artifactId)).toBe(
      artifactService.getVersion(projectId, artifactId, 2).content,
    );
    const rbEntry = auditLog.at(-1);
    if (rbEntry?.kind !== "artifact_rollback") throw new Error("unreachable");
    expect(rbEntry).toMatchObject({
      fromVersion: 4,
      toVersion: 2,
      newVersion: 5,
      undoing: false,
      note: "rollback to v2",
    });

    // 撤销回滚：恢复目标 = 原回滚的 fromVersion（4）→ v6 = v4 内容
    const undo = await rollbackUndoWithAudit(deps, projectId, artifactId, { version: 4 });
    expect(undo).toEqual({ fromVersion: 5, toVersion: 4, newVersion: 6 });
    expect(artifactService.readCurrentContent(projectId, artifactId)).toBe(v4Content);
    expect(artifactService.getVersion(projectId, artifactId, 6).content).toBe(
      artifactService.getVersion(projectId, artifactId, 4).content,
    );
    const undoEntry = auditLog.at(-1);
    if (undoEntry?.kind !== "artifact_rollback") throw new Error("unreachable");
    expect(undoEntry).toMatchObject({
      fromVersion: 5,
      toVersion: 4,
      newVersion: 6,
      undoing: true,
      note: "undo rollback to v4",
    });
    // 回滚版 v5 仍在版本链上（回滚 = 追加，不删旧版）
    expect(artifactService.listVersions(projectId, artifactId).map((v) => v.version)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });
});

// ---------------------------------------------------------------------------
// deferred 分支（Entry 端口，本期不接线——单测覆盖类型）
// ---------------------------------------------------------------------------
describe("deferred 分支（EntryDecisionPort 第一期语义）", () => {
  it("ask 返回 deferred → pending 保留、审计仅 proposed + request、返回等待面板处理", async () => {
    const { artifactId, next } = setupArtifactAtV3();
    stubDecision.respond = () => ({ status: "deferred" });

    const outcome = await proposeWithGate(deps, projectId, {
      artifactId,
      newContent: next,
      sourceActor: "designer",
    });

    expect(outcome.status).toBe("deferred");
    if (outcome.status !== "deferred") throw new Error("unreachable");
    expect(outcome.materialized).toBe(false);
    expect(typeof outcome.changeId).toBe("string");
    expect(pendingStore.listPendingChanges(projectId, artifactId)).toHaveLength(1);
    // ask 路径仍产生 approval_request（P1-3：request 由 gate 在 ask 前写入，与端口返回值无关）
    expect(kinds()).toEqual(["artifact_proposed", "approval_request"]);
  });
});

// ---------------------------------------------------------------------------
// 空块：内容无变化（卡实现要点②，不落 pending）
// ---------------------------------------------------------------------------
describe("空块（内容无变化）", () => {
  it("newContent 与当前版相同 → no_change、不落 pending、零审计", async () => {
    const { artifactId, v3 } = setupArtifactAtV3();
    const outcome = await proposeWithGate(deps, projectId, {
      artifactId,
      newContent: v3,
      sourceActor: "designer",
    });
    expect(outcome).toMatchObject({ status: "no_change", materialized: false });
    if (outcome.status !== "no_change") throw new Error("unreachable");
    expect(outcome.message).toBe("内容无变化，未创建待确认变更。");
    expect(pendingStore.listPendingChanges(projectId, artifactId)).toEqual([]);
    expect(auditLog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L1 红线（§2.1 / B1）：本卡文件零 UI 上下文引用、零 pi import
// ---------------------------------------------------------------------------
describe("L1 红线", () => {
  it("pending-gate-service.ts grep 不到 UI 上下文引用（ctx.ui 零命中）", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./pending-gate-service.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toContain("ctx.ui");
  });

  it("pending-gate-service.ts 无 pi（@earendil-works）import", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./pending-gate-service.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toContain("@earendil-works");
  });
});
