import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NEXTSTEP_DIR_NAME } from "../domain/config/paths";
import { ArtifactService } from "../domain/domain/artifact-service";
import {
  applyResolvedBlocks,
  computeReplaceDiffBlocks,
  PendingChangeStore,
  type DiffBlock,
  type PendingChange,
} from "../domain/domain/pending-change-service";
import { ProjectRegistry } from "../domain/domain/project-registry";
import type { AuditPort, DecisionPort, Decision } from "../domain/gate/ports";
import type { AuditEntryPayload } from "../domain/audit/entries";
import { buildDocTools, type DocToolDeps } from "./doc-tools";
import type { NextStepToolDef, NextStepToolResult } from "./harness-adapter";

/**
 * T1-10 · 六工具工具级集成测试（直接调 execute，hermetic 临时目录后端）。
 *
 * 验收断言落点：
 * - AC-1.1：只读三工具逐一调用返回结构化 JSON（含无变化/边界分支）。
 * - AC-1.2（P1-6 重写）：get_artifact_diff(v1, v2) 的块按全收应用后重建 = v2 内容
 *   （与 applyResolvedBlocks 同不变量——用已物化版本对断言，绕开「未物化提案不可 diff」漂移）。
 * - AC-1.4：只读三工具调用后 pending 目录为空、版本链不变、无审计条目产生。
 * - propose_edit 全流程（stub 确认）：落盘 baseVersion 正确的 PendingChange → 物化新版本 →
 *   sourceRef 随 artifact_resolved 写入（M2a）；取消路径；有未决二次 propose 引导。
 */

/** hermetic fixture：临时目录 + registry + 服务 + 记录型 auditPort。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "ns-doc-tools-"));
  const registry = new ProjectRegistry(join(root, "projects.json"));
  const project = registry.create({ name: "p", root: join(root, "proj"), createIfMissing: true });
  const artifactService = new ArtifactService(registry);
  const pendingStore = new PendingChangeStore(registry, artifactService);
  const auditEntries: AuditEntryPayload[] = [];
  const auditPort: AuditPort = {
    append: async (entry) => {
      auditEntries.push(entry);
    },
  };
  return { root, project, artifactService, pendingStore, auditEntries, auditPort };
}

type Fixture = ReturnType<typeof setup>;

/** stub DecisionPort：返回预设 decisions（默认全收）。 */
function resolvedPort(
  change: { diffBlockCount: number; changeId: string; artifactId: string } | undefined,
  decision: Decision = { status: "resolved", decisions: [] },
): DecisionPort {
  return {
    async ask(req) {
      if (decision.status === "resolved" && decision.decisions.length === 0) {
        // 缺省全收：用请求里的块 id 构造 decisions
        return {
          status: "resolved",
          decisions: req.blocks.map((b) => ({ blockId: b.blockId, decision: "accept" as const })),
        };
      }
      return decision;
    },
  };
}

function toolByName(tools: NextStepToolDef[], name: string): NextStepToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

function execute(tool: NextStepToolDef, args: Record<string, unknown>): Promise<NextStepToolResult> {
  return tool.execute(args, new AbortController().signal);
}

function resultText(result: NextStepToolResult): unknown {
  const text = result.content[0]?.text;
  return JSON.parse(text);
}

/** 返回全 confirmed 的 PendingChange（AC-1.2 重建不变量用）。 */
function allConfirmed(artifactId: string, oldContent: string, newContent: string): PendingChange {
  const blocks: DiffBlock[] = computeReplaceDiffBlocks(oldContent, newContent).map((b) => ({
    ...b,
    state: "confirmed",
  }));
  return {
    id: "rebuild",
    artifactId,
    targetType: "artifact",
    op: "replace",
    diff: { kind: "replace", oldContent, newContent },
    diffBlocks: blocks,
    sourceActor: "test",
    hitlMode: "per_block",
    createdAt: new Date().toISOString(),
    baseVersion: 1,
  };
}

// 内容不带末尾换行：splitLines 会 pop 末尾空行（"a\n" → ["a"]），重建 join("\n")
// 会丢末尾换行——AC-1.2 重建不变量断言避开该领域语义干扰（与既有单测同约定）。
const V1 = "# 设计文档\n\n## 第一节\n这是原文。\n\n## 第二节\n保留段落。";
const V2 = "# 设计文档\n\n## 第一节\n这是**修改后**的正文。\n新增一行。\n\n## 第二节\n保留段落。";

