/**
 * pending-change-service 领域单测：
 * - 行级切块纯函数：纯增(add) / 纯删(del) / 替换(mod) / 混合 / 无改动 / edit 多块。
 * - DiffBlock 形状：id/state=pending、mod 带 oldLines、add/del 无 oldLines。
 * - 落盘：managed/<id>/pending/<id>.json 原子写 + get 读回 + NOT_FOUND。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PendingChangeStore,
  PendingChangeError,
  applyResolvedBlocks,
  buildReplacePendingChange,
  buildPatchPendingChange,
  computeReplaceDiffBlocks,
  computeEditDiffBlocks,
  type DiffBlock,
  type PendingChange,
} from "./pending-change-service";
import { ProjectRegistry } from "./project-registry";
import { ArtifactService, ArtifactError } from "./artifact-service";
import { NEXTSTEP_DIR_NAME } from "../config/paths";

let dir: string;
let registry: ProjectRegistry;
let store: PendingChangeStore;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ns-d2-pending-"));
  registry = new ProjectRegistry(join(dir, "projects.json"));
  projectId = registry.create({ name: "proj", root: dir }).id;
  store = new PendingChangeStore(registry);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 提取每块的 (kind, lines) 便于断言形状，忽略随机 id。 */
function shape(blocks: DiffBlock[]): { kind: string; lines: string[]; oldLines?: string[] }[] {
  return blocks.map((b) => ({
    kind: b.kind,
    lines: b.lines,
    ...(b.oldLines !== undefined ? { oldLines: b.oldLines } : {}),
  }));
}

