import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Decision, DecisionRequest } from "../domain/gate/ports";
import {
  buildReplacePendingChange,
  computeReplaceDiffBlocks,
} from "../domain/domain/pending-change-service";
import { buildDiffRefFromChange } from "../domain/presentation/builders";
import { createCliDecisionPort } from "./cli-decision-port";

/**
 * T1-09 验收断言：stub ctx.ui 模拟按键序列，覆盖主形态 A（汇总卡 custom 组件）、
 * 保底 B（逐块 select 序列）与取消三分支（q / Esc / signal abort）。
 *
 * 两条 P1 修正的直接断言（qa/T1-08-spike-verify.md）：
 * - ① custom 的 opts 不接受 signal → abort 接线在组件 factory 闭包内自建（组件里
 *   监听 ctx.signal，abort → done(undefined) 映射 cancelled；done/dispose 后移除监听）。
 * - ② Esc 的 handleInput data 实测为 "\x1b" → 取消键按 "\x1b" / q 双路径匹配。
 *
 * 呈现数据原样消费（卡断言 6）：CliDecisionPort 不 import 任何 domain 计算模块，
 * 渲染只消费 gate 传入的 DecisionRequest（测试另以 buildDiffRefFromChange 真实数据
 * 断言 render 输出与输入一致）。
 */

// ---- stub 基建：fake theme / fake ctx.ui ----

const fakeTheme = { fg: (_color: string, text: string) => text };

/** fake ctx.ui.custom 运行时：factory 调用后组件可被按键驱动，done 记结果。 */
class FakeCustomRuntime {
  component: {
    handleInput(data: string): void;
    render(width: number): string[];
    dispose(): void;
    invalidate(): void;
  } | undefined;
  doneResult: unknown;
  doneCalled = false;
  throwOnCustom = false;

  custom = async <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown): Promise<T> => {
    if (this.throwOnCustom) throw new Error("custom unavailable (render failure)");
    let resolveDone!: (r: T) => void;
    const promise = new Promise<T>((res) => {
      resolveDone = res;
    });
    const done = (r: T) => {
      this.doneCalled = true;
      this.doneResult = r;
      resolveDone(r);
    };
    this.component = factory({}, fakeTheme, {}, done) as FakeCustomRuntime["component"];
    return promise;
  };

  press(...keys: string[]): void {
    for (const key of keys) this.component?.handleInput(key);
  }
  render(): string[] {
    return this.component?.render(80) ?? [];
  }
}

/** fake ctx.ui.select：按脚本逐次回选项（保底 B）。 */
class FakeSelectRuntime {
  responses: (string | undefined)[] = [];
  calls: { title: string; options: string[] }[] = [];
  select = async (title: string, options: string[]) => {
    this.calls.push({ title, options });
    return this.responses.shift();
  };
}

/** 组装一个测试夹具：fake ctx + 可驱动的 custom/select runtime（stub ui 组件工厂注入点）。 */
function makeHarness(overrides: {
  mode?: ExtensionContext["mode"];
  hasUI?: boolean;
  signal?: AbortSignal;
} = {}) {
  const custom = new FakeCustomRuntime();
  const select = new FakeSelectRuntime();
  const ctx = {
    mode: overrides.mode ?? "tui",
    hasUI: overrides.hasUI ?? true,
    signal: overrides.signal ?? new AbortController().signal,
    ui: {
      custom: custom.custom,
      select: select.select,
      confirm: async () => true,
      input: async () => undefined,
    },
  } as unknown as ExtensionContext;
  return { ctx, custom, select };
}

// ---- 测试数据（presentation 同源：tag/anchor/lines 由 gate 传入，端口不重算）----

function sampleRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    kind: "approve_blocks",
    changeId: "change-1",
    artifactId: "doc-1",
    title: "设计文档.md v3 → v4",
    mode: "block",
    blocks: [
      { blockId: "b1", kind: "mod", tag: "✏️ 修改 1/5", anchor: "§2.1 内核策略", lines: ["内容一：改 A 为 B", "保留行"], state: "pending" },
      { blockId: "b2", kind: "add", tag: "➕ 新增 2/5", anchor: "§2.3 Web 壳选型", lines: ["新增章节：Web 壳选型"], state: "pending" },
      { blockId: "b3", kind: "del", tag: "➖ 删除 3/5", anchor: "§3 架构", lines: ["删除旧段"], state: "pending" },
      { blockId: "b4", kind: "mod", tag: "✏️ 修改 4/5", anchor: "§4 接口", lines: ["接口签名调整"], state: "pending" },
      { blockId: "b5", kind: "mod", tag: "✏️ 修改 5/5", anchor: "§5 部署", lines: ["部署步骤更新"], state: "pending" },
    ],
    ...overrides,
  };
}

function customOf(ctx: ExtensionContext): FakeCustomRuntime {
  return (ctx.ui as unknown as { custom: FakeCustomRuntime }).custom as unknown as FakeCustomRuntime;
}

