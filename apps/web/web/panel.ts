/**
 * 受管文档面板（T1-12，S1–S4 全交互）：浏览器端装配与交互语义。
 *
 * 数据流：只 fetch server 端点（api.ts）→ 本地状态（panel-state.ts 纯函数）→
 * 渲染器（renderer.ts 纯函数）→ DOM 挂载（dom.ts）。本文件是唯一持有「交互语义」
 * 的壳层：裁决/写回/回滚/外部三动作的编排，全部判断复用 panel-state 门禁，
 * 不重算 diff、不判断领域状态（守卫在 L1，本层只按门禁禁用/提示）。
 *
 * P2-5 交互模型：前端本地状态、写回一次性提交（点一次写回 → 逐块调 resolve 端点，
 * 最后一次触发物化 + 审计 approval_response 含逐块明细）。
 * P1-4 数据管线：回滚报告「确认过 N 块」= 审计回放 artifact_resolved.acceptedBlocks
 * 计数（非从版本 diff 重算）。
 */
import { api, ApiError } from "./api";
import { buildToc, collectTocNodes, mountRenderTree } from "./dom";
import {
  bulkVote,
  canInteract,
  canRollback,
  canWriteback,
  emptyState,
  hasUndecided,
  settledCount,
  toggleVote,
  type PanelState,
  type Vote,
} from "./panel-state";
import { renderDocument } from "./renderer";
import type {
  ArtifactDetail,
  ArtifactVersion,
  DiffBlockPresentation,
  DiffRef,
  ExternalDiffResp,
  PendingEntry,
  Presentation,
  ResolveResp,
  RollbackResp,
} from "./types";

const EXTERNAL_MERGE_ACTOR = "external-merge";

/** 从 presentation 取第一个 diff 块集（body 各块类型按 kind 窄化；无 diff → null）。 */
function diffRefOf(p: Presentation): DiffRef | null {
  for (const b of p.body) {
    if (b.kind === "diff") return b.diffRef;
  }
  return null;
}

/** 回滚报告视图（方案 C）：横幅取数 + 灰化块（本会话缓存的提案块盖 rolledback 态）。 */
type RollbackView = {
  fromVersion: number;
  toVersion: number;
  newVersion: number;
  undoing: boolean;
  blockCount: number;
  confirmedCount: number;
  /** 灰化块（rolledback 态）；刷新后审计无块行 → 缺失（第一期 MVP，横幅与正文不受影响）。 */
  blocks: DiffBlockPresentation[];
};

type View = {
  artifact: ArtifactDetail | null;
  pending: PendingEntry | null;
  state: PanelState;
  /** 本会话缓存：打开面板时 GET /pending 拿到的提案块（写回/回滚后 pending 清空，灰化块渲染依赖此缓存）。 */
  cachedBlocks: DiffBlockPresentation[];
  rolledback: RollbackView | null;
  /** 顶部成功/提示横幅（写回成功、合并转提案等）。 */
  info: { tone: "info" | "ok" | "warn"; text: string } | null;
  /** 「查看 diff」展开（外部手改 diff / 回滚差异）。 */
  diffView: ExternalDiffResp | { blocks: DiffBlockPresentation[] } | null;
  loading: boolean;
  error: string | null;
};

export class DocPanel {
  private view: View = {
    artifact: null,
    pending: null,
    state: emptyState(0),
    cachedBlocks: [],
    rolledback: null,
    info: null,
    diffView: null,
    loading: true,
    error: null,
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly artifactId: string,
  ) {}

