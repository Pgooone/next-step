import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactService } from "../domain/domain/artifact-service";
import { PendingChangeStore } from "../domain/domain/pending-change-service";
import { ProjectRegistry } from "../domain/domain/project-registry";
import type { AuditPort, DecisionPort, Decision } from "../domain/gate/ports";
import { createHarnessAdapter } from "./harness-adapter";
import { assembleDocSession, DOC_TOOLS_EXCLUDE, DOC_TOOLS_WHITELIST, MANAGED_PATH_BLOCK_REASON } from "./session-assembly";
import { createStubModel, type StubModel } from "./test-helpers";

/**
 * T1-10 · doc 会话装配级集成测试（SessionManager.inMemory + stub 模型 + stub DecisionPort）。
 *
 * 验收断言落点：
 * - AC-1.3：doc 会话装配后工具注册表不含 write/edit/bash（白名单 + excludeTools + 模型工具面
 *   三重断言）。
 * - 受管路径守卫：伪造 write 到受管 .md 的 tool_call → { block: true }；read 放行。
 * - 六工具全链路（模型真调）：create_artifact → propose_edit（stub 确认）→ 物化 →
 *   list_artifacts / get_artifact_history 可见新版本（AC-1.1 / S5③）；取消路径 pending 保留。
 * - AC-1.4：只读三工具调用后 pending 目录为空、版本链不变、无新审计条目。
 */

const V1 = "# 设计文档\n\n## 第一节\n这是原文。\n\n## 第二节\n保留段落。";
const V2 = "# 设计文档\n\n## 第一节\n这是**修改后**的正文。\n新增一行。\n\n## 第二节\n保留段落。";

/** 无操作端口（装配内部有真实接线；SessionStartOptions 的必填字段只存不用）。 */
const noOpDecisionPort: DecisionPort = { ask: async () => ({ status: "deferred" }) };
const noOpAuditPort: AuditPort = { append: async () => undefined };

/** stub DecisionPort：resolved 时按请求块全收。 */
function stubDecisionPort(decision: Decision): DecisionPort {
  return {
    async ask(req) {
      if (decision.status === "resolved" && decision.decisions.length === 0) {
        return {
          status: "resolved",
          decisions: req.blocks.map((b) => ({ blockId: b.blockId, decision: "accept" as const })),
        };
      }
      return decision;
    },
  };
}

type Ctx = {
  root: string;
  projectRoot: string;
  projectId: string;
  artifactService: ArtifactService;
  pendingStore: PendingChangeStore;
  sessionManager: SessionManager;
  stub: StubModel;
  adapter: ReturnType<typeof createHarnessAdapter>;
  handle: { id: string };
  toolCallGuard: (event: Parameters<NonNullable<SessionStartOptionsLike["toolCallGuard"]>>[0]) => ReturnType<NonNullable<SessionStartOptionsLike["toolCallGuard"]>>;
};

/** SessionStartOptions 形状（本地窄化，避免引 pi 具体类型进断言面）。 */
type SessionStartOptionsLike = {
  toolCallGuard?: (event: unknown) => { block?: boolean; reason?: string };
};

async function setup(decision: Decision = { status: "resolved", decisions: [] }): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "ns-session-assembly-"));
  const registry = new ProjectRegistry(join(root, "projects.json"));
  const project = registry.create({ name: "p", root: join(root, "proj"), createIfMissing: true });
  const artifactService = new ArtifactService(registry);
  const pendingStore = new PendingChangeStore(registry, artifactService);
  const sessionManager = SessionManager.inMemory(project.root);

  const stub = await createStubModel();
  const adapter = createHarnessAdapter({
    sessionManager,
    model: stub.model,
    modelRuntime: stub.modelRuntime,
  });

  const assembly = assembleDocSession({
    projectId: project.id,
    sourceActor: "agent-a",
    cwd: project.root,
    sessionManager,
    artifactService,
    pendingStore,
    // 集成测试注入 stub DecisionPort（任务卡 5：resolved/cancelled 两路）；
    // auditPort 省略走默认 createEntryAuditPort(sessionManager)（AC-1.4 审计计数断言依赖）
    decisionPort: stubDecisionPort(decision),
  });

  const handle = await adapter.startSession({
    cwd: project.root,
    agentDir: join(root, "agent-dir"),
    systemPrompt: "T1-10 test session",
    tools: assembly.tools,
    toolsWhitelist: assembly.toolsWhitelist,
    excludeTools: assembly.excludeTools,
    toolCallGuard: assembly.toolCallGuard,
    decisionPort: noOpDecisionPort,
    auditPort: noOpAuditPort,
    sourceActor: "agent-a",
    projectId: project.id,
  });

  return {
    root,
    projectRoot: project.root,
    projectId: project.id,
    artifactService,
    pendingStore,
    sessionManager,
    stub,
    adapter,
    handle,
    toolCallGuard: assembly.toolCallGuard as Ctx["toolCallGuard"],
  };
}

