/**
 * 通用渲染器（T1-12，D8 承重实证核心）：presentation 纯数据 → 渲染树（RenderNode）。
 *
 * 零领域判断：不重算 diff、不判断状态——输入的块状态/行内容/标题锚全部来自 server
 * 端点（T1-11 presentation 构建同源），本模块只做「按数据排版」：
 * - title/badges/body 各块类型（diff / rows / banner / text）→ 树节点。
 * - 正文行流渲染（标题行 → h1-h3、空行跳过、其余 → 段）+ diff 块卡片按声明的位置嵌入。
 *
 * 零 DOM：输出普通对象树（tag/classes/dataset/text/children），浏览器端由 dom.ts
 * 挂载、单测直接断言树——渲染逻辑与 UI 壳分离，「新增条目类型两壳零改动」的 Web 侧实证。
 *
 * 本文件零 pi import、零 IO（红线：组件树 grep 无 L1 服务调用）。
 */
import type {
  DiffBlockPresentation,
  Presentation,
  PresentationBlock,
  Row,
} from "./types";

/** 渲染树节点（DOM 的纯数据描述）。 */
export type RenderNode = {
  tag: string;
  attrs?: Record<string, string>;
  classes?: string[];
  dataset?: Record<string, string>;
  text?: string;
  children?: RenderNode[];
};

const node = (
  tag: string,
  opts: {
    classes?: string[];
    dataset?: Record<string, string>;
    attrs?: Record<string, string>;
    text?: string;
    children?: RenderNode[];
  } = {},
): RenderNode => ({ tag, ...opts });

/** 行切分（与 pi lcs.splitLines 同语义：去尾空行、保留行内空白）。 */
export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 标题行 → 级数与标题文本（`## 标题` → { level: 2, label: "标题" }；非标题行 → null）。 */
export function parseHeading(line: string): { level: number; label: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const label = m[2].trim();
  if (!label) return null;
  return { level: m[1].length, label };
}

/** 「（无就近标题）」占位锚（pi builders.NO_HEADING_ANCHOR 同文案，前端仅用于跳过定位）。 */
export const NO_HEADING_ANCHOR = "（无就近标题）";

// ---------------------------------------------------------------------------
// 块卡片渲染（diff 块：tag/anchor/行/note + ✓✗ 动作位）
// ---------------------------------------------------------------------------

/** add 块：标题行抽到卡片外（新节的标题，v4only——回滚后隐藏），剩余行进卡片 ins。 */
function blockHeading(block: DiffBlockPresentation): RenderNode[] {
  if (block.kind !== "add") return [];
  const idx = block.lines.findIndex((l) => parseHeading(l) !== null);
  if (idx < 0) return [];
  const h = parseHeading(block.lines[idx])!;
  const title = block.anchor !== "" && block.anchor !== NO_HEADING_ANCHOR ? block.anchor : h.label;
  return [
    node(`h${Math.min(h.level, 3)}`, {
      classes: ["v4only", "block-title"],
      dataset: { blockTitle: block.blockId },
      text: title,
    }),
  ];
}

/** diff 块卡片（state 类由面板把本地裁决映射进 presentation state 后传入，渲染器照画）。 */
export function renderBlockCard(
  block: DiffBlockPresentation,
  opts: { externalMerge?: boolean; skipHeading?: boolean } = {},
): RenderNode {
  const insLines = block.kind === "del" ? [] : block.lines;
  // add 块的标题行由 blockHeading 抽到卡片外（h3.v4only），卡片内跳过避免重复
  const ins = insLines.filter((l) => !(block.kind === "add" && parseHeading(l) !== null));
  const delLines = block.kind === "mod" ? (block.oldLines ?? []) : block.kind === "del" ? block.lines : [];
  // 标题行已由正文/块头呈现时不在卡片内重复（正文定位回退时跳过，见 renderDocument 注释）
  const del = delLines.filter((l, i) => !(i === 0 && parseHeading(l) !== null && opts.skipHeading));
  const children: RenderNode[] = [
    node("div", {
      classes: ["block-head"],
      children: [
        node("span", { classes: ["block-tag"], text: block.tag }),
        node("span", { classes: ["block-anchor"], text: block.anchor }),
        ...(opts.externalMerge
          ? [node("span", { classes: ["block-src"], text: "外部手改合并" })]
          : []),
        node("div", {
          classes: ["block-actions"],
          children: [
            node("button", {
              classes: ["pick", "yes"],
              dataset: { action: "yes", block: block.blockId },
              attrs: { type: "button", title: "接受" },
              text: "✓",
            }),
            node("button", {
              classes: ["pick", "no"],
              dataset: { action: "no", block: block.blockId },
              attrs: { type: "button", title: "拒绝" },
              text: "✗",
            }),
          ],
        }),
      ],
    }),
  ];
  for (const l of del) children.push(node("p", { classes: ["diff-line", "del"], text: l }));
  for (const l of ins) children.push(node("p", { classes: ["diff-line", "ins"], text: l }));
  if (block.note !== undefined && block.note !== "") {
    children.push(node("div", { classes: ["block-note"], text: block.note }));
  }
  return node("div", {
    classes: ["block", `block-${block.state}`],
    dataset: { blockId: block.blockId, blockState: block.state },
    children,
  });
}

