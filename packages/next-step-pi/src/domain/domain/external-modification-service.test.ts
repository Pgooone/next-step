/**
 * external-modification-service 单测（T1-06 验收断言，S4 外部手改三动作）：
 * 全注入（stub DecisionPort + stub AuditPort 收集数组 + 内存临时目录后端）在 L1 验证，
 * 不碰 pi。断言口径对齐任务卡：
 * 1. check：外部改文件 → modified:true；未改/文件不存在 → false（旧仓 :136 放行语义）。
 * 2. reject（P1-7）：外部手改后拒绝采纳 → 物化文件 = 当前版内容、版本链不变
 *    （版本数不变、无新版本文件）、出现 artifact_external_resolved{action:"reject"} 审计。
 * 3. reject 不经过 assertNotExternallyModified（先改文件再 reject，断言成功而非被挡；
 *    同测对照证明外部检测对普通提交仍生效）。
 * 4. merge：外部内容 → 产生 PendingChange（baseVersion = 当前版）、走逐块确认全流程。
 * 5. 抽取不回归：reject 恢复后检测回到 clean、普通 submitVersion 畅通（与 T1-02 平移的
 *    artifact-service.test.ts EXTERNAL_MODIFIED 用例共用同一 detectExternalModification 实现）。
 */
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactService, ArtifactError } from "./artifact-service";
import { PendingChangeStore } from "./pending-change-service";
import { NEXTSTEP_DIR_NAME } from "../config/paths";
import { ProjectRegistry } from "./project-registry";
import type { AuditEntryPayload } from "../audit/entries";
import type { GateDeps } from "../gate/pending-gate-service";
import { proposeWithGate } from "../gate/pending-gate-service";
import type { AuditPort, Decision, DecisionPort, DecisionRequest } from "../gate/ports";
import {
  checkExternalModification,
  mergeExternalAsProposal,
  rejectExternalModification,
  EXTERNAL_MERGE_SOURCE_ACTOR,
} from "./external-modification-service";

/** stub DecisionPort：按需换响应策略（默认全收）；只返回 Decision、零审计副作用。 */
class StubDecisionPort implements DecisionPort {
  respond: (req: DecisionRequest) => Decision = (req) => ({
    status: "resolved",
    decisions: req.blocks.map((b) => ({ blockId: b.blockId, decision: "accept" as const })),
  });

