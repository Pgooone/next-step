import { describe, expect, it } from "vitest";
import {
  applyVotes,
  bulkVote,
  canInteract,
  canRollback,
  canWriteback,
  emptyState,
  hasUndecided,
  settledCount,
  toggleVote,
} from "./panel-state";

const IDs = ["b1", "b2", "b3", "b4", "b5"];

describe("panel-state（确认分档交互状态机，D6 / P2-5）", () => {
  it("逐块 ✓/✗：状态即时三色变化（votes 记录），再点同键取消回待定", () => {
    let s = emptyState(5);
    s = toggleVote(s, "b1", "yes");
    expect(s.votes.b1).toBe("yes");
    expect(settledCount(s)).toBe(1);
    s = toggleVote(s, "b2", "no");
    expect(s.votes.b2).toBe("no");
    expect(settledCount(s)).toBe(2);
    s = toggleVote(s, "b1", "yes"); // 再点 → 取消
    expect(s.votes.b1).toBeUndefined();
    expect(settledCount(s)).toBe(1);
  });

  it("有待定块写回禁用：全部有着落才可用（卡内断言 2）", () => {
    let s = emptyState(2);
    expect(canWriteback(s)).toBe(false); // 全待定
    s = toggleVote(s, "b1", "yes");
    expect(canWriteback(s)).toBe(false); // 仍有待定
    s = toggleVote(s, "b2", "no");
    expect(canWriteback(s)).toBe(true); // 2/2 有着落
    expect(hasUndecided(s)).toBe(false);
  });

  it("批量后单块仍可翻转（混合档：先全收再打回单块）", () => {
    let s = emptyState(5);
    s = bulkVote(s, IDs, "yes");
    expect(settledCount(s)).toBe(5);
    expect(s.votes).toEqual({ b1: "yes", b2: "yes", b3: "yes", b4: "yes", b5: "yes" });
    s = toggleVote(s, "b3", "no"); // 批量后单块翻转
    expect(s.votes.b3).toBe("no");
    expect(settledCount(s)).toBe(5);
    expect(canWriteback(s)).toBe(true);
  });

  it("批量全部拒绝", () => {
    const s = bulkVote(emptyState(3), ["x", "y", "z"], "no");
    expect(s.votes).toEqual({ x: "no", y: "no", z: "no" });
  });

  it("有 pending 回滚禁用；写回（pending 清除）后可回滚（卡内断言 2）", () => {
    let s = emptyState(3);
    expect(canRollback(s)).toBe(false); // 有 pending
    s = { ...s, hasPending: false }; // 写回/回滚后的状态
    expect(canRollback(s)).toBe(true);
  });

  it("外部手改冻结（S4）：写回/回滚/逐块交互全部禁用，警告消除后恢复", () => {
    let s = emptyState(1);
    s = toggleVote(s, "b1", "yes");
    s = { ...s, extMode: true };
    expect(canWriteback(s)).toBe(false);
    expect(canRollback(s)).toBe(false);
    expect(canInteract(s)).toBe(false);
    s = { ...s, extMode: false };
    expect(canWriteback(s)).toBe(true);
  });

  it("写回锁定后交互冻结", () => {
    let s = emptyState(1);
    s = toggleVote(s, "b1", "yes");
    s = { ...s, locked: true, hasPending: false };
    expect(canWriteback(s)).toBe(false);
    expect(canInteract(s)).toBe(false);
    expect(canRollback(s)).toBe(true); // 锁定不影响回滚（pending 已清）
  });

  it("applyVotes：本地裁决映射为 presentation state（渲染数据），待定块保持原样", () => {
    const blocks = [
      { blockId: "b1", state: "pending" },
      { blockId: "b2", state: "pending" },
      { blockId: "b3", state: "pending" },
    ];
    const mapped = applyVotes(blocks, { b1: "yes", b2: "no" });
    expect(mapped.map((b) => [b.blockId, b.state])).toEqual([
      ["b1", "confirmed"],
      ["b2", "rejected"],
      ["b3", "pending"],
    ]);
    expect(blocks[0].state).toBe("pending"); // 不修改输入（纯函数）
  });
});