  async load(): Promise<void> {
    try {
      const [detail, pending] = await Promise.all([
        api.getArtifact(this.artifactId),
        api.getPending(this.artifactId),
      ]);
      const entry = pending.changes[0] ?? null;
      this.view.artifact = detail;
      this.view.pending = entry;
      // 有 pending：进入待确认态（本地裁决全部待定）；无 pending：展示当前版正文
      this.view.state = entry
        ? emptyState(entry.change.diffBlocks.length)
        : emptyState(0);
      this.view.cachedBlocks = entry ? diffRefOf(entry.presentation)?.blocks ?? [] : [];
      // S4 前置：打开面板即检测外部手改 → 警告横幅 + 版本操作冻结
      if (detail.external.modified) this.view.state.extMode = true;
      this.view.loading = false;
      this.render();
    } catch (e) {
      this.view.loading = false;
      this.view.error = e instanceof ApiError ? `${e.code}: ${e.message}` : String(e);
      this.render();
    }
  }

  // -------------------------------------------------------------------------
  // 渲染（每次全量重画：渲染树 → DOM → 滚动链；数据量小，无 diff 优化需求）
  // -------------------------------------------------------------------------

  private render(): void {
    const v = this.view;
    this.root.innerHTML = "";
    if (v.loading) {
      this.root.appendChild(el("div", { className: "devnote", textContent: "加载中…" }));
      return;
    }
    if (v.error || !v.artifact) {
      this.root.appendChild(
        el("div", { className: "banner warn", textContent: `面板加载失败：${v.error ?? "未找到文档"}` }),
      );
      return;
    }
    const a = v.artifact.artifact;
    const blocks = this.displayBlocks();
    const externalMerge = v.pending?.change.sourceActor === EXTERNAL_MERGE_ACTOR;
    const docNodes = renderDocument({
      baseContent: a.content,
      blocks,
      mode: v.rolledback && !v.rolledback.undoing ? "rolledback" : "inline",
      externalMerge,
    });
    const app = this.root.ownerDocument.createDocumentFragment();

    // 顶栏
    const topbar = document.createElement("header");
    topbar.className = "topbar";
    topbar.innerHTML = "";
    const title = document.createElement("span");
    title.className = "doc-title";
    title.textContent = `📄 ${a.title}`;
    const ver = document.createElement("span");
    ver.className = "ver";
    ver.id = "verLabel";
    ver.textContent = this.versionLabel();
    title.appendChild(ver);
    const badge = document.createElement("span");
    badge.className = `badge ${this.badgeKind()}`;
    badge.id = "statusBadge";
    badge.textContent = this.badgeText();
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const btnHistory = document.createElement("button");
    btnHistory.className = "btn";
    btnHistory.textContent = "🕘 版本链";
    btnHistory.addEventListener("click", () => this.openHistory());
    const btnDiscard = document.createElement("button");
    btnDiscard.className = "btn";
    btnDiscard.textContent = "🗑 放弃提案";
    btnDiscard.disabled = !(v.pending && canInteract(v.state));
    btnDiscard.addEventListener("click", () => this.discardPending());
    topbar.append(title, badge, spacer, btnHistory);
    if (v.pending) topbar.appendChild(btnDiscard);

    // 横幅区
    const banners = this.renderBanners();

    // 文档主体
    const main = document.createElement("main");
    const article = document.createElement("article");
    article.className = "doc";
    for (const n of docNodes) mountRenderTree(n, article);
    main.appendChild(article);

    // 滚动链
    const toc = document.createElement("nav");
    toc.className = "toc";
    toc.id = "toc";
    toc.setAttribute("aria-label", "文档导航");
    if (window.innerWidth > 1180) {
      const nodes = collectTocNodes(article);
      buildToc(toc, nodes, (n) => {
        if (n.blockId === null) return "p";
        const card = article.querySelector<HTMLElement>(`[data-block-id="${n.blockId}"]`);
        if (!card) return "p";
        if (card.classList.contains("block-confirmed")) return "y";
        if (card.classList.contains("block-rejected")) return "n";
        return card.dataset.blockState === "rolledback" ? "r" : "p";
      });
    }

    // 逐块 ✓/✗ 按钮绑定（渲染器只画按钮位，交互语义在本层）
    article.querySelectorAll<HTMLButtonElement>(".block .pick[data-action]").forEach((btn) => {
      const blockId = btn.dataset.block;
      const vote = btn.dataset.action as Vote;
      if (blockId) btn.addEventListener("click", () => this.pick(blockId, vote));
    });

    // 悬浮操作条
    const fab = this.renderFab();

    app.append(topbar, banners, main, toc, fab);
    this.root.appendChild(app);
    // 回滚态：正文/块灰化由 body 级 class 控制（方案 C，原型 CSS 语义）
    document.body.classList.toggle("rolled-back", v.rolledback !== null && !v.rolledback.undoing);
  }

