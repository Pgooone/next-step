/**
 * DOM 挂载层（T1-12）：RenderNode 渲染树 → 真实 DOM + 滚动链（P2-11）构建。
 *
 * 本层无任何领域逻辑——只做节点创建/class/dataset/文本与事件绑定；
 * 交互语义（裁决/写回/回滚/外部三动作）全部在 panel.ts，状态判断在 panel-state.ts。
 */
import type { RenderNode } from "./renderer";

/** 渲染树 → DOM 元素（挂到 container 内，返回首节点）。 */
export function mountRenderTree(root: RenderNode, container: HTMLElement): HTMLElement | null {
  const el = createElement(root);
  if (el) container.appendChild(el);
  return el;
}

export function createElement(n: RenderNode): HTMLElement | null {
  const el = document.createElement(n.tag);
  if (n.classes) el.classList.add(...n.classes);
  if (n.dataset) {
    for (const [k, v] of Object.entries(n.dataset)) el.dataset[k] = v;
  }
  if (n.attrs) {
    for (const [k, v] of Object.entries(n.attrs)) el.setAttribute(k, v);
  }
  if (n.text !== undefined) el.textContent = n.text;
  for (const c of n.children ?? []) {
    const child = createElement(c);
    if (child) el.appendChild(child);
  }
  return el;
}

/** 滚动链节点描述（标题节点 + diff 块节点，颜色随块状态）。 */
export type TocNode = {
  el: HTMLElement;
  label: string;
  blockId: string | null; // null = 标题节点
};

/**
 * 从渲染后的文档容器收集滚动链节点：顺序 = 文档内顺序
 * （标题元素 data-toc-target + 块卡片 data-block-id，presentation DiffRef 块序保证一致）。
 */
export function collectTocNodes(container: HTMLElement): TocNode[] {
  const nodes: TocNode[] = [];
  const els = container.querySelectorAll<HTMLElement>("[data-toc-target], [data-block-id]");
  els.forEach((el) => {
    if (el.dataset.tocTarget !== undefined) {
      nodes.push({ el, label: el.dataset.tocLabel ?? el.dataset.tocTarget, blockId: null });
    } else if (el.dataset.blockId !== undefined) {
      const tag = el.querySelector(".block-tag")?.textContent ?? "";
      const anchor = el.querySelector(".block-anchor")?.textContent ?? "";
      nodes.push({ el, label: `${tag}${anchor ? " · " + anchor : ""}`, blockId: el.dataset.blockId });
    }
  });
  return nodes;
}

/** 块节点状态色类（与 CSS 联动）：y=绿 / n=红 / p=黄（待定）/ r=灰（回滚）。 */
export function blockTocState(card: HTMLElement): "y" | "n" | "p" | "r" {
  const state = card.dataset.blockState ?? "pending";
  if (card.classList.contains("block-confirmed")) return "y";
  if (card.classList.contains("block-rejected")) return "n";
  if (state === "rolledback") return "r";
  return "p";
}

/** 构建右侧滚动链（TOC）：半透明细条、hover 展开、点击平滑滚动、scrollspy 高亮。 */
export function buildToc(
  nav: HTMLElement,
  nodes: TocNode[],
  stateOf: (n: TocNode) => "y" | "n" | "p" | "r",
): void {
  nav.innerHTML = "";
  const itemEls: HTMLElement[] = [];
  for (const n of nodes) {
    const item = document.createElement("div");
    item.className = `toc-item b-${stateOf(n)}`;
    const label = document.createElement("span");
    label.className = "toc-label";
    label.textContent = n.label;
    const line = document.createElement("span");
    line.className = "toc-line";
    item.append(label, line);
    item.addEventListener("click", () => {
      n.el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.appendChild(item);
    itemEls.push(item);
  }
  // scrollspy：阅读位置高亮（对齐原型 IntersectionObserver 方案）
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const idx = nodes.findIndex((n) => n.el === e.target);
        if (idx < 0) continue;
        const el = itemEls[idx];
        if (e.isIntersecting) {
          itemEls.forEach((x) => x.classList.remove("active"));
          el.classList.add("active");
        }
      }
    },
    { rootMargin: "-18% 0px -70% 0px" },
  );
  nodes.forEach((n) => spy.observe(n.el));
}
