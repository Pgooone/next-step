import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Decision, DecisionPort, DecisionRequest } from "../domain/gate/ports";

/**
 * CliDecisionPort（T1-09，详细设计 §2.2 / D6 方案 A 汇总卡）：
 * DecisionPort.ask 的 CLI 交互实现——只画数据、不做领域判断（L1 只认 Decision 返回值）。
 *
 * 形态（spike 报告 T1-08 定案 + verifier 两条 P1 修正）：
 * - 主形态 A：TUI 下 ctx.ui.custom() 渲染汇总卡——一次呈现全部块（tag/anchor/首行摘要，
 *   对齐 L1 presentation 数据），组件内状态机承载逐块翻转 + 全收/全拒 + 即时上屏 + 提交/取消。
 * - 保底 B：RPC 模式（custom 不可用，spike Q2 实证返回 undefined）/ TUI 渲染异常兜底——
 *   逐块 select 序列（接受/拒绝/取消），产出等价 decisions，退化不丢 F1（spike Q4）。
 *
 * 两条 P1 修正（qa/T1-08-spike-verify.md，实现直接踩其上）：
 * - ① custom 的 opts 不接受 signal（types.d.ts：custom options 仅 overlay/overlayOptions/
 *   onHandle）——汇总卡的 abort 接线在组件 factory 闭包内自建：捕获 ctx.signal
 *   （spike R2 实证 ctx.signal 与 execute 第三参同源、abort 后 1ms 双双触发），
 *   abort → done(undefined) 映射 Decision cancelled；组件 dispose 时移除监听防泄漏。
 * - ② custom 组件内 Esc 的 handleInput data 实测为 "\x1b" 而非 ""（spike 复跑 R5 钉死）——
 *   取消键按 "\x1b" / "q" 双路径匹配，不用空字符串判断。
 *
 * 本文件零领域重算：块数据（tag/anchor/lines）全部来自 gate 传入的 DecisionRequest
 * （与 presentation 同源，buildDiffRefFromChange 锚信息重放），渲染器按数据画。
 */

/** 汇总卡组件提交给 ask 的结果（块级记账，D6 红线：decisions 逐块覆盖全部块）。 */
type CardResult = { decisions: { blockId: string; decision: "accept" | "reject" }[] };

/** 组件内部块状态（pending 未决 / accepted 接受 / rejected 拒绝）。 */
type BlockState = "pending" | "accepted" | "rejected";

/** Esc 键在 custom 组件 handleInput 中的实测编码（P1 修正②，勿改回空串判断）。 */
const ESCAPE = "\x1b";

/** 保底 B 逐块选项（显式「取消」第三档，Esc/取消均映射整体 cancelled）。 */
const BLOCK_CHOICES = ["接受", "拒绝", "取消"] as const;

/** 单行截断到最大宽度（超长 anchor/摘要不撑破卡片）。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * 汇总卡组件（TUI custom 载体）。快捷键协议（任务卡 D6）：
 * `y<n>` 接受块 n · `n<n>` 拒绝块 n（可反复翻转改主意）· `a` 全收 · `r` 全拒 ·
 * `b<n>` 混合档打回单块（全收后改部分）· Enter 提交（存在 pending 块时拒绝并提示）·
 * `q`/Esc 取消。y/n/b 后跟单个数字键即时结算（即时上屏，块号 1-9）。
 */
