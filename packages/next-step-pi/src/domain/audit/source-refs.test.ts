/**
 * sourceRef + blockAnchor 基线规则单测（H6 + P2-4 定案，T1-04 验收断言）：
 * - del/mod 块锚 oldContent 行区间（LCS ops 直接可推）。
 * - add 块锚「块前最近 equal 行 + 1 行、lineEnd 同」（无旧行的基线规则）。
 * - heading 就近推导（向上找最近标题行，尽力而为；无标题省略）。
 * - 不变量：confirmed 块数 = sourceRefs 条数；version = newVersion。
 */
import { describe, expect, it } from "vitest";

import {
  buildPatchPendingChange,
  buildReplacePendingChange,
  PendingChangeError,
  type PendingChange,
} from "../domain/pending-change-service";
import { buildSourceRefs, computeBlockAnchors } from "./source-refs";

/** 全部块置 confirmed（物化成功后的调用现场语义）。 */
function confirmAll(change: PendingChange): PendingChange {
  for (const b of change.diffBlocks) b.state = "confirmed";
  return change;
}

function anchorsOf(change: PendingChange) {
  return computeBlockAnchors(change).map((a) => ({
    lineStart: a.lineStart,
    lineEnd: a.lineEnd,
    heading: a.heading,
  }));
}

describe("computeBlockAnchors · del/mod 锚 old 行区间", () => {
  it("mod 块 → 连续 del 段的 [首行, 末行]", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "a\nb\nc\nd",
      newContent: "a\nB\nc\nd",
      baseVersion: 1,
    });
    expect(change.diffBlocks.map((b) => b.kind)).toEqual(["mod"]);
    expect(anchorsOf(change)).toEqual([{ lineStart: 2, lineEnd: 2, heading: undefined }]);
  });

  it("del 块（含整段多行删除）→ old 行区间", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "a\nb\nc\nd",
      newContent: "a\nd",
      baseVersion: 1,
    });
    expect(change.diffBlocks.map((b) => b.kind)).toEqual(["del"]);
    expect(anchorsOf(change)).toEqual([{ lineStart: 2, lineEnd: 3, heading: undefined }]);
  });

  it("被删段首行是标题行 → heading 命中被删标题自身（就近含锚行）", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "## §4 旧部署方案\nPM2\nNginx",
      newContent: "",
      baseVersion: 1,
    });
    expect(anchorsOf(change)).toEqual([
      { lineStart: 1, lineEnd: 3, heading: "§4 旧部署方案" },
    ]);
  });
});

describe("computeBlockAnchors · add 块锚「块前最近 equal 行 + 1、lineEnd 同」", () => {
  it("中部插入 → 锚 = 前文 equal 行 + 1", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "a\nb\nc",
      newContent: "a\nX\nb\nc",
      baseVersion: 1,
    });
    expect(change.diffBlocks.map((b) => b.kind)).toEqual(["add"]);
    expect(anchorsOf(change)).toEqual([{ lineStart: 2, lineEnd: 2, heading: undefined }]);
  });

  it("文首插入（前面无 equal 行）→ lineStart = 1", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "a\nb",
      newContent: "X\na\nb",
      baseVersion: 1,
    });
    expect(anchorsOf(change)).toEqual([{ lineStart: 1, lineEnd: 1, heading: undefined }]);
  });

  it("尾部追加 → 锚 = old 末行 + 1（超出 old 长度时不炸，heading 省略）", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "a\nb",
      newContent: "a\nb\nX",
      baseVersion: 1,
    });
    expect(anchorsOf(change)).toEqual([{ lineStart: 3, lineEnd: 3, heading: undefined }]);
  });
});

describe("computeBlockAnchors · heading 就近推导（H6 尽力而为）", () => {
  it("mod 块 → 向上找最近标题行（# 前缀剥离）", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "# 标题\n## §2.1 内核策略\nfoo",
      newContent: "# 标题\n## §2.1 内核策略\nbar",
      baseVersion: 1,
    });
    expect(anchorsOf(change)).toEqual([
      { lineStart: 3, lineEnd: 3, heading: "§2.1 内核策略" },
    ]);
  });

  it("全文无标题 → heading 省略", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "foo",
      newContent: "bar",
      baseVersion: 1,
    });
    expect(anchorsOf(change)).toEqual([{ lineStart: 1, lineEnd: 1, heading: undefined }]);
  });
});

describe("computeBlockAnchors · 失配与 op 边界", () => {
  it("op=patch → INVALID（物化路径仅支持 replace）", () => {
    const change = buildPatchPendingChange({
      artifactId: "a1",
      sourceActor: "s",
      edits: [{ oldText: "a", newText: "b" }],
      baseVersion: 1,
    });
    expect(() => computeBlockAnchors(change)).toThrow(PendingChangeError);
    expect(() => computeBlockAnchors(change)).toThrow(/op=replace/);
  });
});

describe("buildSourceRefs · confirmed 过滤与版本号", () => {
  it("confirmed 块数 = sourceRefs 条数；version = newVersion；块 id 对应", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "a\nb\nc",
      newContent: "A\nb\nc\nD",
      baseVersion: 2,
    });
    confirmAll(change);
    const refs = buildSourceRefs(change, 3);
    expect(refs).toHaveLength(change.diffBlocks.length);
    expect(refs.every((r) => r.version === 3)).toBe(true);
    expect(refs.every((r) => r.artifactId === "a1")).toBe(true);
    expect(refs.map((r) => r.blockAnchor.lineStart)).toEqual([1, 4]);
  });

  it("pending / rejected 块不产 sourceRef（只记物化生效的块）", () => {
    const change = buildReplacePendingChange({
      artifactId: "a1",
      sourceActor: "s",
      oldContent: "a\nb\nc",
      newContent: "A\nb\nc\nD",
      baseVersion: 2,
    });
    change.diffBlocks[0].state = "confirmed";
    change.diffBlocks[1].state = "rejected";
    const refs = buildSourceRefs(change, 3);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      artifactId: "a1",
      version: 3,
      blockAnchor: { lineStart: 1, lineEnd: 1 },
    });
  });
});
