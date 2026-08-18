import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactService } from "@pgooone/next-step-pi/src/domain/domain/artifact-service.ts";
import { checkExternalModification } from "@pgooone/next-step-pi/src/domain/domain/external-modification-service.ts";
import { PendingChangeStore } from "@pgooone/next-step-pi/src/domain/domain/pending-change-service.ts";
import { ProjectRegistry } from "@pgooone/next-step-pi/src/domain/domain/project-registry.ts";
import { createWebServer } from "./create-server";
import { WebPanelSessionManager } from "./web-panel-audit";

/**
 * T1-11 端点级集成测试：起真 server（listen(0) 随机端口）+ fetch 真调用 +
 * 断言 JSON 结构与领域终态（裁决→物化 / 守卫拒绝 / 409 语义映射）。
 * 审计断言直接解析 web-panel.jsonl 文件内容（卡内验收断言数据源 = 落盘文件）。
 */

type Api = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; body: any }>;

type Env = {
  tmp: string;
  registry: ProjectRegistry;
  projectId: string;
  artifactService: ArtifactService;
  pendingStore: PendingChangeStore;
  webPanelPath: string;
  api: Api;
};

let env: Env;
let close: () => Promise<void>;

beforeEach(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nextstep-web-test-"));
  const registry = new ProjectRegistry(join(tmp, "projects.json"));
  const project = registry.create({ name: "demo", root: tmp });
  const artifactService = new ArtifactService(registry);
  const pendingStore = new PendingChangeStore(registry);
  const webPanelPath = join(tmp, "web-panel.jsonl");
  const server = createWebServer({
    registry,
    artifactService,
    pendingStore,
    auditSessionManager: new WebPanelSessionManager(webPanelPath),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const api: Api = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  env = { tmp, registry, projectId: project.id, artifactService, pendingStore, webPanelPath, api };
  close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
});

afterEach(async () => {
  await close();
  rmSync(env.tmp, { recursive: true, force: true });
});

/** 建 artifact 并返回 id（content 自定，便于断言物化文件）。 */
function createArtifact(title = "设计文档", content = "v1 内容\n") {
  return env.artifactService.createArtifact(env.projectId, { kind: "md", title, content });
}

/** 外部手改物化文件（模拟 S4：用户在系统外改了真实 .md）。 */
function externallyModify(artifactId: string, content: string): void {
  const abs = env.artifactService.materializedAbsPath(env.projectId, artifactId);
  writeFileSync(abs!, content, "utf-8");
}

/** 经 merge 端点造一条未决提案（外部改 → merge → deferred，pending 落盘）。 */
async function createPendingViaMerge(artifactId: string, externalContent: string) {
  externallyModify(artifactId, externalContent);
  const r = await env.api("POST", `/api/artifacts/${artifactId}/external/merge`);
  expect(r.status).toBe(200);
  return r.body;
}

/** 解析 web-panel.jsonl：每行 = pi 同构 custom 条目，返回 data 数组（含 kind 过滤）。 */
function readAuditData() {
  if (!existsSync(env.webPanelPath)) return [];
  const raw = readFileSync(env.webPanelPath, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const entry = JSON.parse(line);
    return { ...entry, data: entry.data };
  });
}

function auditByKind(kind: string) {
  return readAuditData().filter((e) => e.data.kind === kind);
}

// ---------------------------------------------------------------------------
// 读端点
// ---------------------------------------------------------------------------