function baseDeps(fx: Fixture, overrides: Partial<DocToolDeps> = {}): DocToolDeps {
  return {
    projectId: fx.project.id,
    sourceActor: "agent-a",
    decisionPort: resolvedPort(undefined),
    auditPort: fx.auditPort,
    artifactService: fx.artifactService,
    pendingStore: fx.pendingStore,
    ...overrides,
  };
}

let fx: Fixture | undefined;
afterEach(() => {
  fx = undefined;
});

describe("buildDocTools 工具集形态", () => {
  it("返回且仅返回六个工具（提议三件套 + 只读三件套，顺序固定）", () => {
    fx = setup();
    const tools = buildDocTools(baseDeps(fx));
    expect(tools.map((t) => t.name)).toEqual([
      "create_artifact",
      "propose_edit",
      "list_artifacts",
      "get_artifact_diff",
      "list_my_artifacts",
      "get_artifact_history",
    ]);
  });

  it("propose_edit 的 description 含「完整新全文」硬约束（双通道之 description 通道）", () => {
    fx = setup();
    const tools = buildDocTools(baseDeps(fx));
    const propose = toolByName(tools, "propose_edit");
    expect(propose.description).toContain("完整的新全文");
    expect(propose.promptGuidelines?.[0] ?? "").toContain("完整的新全文");
  });
});

describe("create_artifact（旧仓搬）", () => {
  it("落 v1 侧车 + 物化真实文件 + 返回 {id,filePath,version:1}", async () => {
    fx = setup();
    const tools = buildDocTools(baseDeps(fx));
    const result = (await execute(toolByName(tools, "create_artifact"), {
      kind: "design",
      title: "设计文档",
      content: V1,
    })) as { content: { text: string }[] };
    const payload = JSON.parse(result.content[0].text) as { id: string; filePath: string; version: number };

    expect(payload.version).toBe(1);
    expect(payload.filePath).toContain("设计文档");
    // 物化真实文件存在且内容 = 首版正文；侧车 versions/1.json 在
    const abs = join(fx.project.root, payload.filePath);
    expect(readFileSync(abs, "utf-8")).toBe(V1);
    expect(
      existsSync(
        join(fx.project.root, NEXTSTEP_DIR_NAME, "artifacts", "managed", payload.id, "versions", "1.json"),
      ),
    ).toBe(true);
  });

  it("空 kind/title → 返回错误文本、不抛", async () => {
    fx = setup();
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "create_artifact"), { kind: "", title: "", content: "" });
    const payload = resultText(result) as { error: string };
    expect(payload.error).toContain("创建文档失败");
    // 未落任何 artifact
    expect(fx.artifactService.listArtifacts(fx.project.id)).toHaveLength(0);
  });
});