  /** 展示块：pending 态 = 本地裁决映射 state；回滚态 = 灰化块；其余 = 空。 */
  private displayBlocks(): DiffBlockPresentation[] {
    const v = this.view;
    if (v.rolledback && !v.rolledback.undoing) return v.rolledback.blocks;
    if (!v.pending) return [];
    const src = v.cachedBlocks;
    return src.map((b) => {
      const vote = v.state.votes[b.blockId];
      if (vote === "yes") return { ...b, state: "confirmed" as const };
      if (vote === "no") return { ...b, state: "rejected" as const };
      return b;
    });
  }

  private versionLabel(): string {
    const v = this.view;
    const a = v.artifact?.artifact;
    if (!a) return "";
    if (v.rolledback) {
      return v.rolledback.undoing
        ? `当前 v${v.rolledback.newVersion}（撤销回滚 = v${v.rolledback.toVersion} 内容）`
        : `当前 v${v.rolledback.newVersion}（自 v${v.rolledback.toVersion} 回滚）`;
    }
    const p = v.pending;
    if (p) return `v${p.change.baseVersion} → v${p.change.baseVersion + 1}`;
    return `当前 v${a.currentVersion}`;
  }

  private badgeKind(): "pending" | "ok" {
    const v = this.view;
    if (v.pending) return "pending";
    if (v.rolledback) return "ok";
    return v.artifact?.versions.length ? "ok" : "pending";
  }

  private badgeText(): string {
    const v = this.view;
    if (v.pending) return `待确认 · ${v.pending.change.diffBlocks.length} 块`;
    if (v.rolledback) {
      return v.rolledback.undoing
        ? `当前 v${v.rolledback.newVersion}（撤销回滚 = v${v.rolledback.toVersion} 内容）`
        : `已回滚 · v${v.rolledback.newVersion} = v${v.rolledback.toVersion} 的内容`;
    }
    return `已确认 · v${v.artifact?.artifact.currentVersion} 已物化`;
  }