// ---------------------------------------------------------------------------
// 切块：computeReplaceDiffBlocks（write 整文件替换）
// ---------------------------------------------------------------------------
describe("computeReplaceDiffBlocks", () => {
  it("内容相同 → 空块数组", () => {
    expect(computeReplaceDiffBlocks("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("纯新增：尾部追加行 → 一个 add 块", () => {
    const blocks = computeReplaceDiffBlocks("a\nb", "a\nb\nc\nd");
    expect(shape(blocks)).toEqual([{ kind: "add", lines: ["c", "d"] }]);
  });

  it("纯新增：空文件 → 全文 → 一个 add 块", () => {
    const blocks = computeReplaceDiffBlocks("", "x\ny");
    expect(shape(blocks)).toEqual([{ kind: "add", lines: ["x", "y"] }]);
  });

  it("纯删除：删掉中间几行 → 一个 del 块", () => {
    const blocks = computeReplaceDiffBlocks("a\nb\nc\nd", "a\nd");
    expect(shape(blocks)).toEqual([{ kind: "del", lines: ["b", "c"] }]);
  });

  it("纯删除：全文清空 → 一个 del 块", () => {
    const blocks = computeReplaceDiffBlocks("a\nb", "");
    expect(shape(blocks)).toEqual([{ kind: "del", lines: ["a", "b"] }]);
  });

  it("替换：连续 del 后紧跟 add → 合并为 mod 块（lines=新, oldLines=旧）", () => {
    const blocks = computeReplaceDiffBlocks("a\nOLD\nc", "a\nNEW\nc");
    expect(shape(blocks)).toEqual([{ kind: "mod", lines: ["NEW"], oldLines: ["OLD"] }]);
  });

  it("替换：多行替换多行 → 一个 mod 块", () => {
    const blocks = computeReplaceDiffBlocks("a\nO1\nO2\nb", "a\nN1\nN2\nN3\nb");
    expect(shape(blocks)).toEqual([{ kind: "mod", lines: ["N1", "N2", "N3"], oldLines: ["O1", "O2"] }]);
  });

  it("混合：一处 mod + 一处 add（被未改动行隔开）→ 两个块", () => {
    // a [OLD→NEW] b c [+追加 d]
    const blocks = computeReplaceDiffBlocks("a\nOLD\nb\nc", "a\nNEW\nb\nc\nd");
    expect(shape(blocks)).toEqual([
      { kind: "mod", lines: ["NEW"], oldLines: ["OLD"] },
      { kind: "add", lines: ["d"] },
    ]);
  });

  it("所有块初始 state=pending 且带 id；add/del 块不带 oldLines", () => {
    const blocks = computeReplaceDiffBlocks("a\nb", "a\nX");
    for (const b of blocks) {
      expect(b.state).toBe("pending");
      expect(typeof b.id).toBe("string");
      expect(b.id.length).toBeGreaterThan(0);
    }
    // 这例是 mod（b→X），带 oldLines
    expect(blocks[0].kind).toBe("mod");
    expect(blocks[0].oldLines).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// 切块：computeEditDiffBlocks（edit 局部替换）
// ---------------------------------------------------------------------------
describe("computeEditDiffBlocks", () => {
  it("单 edit 单行替换 → 一个 mod 块", () => {
    const blocks = computeEditDiffBlocks([{ oldText: "foo", newText: "bar" }]);
    expect(shape(blocks)).toEqual([{ kind: "mod", lines: ["bar"], oldLines: ["foo"] }]);
  });

  it("多个 edit 按顺序各自成块", () => {
    const blocks = computeEditDiffBlocks([
      { oldText: "a", newText: "A" },
      { oldText: "b", newText: "" }, // 纯删
      { oldText: "", newText: "c" }, // 纯增
    ]);
    expect(shape(blocks)).toEqual([
      { kind: "mod", lines: ["A"], oldLines: ["a"] },
      { kind: "del", lines: ["b"] },
      { kind: "add", lines: ["c"] },
    ]);
  });

  it("单 edit 内部多行替换 → 行级精确切块", () => {
    const blocks = computeEditDiffBlocks([{ oldText: "keep\nOLD\ntail", newText: "keep\nNEW\ntail" }]);
    expect(shape(blocks)).toEqual([{ kind: "mod", lines: ["NEW"], oldLines: ["OLD"] }]);
  });
});

// ---------------------------------------------------------------------------
// 组装 PendingChange
// ---------------------------------------------------------------------------
describe("buildReplacePendingChange / buildPatchPendingChange", () => {
  it("replace：op=replace、targetType=artifact、diff 携新旧全文、默认 hitlMode=per_block", () => {
    const pc = buildReplacePendingChange({
      artifactId: "art-1",
      sourceActor: "需求分析师",
      oldContent: "a",
      newContent: "b",
    });
    expect(pc.op).toBe("replace");
    expect(pc.targetType).toBe("artifact");
    expect(pc.sourceActor).toBe("需求分析师");
    expect(pc.hitlMode).toBe("per_block");
    expect(pc.diff).toEqual({ kind: "replace", oldContent: "a", newContent: "b" });
    expect(pc.diffBlocks.length).toBeGreaterThan(0);
    expect(typeof pc.createdAt).toBe("string");
  });

  it("patch：op=patch、diff 携 edits、diffBlocks 由 edits 切出", () => {
    const pc = buildPatchPendingChange({
      artifactId: "art-1",
      sourceActor: "agent-x",
      edits: [{ oldText: "x", newText: "y" }],
    });
    expect(pc.op).toBe("patch");
    expect(pc.diff).toEqual({ kind: "patch", edits: [{ oldText: "x", newText: "y" }] });
    expect(shape(pc.diffBlocks)).toEqual([{ kind: "mod", lines: ["y"], oldLines: ["x"] }]);
  });
});

// ---------------------------------------------------------------------------
// 落盘 PendingChangeStore
// ---------------------------------------------------------------------------
describe("PendingChangeStore", () => {
  it("save 落盘到 managed/<artifactId>/pending/<id>.json 且 get 读回一致", () => {
    const pc = buildReplacePendingChange({
      artifactId: "art-42",
      sourceActor: "a",
      oldContent: "old",
      newContent: "new",
    });
    store.save(projectId, pc);

    const path = join(dir, NEXTSTEP_DIR_NAME, "artifacts", "managed", "art-42", "pending", `${pc.id}.json`);
    expect(existsSync(path)).toBe(true);

    const got = store.get(projectId, "art-42", pc.id);
    expect(got).toEqual(pc);
  });

  it("save 用原子写（不留 .tmp 残留）", () => {
    const pc = buildReplacePendingChange({ artifactId: "art-9", sourceActor: "a", oldContent: "", newContent: "z" });
    store.save(projectId, pc);
    const pendingDir = join(dir, NEXTSTEP_DIR_NAME, "artifacts", "managed", "art-9", "pending");
    const leftover = readdirSync(pendingDir).filter((f) => f.includes(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("get 不存在 → NOT_FOUND", () => {
    try {
      store.get(projectId, "art-x", "missing-id");
    } catch (e) {
      expect(e).toBeInstanceOf(PendingChangeError);
      expect((e as PendingChangeError).code).toBe("NOT_FOUND");
      return;
    }
    throw new Error("期望抛 PendingChangeError(NOT_FOUND)，但没抛");
  });
});

// ---------------------------------------------------------------------------
// listPendingChanges（供 ArtifactPanel 只读渲染，D3 AC②③）
// ---------------------------------------------------------------------------
describe("PendingChangeStore.listPendingChanges", () => {
  it("pending 目录不存在（无变更）→ 空数组（不抛错）", () => {
    expect(store.listPendingChanges(projectId, "no-such-artifact")).toEqual([]);
  });

  it("列出该 artifact 全部 pending 变更，按 createdAt 升序", () => {
    const a = buildReplacePendingChange({ artifactId: "art-1", sourceActor: "x", oldContent: "a", newContent: "b" });
    a.createdAt = "2026-01-01T00:00:00.000Z";
    const b = buildReplacePendingChange({ artifactId: "art-1", sourceActor: "x", oldContent: "b", newContent: "c" });
    b.createdAt = "2026-01-02T00:00:00.000Z";
    // 先存较晚的，验证排序按 createdAt 而非落盘顺序
    store.save(projectId, b);
    store.save(projectId, a);

    const list = store.listPendingChanges(projectId, "art-1");
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("只返回该 artifact 自己的变更，不串其它 artifact", () => {
    store.save(projectId, buildReplacePendingChange({ artifactId: "art-A", sourceActor: "x", oldContent: "", newContent: "1" }));
    store.save(projectId, buildReplacePendingChange({ artifactId: "art-B", sourceActor: "x", oldContent: "", newContent: "2" }));
    expect(store.listPendingChanges(projectId, "art-A").length).toBe(1);
    expect(store.listPendingChanges(projectId, "art-B").length).toBe(1);
  });

  it("跳过解析失败的坏 json，不拖垮整列表", () => {
    const ok = buildReplacePendingChange({ artifactId: "art-9", sourceActor: "x", oldContent: "", newContent: "ok" });
    store.save(projectId, ok);
    const pendingDir = join(dir, NEXTSTEP_DIR_NAME, "artifacts", "managed", "art-9", "pending");
    writeFileSync(join(pendingDir, "broken.json"), "{ not json", "utf-8");

    const list = store.listPendingChanges(projectId, "art-9");
    expect(list.map((p) => p.id)).toEqual([ok.id]);
  });
});

// ---------------------------------------------------------------------------
// 部分确认重建：applyResolvedBlocks（D4，§5.5）
// ---------------------------------------------------------------------------

/** 把 change 全部块置为同一 state，便于测不变量。 */
function setAllBlockState(pc: PendingChange, state: DiffBlock["state"]): PendingChange {
  for (const b of pc.diffBlocks) b.state = state;
  return pc;
}

describe("applyResolvedBlocks", () => {
  const OLD = "line1\nOLD\nline3\nkeep4";
  const NEW = "line1\nNEW\nline3\nkeep4\nadded5";

  it("全块 confirmed → 必等 newContent（splitLines 归一化）", () => {
    const pc = setAllBlockState(
      buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: OLD, newContent: NEW }),
      "confirmed",
    );
    expect(applyResolvedBlocks(pc)).toBe(NEW);
  });

  it("全块 rejected → 必等 oldContent", () => {
    const pc = setAllBlockState(
      buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: OLD, newContent: NEW }),
      "rejected",
    );
    expect(applyResolvedBlocks(pc)).toBe(OLD);
  });

  it("全块仍 pending → 等 oldContent（未决=保持原样）", () => {
    const pc = buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: OLD, newContent: NEW });
    expect(applyResolvedBlocks(pc)).toBe(OLD);
  });

  it("部分确认：mod 块 confirmed + add 块 rejected → 只应用 mod", () => {
    // OLD→NEW 切出两块：mod(OLD→NEW) + add(added5)
    const pc = buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: OLD, newContent: NEW });
    const [mod, add] = pc.diffBlocks;
    expect(mod.kind).toBe("mod");
    expect(add.kind).toBe("add");
    mod.state = "confirmed";
    add.state = "rejected";
    // 应用 mod（OLD→NEW）、拒绝 add（不追加 added5）
    expect(applyResolvedBlocks(pc)).toBe("line1\nNEW\nline3\nkeep4");
  });

  it("部分确认：mod 块 rejected + add 块 confirmed → 只应用 add", () => {
    const pc = buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: OLD, newContent: NEW });
    const [mod, add] = pc.diffBlocks;
    mod.state = "rejected";
    add.state = "confirmed";
    // 保留 OLD（拒绝 mod）、追加 added5（接受 add）
    expect(applyResolvedBlocks(pc)).toBe("line1\nOLD\nline3\nkeep4\nadded5");
  });

  it("纯删除块 confirmed → 删掉旧行；rejected → 保留", () => {
    const del = buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: "a\nb\nc", newContent: "a\nc" });
    expect(del.diffBlocks[0].kind).toBe("del");
    del.diffBlocks[0].state = "confirmed";
    expect(applyResolvedBlocks(del)).toBe("a\nc");

    const del2 = buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: "a\nb\nc", newContent: "a\nc" });
    del2.diffBlocks[0].state = "rejected";
    expect(applyResolvedBlocks(del2)).toBe("a\nb\nc");
  });

  it("op=patch → 抛 INVALID（仅支持 replace）", () => {
    const pc = buildPatchPendingChange({ artifactId: "a", sourceActor: "x", edits: [{ oldText: "x", newText: "y" }] });
    expect(() => applyResolvedBlocks(pc)).toThrow(PendingChangeError);
    try {
      applyResolvedBlocks(pc);
    } catch (e) {
      expect((e as PendingChangeError).code).toBe("INVALID");
    }
  });

  it("diffBlocks 与 diff 失配（块数被人为篡改）→ 抛 INVALID", () => {
    const pc = buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: OLD, newContent: NEW });
    pc.diffBlocks.pop(); // 删掉一块制造失配
    expect(() => applyResolvedBlocks(pc)).toThrow(PendingChangeError);
  });

  it("三块混合（mod 接受 / del 拒绝 / add 接受）→ 行序正确", () => {
    // 旧: h1 / A / m / B / t        新: h1 / A2 / m / t / C
    // 切块：mod(A→A2) · del(B) · add(C)（被未改动行 m/t 隔开，文档序保持）
    const old = "h1\nA\nm\nB\nt";
    const neu = "h1\nA2\nm\nt\nC";
    const pc = buildReplacePendingChange({ artifactId: "a", sourceActor: "x", oldContent: old, newContent: neu });
    expect(pc.diffBlocks.map((b) => b.kind)).toEqual(["mod", "del", "add"]);
    pc.diffBlocks[0].state = "confirmed"; // A→A2 接受
    pc.diffBlocks[1].state = "rejected"; // 删 B 拒绝 → 保留 B
    pc.diffBlocks[2].state = "confirmed"; // 加 C 接受
    // 期望: h1 / A2 / m / B / t / C —— 行序随 equal/块 原序交织正确
    expect(applyResolvedBlocks(pc)).toBe("h1\nA2\nm\nB\nt\nC");
  });
});