describe("propose_edit（改造：gate 全流程）", () => {
  it("stub 确认全收 → 落 baseVersion 正确的 PendingChange → 物化 v2 → sourceRef 随 artifact_resolved 写入（M2a）", async () => {
    fx = setup();
    const artifact = fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    const tools = buildDocTools(baseDeps(fx));

    const result = await execute(toolByName(tools, "propose_edit"), {
      id: artifact.id,
      newContent: V2,
    });
    const payload = resultText(result) as { changeId: string; diffBlockCount: number; note: string };
    expect(payload.changeId).not.toBeNull();
    expect(payload.diffBlockCount).toBeGreaterThan(0);
    expect(payload.note).toContain("确认");

    // ① 物化新版本 v2，内容 = 提案全文；pending 已在全决物化后清理。
    //    author = "user"：L1 物化路径（resolveAndMaterialize → submitVersion）不传 author
    //    的既有语义（旧仓同）；sourceActor 落点在 PendingChange / artifact_proposed 审计。
    const versions = fx.artifactService.listVersions(fx.project.id, artifact.id);
    expect(versions).toHaveLength(2);
    expect(versions[1].content).toBe(V2);
    expect(versions[1].author).toBe("user");
    expect(fx.pendingStore.listPendingChanges(fx.project.id, artifact.id)).toHaveLength(0);
    // 物化文件同步
    const artifactMeta = fx.artifactService.getArtifact(fx.project.id, artifact.id);
    expect(readFileSync(join(fx.project.root, artifactMeta.filePath!), "utf-8")).toBe(V2);

    // ② 审计序列：proposed → request → response → resolved（M2a 落点）；
    //    baseVersion / sourceActor 落盘断言经审计条目验证（全决后 pending 已删，
    //    「pending 落盘时 baseVersion 正确」由取消路径用例直查 pending JSON 兜底）
    const kinds = fx.auditEntries.map((e) => e.kind);
    expect(kinds).toEqual([
      "artifact_proposed",
      "approval_request",
      "approval_response",
      "artifact_resolved",
    ]);
    const proposed = fx.auditEntries.find((e) => e.kind === "artifact_proposed");
    if (proposed && proposed.kind === "artifact_proposed") {
      expect(proposed.baseVersion).toBe(1);
      expect(proposed.sourceActor).toBe("agent-a");
      expect(proposed.diffBlockCount).toBe(payload.diffBlockCount);
    }
    const resolved = fx.auditEntries.find((e) => e.kind === "artifact_resolved");
    expect(resolved).toBeDefined();
    if (resolved && resolved.kind === "artifact_resolved") {
      expect(resolved.newVersion).toBe(2);
      expect(resolved.acceptedBlocks).toHaveLength(payload.diffBlockCount);
      // M2a：confirmed 块数 = sourceRefs 条数；每条 version=2、行区间在界内
      expect(resolved.sourceRefs).toHaveLength(resolved.acceptedBlocks.length);
      for (const ref of resolved.sourceRefs) {
        expect(ref.artifactId).toBe(artifact.id);
        expect(ref.version).toBe(2);
        expect(ref.blockAnchor.lineStart).toBeGreaterThanOrEqual(1);
        expect(ref.blockAnchor.lineEnd).toBeGreaterThanOrEqual(ref.blockAnchor.lineStart);
      }
    }
  });

  it("取消路径（stub cancelled）：返回文本含 changeId 与「已提案未确认」，pending 保留、版本链不变", async () => {
    fx = setup();
    const artifact = fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    const tools = buildDocTools(baseDeps(fx, { decisionPort: resolvedPort(undefined, { status: "cancelled" }) }));

    const result = await execute(toolByName(tools, "propose_edit"), { id: artifact.id, newContent: V2 });
    const payload = resultText(result) as { changeId: string; diffBlockCount: number; note: string };
    // P1-1①：cancelled 不删 pending，工具结果文本含 changeId 与「已提案未确认」
    expect(payload.changeId).not.toBeNull();
    expect(payload.note).toContain("已提案未确认");
    expect(payload.note).toContain(payload.changeId);
    expect(payload.note).toContain("Web 面板或重试处理");

    // pending 保留（供 Web 面板 / discard 处理）、版本链未动、无物化
    const pending = fx.pendingStore.listPendingChanges(fx.project.id, artifact.id);
    expect(pending).toHaveLength(1);
    // 「落盘 baseVersion 正确」的直查断言（全收路径 pending 已删，这里直查 JSON）
    expect(pending[0].baseVersion).toBe(1);
    expect(pending[0].sourceActor).toBe("agent-a");
    expect(fx.artifactService.listVersions(fx.project.id, artifact.id)).toHaveLength(1);
  });

  it("已有未决时二次 propose → changeId:null + 引导先处理（旧仓 :178-186 回归）", async () => {
    fx = setup();
    const artifact = fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    const tools = buildDocTools(baseDeps(fx, { decisionPort: resolvedPort(undefined, { status: "cancelled" }) }));
    // 第一次：取消 → pending 保留
    await execute(toolByName(tools, "propose_edit"), { id: artifact.id, newContent: V2 });
    expect(fx.pendingStore.listPendingChanges(fx.project.id, artifact.id)).toHaveLength(1);

    // 第二次：被「查未决」拦截
    const again = await execute(toolByName(tools, "propose_edit"), { id: artifact.id, newContent: V2 + "\n更多改动。\n" });
    const payload = resultText(again) as { changeId: null; diffBlockCount: number; note: string };
    expect(payload.changeId).toBeNull();
    expect(payload.diffBlockCount).toBe(0);
    expect(payload.note).toContain("已有 1 处待确认变更");
    expect(payload.note).toContain("先处理");
    // 未叠加新 pending
    expect(fx.pendingStore.listPendingChanges(fx.project.id, artifact.id)).toHaveLength(1);
  });

  it("内容无变化 → changeId:null、diffBlockCount:0、无幽灵版本、无审计条目", async () => {
    fx = setup();
    const artifact = fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    const tools = buildDocTools(baseDeps(fx));

    const result = await execute(toolByName(tools, "propose_edit"), { id: artifact.id, newContent: V1 });
    const payload = resultText(result) as { changeId: null; diffBlockCount: number; note: string };
    expect(payload.changeId).toBeNull();
    expect(payload.diffBlockCount).toBe(0);
    expect(payload.note).toContain("内容无变化");
    expect(fx.pendingStore.listPendingChanges(fx.project.id, artifact.id)).toHaveLength(0);
    expect(fx.artifactService.listVersions(fx.project.id, artifact.id)).toHaveLength(1);
    expect(fx.auditEntries).toHaveLength(0);
  });

  it("id 不存在 → 返回错误说明文本、不抛异常", async () => {
    fx = setup();
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "propose_edit"), { id: "no-such-id", newContent: V2 });
    const payload = resultText(result) as { error: string };
    expect(payload.error).toContain("提议修改（请确认 id 是否正确");
    expect(payload.error).toContain("失败：artifact 不存在");
  });
});

