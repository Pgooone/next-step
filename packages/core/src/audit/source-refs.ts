import { PendingChangeError, type PendingChange } from "../domain/pending-change-service";
import { splitLines, lcsDiff } from "../domain/lcs";

/**
 * 块级来源引用（详细设计 §1.2，M2a 第一期只写不查）。
 * D4 拍板：{ artifactId + version + blockAnchor }，由工具写入而非模型输出——
 * 模型全程不产出 sourceRef（正本 §6 M2 红线）。
 * 第一期无任何读取查询路径；只保证「每条物化版本的 confirmed 块都有一份可追溯记录」。
 */
export type SourceRef = {
  artifactId: string;
  /** 该块生效后的产物版本号（= 物化出的新版本）。 */
  version: number;
  /** 块锚点：行区间 + 就近标题（第三期归因消费；本期只保证「写了、可稳定定位」）。 */
  blockAnchor: {
    lineStart: number; // 基于 oldContent 的行区间（1 基）
    lineEnd: number;
    /** 该块所处最近一节标题（构建时推导，尽力而为，H6）。 */
    heading?: string;
  };
};

/**
 * 块锚信息（含块 id，供 presentation anchor 与 sourceRef 两个消费者共用同一次重放）。
 */
export type BlockAnchorInfo = {
  blockId: string;
  lineStart: number;
  lineEnd: number;
  heading?: string;
};

/** ATX 标题行（# ~ ###### 后跟空格；允许行首行尾空白，尽力而为）。 */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * 从 fromLine（1 基，含自身）向上找最近的标题行，返回标题文本（去掉 # 前缀）。
 * H6 裁决：heading 仅可读、尽力而为——找不到返回 undefined；第三期 trace_defect 消费时再细化。
 */
export function findHeadingUp(lines: string[], fromLine: number): string | undefined {
  for (let i = Math.min(fromLine, lines.length); i >= 1; i--) {
    const raw = lines[i - 1].trim();
    const m = HEADING_RE.exec(raw);
    if (m) return m[2].trim() || raw;
  }
  return undefined;
}

/** 在给定行序列中找第一个标题行（add 块新增了自己的节标题时，节名取自新内容）。 */
export function firstHeadingIn(lines: string[]): string | undefined {
  for (const line of lines) {
    const raw = line.trim();
    const m = HEADING_RE.exec(raw);
    if (m) return m[2].trim() || raw;
  }
  return undefined;
}

/**
 * 为 PendingChange 的**全部** diff 块推导 blockAnchor（H6 + P2-4 定案的行区间基线，本函数即唯一实现）：
 *
 * 1. **del / mod 块锚 oldContent 行区间**：LCS ops 的 equal/del 都消耗旧行号，
 *    连续 del 段的 [首行, 末行] 即锚（mod = del 段 + 紧跟 add 段，锚同一 old 区间）。
 * 2. **add 块锚「块前最近 equal 行 + 1 行、lineEnd 同」**（P2-4 定案）：新增内容在 oldContent
 *    里没有行号，锚定到「紧随前文最后一行 equal 之后的位置」（插入点可复现）；
 *    文首插入（前面无 equal 行）→ lineStart = 1。
 * 3. **heading 就近推导**：从锚区间首行（含自身，超出 old 末行时取末行）向上找最近标题行，
 *    找不到省略（尽力而为，H6）。
 *
 * 实现与 applyResolvedBlocks 同一「重放生成 diffBlocks 时的同一切块过程」范式：对 old/new 重跑
 * lcsDiff + 同一聚块循环，编辑组与 change.diffBlocks 一一对应、同序；失配抛 INVALID（不静默错配）。
 * 仅支持 op="replace"（与 applyResolvedBlocks / 物化路径一致，MVP 唯一路径）。
 */
export function computeBlockAnchors(change: PendingChange): BlockAnchorInfo[] {
  if (change.diff.kind !== "replace") {
    throw new PendingChangeError(
      "INVALID",
      `computeBlockAnchors 仅支持 op=replace，收到 ${change.op}`,
    );
  }
  const oldLines = splitLines(change.diff.oldContent);
  const ops = lcsDiff(oldLines, splitLines(change.diff.newContent));

  const anchors: BlockAnchorInfo[] = [];
  let oldLine = 0; // 已消耗的旧行数（下一旧行号 = oldLine + 1）
  let lastEqualLine = 0; // 块前最近一次 equal 的旧行号（0 = 文首之前）
  let blockIdx = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === "equal") {
      oldLine++;
      lastEqualLine = oldLine;
      k++;
      continue;
    }
    const firstDelLine = oldLine + 1;
    let delCount = 0;
    while (k < ops.length && ops[k].type === "del") {
      delCount++;
      oldLine++;
      k++;
    }
    while (k < ops.length && ops[k].type === "add") {
      k++; // add 不消耗旧行号
    }
    const block = change.diffBlocks[blockIdx++];
    if (!block) {
      throw new PendingChangeError("INVALID", "diffBlocks 与 diff 失配：编辑组多于块数");
    }
    const lineStart = delCount > 0 ? firstDelLine : lastEqualLine + 1;
    const lineEnd = delCount > 0 ? oldLine : lineStart;
    const heading = findHeadingUp(oldLines, Math.min(lineStart, oldLines.length));
    anchors.push({
      blockId: block.id,
      lineStart,
      lineEnd,
      ...(heading !== undefined ? { heading } : {}),
    });
  }
  if (blockIdx !== change.diffBlocks.length) {
    throw new PendingChangeError("INVALID", "diffBlocks 与 diff 失配：块数多于编辑组");
  }
  return anchors;
}

/**
 * 物化成功后为每个 **confirmed** 块构造一条 SourceRef（详细设计 §1.2 写入路径：
 * pending-gate-service 在确认物化成功后调用，随 artifact_resolved 审计条目写入 appendEntry）。
 * 不变量：confirmed 块数 = sourceRefs 条数；version = newVersion（物化出的新版本号）。
 */
export function buildSourceRefs(change: PendingChange, newVersion: number): SourceRef[] {
  const confirmedIds = new Set(
    change.diffBlocks.filter((b) => b.state === "confirmed").map((b) => b.id),
  );
  return computeBlockAnchors(change)
    .filter((a) => confirmedIds.has(a.blockId))
    .map((a) => ({
      artifactId: change.artifactId,
      version: newVersion,
      blockAnchor: {
        lineStart: a.lineStart,
        lineEnd: a.lineEnd,
        ...(a.heading !== undefined ? { heading: a.heading } : {}),
      },
    }));
}