// ---------------------------------------------------------------------------
// 逐块 resolve + remove（D4，§5.5）
// ---------------------------------------------------------------------------
describe("PendingChangeStore.resolveBlock / remove", () => {
  it("resolveBlock 指定块 confirm → 该块 state=confirmed 并落盘", () => {
    const pc = buildReplacePendingChange({ artifactId: "art-r", sourceActor: "x", oldContent: "a\nOLD\nb", newContent: "a\nNEW\nb" });
    store.save(projectId, pc);
    const blockId = pc.diffBlocks[0].id;

    const updated = store.resolveBlock(projectId, "art-r", pc.id, { blockId, action: "confirm" });
    expect(updated.diffBlocks[0].state).toBe("confirmed");
    // 读回落盘结果一致
    expect(store.get(projectId, "art-r", pc.id).diffBlocks[0].state).toBe("confirmed");
  });

  it("resolveBlock 指定块 reject → 该块 state=rejected", () => {
    const pc = buildReplacePendingChange({ artifactId: "art-r", sourceActor: "x", oldContent: "a", newContent: "b" });
    store.save(projectId, pc);
    const updated = store.resolveBlock(projectId, "art-r", pc.id, { blockId: pc.diffBlocks[0].id, action: "reject" });
    expect(updated.diffBlocks[0].state).toBe("rejected");
  });

  it("resolveBlock 省略 blockId → 全部 pending 块统一置态", () => {
    const pc = buildReplacePendingChange({ artifactId: "art-r", sourceActor: "x", oldContent: "a\nOLD\nb\nc", newContent: "a\nNEW\nb\nc\nd" });
    store.save(projectId, pc);
    expect(pc.diffBlocks.length).toBeGreaterThan(1);
    const updated = store.resolveBlock(projectId, "art-r", pc.id, { action: "confirm" });
    expect(updated.diffBlocks.every((b) => b.state === "confirmed")).toBe(true);
  });

  it("resolveBlock 省略 blockId 幂等跳过已决块（不回退已 reject 的块）", () => {
    const pc = buildReplacePendingChange({ artifactId: "art-r", sourceActor: "x", oldContent: "a\nOLD\nb\nc", newContent: "a\nNEW\nb\nc\nd" });
    pc.diffBlocks[0].state = "rejected"; // 先手动决一块
    store.save(projectId, pc);
    const updated = store.resolveBlock(projectId, "art-r", pc.id, { action: "confirm" });
    expect(updated.diffBlocks[0].state).toBe("rejected"); // 不被 confirm 覆盖
    expect(updated.diffBlocks[1].state).toBe("confirmed"); // 原 pending 的被 confirm
  });

  it("resolveBlock blockId 不存在 → NOT_FOUND", () => {
    const pc = buildReplacePendingChange({ artifactId: "art-r", sourceActor: "x", oldContent: "a", newContent: "b" });
    store.save(projectId, pc);
    try {
      store.resolveBlock(projectId, "art-r", pc.id, { blockId: "no-such-block", action: "confirm" });
    } catch (e) {
      expect(e).toBeInstanceOf(PendingChangeError);
      expect((e as PendingChangeError).code).toBe("NOT_FOUND");
      return;
    }
    throw new Error("期望抛 NOT_FOUND");
  });

  it("resolveBlock 整条 pending 不存在 → NOT_FOUND", () => {
    try {
      store.resolveBlock(projectId, "art-r", "missing-pending", { action: "confirm" });
    } catch (e) {
      expect((e as PendingChangeError).code).toBe("NOT_FOUND");
      return;
    }
    throw new Error("期望抛 NOT_FOUND");
  });

  it("remove 删除 pending 文件；再 get → NOT_FOUND；remove 不存在不抛", () => {
    const pc = buildReplacePendingChange({ artifactId: "art-r", sourceActor: "x", oldContent: "a", newContent: "b" });
    store.save(projectId, pc);
    store.remove(projectId, "art-r", pc.id);
    expect(() => store.get(projectId, "art-r", pc.id)).toThrow(PendingChangeError);
    // 幂等：再删不抛
    expect(() => store.remove(projectId, "art-r", pc.id)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveAndMaterialize：全块 resolve → 重建 + 出新版 + 删 pending（D4，§5.5 AC⑤）
// ---------------------------------------------------------------------------
describe("PendingChangeStore.resolveAndMaterialize", () => {
  let artifactSvc: ArtifactService;
  let store2: PendingChangeStore;

  beforeEach(() => {
    artifactSvc = new ArtifactService(registry);
    store2 = new PendingChangeStore(registry, artifactSvc);
  });

  /** 建一个内容=oldContent 的受管 artifact，再对它建并落一条 oldContent→newContent 的 pending。 */
  function seed(oldContent: string, newContent: string): { artifactId: string; pcId: string } {
    const art = artifactSvc.createArtifact(projectId, { kind: "doc", title: "t", content: oldContent });
    const pc = buildReplacePendingChange({ artifactId: art.id, sourceActor: "x", oldContent, newContent });
    store2.save(projectId, pc);
    return { artifactId: art.id, pcId: pc.id };
  }

  it("未全决（仍有 pending 块）→ materialized=false、不出新版、pending 仍在", () => {
    const { artifactId, pcId } = seed("a\nOLD\nb\nc", "a\nNEW\nb\nc\nd"); // 两块
    const before = artifactSvc.getArtifact(projectId, artifactId).currentVersion;
    // 只决一块
    const oneBlock = store2.get(projectId, artifactId, pcId).diffBlocks[0].id;
    const res = store2.resolveAndMaterialize(projectId, artifactId, pcId, { blockId: oneBlock, action: "confirm" });
    expect(res.materialized).toBe(false);
    expect(res.artifact).toBeUndefined();
    expect(artifactSvc.getArtifact(projectId, artifactId).currentVersion).toBe(before); // 没出新版
    expect(() => store2.get(projectId, artifactId, pcId)).not.toThrow(); // pending 仍在
  });

  it("全块 confirm（省略 blockId）→ materialized=true、内容=newContent、版本+1、pending 删除", () => {
    const oldC = "a\nOLD\nb";
    const newC = "a\nNEW\nb\nc";
    const { artifactId, pcId } = seed(oldC, newC);
    const res = store2.resolveAndMaterialize(projectId, artifactId, pcId, { action: "confirm" });

    expect(res.materialized).toBe(true);
    expect(res.artifact?.currentVersion).toBe(2);
    // 物化后当前版内容 = 全 confirmed 重建 = newContent
    expect(artifactSvc.getArtifact(projectId, artifactId).content).toBe(newC);
    expect(artifactSvc.getArtifact(projectId, artifactId).currentVersion).toBe(2);
    // pending 已删
    expect(() => store2.get(projectId, artifactId, pcId)).toThrow(PendingChangeError);
  });

  it("全块 reject → materialized=true、内容=oldContent（出新版但内容回原样）、pending 删除", () => {
    const oldC = "a\nOLD\nb";
    const { artifactId, pcId } = seed(oldC, "a\nNEW\nb\nc");
    const res = store2.resolveAndMaterialize(projectId, artifactId, pcId, { action: "reject" });
    expect(res.materialized).toBe(true);
    expect(artifactSvc.getArtifact(projectId, artifactId).content).toBe(oldC);
    expect(() => store2.get(projectId, artifactId, pcId)).toThrow(PendingChangeError);
  });

  it("逐块 resolve：最后一块决完才物化（前面的块 materialized=false，最后一块 true）", () => {
    const { artifactId, pcId } = seed("a\nOLD\nb\nc", "a\nNEW\nb\nc\nd"); // 两块 mod + add
    const ids = store2.get(projectId, artifactId, pcId).diffBlocks.map((b) => b.id);
    const r1 = store2.resolveAndMaterialize(projectId, artifactId, pcId, { blockId: ids[0], action: "confirm" });
    expect(r1.materialized).toBe(false);
    const r2 = store2.resolveAndMaterialize(projectId, artifactId, pcId, { blockId: ids[1], action: "reject" });
    expect(r2.materialized).toBe(true);
    // mod 接受 + add 拒绝 → "a\nNEW\nb\nc"
    expect(artifactSvc.getArtifact(projectId, artifactId).content).toBe("a\nNEW\nb\nc");
  });

  it("artifact 不存在 → ArtifactError NOT_FOUND（物化阶段读当前版失败）", () => {
    // 直接对不存在的 artifact 造 pending（绕过 seed），全决触发物化时读 meta 抛 NOT_FOUND
    const pc = buildReplacePendingChange({ artifactId: "ghost", sourceActor: "x", oldContent: "a", newContent: "b" });
    store2.save(projectId, pc);
    expect(() => store2.resolveAndMaterialize(projectId, "ghost", pc.id, { action: "confirm" })).toThrow(ArtifactError);
  });
});