  async ask(req: DecisionRequest): Promise<Decision> {
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
  dir = mkdtempSync(join(tmpdir(), "ns-t106-external-"));
  registry = new ProjectRegistry(join(dir, "projects.json"));
  projectId = registry.create({ name: "proj", root: dir }).id;
  artifactService = new ArtifactService(registry);
  pendingStore = new PendingChangeStore(registry);
  stubDecision = new StubDecisionPort();
  auditLog = [];
  auditPort = { append: async (entry) => { auditLog.push(entry); } };
  deps = { artifactService, pendingStore, decisionPort: stubDecision, auditPort, via: "web-panel" };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 建一个当前版在 v2 的 artifact（v1→v2 各一块差异），返回 { id, v2, matPath }。 */
function setupArtifactAtV2(): { id: string; v2: string; matPath: string } {
  const artifact = artifactService.createArtifact(projectId, {
    kind: "design",
    title: "设计文档",
    content: "# 设计文档\n旧内容",
  });
  const v2 = "# 设计文档\n新内容\n追加一段";
  artifactService.submitVersion(projectId, artifact.id, { content: v2, note: "to v2" });
  // 物化路径跟 artifact.filePath 走（create 时生成、可能带避让序号），不硬编码文件名。
  return { id: artifact.id, v2, matPath: join(dir, artifact.filePath!) };
}

/** 审计里第一个 artifact_external_resolved 条目（断言 action 用）。 */
function externalResolvedEntry() {
  const entry = auditLog.find((e) => e.kind === "artifact_external_resolved");
  expect(entry).toBeDefined();
  return entry as Extract<AuditEntryPayload, { kind: "artifact_external_resolved" }>;
}

describe("checkExternalModification（检测）", () => {
  it("外部改物化文件 → modified:true + onDiskExcerpt 为磁盘现状", () => {
    const { id, v2, matPath } = setupArtifactAtV2();
    writeFileSync(matPath, "外部手改的内容", "utf-8");

    const status = checkExternalModification({ artifactService }, projectId, id);
    expect(status.modified).toBe(true);
    expect(status.onDiskExcerpt).toBe("外部手改的内容");
    expect(status.onDiskExcerpt).not.toBe(v2);
  });

  it("未改（物化文件 = 当前版）→ modified:false 且无 onDiskExcerpt", () => {
    const { id } = setupArtifactAtV2();
    const status = checkExternalModification({ artifactService }, projectId, id);
    expect(status.modified).toBe(false);
    expect(status.onDiskExcerpt).toBeUndefined();
  });

  it("物化文件被外部删除 → modified:false（旧仓 :136 文件不存在放行语义保持）", () => {
    const { id, matPath } = setupArtifactAtV2();
    rmSync(matPath);
    const status = checkExternalModification({ artifactService }, projectId, id);
    expect(status.modified).toBe(false);
  });

  it("超长外部内容 → onDiskExcerpt 截断到 200 字符 + …（仅预览定位用）", () => {
    const { id, matPath } = setupArtifactAtV2();
    writeFileSync(matPath, "外".repeat(500), "utf-8");
    const status = checkExternalModification({ artifactService }, projectId, id);
    expect(status.onDiskExcerpt).toBe(`${"外".repeat(200)}…`);
  });
});

describe("rejectExternalModification（拒绝采纳，P1-7）", () => {
  it("外部手改后拒绝采纳 → 物化文件 = 当前版内容、版本链不变、审计 reject；且不经外部检测（成功而非被挡）", async () => {
    const { id, v2, matPath } = setupArtifactAtV2();
    writeFileSync(matPath, "外部手改的内容", "utf-8");

    // 对照（卡内断言③+⑤）：同一外部改动下，普通提交仍被检测挡死——证明检测活着、
    // 下面 reject 的成功只能来自用户指令路径（明示绕过），而非检测失效。
    try {
      artifactService.submitVersion(projectId, id, { content: "AI 想写的新内容" });
      expect.unreachable("外部改动下 submitVersion 应抛 EXTERNAL_MODIFIED");
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactError);
      expect((e as ArtifactError).code).toBe("EXTERNAL_MODIFIED");
    }

    // 拒绝采纳：成功、不抛 EXTERNAL_MODIFIED（用户指令路径）。
    const artifact = await rejectExternalModification(deps, projectId, id);

    // 物化文件 = 当前版（v2）内容——外部改动被丢弃。
    expect(readFileSync(matPath, "utf-8")).toBe(v2);
    // 版本链不变：版本数不变、无新版本文件（H4：不出 v{n+1}=v{n} 幽灵版本）。
    expect(artifact.currentVersion).toBe(2);
    expect(artifact.version).toBe(2); // 乐观锁计数也不动（artifact.json 未被改写）
    expect(existsSync(join(dir, NEXTSTEP_DIR_NAME, "artifacts", "managed", id, "versions", "3.json"))).toBe(false);
    expect(artifactService.listVersions(projectId, id)).toHaveLength(2);
    // 审计：artifact_external_resolved {action:"reject"}（H3 第六类），via 记入 note。
    const entry = externalResolvedEntry();
    expect(entry.action).toBe("reject");
    expect(entry.artifactId).toBe(id);
    expect(entry.note).toContain("v2");
    expect(entry.note).toContain("web-panel");

    // 抽取不回归（卡内断言⑤）：恢复后检测回到 clean，普通提交畅通（共用同一比对实现）。
    expect(checkExternalModification({ artifactService }, projectId, id).modified).toBe(false);
    const v3 = artifactService.submitVersion(projectId, id, { content: v2 + "\nv3" });
    expect(v3.currentVersion).toBe(3);
    expect(readFileSync(matPath, "utf-8")).toBe(v2 + "\nv3");
  });

  it("有未决 pending 时拒绝采纳 → 成功恢复系统版本且 pending 保留、baseVersion 不变（基底兜底继续生效）", async () => {
    const { id, v2, matPath } = setupArtifactAtV2();
    // 先落一条未决提案（stub 返回 cancelled → pending 保留），基底 = 当前版 v2。
    stubDecision.respond = () => ({ status: "cancelled" });
    const outcome = await proposeWithGate(deps, projectId, {
      artifactId: id,
      newContent: v2 + "\n提案改动",
      sourceActor: "agent",
    });
    expect(outcome.status).toBe("unconfirmed");
    auditLog.length = 0; // 只看 reject 的审计

    writeFileSync(matPath, "外部手改的内容", "utf-8");
    await rejectExternalModification(deps, projectId, id, { via: "cli-keyboard" });

    expect(readFileSync(matPath, "utf-8")).toBe(v2);
    const pending = pendingStore.listPendingChanges(projectId, id);
    expect(pending).toHaveLength(1);
    expect(pending[0].baseVersion).toBe(2); // pending 针对的基底内容仍是当前版
    expect(externalResolvedEntry().action).toBe("reject");
  });
});

describe("mergeExternalAsProposal（以提案方式合并）", () => {
  it("外部内容 → 产生 PendingChange（baseVersion = 当前版）并走逐块确认全流程至物化出新版", async () => {
    const { id, v2, matPath } = setupArtifactAtV2();
    const external = "# 设计文档\n新内容\n追加一段\n外部补充一\n外部补充二";
    writeFileSync(matPath, external, "utf-8");

    const outcome = await mergeExternalAsProposal(deps, projectId, id);

    // 走完逐块确认全流程：全收 → 物化出新版 v3 = 外部内容（真实文件回到系统管辖）。
    expect(outcome).toMatchObject({ status: "materialized", newVersion: 3 });
    expect(readFileSync(matPath, "utf-8")).toBe(external);
    expect(artifactService.readCurrentContent(projectId, id)).toBe(external);

    // 提案落盘时 baseVersion = 当前版（v2），sourceActor 标识外部合并来源。
    const proposed = auditLog.find((e) => e.kind === "artifact_proposed") as Extract<
      AuditEntryPayload,
      { kind: "artifact_proposed" }
    >;
    expect(proposed.baseVersion).toBe(2);
    expect(proposed.sourceActor).toBe(EXTERNAL_MERGE_SOURCE_ACTOR);

    // 审计序列：提案 → 问询 → 裁决 → 物化，外部合并裁决条目殿后（gate 惯例：动作后写审计）。
    expect(auditLog.map((e) => e.kind)).toEqual([
      "artifact_proposed",
      "approval_request",
      "approval_response",
      "artifact_resolved",
      "artifact_external_resolved",
    ]);
    const entry = externalResolvedEntry();
    expect(entry.action).toBe("merge");
    expect(entry.note).toContain("changeId=");
    expect(entry.note).toContain("web-panel");

    // 合并物化后 pending 清空、外部改动已进版本链。
    expect(pendingStore.listPendingChanges(projectId, id)).toHaveLength(0);
  });

  it("deferred（Entry 端口语义）→ pending 保留（baseVersion = 当前版）、版本链不动、审计含 merge 条目", async () => {
    const { id, v2, matPath } = setupArtifactAtV2();
    const external = "# 设计文档\n新内容\n追加一段\n外部补充";
    writeFileSync(matPath, external, "utf-8");
    stubDecision.respond = () => ({ status: "deferred" });

    const outcome = await mergeExternalAsProposal(deps, projectId, id, { via: "cli-keyboard" });

    expect(outcome.status).toBe("deferred");
    const pending = pendingStore.listPendingChanges(projectId, id);
    expect(pending).toHaveLength(1);
    expect(pending[0].baseVersion).toBe(2);
    expect(pending[0].sourceActor).toBe(EXTERNAL_MERGE_SOURCE_ACTOR);
    // 版本链不动（v2 仍是当前版），等待面板逐块处理；外部内容以提案 newContent 为载体
    // （磁盘已回系统版——P1-7 merge 侧：进提案通道前恢复基底，物化检测天然通过）。
    expect(artifactService.getArtifact(projectId, id).currentVersion).toBe(2);
    expect(readFileSync(matPath, "utf-8")).toBe(v2);
    expect(pending[0].diff).toMatchObject({ kind: "replace", newContent: external });
    expect(externalResolvedEntry().action).toBe("merge");
    expect(externalResolvedEntry().note).toContain("cli-keyboard");
  });

  it("已有未决提案时合并 → pending_exists 前置拦截：磁盘未动（外部内容仍在）、不写 merge 条目", async () => {
    const { id, v2, matPath } = setupArtifactAtV2();
    // 先落一条未决提案（cancelled → pending 保留）。
    stubDecision.respond = () => ({ status: "cancelled" });
    await proposeWithGate(deps, projectId, {
      artifactId: id,
      newContent: v2 + "\n提案改动",
      sourceActor: "agent",
    });
    auditLog.length = 0;

    // 再外部手改 + 尝试合并：外部内容只存在于磁盘，必须先引导处理未决、不得恢复磁盘。
    const external = "# 设计文档\n新内容\n追加一段\n外部补充";
    writeFileSync(matPath, external, "utf-8");
    const outcome = await mergeExternalAsProposal(deps, projectId, id);

    expect(outcome.status).toBe("pending_exists");
    expect(readFileSync(matPath, "utf-8")).toBe(external); // 磁盘未动
    expect(auditLog.some((e) => e.kind === "artifact_external_resolved")).toBe(false);
  });

  it("外部内容与当前版相同 → no_change：不落 pending、不写 external_resolved 条目", async () => {
    const { id, v2, matPath } = setupArtifactAtV2();
    // 外部「改」成了与当前版逐字节相同的内容（例如改了又改回来）。
    writeFileSync(matPath, v2, "utf-8");
    expect(checkExternalModification({ artifactService }, projectId, id).modified).toBe(false);

    const outcome = await mergeExternalAsProposal(deps, projectId, id);

    expect(outcome.status).toBe("no_change");
    expect(pendingStore.listPendingChanges(projectId, id)).toHaveLength(0);
    expect(auditLog.some((e) => e.kind === "artifact_external_resolved")).toBe(false);
  });
});
