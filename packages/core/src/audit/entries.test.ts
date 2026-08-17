/**
 * 审计条目族 v1（六类，H3 定案冻结）构建单测（T1-04 验收断言）：
 * - 六类条目均可构建，ns/kind/ts/presentation 顶层壳齐全。
 * - artifact_external_resolved 支持 action: merge | reject 两态。
 * - approval_response 支持 status "discarded"（P1-2 承接：decisions=[]，note 说明原因）。
 * - artifact_resolved 携带 sourceRefs（confirmed 块 → M2a 落点）。
 * - 全部为纯函数：零 IO，ts 可注入保证断言确定性。
 */
import { describe, expect, it } from "vitest";

import { buildReplacePendingChange, type PendingChange } from "../domain/pending-change-service";
import {
  buildApprovalRequest,
  buildApprovalResponse,
  buildApprovalResponseDiscarded,
  buildArtifactExternalResolved,
  buildArtifactProposed,
  buildArtifactResolved,
  buildArtifactRollback,
  summarizeBlocks,
  type AuditEntryPayload,
} from "./entries";

const TS = "2026-08-17T10:00:00.000Z";

/** 5 块样例（1 修改 / 1 新增 / 1 删除 / 2 修改，与原型 managed-doc-panel 同序）。 */
function buildFiveBlockChange(): PendingChange {
  const change = buildReplacePendingChange({
    artifactId: "a1",
    sourceActor: "designer",
    oldContent: "T1\na\nT2\nT3\nb\nc\nT4\nd\nT5\ne",
    newContent: "T1\na2\nT2\nX\nT3\nT4\nd2\nT5\ne2",
    baseVersion: 3,
  });
  expect(change.diffBlocks.map((b) => b.kind)).toEqual(["mod", "add", "del", "mod", "mod"]);
  return change;
}

/** 物化成功后的现场：块 0/1/3 confirmed，块 2/4 rejected（3 收 2 拒混合场景）。 */
function settleFiveBlockChange(): PendingChange {
  const change = buildFiveBlockChange();
  const states = ["confirmed", "confirmed", "rejected", "confirmed", "rejected"] as const;
  change.diffBlocks.forEach((b, i) => (b.state = states[i]));
  return change;
}

describe("buildArtifactProposed", () => {
  it("领域字段取自 PendingChange；diffSummary 按首次出现顺序统计", () => {
    const change = buildFiveBlockChange();
    const entry = buildArtifactProposed(change, { ts: TS });
    expect(entry).toMatchObject({
      ns: "next-step",
      kind: "artifact_proposed",
      ts: TS,
      changeId: change.id,
      artifactId: "a1",
      baseVersion: 3,
      diffBlockCount: 5,
      sourceActor: "designer",
    });
    expect(entry.diffSummary).toEqual([
      { kind: "mod", count: 3 },
      { kind: "add", count: 1 },
      { kind: "del", count: 1 },
    ]);
  });

  it("ts 缺省取当前时间（ISO-8601）", () => {
    const entry = buildArtifactProposed(buildFiveBlockChange());
    expect(!Number.isNaN(Date.parse(entry.ts))).toBe(true);
  });
});

describe("buildArtifactResolved", () => {
  it("acceptedBlocks / rejectedBlocks 按 state 分账；sourceRefs 与 confirmed 块对应且版本 = newVersion", () => {
    const change = settleFiveBlockChange();
    const entry = buildArtifactResolved(change, 4, { ts: TS });
    expect(entry).toMatchObject({ ns: "next-step", kind: "artifact_resolved", ts: TS, newVersion: 4 });
    expect(entry.acceptedBlocks).toEqual([
      change.diffBlocks[0].id,
      change.diffBlocks[1].id,
      change.diffBlocks[3].id,
    ]);
    expect(entry.rejectedBlocks).toEqual([change.diffBlocks[2].id, change.diffBlocks[4].id]);
    expect(entry.sourceRefs).toHaveLength(3);
    expect(entry.sourceRefs.every((r) => r.version === 4)).toBe(true);
  });

  it("opts.presentation 挂入顶层壳（两壳通用渲染器消费）", () => {
    const change = settleFiveBlockChange();
    const presentation = { title: "📄 面板", badges: [], body: [] };
    const entry = buildArtifactResolved(change, 4, { ts: TS, presentation });
    expect(entry.presentation).toEqual(presentation);
  });
});

