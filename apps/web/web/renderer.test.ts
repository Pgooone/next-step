import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NO_HEADING_ANCHOR,
  bodyLineToNode,
  findLineRun,
  renderBlockCard,
  renderDocument,
  renderPresentation,
  splitLines,
} from "./renderer";
import type { DiffBlockPresentation, Presentation } from "./types";

/** 造一个 diff 块（测试 fixture）。 */
function block(over: Partial<DiffBlockPresentation> & { blockId: string }): DiffBlockPresentation {
  return {
    kind: "mod",
    tag: "✏️ 修改 1/5",
    anchor: "§2.1 内核策略",
    lines: ["新行 A", "新行 B"],
    oldLines: ["旧行 A"],
    state: "pending",
    ...over,
  };
}

function findCard(nodes: { tag: string; classes?: string[] }[], className: string): boolean {
  return nodes.some((n) => n.classes?.includes(className));
}

describe("splitLines（行切分与 pi 同语义）", () => {
  it("去尾空行、保留行内空白", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("parseHeading / bodyLineToNode（标题行 → 标题节点 + tocTarget）", () => {
  it("h1-h6 标题行带 tocTarget，空行 → null，正文 → p", () => {
    const h2 = bodyLineToNode("## §2 技术选型")!;
    expect(h2.tag).toBe("h2");
    expect(h2.dataset).toMatchObject({ tocTarget: "§2 技术选型", tocLabel: "§2 技术选型" });
    expect(bodyLineToNode("  ")).toBeNull();
    expect(bodyLineToNode("普通段落")!.tag).toBe("p");
  });
});

describe("findLineRun（块 oldLines 在正文中的连续匹配定位）", () => {
  const base = ["a", "b", "c", "d", "b", "c"];
  it("从 from 起找连续匹配，未命中 → -1", () => {
    expect(findLineRun(base, 0, ["b", "c"])).toBe(1);
    expect(findLineRun(base, 2, ["b", "c"])).toBe(4);
    expect(findLineRun(base, 0, ["x"])).toBe(-1);
    expect(findLineRun(base, 0, [])).toBe(-1);
  });
});

describe("renderBlockCard（块卡片：tag/anchor/行/note/✓✗ 位）", () => {
  it("mod 块渲染 del 旧行 + ins 新行 + 头部 + 动作按钮", () => {
    const card = renderBlockCard(block({ blockId: "b1" }));
    expect(card.classes).toContain("block");
    expect(card.dataset).toMatchObject({ blockId: "b1", blockState: "pending" });
    const text = (n: any): string[] =>
      (n.text ? [n.text] : []).concat((n.children ?? []).flatMap(text));
    const flat = text(card);
    expect(flat).toContain("旧行 A");
    expect(flat).toContain("新行 A");
    expect(flat).toContain("✏️ 修改 1/5");
    expect(flat).toContain("§2.1 内核策略");
    const head = card.children!.find((c) => c.classes?.includes("block-head"))!;
    const actions = head.children!.find((c) => c.classes?.includes("block-actions"))!;
    expect(actions.children).toHaveLength(2);
    expect(actions.children![0].dataset).toMatchObject({ action: "yes", block: "b1" });
    expect(actions.children![1].dataset).toMatchObject({ action: "no", block: "b1" });
  });

  it("state=rolledback 时卡片盖灰化类（渲染器按数据画，不自己判断）", () => {
    const card = renderBlockCard(block({ blockId: "b2", state: "rolledback", note: "未生效（v4 提案）" }));
    expect(card.classes).toContain("block-rolledback");
    const flat = JSON.stringify(card);
    expect(flat).toContain("未生效（v4 提案）");
  });

  it("add 块行渲染为 ins（无 del）", () => {
    const card = renderBlockCard(
      block({ blockId: "b3", kind: "add", lines: ["## §2.3 Web 壳", "自建薄壳"], oldLines: undefined }),
    );
    const lines = card.children!.filter((c) => c.classes?.some((x) => x.startsWith("diff-line")));
    expect(lines.length).toBe(1);
    expect(lines[0].classes).toContain("ins");
    expect(lines[0].text).toBe("自建薄壳");
  });
});

describe("renderDocument（正文行流 + 块嵌入）", () => {
  const base = [
    "# 文档标题",
    "## §1 概述",
    "一段概述",
    "## §2 技术选型",
    "### §2.1 内核策略",
    "旧策略行",
    "## §3 架构",
    "## §4 旧部署方案",
    "被删段落行",
    "## §5 验收标准",
  ].join("\n");

  it("inline：mod 块 oldLines 命中 → 正文跳过该区间、卡片嵌原位", () => {
    const nodes = renderDocument({
      baseContent: base,
      blocks: [
        block({ blockId: "b1", kind: "mod", oldLines: ["旧策略行"], lines: ["新策略行"] }),
      ],
      mode: "inline",
    });
    const flat = JSON.stringify(nodes);
    // 正文「旧策略行」不再单独显示（被卡片替换），卡片 ins 新行
    const pTexts = nodes
      .filter((n) => n.tag === "p" && !n.classes?.some((x) => x.startsWith("diff-line")))
      .map((n) => n.text);
    expect(pTexts).not.toContain("旧策略行");
    expect(flat).toContain("新策略行");
    // 块序：§2.1 标题之后 → 卡片 → §3 标题
    const h2idx = nodes.findIndex((n) => n.text === "§3 架构");
    const h3idx = nodes.findIndex((n) => n.text === "§2.1 内核策略");
    const cardIdx = nodes.findIndex((n) => n.classes?.includes("block"));
    expect(h3idx).toBeLessThan(cardIdx);
    expect(cardIdx).toBeLessThan(h2idx);
  });

  it("inline：del 块整节删除 → 正文整节被跳过（§4 不显示）、卡片含被删行", () => {
    const nodes = renderDocument({
      baseContent: base,
      blocks: [block({ blockId: "b1", kind: "del", lines: ["## §4 旧部署方案", "被删段落行"], oldLines: undefined })],
      mode: "inline",
    });
    const flat = JSON.stringify(nodes);
    expect(flat).toContain("被删段落行"); // 卡片 del 行
    const h2s = nodes.filter((n) => n.tag === "h2").map((n) => n.text);
    expect(h2s).not.toContain("§4 旧部署方案"); // 正文标题被跳过（不重复）
  });

  it("inline：add 块插在当前扫描位（前一块之后），标题行抽为 v4only 标题", () => {
    const nodes = renderDocument({
      baseContent: base,
      blocks: [
        block({ blockId: "b1", kind: "mod", oldLines: ["旧策略行"], lines: ["新策略行"] }),
        block({ blockId: "b2", kind: "add", lines: ["## §2.3 Web 壳", "自建薄壳"], oldLines: undefined, anchor: "§2.3 Web 壳选型" }),
      ],
      mode: "inline",
    });
    const flat = JSON.stringify(nodes);
    expect(flat).toContain("自建薄壳");
    // 块 1 卡片 → §2.3 标题（v4only）→ 块 2 卡片 → §3
    const card1 = nodes.findIndex((n) => n.dataset?.blockId === "b1");
    const title = nodes.findIndex((n) => n.classes?.includes("block-title"));
    const card2 = nodes.findIndex((n) => n.dataset?.blockId === "b2");
    const h3 = nodes.findIndex((n) => n.text === "§3 架构");
    expect(card1).toBeLessThan(title);
    expect(title).toBeLessThan(card2);
    expect(card2).toBeLessThan(h3);
  });

  it("rolledback：正文全量渲染（§4 段落恢复显示）+ 块卡片按 anchor 插标题后、del 行恢复文本", () => {
    const nodes = renderDocument({
      baseContent: base,
      blocks: [
        block({ blockId: "b1", kind: "mod", oldLines: ["旧策略行"], lines: ["新策略行"], state: "rolledback" }),
        block({ blockId: "b3", kind: "del", lines: ["## §4 旧部署方案", "被删段落行"], oldLines: undefined, anchor: "§4 旧部署方案", state: "rolledback" }),
      ],
      mode: "rolledback",
    });
    const flat = JSON.stringify(nodes);
    // 被删段落恢复显示（正文全量）
    expect(flat).toContain("被删段落行");
    const h2s = nodes.filter((n) => n.tag === "h2").map((n) => n.text);
    expect(h2s).toContain("§4 旧部署方案");
    // 卡片存在且灰化（state 透传）
    expect(findCard(nodes, "block-rolledback")).toBe(true);
    // 卡片 del 行跳过标题行（防与正文重复）：b3 只剩「被删段落行」1 行（标题仅出现在 anchor 位）
    const card = nodes.find((n) => n.dataset?.blockId === "b3")!;
    const lines = card.children!.filter((c) => c.classes?.some((x) => x.startsWith("diff-line")));
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("被删段落行");
  });

  it("anchor 未命中（无就近标题）的块退化为插当前位置，不抛错", () => {
    const nodes = renderDocument({
      baseContent: "只有一行",
      blocks: [block({ blockId: "b1", anchor: NO_HEADING_ANCHOR, oldLines: undefined, kind: "add", lines: ["新内容"] })],
      mode: "inline",
    });
    expect(JSON.stringify(nodes)).toContain("新内容");
  });
});

describe("renderPresentation（通用渲染器：title/badges/body 各块类型）", () => {
  it("banner/rows/text/diff 四类块按数据渲染，零领域判断", () => {
    const p: Presentation = {
      title: "📄 测试 v1 → v2",
      badges: [{ kind: "pending", text: "待确认 · 1 块" }],
      body: [
        { kind: "banner", tone: "info", text: "回滚报告", actions: ["查看差异", "撤销回滚"] },
        { kind: "rows", rows: [{ key: "v1", value: "agent: a", detail: "时间" }] },
        { kind: "text", text: "纯文本段" },
        { kind: "diff", diffRef: { artifactId: "x", fromVersion: 1, toVersion: 2, blocks: [block({ blockId: "b1" })] } },
      ],
    };
    const tree = renderPresentation(p);
    const flat = JSON.stringify(tree);
    expect(tree.classes).toContain("presentation");
    expect(flat).toContain("待确认 · 1 块");
    expect(flat).toContain("回滚报告");
    expect(flat).toContain("查看差异");
    expect(flat).toContain("纯文本段");
    expect(flat).toContain("block-actions");
    // 渲染出的 diff 块数/kind/state 与输入一致（卡内断言 1 的纯函数侧）
    const blocks = tree.children!.find((n) => n.classes?.includes("blocks"))!;
    expect(blocks.children).toHaveLength(1);
    expect(blocks.children![0].dataset?.blockId).toBe("b1");
    expect(blocks.children![0].dataset?.blockState).toBe("pending");
  });

  it("externalMerge 标志 → 卡片渲染「外部手改合并」来源标识（T1-06 义务 1 的数据侧）", () => {
    const card = renderBlockCard(block({ blockId: "b1" }), { externalMerge: true });
    expect(JSON.stringify(card)).toContain("外部手改合并");
  });
});

describe("渲染器零领域判断（静态审查，卡内断言 3 的可执行形态）", () => {
  const sources = ["renderer.ts", "panel-state.ts", "dom.ts", "panel.ts", "api.ts", "main.ts"].map((f) =>
    readFileSync(new URL(`./${f}`, import.meta.url), "utf-8"),
  );

  it("web/ 组件树零 pi import（只 fetch server 端点 + 画 presentation）", () => {
    for (const [i, src] of sources.entries()) {
      expect(src).not.toContain("@pgooone/next-step-pi");
      expect(src).not.toContain("node:fs");
      expect(src).not.toContain("node:path");
    }
  });
});