describe("list_artifacts（旧仓搬）", () => {
  it("返回含 id 的清单（id/title/kind/currentVersion/filePath）", async () => {
    fx = setup();
    fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "list_artifacts"), {});
    const payload = resultText(result) as { id: string; title: string; kind: string; currentVersion: number; filePath: string }[];
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ title: "设计文档", kind: "design", currentVersion: 1 });
    expect(payload[0].filePath).toContain("设计文档");
  });

  it("空项目 → 空数组", async () => {
    fx = setup();
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "list_artifacts"), {});
    expect(resultText(result)).toEqual([]);
  });
});

/** fixture：v1 + v2 两个已物化版本（AC-1.2 用已物化版本对断言）。 */
function fixtureWithV2() {
  const f = setup();
  const artifact = f.artifactService.createArtifact(f.project.id, {
    kind: "design",
    title: "设计文档",
    content: V1,
    author: "agent-a",
  });
  f.artifactService.submitVersion(f.project.id, artifact.id, {
    content: V2,
    author: "agent-a",
    note: "apply pending x",
  });
  return { ...f, artifact };
}

describe("get_artifact_diff（新写，AC-1.1 / AC-1.2）", () => {

  it("缺省参数 = 相邻上一版 → 当前版：返回结构化 blocks（kind/lines/oldLines/lineStart/lineEnd）", async () => {
    const f = fixtureWithV2();
    const tools = buildDocTools(baseDeps(f));
    const result = await execute(toolByName(tools, "get_artifact_diff"), { artifactId: f.artifact.id });
    const payload = resultText(result) as {
      artifactId: string;
      fromVersion: number;
      toVersion: number;
      blocks: { kind: string; lines: string[]; oldLines?: string[]; lineStart: number; lineEnd: number }[];
    };
    expect(payload.artifactId).toBe(f.artifact.id);
    expect(payload.fromVersion).toBe(1);
    expect(payload.toVersion).toBe(2);
    expect(payload.blocks.length).toBeGreaterThan(0);
    for (const block of payload.blocks) {
      expect(["add", "del", "mod"]).toContain(block.kind);
      expect(Array.isArray(block.lines)).toBe(true);
      expect(block.lineStart).toBeGreaterThanOrEqual(1);
      expect(block.lineEnd).toBeGreaterThanOrEqual(block.lineStart);
      if (block.kind === "mod") expect(Array.isArray(block.oldLines)).toBe(true);
    }
  });

  it("AC-1.2（P1-6 重写）：get_artifact_diff(v1, v2) 的块按全收应用后重建 = v2 内容", async () => {
    const f = fixtureWithV2();
    const tools = buildDocTools(baseDeps(f));
    const result = await execute(toolByName(tools, "get_artifact_diff"), { artifactId: f.artifact.id });
    const payload = resultText(result) as {
      blocks: { kind: string; lines: string[]; oldLines?: string[]; lineStart: number; lineEnd: number }[];
    };

    // 块数 = 同版本 PendingChange 的 diffBlocks 数（同一 LCS 实现，7.2 表断言）
    const sameImpl = computeReplaceDiffBlocks(V1, V2);
    expect(payload.blocks).toHaveLength(sameImpl.length);

    // 重建不变量：把工具输出的块转成全 confirmed 的 DiffBlock，applyResolvedBlocks = V2 内容
    const rebuilt: DiffBlock[] = payload.blocks.map((b) => ({
      id: `blk-${b.lineStart}-${b.lineEnd}`,
      kind: b.kind as DiffBlock["kind"],
      lines: b.lines,
      ...(b.oldLines !== undefined ? { oldLines: b.oldLines } : {}),
      state: "confirmed" as const,
    }));
    const change: PendingChange = {
      id: "rebuild",
      artifactId: f.artifact.id,
      targetType: "artifact",
      op: "replace",
      diff: { kind: "replace", oldContent: V1, newContent: V2 },
      diffBlocks: rebuilt,
      sourceActor: "test",
      hitlMode: "per_block",
      createdAt: new Date().toISOString(),
      baseVersion: 1,
    };
    expect(applyResolvedBlocks(change)).toBe(V2);
    // 双保险：与领域函数直接构造的全 confirmed 重建一致（块内容零漂移）
    expect(applyResolvedBlocks(allConfirmed(f.artifact.id, V1, V2))).toBe(V2);
  });

  it("边界（P2-9）：currentVersion=1 无上一版 → 空 blocks + note「无上一版本可对比」", async () => {
    fx = setup();
    const artifact = fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "get_artifact_diff"), { artifactId: artifact.id });
    const payload = resultText(result) as { fromVersion: number; toVersion: number; blocks: unknown[]; note: string };
    expect(payload.fromVersion).toBe(1);
    expect(payload.toVersion).toBe(1);
    expect(payload.blocks).toEqual([]);
    expect(payload.note).toContain("无上一版本可对比");
  });

  it("显式区间 fromVersion/toVersion 生效；无效区间 → note「版本区间无效」", async () => {
    const f = fixtureWithV2();
    const tools = buildDocTools(baseDeps(f));

    const explicit = await execute(toolByName(tools, "get_artifact_diff"), {
      artifactId: f.artifact.id,
      fromVersion: 1,
      toVersion: 2,
    });
    const explicitPayload = resultText(explicit) as { blocks: unknown[]; note?: string };
    expect(explicitPayload.blocks.length).toBeGreaterThan(0);
    expect(explicitPayload.note).toBeUndefined();

    const invalid = await execute(toolByName(tools, "get_artifact_diff"), {
      artifactId: f.artifact.id,
      fromVersion: 2,
      toVersion: 1,
    });
    const invalidPayload = resultText(invalid) as { blocks: unknown[]; note: string };
    expect(invalidPayload.blocks).toEqual([]);
    expect(invalidPayload.note).toContain("版本区间无效");
  });

  it("id 不存在 → 错误文本、不抛", async () => {
    fx = setup();
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "get_artifact_diff"), { artifactId: "no-such-id" });
    expect((resultText(result) as { error: string }).error).toContain("获取版本差异失败");
  });
});