  /** 横幅区：外部手改警告（S4）/ 回滚报告（S3④）/ 写回与操作结果横幅。 */
  private renderBanners(): DocumentFragment {
    const frag = document.createDocumentFragment();
    const v = this.view;
    const a = v.artifact?.artifact;
    if (!a) return frag;

    // S4：外部手改警告（onDiskExcerpt 消费，T1-06 义务 3）
    if (v.state.extMode && v.artifact?.external.modified) {
      const b = document.createElement("div");
      b.className = "banner warn";
      const msg = document.createElement("span");
      msg.className = "msg";
      const excerpt = v.artifact.external.onDiskExcerpt;
      msg.textContent = `⚠️ 检测到外部手改（EXTERNAL_MODIFIED）：物化文件「${a.title}.md」在系统外被修改。处理前版本操作已冻结。`;
      b.appendChild(msg);
      if (excerpt) {
        const prev = document.createElement("div");
        prev.className = "ext-excerpt";
        prev.textContent = `磁盘现状预览：${excerpt}`;
        b.appendChild(prev);
      }
      for (const [label, action] of [
        ["查看 diff", "ext-diff"],
        ["以提案方式合并", "ext-merge"],
        ["拒绝采纳，恢复系统版本", "ext-reject"],
      ] as const) {
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.dataset.action = action;
        btn.textContent = label;
        btn.addEventListener("click", () => this.externalAction(action));
        b.appendChild(btn);
      }
      frag.appendChild(b);
    }

    // S3④ 回滚报告横幅（方案 C：正文切换 + 报告 + 动作）
    if (v.rolledback) {
      const rb = v.rolledback;
      const b = document.createElement("div");
      b.className = "banner " + (rb.undoing ? "ok" : "info");
      const msg = document.createElement("span");
      msg.className = "msg";
      msg.textContent = rb.undoing
        ? `✅ 已撤销回滚：v${rb.newVersion} = v${rb.toVersion} 内容（含你确认的 ${rb.confirmedCount} 块，正文已恢复）。回滚版 v${rb.fromVersion} 保留在版本链上可随时再回滚。`
        : `↩️ 已回滚：v${rb.newVersion} = v${rb.toVersion} 的内容（正文已切换）。v${rb.fromVersion} 的 ${rb.blockCount} 块改动不在当前版本——其中你确认过的 ${rb.confirmedCount} 块一并撤销；版本链完整保留，操作记录已写入会话日志（appendEntry）。`;
      b.appendChild(msg);
      if (!rb.undoing) {
        const diffBtn = document.createElement("button");
        diffBtn.className = "btn";
        diffBtn.textContent = `查看 v${rb.newVersion} ↔ v${rb.fromVersion} 差异`;
        diffBtn.addEventListener("click", () => this.showRollbackDiff());
        b.appendChild(diffBtn);
        const undoBtn = document.createElement("button");
        undoBtn.className = "btn";
        undoBtn.textContent = `↩ 撤销回滚（恢复 v${rb.fromVersion} 内容）`;
        undoBtn.addEventListener("click", () => this.undoRollback());
        b.appendChild(undoBtn);
      }
      frag.appendChild(b);
    }

    // 操作结果横幅（写回成功 / 合并转提案 / 拒绝恢复）
    if (v.info) {
      const b = document.createElement("div");
      b.className = `banner ${v.info.tone}`;
      const msg = document.createElement("span");
      msg.className = "msg";
      msg.textContent = v.info.text;
      b.appendChild(msg);
      frag.appendChild(b);
    }

    // 「查看差异」展开区（外部手改 diff / 回滚差异）
    if (v.diffView) {
      const b = document.createElement("div");
      b.className = "banner info diff-view";
      const title = document.createElement("div");
      title.className = "diff-view-title";
      title.textContent = "差异明细";
      b.appendChild(title);
      if ("diff" in v.diffView) {
        const d = v.diffView;
        b.appendChild(diffBlockLines(d.diff, "磁盘现状"));
      } else {
        b.appendChild(diffBlockLines(v.diffView.blocks, "回滚前后"));
      }
      frag.appendChild(b);
    }
    return frag;
  }