let ctx: Ctx | undefined;
afterEach(() => {
  ctx?.adapter.dispose();
  ctx = undefined;
});

/** 统计 inMemory 会话里 custom 审计条目数（type === "custom"）。 */
function customEntryCount(sm: SessionManager): number {
  return sm.getEntries().filter((e) => e.type === "custom").length;
}

describe("AC-1.3：doc 会话物理不含 write/edit/bash", () => {
  it("白名单 10 项（六工具 + read/grep/glob/list）且不含 write/edit/bash", async () => {
    expect(DOC_TOOLS_WHITELIST).toEqual([
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
    ]);
    for (const banned of ["write", "edit", "bash"]) {
      expect(DOC_TOOLS_WHITELIST).not.toContain(banned);
    }
  });

  it("excludeTools 双保险 = [write, edit, bash]", async () => {
    expect(DOC_TOOLS_EXCLUDE).toEqual(["write", "edit", "bash"]);
  });

  it("模型工具面物理无 write/edit/bash（白名单 + excludeTools 在真会话生效）", async () => {
    ctx = await setup();
    ctx.stub.setResponses([{ text: "ok" }]);
    await ctx.adapter.sendMessage(ctx.handle, "hi");
    const names = ctx.stub.calls[0].tools.map((t) => t.name);
    for (const banned of ["write", "edit", "bash"]) expect(names).not.toContain(banned);
    for (const tool of DOC_TOOLS_WHITELIST) {
      // 白名单内六工具名在模型工具面可见（glob/list 为 pi 无此内置名，不要求可见）
      if (tool === "glob" || tool === "list") continue;
      expect(names).toContain(tool);
    }
  });
});