describe("list_my_artifacts（新写，AC-1.1）", () => {
  it("只列当前 Agent 名下（版本链任一 author = sourceActor）产物 + 末版摘要", async () => {
    fx = setup();
    const mine = fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "我的文档",
      content: V1,
      author: "agent-a",
    });
    fx.artifactService.createArtifact(fx.project.id, {
      kind: "prd",
      title: "别人的文档",
      content: V1,
      author: "user",
    });
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "list_my_artifacts"), {});
    const payload = resultText(result) as {
      id: string;
      title: string;
      kind: string;
      currentVersion: number;
      filePath: string;
      lastChange: { version: number; author: string; createdAt: string };
    }[];
    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe(mine.id);
    expect(payload[0].title).toBe("我的文档");
    expect(payload[0].currentVersion).toBe(1);
    expect(payload[0].lastChange).toMatchObject({ version: 1, author: "agent-a" });
    expect(payload[0].lastChange.createdAt).toBeTruthy();
  });

  it("回滚后末版摘要 note = rollback 格式、author = user（旧仓语义，P3）", async () => {
    fx = setup();
    const artifact = fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "我的文档",
      content: V1,
      author: "agent-a",
    });
    fx.artifactService.submitVersion(fx.project.id, artifact.id, { content: V2, author: "agent-a" });
    fx.artifactService.rollback(fx.project.id, artifact.id, { version: 1 });
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "list_my_artifacts"), {});
    const payload = resultText(result) as { lastChange: { version: number; note: string; author: string } }[];
    expect(payload).toHaveLength(1);
    expect(payload[0].lastChange).toMatchObject({
      version: 3,
      author: "user",
      note: "rollback to v1",
    });
  });
});

