/**
 * 面板状态机（T1-12）：确认分档交互的纯函数（D6 / P2-5）。
 *
 * - 逐块 ✓/✗ 即时翻转（再点取消）、批量后单块仍可翻转（混合档）；
 * - 有待定块写回禁用（P2-5：前端本地状态、写回一次性提交——本地聚齐后由面板层一次性调 resolve）；
 * - 有 pending 回滚禁用（原型实证守卫的 UI 侧；L1 侧还有 PENDING_EXISTS → 409 双保险）。
 *
 * 零 IO、零 DOM：输入 votes 记录 → 输出新记录/门禁布尔，面板层负责与 server 交互。
 */
export type Vote = "yes" | "no";
export type Votes = Record<string, Vote | undefined>;

export type PanelState = {
  /** blockId → 本地裁决（yes=✓ 接受 / no=✗ 拒绝 / undefined=待定）。 */
  votes: Votes;
  /** 当前提案的总块数（进度 x/N 的分母）。 */
  total: number;
  /** 是否存在待确认提案（无提案时写回/回滚门禁的另一半）。 */
  hasPending: boolean;
  /** 已写回（本会话锁定交互）。 */
  locked: boolean;
  /** 外部手改冻结（S4：警告消除前版本操作被阻止）。 */
  extMode: boolean;
};

export const emptyState = (total = 0): PanelState => ({
  votes: {},
  total,
  hasPending: total > 0,
  locked: false,
  extMode: false,
});

/** 有着落的块数。 */
export function settledCount(s: PanelState): number {
  return Object.values(s.votes).filter((v) => v !== undefined).length;
}

/** 有待定块（存在未裁决的块）。 */
export function hasUndecided(s: PanelState): boolean {
  return settledCount(s) < s.total;
}

/** 逐块 ✓/✗：点相同裁决 → 取消（回待定）；不同裁决 → 切换。 */
export function toggleVote(s: PanelState, blockId: string, vote: Vote): PanelState {
  return { ...s, votes: { ...s.votes, [blockId]: s.votes[blockId] === vote ? undefined : vote } };
}

/** 批量裁决（全部接受 / 全部拒绝）；批量后单块仍可 toggle 翻转（混合档）。 */
export function bulkVote(s: PanelState, blockIds: string[], vote: Vote): PanelState {
  const votes = { ...s.votes };
  for (const id of blockIds) votes[id] = vote;
  return { ...s, votes };
}

/** 写回可用：有提案 + 未锁定 + 非外部手改冻结 + 全部块有着落。 */
export function canWriteback(s: PanelState): boolean {
  return s.hasPending && !s.locked && !s.extMode && !hasUndecided(s);
}

/** 回滚可用：非外部手改冻结 + 无待确认提案（有 pending 回滚禁用；L1 侧 409 兜底）。 */
export function canRollback(s: PanelState): boolean {
  return !s.extMode && !s.hasPending;
}

/** 逐块/批量交互可用：未锁定 + 非外部手改冻结。 */
export function canInteract(s: PanelState): boolean {
  return !s.locked && !s.extMode;
}

/** 把本地裁决映射为 presentation 块状态（渲染数据：绿/红/黄由 state 表达，渲染器照画）。 */
export function applyVotes(
  blocks: { blockId: string; state: string }[],
  votes: Votes,
): { blockId: string; state: string }[] {
  return blocks.map((b) => {
    const v = votes[b.blockId];
    return v === "yes" ? { ...b, state: "confirmed" } : v === "no" ? { ...b, state: "rejected" } : b;
  });
}