describe("受管路径 tool_call 守卫（S5④ / D10）", () => {
  it("伪造 write 到受管 .md 的 tool_call → { block: true, reason }", async () => {
    ctx = await setup();
    const artifact = ctx.artifactService.createArtifact(ctx.projectId, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    // 相对路径（write 工具常规形态）
    const rel = ctx.toolCallGuard({ type: "tool_call", toolCallId: "c1", toolName: "write", input: { path: artifact.filePath, content: "x" } });
    expect(rel).toEqual({ block: true, reason: MANAGED_PATH_BLOCK_REASON });
    // 绝对路径
    const absPath = join(ctx.projectRoot, artifact.filePath!);
    const abs = ctx.toolCallGuard({ type: "tool_call", toolCallId: "c2", toolName: "write", input: { path: absPath, content: "x" } });
    expect(abs).toEqual({ block: true, reason: MANAGED_PATH_BLOCK_REASON });
    // edit 同样拦截
    const edit = ctx.toolCallGuard({ type: "tool_call", toolCallId: "c3", toolName: "edit", input: { path: artifact.filePath, edits: [] } });
    expect(edit).toEqual({ block: true, reason: MANAGED_PATH_BLOCK_REASON });
  });

  it("read 受管文档放行（模型可轻读正文）；非受管路径 write 放行", async () => {
    ctx = await setup();
    const artifact = ctx.artifactService.createArtifact(ctx.projectId, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    // read 放行（旧仓 list_artifacts 契约明示可用 read 读正文）
    const read = ctx.toolCallGuard({ type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: artifact.filePath } });
    expect(read).toEqual({});
    // 非受管路径 write 放行
    const other = ctx.toolCallGuard({ type: "tool_call", toolCallId: "c2", toolName: "write", input: { path: "notes/scratch.md", content: "x" } });
    expect(other).toEqual({});
    // 无 path 参数放行
    const noPath = ctx.toolCallGuard({ type: "tool_call", toolCallId: "c3", toolName: "write", input: { content: "x" } });
    expect(noPath).toEqual({});
    // bash / 自定义工具不适用（bash 已被白名单排除，守卫不再拦）
    const bash = ctx.toolCallGuard({ type: "tool_call", toolCallId: "c4", toolName: "bash", input: { command: "rm x.md" } });
    expect(bash).toEqual({});
  });
});

describe("六工具全链路（stub 模型真调 + stub DecisionPort）", () => {
  it("create_artifact → propose_edit（全收）→ 物化 v2 → get_artifact_history 可见（AC-1.1 / S5③）", async () => {
    ctx = await setup();
    // ① 模型调 create_artifact
    ctx.stub.setResponses([
      { toolCalls: [{ name: "create_artifact", arguments: { kind: "design", title: "设计文档", content: V1 } }] },
      { text: "文档已创建" },
    ]);
    await ctx.adapter.sendMessage(ctx.handle, "创建设计文档");
    const artifacts = ctx.artifactService.listArtifacts(ctx.projectId);
    expect(artifacts).toHaveLength(1);
    const id = artifacts[0].id;

    // ② 模型调 propose_edit（stub DecisionPort 全收 → 物化 v2）
    ctx.stub.setResponses([
      { toolCalls: [{ name: "propose_edit", arguments: { id, newContent: V2 } }] },
      { text: "已确认并物化" },
    ]);
    await ctx.adapter.sendMessage(ctx.handle, "提议修改设计文档");
    const versions = ctx.artifactService.listVersions(ctx.projectId, id);
    expect(versions).toHaveLength(2);
    expect(versions[1].content).toBe(V2);

    // ③ 模型调 get_artifact_history → 工具结果回灌进下一次 LLM 调用的上下文（V1 实证模式）
    ctx.stub.setResponses([
      { toolCalls: [{ name: "get_artifact_history", arguments: { artifactId: id } }] },
      { text: "历史已读" },
    ]);
    await ctx.adapter.sendMessage(ctx.handle, "读取版本历史");
    // 工具结果回灌进下一次 LLM 调用上下文（V1 实证模式）：history 的结构化 JSON 可被模型读
    const lastCall = ctx.stub.calls[ctx.stub.calls.length - 1];
    const historyResult = lastCall.messages.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { role?: string }).role === "toolResult" &&
        (m as { toolName?: string }).toolName === "get_artifact_history",
    ) as { content: { type: string; text: string }[] } | undefined;
    expect(historyResult).toBeDefined();
    const historyText = historyResult!.content.find((c) => c.type === "text")?.text ?? "";
    const history = JSON.parse(historyText) as { artifactId: string; title: string; versions: { version: number; author: string }[] };
    expect(history.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(history.versions[1]).toMatchObject({ version: 2, author: "user" });

    // 审计条目落进会话（4 条 custom：proposed/request/response/resolved）
    expect(customEntryCount(ctx.sessionManager)).toBe(4);
  });

  it("取消路径：模型调 propose_edit（stub cancelled）→ 工具文本含「已提案未确认」，pending 保留、版本链不变", async () => {
    ctx = await setup({ status: "cancelled" });
    const artifact = ctx.artifactService.createArtifact(ctx.projectId, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    ctx.stub.setResponses([
      { toolCalls: [{ name: "propose_edit", arguments: { id: artifact.id, newContent: V2 } }] },
      { text: "提案已挂起" },
    ]);
    await ctx.adapter.sendMessage(ctx.handle, "提议修改");

    // 工具结果文本（回灌进第二轮 LLM 调用上下文）含「已提案未确认」与 changeId
    const lastCall = ctx.stub.calls[ctx.stub.calls.length - 1];
    expect(lastCall.serialized).toContain("已提案未确认");
    expect(lastCall.serialized).toContain("changeId");
    // pending 保留、版本链未动
    expect(ctx.pendingStore.listPendingChanges(ctx.projectId, artifact.id)).toHaveLength(1);
    expect(ctx.artifactService.listVersions(ctx.projectId, artifact.id)).toHaveLength(1);
  });

  it("AC-1.4：只读三工具调用后 pending 目录为空、版本链不变、无新审计条目", async () => {
    ctx = await setup();
    const artifact = ctx.artifactService.createArtifact(ctx.projectId, {
      kind: "design",
      title: "设计文档",
      content: V1,
      author: "agent-a",
    });
    ctx.artifactService.submitVersion(ctx.projectId, artifact.id, { content: V2, author: "agent-a" });
    const versionsBefore = ctx.artifactService.listVersions(ctx.projectId, artifact.id);
    const auditsBefore = customEntryCount(ctx.sessionManager);

    // 逐一调用三个只读工具（每轮一次模型调用）
    for (const toolCall of [
      { name: "get_artifact_diff", arguments: { artifactId: artifact.id } },
      { name: "list_my_artifacts", arguments: {} },
      { name: "get_artifact_history", arguments: { artifactId: artifact.id } },
    ]) {
      ctx.stub.setResponses([{ toolCalls: [toolCall] }, { text: "ok" }]);
      await ctx.adapter.sendMessage(ctx.handle, `调 ${toolCall.name}`);
    }

    // 版本链逐条不变
    const versionsAfter = ctx.artifactService.listVersions(ctx.projectId, artifact.id);
    expect(versionsAfter.map((v) => v.content)).toEqual(versionsBefore.map((v) => v.content));
    expect(versionsAfter.map((v) => v.version)).toEqual(versionsBefore.map((v) => v.version));
    // pending 目录无新提案
    expect(ctx.pendingStore.listPendingChanges(ctx.projectId, artifact.id)).toHaveLength(0);
    // 零新审计条目（只读工具不写审计）
    expect(customEntryCount(ctx.sessionManager)).toBe(auditsBefore);
    // 版本链里 get_artifact_diff 结果回灌（AC-1.1：结构化 JSON 可被模型读）
    const diffCall = ctx.stub.calls.find((c) => c.serialized.includes('"fromVersion"'));
    expect(diffCall).toBeDefined();
  });
});