describe("get_artifact_history（新写，AC-1.1）", () => {
  it("版本链升序 + title + 每版 version/author/createdAt；rollback 版带 note", async () => {
    fx = setup();
    const artifact = fx.artifactService.createArtifact(fx.project.id, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    fx.artifactService.submitVersion(fx.project.id, artifact.id, { content: V2, author: "agent-a", note: "apply pending x" });
    fx.artifactService.rollback(fx.project.id, artifact.id, { version: 1 });
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "get_artifact_history"), { artifactId: artifact.id });
    const payload = resultText(result) as {
      artifactId: string;
      title: string;
      versions: { version: number; author: string; createdAt: string; note?: string }[];
    };
    expect(payload.artifactId).toBe(artifact.id);
    expect(payload.title).toBe("设计文档");
    expect(payload.versions.map((v) => v.version)).toEqual([1, 2, 3]); // 升序
    expect(payload.versions[0]).toMatchObject({ version: 1, author: "agent-a" });
    expect(payload.versions[2]).toMatchObject({ version: 3, author: "user", note: "rollback to v1" });
    expect(payload.versions[1].note).toBe("apply pending x");
    expect(payload.versions.every((v) => v.createdAt)).toBe(true);
  });

  it("id 不存在 → 错误文本、不抛", async () => {
    fx = setup();
    const tools = buildDocTools(baseDeps(fx));
    const result = await execute(toolByName(tools, "get_artifact_history"), { artifactId: "no-such-id" });
    expect((resultText(result) as { error: string }).error).toContain("获取版本历史失败");
  });
});

describe("AC-1.4：只读三工具零副作用", () => {
  it("调用后 pending 目录为空、版本链不变、无审计条目产生", async () => {
    const f = fixtureWithV2();
    const tools = buildDocTools(baseDeps(f));
    const versionsBefore = f.artifactService.listVersions(f.project.id, f.artifact.id);
    const pendingBefore = f.pendingStore.listPendingChanges(f.project.id, f.artifact.id);
    expect(pendingBefore).toHaveLength(0);

    await execute(toolByName(tools, "get_artifact_diff"), { artifactId: f.artifact.id });
    await execute(toolByName(tools, "list_my_artifacts"), {});
    await execute(toolByName(tools, "get_artifact_history"), { artifactId: f.artifact.id });

    // pending 目录为空（目录不存在或零文件）
    const pendingDir = join(
      f.project.root,
      NEXTSTEP_DIR_NAME,
      "artifacts",
      "managed",
      f.artifact.id,
      "pending",
    );
    if (existsSync(pendingDir)) expect(readdirSync(pendingDir)).toHaveLength(0);
    // 版本链逐条不变（同 id 同 content 同 author）
    const versionsAfter = f.artifactService.listVersions(f.project.id, f.artifact.id);
    expect(versionsAfter).toHaveLength(versionsBefore.length);
    expect(versionsAfter.map((v) => v.content)).toEqual(versionsBefore.map((v) => v.content));
    // 零审计条目
    expect(f.auditEntries).toHaveLength(0);
  });
});