// ---------------------------------------------------------------------------
// 正文渲染：base 行流 + diff 块嵌入（「文档内联沉浸审阅」的排版核心）
// ---------------------------------------------------------------------------

/** 在 base 行数组中从 from 起找 target 的连续匹配（顺序扫描，未找到 → -1）。 */
export function findLineRun(base: string[], from: number, target: string[]): number {
  if (target.length === 0) return -1;
  outer: for (let i = from; i + target.length <= base.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (base[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** 单行 → 正文节点（标题行 → h1-h3 + tocTarget，空行 → null，其余 → 段）。 */
export function bodyLineToNode(line: string): RenderNode | null {
  if (line.trim() === "") return null;
  const h = parseHeading(line);
  if (h) {
    return node(`h${h.level}`, {
      dataset: { tocTarget: h.label, tocLabel: h.label },
      text: h.label,
    });
  }
  return node("p", { text: line });
}

/**
 * 文档正文 + 块嵌入。mode：
 * - "inline"：块按声明 oldLines 顺序匹配 base 行流（命中 → 正文跳过该区间、卡片原位嵌入）；
 *   匹配失败回退「anchor 标题后插入」（不跳过正文行）；add 块（无 oldLines）插在当前扫描位。
 * - "rolledback"：正文全量渲染（历史版内容完整显示），块卡片按 anchor 插到对应标题后
 *   （无匹配 → 前一块后/文档首）；卡片 del 行跳过标题行避免与正文重复。
 *
 * 全部定位数据（块声明的 oldLines / anchor / 行内容）来自 server，本函数只做机械排版。
 */
export function renderDocument(opts: {
  baseContent: string;
  blocks: DiffBlockPresentation[];
  mode: "inline" | "rolledback";
  externalMerge?: boolean;
}): RenderNode[] {
  const { blocks } = opts;
  const base = splitLines(opts.baseContent);
  const out: RenderNode[] = [];
  if (opts.mode === "rolledback") return renderRolledback(base, blocks, opts.externalMerge);

  let scan = 0;
  const pushBody = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const n = bodyLineToNode(base[i]);
      if (n) out.push(n);
    }
  };
  for (const block of blocks) {
    const oldLines = block.oldLines ?? (block.kind === "del" ? block.lines : undefined);
    if (oldLines !== undefined) {
      const pos = findLineRun(base, scan, oldLines);
      if (pos >= 0) {
        pushBody(scan, pos);
        out.push(...blockHeading(block));
        out.push(renderBlockCard(block, { externalMerge: opts.externalMerge }));
        scan = pos + oldLines.length;
        continue;
      }
    }
    if (block.anchor !== "" && block.anchor !== NO_HEADING_ANCHOR) {
      const hPos = findHeadingFrom(base, scan, block.anchor);
      if (hPos >= 0) {
        pushBody(scan, hPos);
        const h = bodyLineToNode(base[hPos]);
        if (h) out.push(h);
        out.push(...blockHeading(block));
        // 正文标题行已渲染 → 卡片内 del 行跳过标题行（防重复）
        out.push(renderBlockCard(block, { externalMerge: opts.externalMerge, skipHeading: true }));
        scan = hPos + 1;
      } else {
        // anchor 未命中：插在当前扫描位（add 块插前一块之后/文档流当前位置）
        out.push(...blockHeading(block));
        out.push(renderBlockCard(block, { externalMerge: opts.externalMerge }));
      }
    } else {
      out.push(...blockHeading(block));
      out.push(renderBlockCard(block, { externalMerge: opts.externalMerge }));
    }
  }
  pushBody(scan, base.length);
  return out;
}

/** 从 from 起找标题行（label 与 anchor 相同，未使用过）的行号；未找到 → -1。 */
function findHeadingFrom(base: string[], from: number, anchor: string): number {
  for (let i = from; i < base.length; i++) {
    const h = parseHeading(base[i]);
    if (h && h.label === anchor) return i;
  }
  return -1;
}

/** 回滚态：正文全量渲染 + 块卡片按 anchor 定位插入。 */
function renderRolledback(
  base: string[],
  blocks: DiffBlockPresentation[],
  externalMerge?: boolean,
): RenderNode[] {
  const out: RenderNode[] = [];
  for (const line of base) {
    const n = bodyLineToNode(line);
    if (n) out.push(n);
  }
  // 标题节点索引（label → 节点位置）；「前一块之后」跟踪
  const headingIndex = new Map<string, number[]>();
  out.forEach((n, i) => {
    if (n.dataset?.tocTarget !== undefined) {
      const list = headingIndex.get(n.dataset.tocTarget) ?? [];
      list.push(i);
      headingIndex.set(n.dataset.tocTarget, list);
    }
  });
  const used = new Set<number>();
  let lastInsert = -1; // out 中最后插入的块卡片位置（栈顶 = 最近一块）
  for (const block of blocks) {
    let insertAt = -1;
    if (block.anchor !== "" && block.anchor !== NO_HEADING_ANCHOR) {
      const candidates = headingIndex.get(block.anchor) ?? [];
      const free = candidates.find((i) => !used.has(i));
      if (free !== undefined) {
        insertAt = free + 1; // 标题之后
        used.add(free);
      }
    }
    if (insertAt < 0) insertAt = lastInsert + 1; // 无匹配 → 前一块之后（首块 → 文档首）
    // 正文全量渲染（标题行已在正文）→ 卡片内 del 行跳过标题行防重复
    const piece = [...blockHeading(block), renderBlockCard(block, { externalMerge, skipHeading: true })];
    out.splice(insertAt, 0, ...piece);
    lastInsert = insertAt + piece.length - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// presentation 通用渲染（title/badges/body 各块类型）
// ---------------------------------------------------------------------------

/** 横幅（warn/info/ok），actions 渲染为按钮位（data-action，事件由面板绑定）。 */
export function renderBanner(block: Extract<PresentationBlock, { kind: "banner" }>): RenderNode {
  return node("div", {
    classes: ["banner", block.tone],
    dataset: { banner: block.tone },
    children: [
      node("span", { classes: ["msg"], text: block.text }),
      ...block.actions.map((a, i) =>
        node("button", {
          classes: ["btn", "banner-action"],
          dataset: { action: `banner-${i}` },
          attrs: { type: "button" },
          text: a,
        }),
      ),
    ],
  });
}

/** 通用行列表（版本链抽屉 / 回滚报告等 body.rows）。 */
export function renderRows(rows: Row[]): RenderNode {
  return node("div", {
    classes: ["rows"],
    children: rows.map((r) =>
      node("div", {
        classes: ["row"],
        children: [
          node("span", { classes: ["row-key"], text: r.key }),
          node("span", { classes: ["row-value"], text: r.value }),
          ...(r.detail !== undefined ? [node("span", { classes: ["row-detail"], text: r.detail })] : []),
        ],
      }),
    ),
  });
}

/**
 * 通用渲染器主入口：Presentation（title/badges/body）→ 渲染树。
 * body 各块类型（diff/rows/banner/text）按数据画；diff 块渲染为卡片区（逐块 ✓✗ 由面板绑定）。
 */
export function renderPresentation(p: Presentation, opts: { externalMerge?: boolean } = {}): RenderNode {
  const children: RenderNode[] = [];
  for (const block of p.body) {
    switch (block.kind) {
      case "diff":
        children.push(
          node("div", {
            classes: ["blocks"],
            children: block.diffRef.blocks.map((b) => renderBlockCard(b, opts)),
          }),
        );
        break;
      case "rows":
        children.push(renderRows(block.rows));
        break;
      case "banner":
        children.push(renderBanner(block));
        break;
      case "text":
        children.push(node("p", { text: block.text }));
        break;
    }
  }
  return node("div", {
    classes: ["presentation"],
    children: [
      node("header", {
        classes: ["pres-head"],
        children: [
          node("h1", { text: p.title }),
          node("div", {
            classes: ["badges"],
            children: p.badges.map((b) => node("span", { classes: ["badge", b.kind], text: b.text })),
          }),
        ],
      }),
      ...children,
    ],
  });
}
