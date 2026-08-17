import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildApprovalRequest } from "@pgoone/next-step-core";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHarnessAdapter } from "../harness-adapter";
import { createEntryAuditPort } from "./audit-port";
import { createStubModel } from "../test-helpers";

/**
 * T1-07 验收断言（AuditPort pi 实现）：
 * - append 后会话 JSONL 出现 type:"custom" 且 ns:"next-step" 条目；
 * - stub 模型收到的 messages 中无该条目内容（appendEntry 不进 LLM 上下文，§5.3 实证语义）。
 */

const startOptions = {
  cwd: process.cwd(),
  agentDir: "/tmp/nextstep-test-agent-dir",
  tools: [],
  toolsWhitelist: [],
  decisionPort: { ask: async () => ({ status: "deferred" as const }) },
  auditPort: { append: async () => undefined },
  sourceActor: "test-actor",
  projectId: "test-project",
};

describe("createEntryAuditPort（appendEntry → 自定义条目）", () => {
  it("append 后 inMemory 会话可读回 type:'custom' + ns:'next-step' 条目", async () => {
    const sessionManager = SessionManager.inMemory(process.cwd());
    const auditPort = createEntryAuditPort(sessionManager);

    const entry = buildApprovalRequest({
      changeId: "chg-1",
      artifactId: "art-1",
      mode: "block",
      requester: "cli",
    });
    await auditPort.append(entry);

    const custom = sessionManager.getEntries().filter((e) => e.type === "custom");
    expect(custom).toHaveLength(1);
    const data = (custom[0] as { customType: string; data: Record<string, unknown> });
    expect(data.customType).toBe("next-step");
    expect((data.data as { ns: string }).ns).toBe("next-step");
    expect((data.data as { kind: string }).kind).toBe("approval_request");
  });

  it("持久会话：append 后 JSONL 文件出现 type:'custom' 行（ns:'next-step'）", async () => {
    const stub = await createStubModel();
    const sessionDir = mkdtempSync(path.join(tmpdir(), "nextstep-audit-jsonl-"));
    const sessionManager = SessionManager.create(process.cwd(), sessionDir);
    const adapter = createHarnessAdapter({
      sessionManager,
      model: stub.model,
      modelRuntime: stub.modelRuntime,
    });
    try {
      stub.setResponses([{ text: "first" }]);
      const handle = await adapter.startSession(startOptions);
      await adapter.sendMessage(handle, "q1"); // pi 语义：首条 assistant 到场后才开始写盘

      await createEntryAuditPort(sessionManager).append(
        buildApprovalRequest({ changeId: "chg-2", artifactId: "art-2", mode: "whole", requester: "entry" }),
      );

      const file = sessionManager.getSessionFile();
      expect(file).toBeDefined();
      const lines = readFileSync(file!, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const custom = lines.filter((l) => l.type === "custom");
      expect(custom).toHaveLength(1);
      expect((custom[0] as { customType?: string }).customType).toBe("next-step");
      const data = custom[0].data as { ns?: string; kind?: string };
      expect(data.ns).toBe("next-step");
      expect(data.kind).toBe("approval_request");
    } finally {
      adapter.dispose();
    }
  });

  it("不进 LLM 上下文：append 后 stub 模型收到的 messages 中无条目内容", async () => {
    const stub = await createStubModel();
    const sessionManager = SessionManager.inMemory(process.cwd());
    const adapter = createHarnessAdapter({
      sessionManager,
      model: stub.model,
      modelRuntime: stub.modelRuntime,
    });
    try {
      stub.setResponses([{ text: "first" }, { text: "second" }]);
      const handle = await adapter.startSession(startOptions);
      await adapter.sendMessage(handle, "q1");

      const marker = "AUDIT-MARKER-DO-NOT-LEAK";
      await createEntryAuditPort(sessionManager).append(
        buildApprovalRequest({ changeId: marker, artifactId: "art-3", mode: "block", requester: "cli" }),
      );

      await adapter.sendMessage(handle, "q2");
      // 第二次 LLM 调用的上下文里不应出现审计条目内容（custom 条目被 buildSessionContext 排除）
      expect(stub.calls.length).toBe(2);
      expect(stub.calls[1].serialized).not.toContain(marker);
      expect(stub.calls[1].serialized).not.toContain("approval_request");
    } finally {
      adapter.dispose();
    }
  });
});
