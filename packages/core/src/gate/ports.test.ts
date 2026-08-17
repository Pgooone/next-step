/**
 * DecisionPort / AuditPort 端口单测（T1-04 验收断言）：
 * - Decision 三分支可构造：resolved（逐块记账）/ deferred / **cancelled**（P1-1①：
 *   gate 收到后 pending 保留，工具返回「已提案未确认，changeId=…」——语义由 T1-05 承接）。
 * - 端口接口可被注入实现（L2 的 CliDecisionPort / pi appendEntry 是 T1-07 / T1-09 的事，
 *   此处用 stub 证明接口形状可用）。
 * - 红线：本卡 L1 新增文件 grep 不到 UI 上下文引用（§2.1）；packages/core 无 pi 依赖（B1）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildArtifactProposed } from "../audit/entries";
import { buildReplacePendingChange } from "../domain/pending-change-service";
import type { AuditPort } from "./ports";
import type { Decision, DecisionPort } from "./ports";

describe("Decision 三分支（P1-1① cancelled）", () => {
  it("resolved：decisions 逐块记账（D6 红线：记账永远块级）", () => {
    const d: Decision = {
      status: "resolved",
      decisions: [
        { blockId: "b1", decision: "accept" },
        { blockId: "b2", decision: "reject" },
      ],
    };
    expect(d.status).toBe("resolved");
    if (d.status === "resolved") expect(d.decisions).toHaveLength(2);
  });

  it("deferred：挂起（EntryDecisionPort 第一期语义：只记条目不阻塞）", () => {
    const d: Decision = { status: "deferred" };
    expect(d.status).toBe("deferred");
  });

  it("cancelled：取消分支可构造（pending 保留、不死锁，T1-05 承接编排）", () => {
    const d: Decision = { status: "cancelled" };
    expect(d.status).toBe("cancelled");
  });
});

describe("端口接口可注入实现（闸门只认接口）", () => {
  it("DecisionPort.ask 返回 Decision（stub 证明接口形状可用）", async () => {
    const port: DecisionPort = { ask: async () => ({ status: "cancelled" }) };
    await expect(
      port.ask({
        kind: "approve_blocks",
        changeId: "c1",
        artifactId: "a1",
        title: "设计文档.md v3 → v4",
        blocks: [],
        mode: "block",
      }),
    ).resolves.toEqual({ status: "cancelled" });
  });

  it("AuditPort.append 接收 AuditEntryPayload（stub 收集证明接口形状可用）", async () => {
    const received: unknown[] = [];
    const port: AuditPort = {
      append: async (entry) => {
        received.push(entry);
      },
    };
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "designer",
      oldContent: "a",
      newContent: "b",
      baseVersion: 1,
    });
    await port.append(buildArtifactProposed(change, { ts: "2026-08-17T00:00:00.000Z" }));
    expect(received).toHaveLength(1);
  });
});

describe("L1 红线（B1 / §2.1）", () => {
  const CARD_FILES = [
    "../audit/entries.ts",
    "../audit/source-refs.ts",
    "../presentation/types.ts",
    "../presentation/builders.ts",
    "./ports.ts",
  ];

  it("本卡 L1 文件 grep 不到 UI 上下文引用（ctx.ui 零命中）", () => {
    for (const rel of CARD_FILES) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
      expect(src, `${rel} 不应出现 UI 上下文引用`).not.toContain("ctx.ui");
    }
  });

  it("本卡 L1 文件无 pi（@earendil-works）import", () => {
    for (const rel of CARD_FILES) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
      expect(src, `${rel} 不应 import pi`).not.toContain("@earendil-works");
    }
  });

  it("packages/core 无 @earendil-works/* 依赖（B1 保持）", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf-8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all.filter((name) => name.startsWith("@earendil-works/"))).toEqual([]);
  });
});