describe("CliDecisionPort · 主形态 A（TUI 汇总卡 custom 组件）", () => {
  it("卡断言 1：5 块按键序列 y1 y2 n3 y4 n5 回车 → resolved、decisions 3 收 2 拒", async () => {
    const { ctx, custom } = makeHarness();
    const port = createCliDecisionPort(() => ctx);

    const pending = port.ask(sampleRequest());
    custom.press("y", "1", "y", "2", "n", "3", "y", "4", "n", "5", "\r");

    const decision = (await pending) as Extract<Decision, { status: "resolved" }>;
    expect(decision.status).toBe("resolved");
    expect(decision.decisions).toEqual([
      { blockId: "b1", decision: "accept" },
      { blockId: "b2", decision: "accept" },
      { blockId: "b3", decision: "reject" },
      { blockId: "b4", decision: "accept" },
      { blockId: "b5", decision: "reject" },
    ]);
  });

  it("即时上屏：y1 按下后立即可见块 1 翻转（无需等下一键结算）", async () => {
    const { ctx, custom } = makeHarness();
    const port = createCliDecisionPort(() => ctx);
    const pending = port.ask(sampleRequest());
    custom.press("y", "1");
    const frame = custom.render().join("\n");
    expect(frame).toContain("已决 1/5 块");
    expect(frame).toContain("[✓ 接受]");
    custom.press("q");
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
  });

  it("卡断言 2：a 全收 → 渲染全 accepted；随后 n2 打回 → 提交后 4 收 1 拒（混合档）", async () => {
    const { ctx, custom } = makeHarness();
    const port = createCliDecisionPort(() => ctx);

    const pending = port.ask(sampleRequest());
    custom.press("a");
    expect(custom.render().join("\n")).toContain("已决 5/5 块");
    expect(custom.render().join("\n")).toContain("[✓ 接受]");
    custom.press("n", "2", "\r");

    const decision = (await pending) as Extract<Decision, { status: "resolved" }>;
    expect(decision.status).toBe("resolved");
    expect(decision.decisions).toEqual([
      { blockId: "b1", decision: "accept" },
      { blockId: "b2", decision: "reject" },
      { blockId: "b3", decision: "accept" },
      { blockId: "b4", decision: "accept" },
      { blockId: "b5", decision: "accept" },
    ]);
  });

  it("卡断言 3：存在 pending 块时提交被拒（提示上屏、done 不触发），全决后才提交", async () => {
    const { ctx, custom } = makeHarness();
    const port = createCliDecisionPort(() => ctx);

    const pending = port.ask(sampleRequest());
    custom.press("y", "1", "\r"); // 还有 4 块 pending

    expect(custom.doneCalled).toBe(false);
    const frame = custom.render().join("\n");
    expect(frame).toContain("仍有 4 块待决"); // 提交被拒提示
    expect(frame).toContain("已决 1/5 块"); // 进度指示

    custom.press("a", "\r"); // 全收后提交
    const decision = (await pending) as Extract<Decision, { status: "resolved" }>;
    expect(decision.status).toBe("resolved");
    expect(decision.decisions).toHaveLength(5);
    expect(decision.decisions.every((d) => d.decision === "accept")).toBe(true);
  });

  it("P3①（T1-10 挂账修复）：Enter 被拒提示后按前缀键 y → 提示立即消失（render 缓存已失效）", async () => {
    const { ctx, custom } = makeHarness();
    const port = createCliDecisionPort(() => ctx);

    const pending = port.ask(sampleRequest());
    custom.press("\r"); // 全 pending → 提交被拒，提示上屏
    expect(custom.render().join("\n")).toContain("仍有 5 块待决");

    // 修复前：按 y（前缀键）不清缓存，render 复用旧帧、提示滞留；
    // 修复后：y 按下当下缓存失效，下一渲染帧按新 hint（已清）绘制
    custom.press("y");
    expect(custom.render().join("\n")).not.toContain("仍有 5 块待决");

    custom.press("1", "a", "\r"); // 正常继续交互不受影响（y1 决第 1 块 → a 全收 → 提交）
    const decision = (await pending) as Extract<Decision, { status: "resolved" }>;
    expect(decision.status).toBe("resolved");
    expect(decision.decisions).toHaveLength(5);
  });

  it("卡断言 4 + P1②：q 与 Esc（\\x1b）双路径取消 → Decision cancelled", async () => {
    for (const cancelKey of ["q", "\x1b"]) {
      const { ctx, custom } = makeHarness();
      const port = createCliDecisionPort(() => ctx);

      const pending = port.ask(sampleRequest());
      custom.press("y", "1", cancelKey);

      const decision = (await pending) as Extract<Decision, { status: "cancelled" }>;
      expect(decision.status).toBe("cancelled");
      expect("decisions" in decision).toBe(false); // 取消不产决策，pending 由 gate 保留
    }
  });

  it("P1①：signal abort → done(undefined) 映射 cancelled；done 后监听移除不泄漏、dispose 幂等", async () => {
    // 场景 1：abort → cancelled；done 只结算一次（再次 abort 不重复触发——监听已在 settle 时移除）
    const controller = new AbortController();
    const { ctx, custom } = makeHarness({ signal: controller.signal });
    const port = createCliDecisionPort(() => ctx);

    const pending = port.ask(sampleRequest());
    controller.abort();

    const decision = (await pending) as Extract<Decision, { status: "cancelled" }>;
    expect(decision.status).toBe("cancelled");
    expect(custom.doneCalled).toBe(true);
    controller.abort();
    expect(custom.doneCalled).toBe(true);

    // 场景 2：正常提交（done）后 dispose 再 abort —— 无重复结算（真实生命周期：TUI 关闭组件后才 dispose）
    const c2 = new AbortController();
    const { ctx: ctx2, custom: custom2 } = makeHarness({ signal: c2.signal });
    const port2 = createCliDecisionPort(() => ctx2);
    const pending2 = port2.ask(sampleRequest());
    custom2.press("a", "\r"); // 全收提交 → done
    const d2 = (await pending2) as Extract<Decision, { status: "resolved" }>;
    expect(d2.status).toBe("resolved");
    expect(custom2.doneCalled).toBe(true);
    custom2.component?.dispose();
    c2.abort();
    expect(custom2.doneCalled).toBe(true); // dispose + abort 后仍只结算一次
  });

  it("P1①：signal 已中止时组件不等待交互，直接取消", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = makeHarness({ signal: controller.signal });
    const port = createCliDecisionPort(() => ctx);
    await expect(port.ask(sampleRequest())).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("CliDecisionPort · 保底 B（RPC 模式 / TUI 渲染异常）", () => {
  it("卡断言 5：RPC 模式逐块 select 序列产出等价 decisions（接受/拒绝交替 3 收 2 拒）", async () => {
    const { ctx, select } = makeHarness({ mode: "rpc" });
    select.responses = ["接受", "接受", "拒绝", "接受", "拒绝"];
    const port = createCliDecisionPort(() => ctx);

    const decision = (await port.ask(sampleRequest())) as Extract<Decision, { status: "resolved" }>;
    expect(decision.status).toBe("resolved");
    expect(decision.decisions).toEqual([
      { blockId: "b1", decision: "accept" },
      { blockId: "b2", decision: "accept" },
      { blockId: "b3", decision: "reject" },
      { blockId: "b4", decision: "accept" },
      { blockId: "b5", decision: "reject" },
    ]);
    expect(select.calls).toHaveLength(5); // 逐块一次，全决才提交
    expect(select.calls[0].options).toEqual(["接受", "拒绝", "取消"]);
  });

  it("保底 B：Esc（undefined）与显式「取消」均映射整体 cancelled（P1-1① 语义）", async () => {
    for (const stop of [undefined, "取消"]) {
      const { ctx, select } = makeHarness({ mode: "rpc" });
      select.responses = ["接受", stop];
      const port = createCliDecisionPort(() => ctx);

      const decision = (await port.ask(sampleRequest())) as Extract<Decision, { status: "cancelled" }>;
      expect(decision.status).toBe("cancelled");
    }
  });

  it("保底 B：TUI 下 custom 抛错（渲染异常）→ 退化逐块序列，仍产出等价 decisions", async () => {
    const { ctx, custom, select } = makeHarness({ mode: "tui" });
    custom.throwOnCustom = true;
    select.responses = ["接受", "接受", "接受", "接受", "拒绝"];
    const port = createCliDecisionPort(() => ctx);

    const decision = (await port.ask(sampleRequest())) as Extract<Decision, { status: "resolved" }>;
    expect(decision.status).toBe("resolved");
    expect(decision.decisions).toEqual([
      { blockId: "b1", decision: "accept" },
      { blockId: "b2", decision: "accept" },
      { blockId: "b3", decision: "accept" },
      { blockId: "b4", decision: "accept" },
      { blockId: "b5", decision: "reject" },
    ]);
  });

  it("无对话框能力（hasUI=false，如 json/print 模式）→ 无法裁决，返回 cancelled", async () => {
    const { ctx } = makeHarness({ mode: "json", hasUI: false });
    const port = createCliDecisionPort(() => ctx);
    await expect(port.ask(sampleRequest())).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("CliDecisionPort · 呈现数据原样消费（卡断言 6）", () => {
  it("渲染行全部源自 req 数据（title/tag/anchor/首行摘要原样上屏）", async () => {
    const { ctx, custom } = makeHarness();
    const port = createCliDecisionPort(() => ctx);

    const pending = port.ask(sampleRequest());
    const frame = custom.render().join("\n");
    expect(frame).toContain("设计文档.md v3 → v4");
    expect(frame).toContain("✏️ 修改 1/5 · §2.1 内核策略");
    expect(frame).toContain("内容一：改 A 为 B"); // lines[0] 首行摘要
    expect(frame).toContain("➕ 新增 2/5 · §2.3 Web 壳选型");
    expect(frame).toContain("b<n> 打回");
    custom.press("q");
    await pending;
  });

  it("真实 domain 数据流（buildDiffRefFromChange）下渲染不炸且逐块一致", async () => {
    // 构造与 gate 同源的 req：buildReplacePendingChange → buildDiffRefFromChange
    const oldContent = "# 设计文档\n\n## 内核\n\n旧策略段落 A。\n";
    const newContent = "# 设计文档\n\n## 内核\n\n新策略段落 B。\n\n## 新增节\n\n补充内容 C。\n";
    const blocks = computeReplaceDiffBlocks(oldContent, newContent);
    expect(blocks.length).toBeGreaterThan(0);
    const change = buildReplacePendingChange({
      artifactId: "doc-1",
      sourceActor: "smoke-actor",
      oldContent,
      newContent,
      baseVersion: 3,
    });
    const req: DecisionRequest = {
      kind: "approve_blocks",
      changeId: change.id,
      artifactId: change.artifactId,
      title: "设计文档.md v3 → v4",
      blocks: buildDiffRefFromChange(change).blocks,
      mode: "block",
    };

    const { ctx, custom } = makeHarness();
    const port = createCliDecisionPort(() => ctx);
    const pending = port.ask(req);
    const frame = custom.render().join("\n");
    expect(frame).toContain("已决 0/" + req.blocks.length + " 块");
    for (const b of req.blocks) {
      expect(frame).toContain(b.tag);
      expect(frame).toContain(b.anchor);
    }
    custom.press("a", "\r");
    const decision = (await pending) as Extract<Decision, { status: "resolved" }>;
    expect(decision.decisions).toHaveLength(req.blocks.length);
    expect(decision.decisions.every((d) => d.decision === "accept")).toBe(true);
  });
});