function makeSummaryCard(
  req: DecisionRequest,
  signal: AbortSignal | undefined,
  done: (r: CardResult | undefined) => void,
  theme: { fg(color: string, text: string): string },
) {
  const blocks: BlockState[] = req.blocks.map(() => "pending");
  /** 快捷键前缀缓冲（"y" | "n" | "b"），遇数字键即时结算。 */
  let prefix: "" | "y" | "n" | "b" = "";
  /** 提交被拒提示（存在 pending 块时上屏，下次按键清除）。 */
  let hint: string | undefined;
  let finished = false;

  // P1 修正①：factory 闭包自建 abort 接线（custom opts 不接受 signal）。
  const abortHandler = () => settle(undefined);
  const cleanup = () => signal?.removeEventListener("abort", abortHandler);
  if (signal !== undefined) {
    if (signal.aborted) {
      // 已中止：不再渲染交互，直接取消（防竞态）
      queueMicrotask(() => settle(undefined));
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  /** done 幂等包装：done 后即移除 abort 监听（+ dispose 双保险），防泄漏。 */
  function settle(result: CardResult | undefined): void {
    if (finished) return;
    finished = true;
    cleanup();
    done(result);
  }

  const component = {
    cached: undefined as string[] | undefined,
    handleInput(data: string): void {
      if (finished) return;
      // 任何按键清除「提交被拒」提示（含 y1 即时结算路径）
      hint = undefined;
      // y/n/b 前缀后的数字键：单数字即时结算（任务卡「每块状态即时上屏」——
      // y1 后立即可见，不等下一键；块号 1-9，对齐卡协议 y<n>/n<n>/b<n>）
      if (prefix !== "" && data.length === 1 && data >= "0" && data <= "9") {
        const n = Number(data);
        if (n >= 1 && n <= blocks.length) {
          blocks[n - 1] = prefix === "y" ? "accepted" : prefix === "n" ? "rejected" : "pending";
        }
        prefix = "";
        component.cached = undefined;
        return;
      }
      // 前缀缓冲遇到非数字：清缓冲，再按普通键处理
      if (prefix !== "") prefix = "";
      if (data === "y" || data === "n" || data === "b") {
        prefix = data;
        // P3①（T1-09 复核挂账，T1-10 修）：前缀键也失效缓存——Enter 被拒提示后紧按
        // y/n/b，hint 已清但 render 复用旧帧，提示滞留到数字键才消失；一行失效即
        // 下一渲染帧按新 hint 绘制（「任何按键清除提示」的注释语义真正落地）。
        component.cached = undefined;
        return;
      }
      if (data === "a") {
        for (let i = 0; i < blocks.length; i++) blocks[i] = "accepted";
        component.cached = undefined;
        return;
      }
      if (data === "r") {
        for (let i = 0; i < blocks.length; i++) blocks[i] = "rejected";
        component.cached = undefined;
        return;
      }
      if (data === "\r" || data === "\n") {
        const pending = blocks
          .map((s, i) => (s === "pending" ? i + 1 : -1))
          .filter((i) => i >= 0);
        if (pending.length > 0) {
          hint = `仍有 ${pending.length} 块待决（${pending.join("、")}），拒绝提交——先用 y<n>/n<n> 逐块定夺`;
          component.cached = undefined;
          return;
        }
        settle({
          decisions: req.blocks.map((block, i) => ({
            blockId: block.blockId,
            decision: blocks[i] === "accepted" ? "accept" : "reject",
          })),
        });
        return;
      }
      // P1 修正②：Esc 实测编码 "\x1b"，与 q 双路径取消
      if (data === "q" || data === ESCAPE) {
        settle(undefined);
      }
    },
    render(width: number): string[] {
      if (component.cached !== undefined) return component.cached;
      const w = Math.min(60, Math.max(20, width));
      const decided = blocks.filter((s) => s !== "pending").length;
      const mark = (s: BlockState) => (s === "accepted" ? "✓ 接受" : s === "rejected" ? "✗ 拒绝" : "· 待决");
      const color = (s: BlockState) => (s === "accepted" ? "success" : s === "rejected" ? "warning" : "dim");
      const lines: string[] = [];
      lines.push(theme.fg("accent", "═".repeat(w)));
      lines.push(theme.fg("text", `  ${clip(req.title, w - 4)}`));
      lines.push(theme.fg("dim", `  已决 ${decided}/${blocks.length} 块`));
      lines.push("");
      for (const [i, block] of req.blocks.entries()) {
        const s = blocks[i];
        lines.push(
          theme.fg("text", `  ${block.tag} · ${clip(block.anchor, w - 16)}  `) +
            theme.fg(color(s), `[${mark(s)}]`),
        );
        const firstLine = block.lines[0] ?? "";
        if (firstLine !== "") lines.push(theme.fg("dim", `    ${clip(firstLine, w - 8)}`));
      }
      lines.push("");
      if (hint !== undefined) lines.push(theme.fg("warning", `  ${hint}`));
      lines.push(
        theme.fg(
          "dim",
          `  y<n> 接受 · n<n> 拒绝 · a 全收 · r 全拒 · b<n> 打回 · Enter 提交 · Esc/q 取消`,
        ),
      );
      lines.push(theme.fg("accent", "═".repeat(w)));
      component.cached = lines;
      return lines;
    },
    dispose(): void {
      cleanup();
    },
    invalidate(): void {
      component.cached = undefined;
    },
  };
  return component;
}

/** 保底 B：逐块 select 序列（接受/拒绝/取消）。Esc 或选「取消」→ 整体 cancelled。 */
async function askByBlocks(ctx: ExtensionContext, req: DecisionRequest): Promise<Decision> {
  const opts = { signal: ctx.signal }; // 内置对话框的唯一取消通道（spike Q3 硬前提）
  const decisions: { blockId: string; decision: "accept" | "reject" }[] = [];
  const total = req.blocks.length;
  for (const [i, block] of req.blocks.entries()) {
    const choice = await ctx.ui.select(
      `块 ${i + 1}/${total} · ${block.tag} · ${block.anchor}`,
      [...BLOCK_CHOICES],
      opts,
    );
    if (choice === undefined || choice === "取消") return { status: "cancelled" };
    decisions.push({ blockId: block.blockId, decision: choice === "接受" ? "accept" : "reject" });
  }
  return { status: "resolved", decisions };
}

/**
 * 创建 CliDecisionPort（L2 工厂）。ctx 经惰性 getContext 注入——DecisionPort 在
 * 会话启动时装配、execute 时才存在 ExtensionContext（T1-10 会话装配时把 execute
 * 的 ctx 喂进来）。
 */
export function createCliDecisionPort(getContext: () => ExtensionContext): DecisionPort {
  return {
    async ask(req: DecisionRequest): Promise<Decision> {
      const ctx = getContext();
      // 主形态 A：仅 TUI（custom 仅 TUI 可用，spike 边界①）
      if (ctx.mode === "tui" && ctx.hasUI) {
        try {
          const result = await ctx.ui.custom<CardResult | undefined>(
            (_tui, theme, _keybindings, done) => makeSummaryCard(req, ctx.signal, done, theme),
            { overlay: true },
          );
          if (result !== undefined) return { status: "resolved", decisions: result.decisions };
          return { status: "cancelled" }; // 用户 q/Esc 或 agent abort → done(undefined)
        } catch {
          // TUI 渲染/交互异常 → 退化保底 B（spike 裁决：退化不丢 F1）
        }
      }
      // 无对话框能力（json/print 等）→ 无法裁决：取消，pending 由 gate 保留
      if (!ctx.hasUI) return { status: "cancelled" };
      return askByBlocks(ctx, req);
    },
  };
}