describe("GET /api/artifacts（项目下拉 H5 + 列表）", () => {
  it("返回 ProjectRegistry 项目列表与指定项目的 artifact 列表（与 L1 一致）", async () => {
    const created = createArtifact();
    const r = await env.api("GET", "/api/artifacts");
    expect(r.status).toBe(200);
    expect(r.body.projects).toHaveLength(1);
    expect(r.body.projects[0]).toMatchObject({ name: "demo", root: env.tmp });
    expect(r.body.artifacts).toEqual([]); // 未指定 projectId → 空列表，零判断

    const r2 = await env.api("GET", `/api/artifacts?projectId=${env.projectId}`);
    expect(r2.status).toBe(200);
    expect(r2.body.artifacts.map((a: any) => a.id)).toEqual([created.id]);
    expect(env.artifactService.listArtifacts(env.projectId).map((a) => a.id)).toEqual(
      r2.body.artifacts.map((a: any) => a.id),
    );
  });

  it("不存在的 projectId → 404（ProjectError NOT_FOUND 映射）", async () => {
    const r = await env.api("GET", "/api/artifacts?projectId=no-such-project");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("NOT_FOUND");
  });
});

describe("GET /api/artifacts/:id（详情 + 版本链 + 外部检测）", () => {
  it("返回 artifact（含 content）+ 版本链 + external 检测，与 L1 一致", async () => {
    const { id } = createArtifact();
    const r = await env.api("GET", `/api/artifacts/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.artifact).toMatchObject({ id, title: "设计文档", currentVersion: 1, kind: "md" });
    expect(r.body.artifact.content).toBe("v1 内容\n");
    expect(r.body.versions).toHaveLength(1);
    expect(r.body.versions[0].version).toBe(1);
    expect(r.body.external).toEqual({ modified: false });
  });

  it("不存在的 artifact → 404", async () => {
    const r = await env.api("GET", "/api/artifacts/no-such-id");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("NOT_FOUND");
  });
});

describe("GET /api/artifacts/:id/pending（待确认态 + presentation）", () => {
  it("返回 pending 列表 + presentation（与 buildProposalPresentation 同源）", async () => {
    const { id } = createArtifact("提案文档", "old line 1\nold line 2\n");
    await createPendingViaMerge(id, "old line 1\nnew line A\nnew line B\n");
    const r = await env.api("GET", `/api/artifacts/${id}/pending`);
    expect(r.status).toBe(200);
    expect(r.body.changes).toHaveLength(1);
    const { change, presentation } = r.body.changes[0];
    expect(change.artifactId).toBe(id);
    expect(change.baseVersion).toBe(1);
    expect(change.diffBlocks.length).toBeGreaterThan(0);
    expect(env.pendingStore.listPendingChanges(env.projectId, id)).toHaveLength(1); // 与领域终态一致
    expect(presentation.title).toContain("提案文档");
    expect(presentation.badges[0]).toMatchObject({ kind: "pending", text: `待确认 · ${change.diffBlocks.length} 块` });
    expect(presentation.body[0].kind).toBe("diff");
  });
});

// ---------------------------------------------------------------------------
// resolve 端点
// ---------------------------------------------------------------------------

describe("POST /api/artifacts/:id/pending/:changeId/resolve", () => {
  it("全决 → 物化新版本 + 审计 approval_response(via:web-panel, 逐块完整) + artifact_resolved", async () => {
    const { id } = createArtifact("设计文档", "alpha\nbeta\ngamma\n");
    const externalContent = "alpha\nBETA-CHANGED\ngamma\n新增一行\n";
    await createPendingViaMerge(id, externalContent);
    const pending = await env.api("GET", `/api/artifacts/${id}/pending`);
    const changeId = pending.body.changes[0].change.id;
    const blockCount = pending.body.changes[0].change.diffBlocks.length;
    expect(blockCount).toBeGreaterThan(0);

    const r = await env.api("POST", `/api/artifacts/${id}/pending/${changeId}/resolve`, { action: "accept" });
    expect(r.status).toBe(200);
    expect(r.body.materialized).toBe(true);
    expect(r.body.artifact.currentVersion).toBe(2);

    // 领域终态：物化文件 = 外部内容（L1 行级重建会规范化尾行换行，与提案 diff 同源）
    const abs = env.artifactService.materializedAbsPath(env.projectId, id)!;
    expect(readFileSync(abs, "utf-8")).toBe("alpha\nBETA-CHANGED\ngamma\n新增一行");

    // 审计落盘（web-panel.jsonl 文件内容解析比对）
    const responses = auditByKind("approval_response");
    expect(responses).toHaveLength(1);
    expect(responses[0].data).toMatchObject({
      kind: "approval_response",
      changeId,
      artifactId: id,
      status: "resolved",
      via: "web-panel",
    });
    expect(responses[0].data.decisions).toHaveLength(blockCount); // decisions 逐块完整
    for (const d of responses[0].data.decisions) expect(d.decision).toBe("accept");

    const resolved = auditByKind("artifact_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].data).toMatchObject({ kind: "artifact_resolved", changeId, artifactId: id, newVersion: 2 });
    expect(resolved[0].data.acceptedBlocks).toHaveLength(blockCount);
    expect(resolved[0].data.sourceRefs).toHaveLength(blockCount); // confirmed 块 → sourceRef

    // 顺序：approval_response 在前、artifact_resolved 在后
    const kinds = readAuditData().map((e) => e.data.kind);
    expect(kinds.indexOf("approval_response")).toBeLessThan(kinds.indexOf("artifact_resolved"));

    // 行格式 = pi 同构壳
    const raw = readFileSync(env.webPanelPath, "utf-8").trim().split("\n");
    const last = JSON.parse(raw[raw.length - 1]);
    expect(last).toMatchObject({ type: "custom", customType: "next-step", parentId: null });
    expect(typeof last.id).toBe("string");
    expect(typeof last.timestamp).toBe("string");
    expect(last.data.ns).toBe("next-step");
    expect(typeof last.data.ts).toBe("string");
  });

  it("部分块裁决 → materialized:false；继续全决 → 物化且被拒块不进新版", async () => {
    const { id } = createArtifact("设计文档", "alpha\nbeta\ngamma\ndelta\n");
    const externalContent = "ALPHA\nbeta\ngamma\nDELTA\n";
    await createPendingViaMerge(id, externalContent);
    const pending = await env.api("GET", `/api/artifacts/${id}/pending`);
    const { change, presentation } = pending.body.changes[0];
    const blocks = presentation.body[0].diffRef.blocks;

    // 逐块：先拒一块
    const r1 = await env.api("POST", `/api/artifacts/${id}/pending/${change.id}/resolve`, {
      blockId: blocks[0].blockId,
      action: "reject",
    });
    expect(r1.status).toBe(200);
    expect(r1.body.materialized).toBe(false);
    const rejectedBlock = r1.body.change.diffBlocks.find((b: any) => b.id === blocks[0].blockId);
    expect(rejectedBlock.state).toBe("rejected");

    // 剩余全收 → 物化 v2 = 被收块新行 + 被拒块旧行（applyResolvedBlocks 不变量）
    const r2 = await env.api("POST", `/api/artifacts/${id}/pending/${change.id}/resolve`, { action: "accept" });
    expect(r2.status).toBe(200);
    expect(r2.body.materialized).toBe(true);
    expect(r2.body.artifact.currentVersion).toBe(2);
    const abs = env.artifactService.materializedAbsPath(env.projectId, id)!;
    const materialized = readFileSync(abs, "utf-8");
    expect(materialized).toContain("alpha"); // 被拒块保留旧行（applyResolvedBlocks 不变量）
    expect(materialized).toContain("DELTA"); // 被收块用新行
    expect(materialized).not.toContain("ALPHA"); // 被拒块的新行不进新版
    expect(materialized).not.toContain("delta"); // 被收块的旧行被替换

    // 审计 decisions 块级记账：1 拒 N 收
    const responses = auditByKind("approval_response");
    expect(responses).toHaveLength(1);
    const decisions = responses[0].data.decisions;
    expect(decisions.filter((d: any) => d.decision === "reject")).toHaveLength(1);
    expect(decisions.filter((d: any) => d.decision === "accept").length).toBeGreaterThan(0);
    const resolved = auditByKind("artifact_resolved");
    expect(resolved[0].data.rejectedBlocks).toEqual([blocks[0].blockId]);
  });

  it("BASE_VERSION_CONFLICT → 409 + 引导文案，pending 保留（供 discard 闭环）", async () => {
    const { id } = createArtifact("设计文档", "v1 内容\n");
    await createPendingViaMerge(id, "v1 内容\n外部改动\n");
    const pending = await env.api("GET", `/api/artifacts/${id}/pending`);
    const changeId = pending.body.changes[0].change.id;

    // 上游出新版（模拟其他客户端提交）：baseVersion 失效
    env.artifactService.submitVersion(env.projectId, id, { content: "上游新内容\n" });

    const r = await env.api("POST", `/api/artifacts/${id}/pending/${changeId}/resolve`, { action: "accept" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("BASE_VERSION_CONFLICT");
    expect(r.body.message).toContain("请放弃当前提案（discard）后重新提案");

    // pending 保留现场
    const after = await env.api("GET", `/api/artifacts/${id}/pending`);
    expect(after.body.changes).toHaveLength(1);
    // 无物化副作用
    expect(env.artifactService.getArtifact(env.projectId, id).currentVersion).toBe(2);
    // 无审计写回（未物化不记账）
    expect(auditByKind("approval_response")).toHaveLength(0);
  });

  it("非法参数 → 422；块不存在 → 404", async () => {
    const { id } = createArtifact();
    const r = await env.api("POST", `/api/artifacts/${id}/pending/x/resolve`, { action: "maybe" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("INVALID");

    await createPendingViaMerge(id, "外部内容\n");
    const pending = await env.api("GET", `/api/artifacts/${id}/pending`);
    const changeId = pending.body.changes[0].change.id;
    const r2 = await env.api("POST", `/api/artifacts/${id}/pending/${changeId}/resolve`, {
      blockId: "no-such-block",
      action: "accept",
    });
    expect(r2.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// discard 端点
// ---------------------------------------------------------------------------

describe("POST /api/artifacts/:id/pending/:changeId/discard", () => {
  it("删除 pending + 审计 approval_response status:discarded（decisions 空）", async () => {
    const { id } = createArtifact("设计文档", "v1 内容\n");
    await createPendingViaMerge(id, "v1 内容\n外部改动\n");
    const pending = await env.api("GET", `/api/artifacts/${id}/pending`);
    const changeId = pending.body.changes[0].change.id;

    const r = await env.api("POST", `/api/artifacts/${id}/pending/${changeId}/discard`, {
      reason: "上游版本已变更，提案作废",
    });
    expect(r.status).toBe(200);
    expect(r.body.discarded).toBe(true);

    // 领域终态：pending 已删（守卫语义「无 pending 不可 discard」的另一半）
    expect(env.pendingStore.listPendingChanges(env.projectId, id)).toHaveLength(0);
    const after = await env.api("GET", `/api/artifacts/${id}/pending`);
    expect(after.body.changes).toHaveLength(0);

    // 审计：approval_response status:"discarded"、decisions:[]、note 透传
    const responses = auditByKind("approval_response");
    expect(responses).toHaveLength(1);
    expect(responses[0].data).toMatchObject({
      kind: "approval_response",
      changeId,
      artifactId: id,
      status: "discarded",
      via: "web-panel",
      decisions: [],
      note: "上游版本已变更，提案作废",
    });
  });

  it("changeId 不存在 → 404（无 pending 不可 discard 的守卫在 L1）", async () => {
    const { id } = createArtifact();
    const r = await env.api("POST", `/api/artifacts/${id}/pending/no-such-change/discard`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("NOT_FOUND");
    expect(auditByKind("approval_response")).toHaveLength(0); // 不写假审计
  });
});

// ---------------------------------------------------------------------------
// rollback / undo 端点
// ---------------------------------------------------------------------------

describe("POST /api/artifacts/:id/rollback", () => {
  it("有 pending 时 409 拒绝（守卫透传 + 文案对齐原型）", async () => {
    const { id } = createArtifact();
    await createPendingViaMerge(id, "外部内容\n");
    const r = await env.api("POST", `/api/artifacts/${id}/rollback`, { version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("PENDING_EXISTS");
    expect(r.body.message).toBe("有待确认提案未处理，暂不可回滚");
    // 无副作用
    expect(env.artifactService.getArtifact(env.projectId, id).currentVersion).toBe(1);
  });

  it("无 pending 时成功 + 物化目标版内容 + 审计 artifact_rollback(undoing:false)", async () => {
    const { id } = createArtifact("设计文档", "v1 内容\n");
    env.artifactService.submitVersion(env.projectId, id, { content: "v2 内容\n", note: "v2" });

    const r = await env.api("POST", `/api/artifacts/${id}/rollback`, { version: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fromVersion: 2, toVersion: 1, newVersion: 3 });
    // 领域终态：物化文件 = v1 内容；版本链追加
    const abs = env.artifactService.materializedAbsPath(env.projectId, id)!;
    expect(readFileSync(abs, "utf-8")).toBe("v1 内容\n");
    expect(env.artifactService.listVersions(env.projectId, id)).toHaveLength(3);

    const rollbacks = auditByKind("artifact_rollback");
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0].data).toMatchObject({
      kind: "artifact_rollback",
      artifactId: id,
      fromVersion: 2,
      toVersion: 1,
      newVersion: 3,
      undoing: false,
    });
  });

  it("非法 version → 422", async () => {
    const { id } = createArtifact();
    const r = await env.api("POST", `/api/artifacts/${id}/rollback`, { version: "1" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("INVALID");
  });
});

describe("POST /api/artifacts/:id/rollback/undo（P2-8 契约）", () => {
  it("version = 恢复目标版（原 fromVersion）：撤销「回滚到 v2」→ 物化文件 = v4 内容", async () => {
    const { id } = createArtifact("设计文档", "v1 内容\n");
    env.artifactService.submitVersion(env.projectId, id, { content: "v2 内容\n" });
    env.artifactService.submitVersion(env.projectId, id, { content: "v3 内容\n" });
    env.artifactService.submitVersion(env.projectId, id, { content: "v4 内容\n" });

    // 回滚到 v2：fromVersion=4 → v5 = v2 内容
    const rollback = await env.api("POST", `/api/artifacts/${id}/rollback`, { version: 2 });
    expect(rollback.status).toBe(200);
    expect(rollback.body).toEqual({ fromVersion: 4, toVersion: 2, newVersion: 5 });
    let abs = env.artifactService.materializedAbsPath(env.projectId, id)!;
    expect(readFileSync(abs, "utf-8")).toBe("v2 内容\n");

    // 撤销回滚：version = 恢复目标版 4（= 原回滚的 fromVersion，P2-8）→ v6 = v4 内容
    const undo = await env.api("POST", `/api/artifacts/${id}/rollback/undo`, { version: 4 });
    expect(undo.status).toBe(200);
    expect(undo.body).toEqual({ fromVersion: 5, toVersion: 4, newVersion: 6 });
    abs = env.artifactService.materializedAbsPath(env.projectId, id)!;
    expect(readFileSync(abs, "utf-8")).toBe("v4 内容\n");
    expect(env.artifactService.getArtifact(env.projectId, id).currentVersion).toBe(6);
    expect(env.artifactService.listVersions(env.projectId, id)).toHaveLength(6); // 旧版全在

    const rollbacks = auditByKind("artifact_rollback");
    expect(rollbacks).toHaveLength(2);
    expect(rollbacks[1].data).toMatchObject({ fromVersion: 5, toVersion: 4, newVersion: 6, undoing: true });
  });
});

// ---------------------------------------------------------------------------
// external 三端点（S4）
// ---------------------------------------------------------------------------

describe("GET /api/artifacts/:id/external/diff", () => {
  it("外部手改后 modified:true + 块级差异快照 + onDiskExcerpt", async () => {
    const { id } = createArtifact("设计文档", "alpha\nbeta\ngamma\n");
    externallyModify(id, "alpha\nBETA-CHANGED\ngamma\n");
    const r = await env.api("GET", `/api/artifacts/${id}/external/diff`);
    expect(r.status).toBe(200);
    expect(r.body.modified).toBe(true);
    expect(r.body.diff.length).toBeGreaterThan(0);
    expect(r.body.diff[0]).toMatchObject({ kind: "mod" });
    expect(r.body.onDiskExcerpt).toContain("BETA-CHANGED");
    // 与 L1 checkExternalModification 一致
    expect(r.body.modified).toBe(
      checkExternalModification({ artifactService: env.artifactService }, env.projectId, id).modified,
    );
  });

  it("未手改时 modified:false + diff 空", async () => {
    const { id } = createArtifact();
    const r = await env.api("GET", `/api/artifacts/${id}/external/diff`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ modified: false, diff: [] });
  });
});

describe("POST /api/artifacts/:id/external/merge", () => {
  it("外部内容转提案（pending 落盘待确认）+ 审计 artifact_external_resolved action:merge", async () => {
    const { id } = createArtifact("设计文档", "alpha\nbeta\n");
    const externalContent = "alpha\nbeta\nnew line\n";
    const r2 = await createPendingViaMerge(id, externalContent);
    expect(r2.status).toBe("deferred"); // Entry 端口语义：落盘待确认

    // 领域终态：pending 落盘（含完整外部内容），磁盘恢复系统版（提案基底干净）
    const pending = env.pendingStore.listPendingChanges(env.projectId, id);
    expect(pending).toHaveLength(1);
    const abs = env.artifactService.materializedAbsPath(env.projectId, id)!;
    expect(readFileSync(abs, "utf-8")).toBe("alpha\nbeta\n");

    const externals = auditByKind("artifact_external_resolved");
    expect(externals).toHaveLength(1);
    expect(externals[0].data).toMatchObject({ kind: "artifact_external_resolved", artifactId: id, action: "merge" });
  });
});

describe("POST /api/artifacts/:id/external/reject", () => {
  it("物化文件恢复当前版内容、版本链不变 + 审计 artifact_external_resolved action:reject", async () => {
    const { id } = createArtifact("设计文档", "v1 内容\n");
    externallyModify(id, "外部手改内容\n");

    const r = await env.api("POST", `/api/artifacts/${id}/external/reject`);
    expect(r.status).toBe(200);
    expect(r.body.artifact.id).toBe(id);

    // 领域终态：物化文件 = 当前版内容；版本链不变（H4：不生成幽灵版本）
    const abs = env.artifactService.materializedAbsPath(env.projectId, id)!;
    expect(readFileSync(abs, "utf-8")).toBe("v1 内容\n");
    expect(env.artifactService.getArtifact(env.projectId, id).currentVersion).toBe(1);
    expect(env.artifactService.listVersions(env.projectId, id)).toHaveLength(1);

    const externals = auditByKind("artifact_external_resolved");
    expect(externals).toHaveLength(1);
    expect(externals[0].data).toMatchObject({ kind: "artifact_external_resolved", artifactId: id, action: "reject" });
  });
});

// ---------------------------------------------------------------------------
// 审计回放端点（T1-12：P1-4 数据管线——回滚报告「确认过 N 块」的数据源）
// ---------------------------------------------------------------------------

describe("GET /api/audit/replay（审计回放，P1-4）", () => {
  it("返回全部条目；按 artifactId 过滤后含 artifact_resolved.acceptedBlocks（确认过 N 块取数）", async () => {
    const { id } = createArtifact("设计文档", "alpha\nbeta\ngamma\n");
    await createPendingViaMerge(id, "alpha\nBETA\n");
    const pending = await env.api("GET", `/api/artifacts/${id}/pending`);
    const changeId = pending.body.changes[0].change.id;
    const accepted = pending.body.changes[0].change.diffBlocks[0].id;
    await env.api("POST", `/api/artifacts/${id}/pending/${changeId}/resolve`, { action: "accept" });

    const r = await env.api("GET", `/api/audit/replay?artifactId=${id}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.entries)).toBe(true);
    const resolved = r.body.entries.filter((e: any) => e.kind === "artifact_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].acceptedBlocks).toEqual([accepted]); // 「确认过 N 块」计数源
    const proposed = r.body.entries.filter((e: any) => e.kind === "artifact_proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0].diffBlockCount).toBeGreaterThan(0); // 「撤销块数」计数源
  });

  it("无 artifactId 过滤返回全部条目（壳零判断：过滤与否由查询参数透传）", async () => {
    const { id } = createArtifact("设计文档", "v1 内容\n");
    await createPendingViaMerge(id, "v1 内容\n外部改动\n"); // 产生 artifact_external_resolved 审计
    const r = await env.api("GET", "/api/audit/replay");
    expect(r.status).toBe(200);
    expect(r.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(r.body.entries.some((e: any) => e.artifactId === id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 静态资源（T1-12：dist-web 静态托管 + 穿越防护）
// ---------------------------------------------------------------------------

describe("静态资源路由（T1-12 前端产物）", () => {
  it("GET / 返回 index.html；路径穿越 → 404", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nextstep-web-static-"));
    writeFileSync(join(tmp, "index.html"), "<html>panel</html>", "utf-8");
    const registry2 = new ProjectRegistry(join(tmp, "projects.json"));
    const server2 = createWebServer({
      registry: registry2,
      artifactService: new ArtifactService(registry2),
      pendingStore: new PendingChangeStore(registry2),
      auditSessionManager: new WebPanelSessionManager(join(tmp, "web-panel.jsonl")),
      staticDir: tmp,
    });
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const port2 = (server2.address() as AddressInfo).port;
    try {
      const index = await fetch(`http://127.0.0.1:${port2}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toBe("<html>panel</html>");
      expect(index.headers.get("content-type")).toContain("text/html");
      // 未命中 API 的 GET 静态文件
      const f = await fetch(`http://127.0.0.1:${port2}/x.js`);
      expect(f.status).toBe(404);
      // 路径穿越（%2E%2E 编码逃逸）→ 404 不外泄真实路径（服务端不解码 + startsWith 双保险）
      const esc = await fetch(`http://127.0.0.1:${port2}/%2E%2E/package.json`);
      expect(esc.status).toBe(404);
    } finally {
      await new Promise<void>((resolve2) => server2.close(() => resolve2()));
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 静态审查：壳零领域判断（卡内代码审查项的可执行形态）
// ---------------------------------------------------------------------------

describe("壳零领域判断（静态审查）", () => {
  const source = readFileSync(new URL("./create-server.ts", import.meta.url), "utf-8");

  it("handler 层不直接实例化领域存储、不直接写盘", () => {
    // 实例化只允许出现在生产入口 index.ts（装配），create-server 只消费注入的 deps
    expect(source).not.toContain("new ArtifactService(");
    expect(source).not.toContain("new PendingChangeStore(");
    expect(source).not.toContain("new ProjectRegistry(");
    // 写盘只发生在 L1：server 不得直接调用 submitVersion / save / remove / rollback / 原子写
    expect(source).not.toContain(".submitVersion(");
    expect(source).not.toContain(".save(");
    expect(source).not.toContain(".remove(");
    expect(source).not.toContain(".rollback(");
    expect(source).not.toContain("atomicWrite");
  });

  it("所有领域调用走 L1 服务函数（gate / external-modification / store 方法）", () => {
    expect(source).toContain("resolveAndMaterialize");
    expect(source).toContain("rollbackWithAudit");
    expect(source).toContain("rollbackUndoWithAudit");
    expect(source).toContain("discardWithAudit");
    expect(source).toContain("mergeExternalAsProposal");
    expect(source).toContain("rejectExternalModification");
    expect(source).toContain("checkExternalModification");
    expect(source).toContain("findArtifact");
  });
});