  private renderFab(): HTMLElement {
    const v = this.view;
    const s = v.state;
    const fab = document.createElement("aside");
    fab.className = "fab";
    fab.id = "fab";
    if (!v.pending && !v.rolledback) {
      // 无提案且非回滚态：无确认操作 → 隐藏悬浮条
      fab.style.display = "none";
      return fab;
    }
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.textContent = "确认进度";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${settledCount(s)}/${s.total}`;
    row.append(label, count);

    const dots = document.createElement("div");
    dots.className = "dots";
    for (const b of v.cachedBlocks) {
      const dot = document.createElement("span");
      dot.className = `dot ${
        s.votes[b.blockId] === "yes" ? "y" : s.votes[b.blockId] === "no" ? "n" : ""
      }`;
      dots.appendChild(dot);
    }

    const allYes = this.fabButton("✅ 全部接受", "allYes", () => {
      if (!canInteract(s)) return;
      this.view.state = bulkVote(s, v.cachedBlocks.map((b) => b.blockId), "yes");
      this.render();
    });
    const allNo = this.fabButton("❌ 全部拒绝", "allNo", () => {
      if (!canInteract(s)) return;
      this.view.state = bulkVote(s, v.cachedBlocks.map((b) => b.blockId), "no");
      this.render();
    });
    const writeback = this.fabButton("⬆ 写回（approval_response）", "writeback", () =>
      this.writeback(),
    );
    writeback.disabled = !canWriteback(s);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = s.extMode
      ? "⛔ 有外部手改待处理，版本操作冻结"
      : hasUndecided(s)
        ? "全部块有着落后方可写回"
        : "点击写回一次性提交全部裁决";
    fab.append(row, dots, allYes, allNo, writeback, hint);
    return fab;
  }

  private fabButton(text: string, cls: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = `btn ${cls}`;
    btn.id = cls; // 选择器锚点（#writeback / #allYes / #allNo）
    btn.textContent = text;
    btn.disabled = false;
    btn.addEventListener("click", onClick);
    return btn;
  }

  // -------------------------------------------------------------------------
  // 交互：裁决 / 写回 / 版本链回滚 / 撤销 / 外部三动作 / 放弃提案
  // -------------------------------------------------------------------------

  private pick(blockId: string, vote: Vote): void {
    const s = this.view.state;
    if (!canInteract(s)) return;
    this.view.state = toggleVote(s, blockId, vote);
    this.render();
  }

  /** 写回 = 一次性提交（P2-5）：逐块调 resolve，最后一次触发物化 + 审计。 */
  private async writeback(): Promise<void> {
    const v = this.view;
    const change = v.pending?.change;
    if (!change || !canWriteback(v.state)) return;
    const remaining = change.diffBlocks.filter((b) => b.state === "pending");
    let last: ResolveResp | null = null;
    try {
      for (const b of remaining) {
        const vote = v.state.votes[b.id];
        if (vote === undefined) continue;
        const resp = await api.resolve(this.artifactId, change.id, {
          blockId: b.id,
          action: vote === "yes" ? "accept" : "reject",
        });
        last = resp;
        change.diffBlocks = resp.change.diffBlocks;
      }
      if (!last?.materialized) return; // 理论上不会（写回门禁保证全决）；不静默继续
      const accepted = change.diffBlocks.filter((b) => b.state === "confirmed").length;
      const rejected = change.diffBlocks.filter((b) => b.state === "rejected").length;
      this.view.state = { ...v.state, locked: true, hasPending: false };
      this.view.pending = null;
      this.view.info = {
        tone: "ok",
        text: `✅ 已写回 approval_response（含逐块明细）：接受 ${accepted} 块 → 物化为 v${last.artifact?.currentVersion ?? ""}；拒绝 ${rejected} 块 → 保留 v${change.baseVersion} 内容。裁决已落入 append-only 会话日志。`,
      };
      // 版本链更新
      this.view.artifact = await api.getArtifact(this.artifactId);
      this.render();
    } catch (e) {
      this.view.info = { tone: "warn", text: `写回失败：${(e as Error).message}` };
      this.render();
    }
  }

  private async discardPending(): Promise<void> {
    const change = this.view.pending?.change;
    if (!change) return;
    const fromExternal = change.sourceActor === EXTERNAL_MERGE_ACTOR;
    const ok = confirm(
      fromExternal
        ? `放弃这条「外部手改合并」提案？外部内容将仅存审计日志，无法恢复。\n（changeId=${change.id}）`
        : `放弃当前提案（changeId=${change.id}）？文档将保持当前版本内容不变。`,
    );
    if (!ok) return;
    try {
      await api.discard(this.artifactId, change.id, fromExternal ? "面板放弃外部手改合并提案" : "面板放弃提案");
      this.view.pending = null;
      this.view.state = emptyState(0);
      this.view.info = { tone: "info", text: "提案已放弃。文档保持当前版本内容，操作已落入 append-only 会话日志。" };
      this.view.artifact = await api.getArtifact(this.artifactId);
      this.render();
    } catch (e) {
      this.view.info = { tone: "warn", text: `放弃失败：${(e as Error).message}` };
      this.render();
    }
  }

  // -- 版本链抽屉 --------------------------------------------------------------

  private openHistory(): void {
    const v = this.view;
    const versions = v.artifact?.versions ?? [];
    const mask = document.createElement("div");
    mask.className = "drawer-mask";
    mask.id = "drawerMask";
    const drawer = document.createElement("aside");
    drawer.className = "drawer";
    drawer.id = "drawer";
    const h3 = document.createElement("h3");
    h3.textContent = `🕘 版本链 · ${v.artifact?.artifact.title ?? ""}.md`;
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = "append-only：历史永不改写；回滚 = 以旧版内容生成新版本";
    const list = document.createElement("div");
    list.id = "vlist";
    const current = v.artifact?.artifact.currentVersion ?? 0;
    const rollbackable = canRollback(v.state);
    for (const ver of [...versions].reverse()) {
      const row = document.createElement("div");
      row.className = `vrow ${ver.version === current ? "current" : ""}`;
      const num = document.createElement("span");
      num.className = "vnum";
      num.textContent = `v${ver.version}`;
      const info = document.createElement("span");
      info.className = "vinfo";
      const b = document.createElement("b");
      b.textContent = ver.author;
      info.appendChild(b);
      info.appendChild(
        document.createTextNode(`${ver.createdAt}${ver.note !== undefined ? " · " + ver.note : ""}`),
      );
      row.append(num, info);
      if (ver.version === current) {
        const tag = document.createElement("span");
        tag.className = "vcur";
        tag.textContent = "当前";
        row.appendChild(tag);
      } else if (rollbackable) {
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.textContent = "回滚到此版";
        btn.addEventListener("click", () => this.rollbackTo(ver));
        row.appendChild(btn);
      } else {
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.disabled = true;
        btn.title = v.state.extMode
          ? "有外部手改待处理，暂不可回滚"
          : "有待确认提案未处理，暂不可回滚";
        btn.textContent = "回滚到此版";
        row.appendChild(btn);
      }
      list.appendChild(row);
    }
    if (v.pending) {
      const row = document.createElement("div");
      row.className = "vrow current";
      const num = document.createElement("span");
      num.className = "vnum";
      num.textContent = `v${v.pending.change.baseVersion + 1}`;
      const info = document.createElement("span");
      info.className = "vinfo";
      const b = document.createElement("b");
      b.textContent = "待确认提案";
      info.appendChild(b);
      info.appendChild(document.createTextNode(` · ${v.pending.change.diffBlocks.length} 块改动，等待你的裁决`));
      row.append(num, info);
      list.appendChild(row);
    }
    const close = document.createElement("button");
    close.className = "btn";
    close.textContent = "关闭";
    const closeAll = () => {
      mask.remove();
      drawer.remove();
    };
    close.addEventListener("click", closeAll);
    mask.addEventListener("click", closeAll);
    drawer.append(h3, sub, list, close);
    document.body.append(mask, drawer);
  }

  private async rollbackTo(ver: ArtifactVersion): Promise<void> {
    const v = this.view;
    const current = v.artifact?.artifact.currentVersion ?? 0;
    if (!canRollback(v.state)) return;
    const ok = confirm(
      `回滚到 v${ver.version}：将以 v${ver.version} 的内容生成新版本 v${current + 1}。\n历史版本不会被删除（append-only）。继续？`,
    );
    if (!ok) return;
    try {
      const resp = await api.rollback(this.artifactId, ver.version);
      await this.afterRollback(resp, false);
    } catch (e) {
      this.view.info = { tone: "warn", text: `回滚失败：${(e as Error).message}` };
      this.render();
    }
  }

  private async undoRollback(): Promise<void> {
    const rb = this.view.rolledback;
    if (!rb || rb.undoing) return;
    try {
      // P2-8 契约：undo 的 version = 恢复目标版（原回滚的 fromVersion）
      const resp = await api.undoRollback(this.artifactId, rb.fromVersion);
      await this.afterRollback(resp, true);
    } catch (e) {
      this.view.info = { tone: "warn", text: `撤销回滚失败：${(e as Error).message}` };
      this.render();
    }
  }

  /** 回滚/撤销回滚后的统一收尾：审计回放取数（P1-4）+ 刷新数据 + 重渲染。 */
  private async afterRollback(resp: RollbackResp, undoing: boolean): Promise<void> {
    const audit = await api.auditReplay(this.artifactId);
    const resolved = audit.entries
      .filter((e) => e.kind === "artifact_resolved" && e.newVersion === resp.fromVersion)
      .pop();
    const confirmedCount = resolved?.acceptedBlocks?.length ?? 0;
    const proposed = audit.entries
      .filter((e) => e.kind === "artifact_proposed" && e.baseVersion === resp.fromVersion - 1)
      .pop();
    const blockCount = proposed?.diffBlockCount ?? this.view.cachedBlocks.length;
    const blocks = undoing
      ? this.view.cachedBlocks
      : this.view.cachedBlocks.map((b) => ({
          ...b,
          state: "rolledback" as const,
          note: `未生效（v${resp.fromVersion} 提案）`,
        }));
    this.view.rolledback = { ...resp, undoing, blockCount, confirmedCount, blocks };
    this.view.pending = null;
    this.view.state = { ...this.view.state, hasPending: false };
    this.view.diffView = null;
    this.view.artifact = await api.getArtifact(this.artifactId);
    this.render();
  }

  private showRollbackDiff(): void {
    const rb = this.view.rolledback;
    if (!rb) return;
    this.view.diffView = { blocks: rb.blocks };
    this.render();
  }

  // -- S4 外部手改三动作 ---------------------------------------------------------

  private async externalAction(action: "ext-diff" | "ext-merge" | "ext-reject"): Promise<void> {
    try {
      if (action === "ext-diff") {
        this.view.diffView = await api.externalDiff(this.artifactId);
        this.render();
        return;
      }
      if (action === "ext-merge") {
        await api.externalMerge(this.artifactId);
        this.view.state.extMode = false;
        this.view.diffView = null;
        this.view.info = {
          tone: "info",
          text: "外部手改已转为提案：改动以新提案块呈现（标「外部手改合并」），走同一条逐块确认通道。",
        };
        // 刷新：pending 出现（external-merge sourceActor）+ external 消除
        const [detail, pending] = await Promise.all([
          api.getArtifact(this.artifactId),
          api.getPending(this.artifactId),
        ]);
        const entry = pending.changes[0] ?? null;
        this.view.artifact = detail;
        this.view.pending = entry;
        this.view.cachedBlocks = entry ? diffRefOf(entry.presentation)?.blocks ?? [] : [];
        this.view.state = entry ? emptyState(entry.change.diffBlocks.length) : emptyState(0);
        this.render();
        return;
      }
      // ext-reject：覆盖式物化恢复系统版（H4 不生成新版本）
      await api.externalReject(this.artifactId);
      this.view.state.extMode = false;
      this.view.diffView = null;
      this.view.info = {
        tone: "ok",
        text: "已拒绝采纳外部手改：物化文件已恢复为当前版内容，版本链不变（不生成新版本）。",
      };
      this.view.artifact = await api.getArtifact(this.artifactId);
      this.render();
    } catch (e) {
      this.view.info = { tone: "warn", text: `操作失败：${(e as Error).message}` };
      this.render();
    }
  }
}

/** diff 块行 → 差异明细 DOM（del/ins 行列表）。 */
function diffBlockLines(blocks: { kind: string; lines: string[]; oldLines?: string[] }[], caption: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "diff-box";
  const cap = document.createElement("div");
  cap.className = "diff-box-cap";
  cap.textContent = caption;
  box.appendChild(cap);
  for (const b of blocks) {
    for (const l of b.oldLines ?? []) {
      box.appendChild(el("div", { className: "diff-line del", textContent: l }));
    }
    if (b.kind !== "del") {
      for (const l of b.lines) {
        box.appendChild(el("div", { className: "diff-line ins", textContent: l }));
      }
    }
  }
  return box;
}

/** 轻量元素构造（panel 内部用）。 */
function el(tag: string, opts: { className?: string; textContent?: string }): HTMLElement {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.textContent !== undefined) e.textContent = opts.textContent;
  return e;
}
