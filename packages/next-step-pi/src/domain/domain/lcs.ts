/**
 * 行级 LCS diff 纯算法（**零 node/外部依赖、客户端安全**）。
 *
 * 抽出动机（第七轮·第二轮纠偏 bugfix）：写盘端 `pending-change-service.ts` 引 `node:fs`/`node:crypto`
 * 等 server-only 依赖；而内联渲染端 `lib/artifact-view/anchor.ts`（被 `"use client"` 的 ArtifactPanel 导入）
 * 需要 **值导入** 同一份 `lcsDiff`/`splitLines` 来按 LCS ops 顺序渲染。若 anchor 直接从 pending-change-service
 * 值导入，整条 server-only 链（→ node:fs）会被拖进客户端 bundle，Turbopack 报
 * `the chunking context does not support external modules (request: node:fs)` 致全站 500。
 * 故把这两个纯算法 + DiffOp 抽到本模块：`pending-change-service.ts`（写盘）与 `anchor.ts`（渲染）
 * 都从这里导入——**共用同一实现**（block.id 与 ops 对齐绝不漂移，D-R7B-04），且客户端只拉到纯函数。
 */

/** LCS 行级 diff 的单步操作：未改动 / 删除 / 新增。 */
export type DiffOp =
  | { type: "equal"; line: string }
  | { type: "del"; line: string }
  | { type: "add"; line: string };

/**
 * 把文本按行切分（保留空文件 → 空数组语义）。
 * 末尾换行不额外产出一个空行项（"a\n" → ["a"]，与编辑器「a 后有换行」直觉一致）。
 */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 经典 LCS（最长公共子序列）行级 diff：返回 equal/del/add 的有序序列。
 * 删除排在新增之前（del 段后紧跟 add 段时由调用方合并为 mod 块）。
 */
export function lcsDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const m = oldLines.length;
  const n = newLines.length;
  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "equal", line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "add", line: newLines[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: "del", line: oldLines[i++] });
  while (j < n) ops.push({ type: "add", line: newLines[j++] });
  return ops;
}