describe("buildArtifactRollback", () => {
  it("回滚：newVersion = fromVersion + 1，note = rollback to v{n}", () => {
    const entry = buildArtifactRollback(
      { artifactId: "a1", fromVersion: 4, toVersion: 2, undoing: false },
      { ts: TS },
    );
    expect(entry).toMatchObject({
      kind: "artifact_rollback",
      artifactId: "a1",
      fromVersion: 4,
      toVersion: 2,
      newVersion: 5,
      undoing: false,
      note: "rollback to v2",
    });
  });

  it("撤销回滚：undoing = true，note = undo rollback to v{n}", () => {
    const entry = buildArtifactRollback(
      { artifactId: "a1", fromVersion: 5, toVersion: 4, undoing: true },
      { ts: TS },
    );
    expect(entry).toMatchObject({ newVersion: 6, undoing: true, note: "undo rollback to v4" });
  });
});

describe("buildApprovalRequest", () => {
  it("status 恒为 pending；mode / requester 可检视（P1-3：写入责任归 gate 编排）", () => {
    const entry = buildApprovalRequest(
      { changeId: "c1", artifactId: "a1", mode: "block", requester: "cli" },
      { ts: TS },
    );
    expect(entry).toMatchObject({
      kind: "approval_request",
      changeId: "c1",
      artifactId: "a1",
      status: "pending",
      mode: "block",
      requester: "cli",
    });
  });
});

describe("buildApprovalResponse", () => {
  it("resolved：decisions 逐块记账（D6 红线），via 标注裁决通道", () => {
    const entry = buildApprovalResponse(
      {
        changeId: "c1",
        artifactId: "a1",
        decisions: [
          { blockId: "b1", decision: "accept" },
          { blockId: "b2", decision: "reject" },
        ],
        via: "cli-keyboard",
      },
      { ts: TS },
    );
    expect(entry).toMatchObject({
      kind: "approval_response",
      status: "resolved",
      via: "cli-keyboard",
      decisions: [
        { blockId: "b1", decision: "accept" },
        { blockId: "b2", decision: "reject" },
      ],
    });
  });

  it("discarded（P1-2）：decisions=[]，note 说明放弃原因", () => {
    const entry = buildApprovalResponseDiscarded(
      { changeId: "c1", artifactId: "a1", note: "上游版本已变更，提案作废", via: "web-panel" },
      { ts: TS },
    );
    expect(entry).toMatchObject({
      kind: "approval_response",
      status: "discarded",
      decisions: [],
      via: "web-panel",
      note: "上游版本已变更，提案作废",
    });
  });
});

describe("buildArtifactExternalResolved（H3 第六类）", () => {
  it("action: merge（以提案方式合并）", () => {
    const entry = buildArtifactExternalResolved(
      { artifactId: "a1", action: "merge", note: "外部手改转为提案" },
      { ts: TS },
    );
    expect(entry).toMatchObject({
      kind: "artifact_external_resolved",
      artifactId: "a1",
      action: "merge",
      note: "外部手改转为提案",
    });
  });

  it("action: reject（拒绝采纳，不生成新版本 → 不污染 artifact_resolved）", () => {
    const entry = buildArtifactExternalResolved(
      { artifactId: "a1", action: "reject", note: "恢复系统版本" },
      { ts: TS },
    );
    expect(entry).toMatchObject({ action: "reject", note: "恢复系统版本" });
  });
});

describe("summarizeBlocks", () => {
  it("空块 → 空统计", () => {
    expect(summarizeBlocks([])).toEqual([]);
  });
});

describe("条目族 v1 冻结形状", () => {
  it("六类 kind 全部可产出且顶层壳一致（ns=next-step）", () => {
    const entries: AuditEntryPayload[] = [
      buildArtifactProposed(buildFiveBlockChange(), { ts: TS }),
      buildArtifactResolved(settleFiveBlockChange(), 4, { ts: TS }),
      buildArtifactRollback({ artifactId: "a1", fromVersion: 4, toVersion: 2, undoing: false }, { ts: TS }),
      buildApprovalRequest({ changeId: "c1", artifactId: "a1", mode: "whole", requester: "entry" }, { ts: TS }),
      buildApprovalResponse(
        { changeId: "c1", artifactId: "a1", decisions: [], via: "web-panel" },
        { ts: TS },
      ),
      buildArtifactExternalResolved({ artifactId: "a1", action: "merge", note: "n" }, { ts: TS }),
    ];
    expect(entries.map((e) => e.kind)).toEqual([
      "artifact_proposed",
      "artifact_resolved",
      "artifact_rollback",
      "approval_request",
      "approval_response",
      "artifact_external_resolved",
    ]);
    expect(entries.every((e) => e.ns === "next-step" && e.ts === TS)).toBe(true);
    // 条目可 JSON 序列化落盘（appendEntry 载荷）
    expect(() => JSON.stringify(entries)).not.toThrow();
  });
});
