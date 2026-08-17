/**
 * T1-09 真 TUI 冒烟探针（可丢弃，不进仓库）
 *
 * 链路：真模型（deepseek，key 从 .env.pi-test 注入）→ 工具 smoke_propose →
 * execute 内用 domain 构建器构造真实 PendingChange → DecisionRequest →
 * createCliDecisionPort(() => ctx).ask(req) → 汇总卡（custom 组件）→
 * tmux 真实按键 → Decision 回传 execute → 文本摘要。
 *
 * 覆盖：汇总卡渲染（presentation 数据驱动）、y<n>/n<n>/a/r 翻转即时上屏、
 * Enter 提交、Esc/q 取消、pending 提交被拒提示。
 */
import fs from "node:fs";

const LOG = "/tmp/t1-09-smoke/probe.log";
const log = (tag: string, obj: unknown) => {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${tag} ${JSON.stringify(obj)}\n`);
};

// 仓库绝对路径（pi 扩展 loader 直接跑 ts；域内相对导入经同一 loader 解析）
const PKG = "/home/pgoone/GitHubproject/nextstep重构/packages/next-step-pi/src";

export default function (pi: any) {
  pi.registerProvider("deepseek", {
    name: "DeepSeek (t1-09 smoke)",
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    apiKey: process.env.DEEPSEEK_API_KEY,
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: process.env.DEEPSEEK_MODEL,
        name: "deepseek smoke model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });

  pi.registerTool({
    name: "smoke_propose",
    label: "smoke propose",
    description:
      "T1-09 冒烟：构造一份 3 块提案并走 CliDecisionPort 汇总卡确认。请直接调用，无需参数。",
    promptSnippet: "smoke tool for decision summary card",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (
      _toolCallId: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) => {
      log("execute.enter", { mode: ctx.mode, hasUI: ctx.hasUI });
      // 动态 import（pi loader 的模块系统对顶层 import 仓库路径可能不友好）
      const { computeReplaceDiffBlocks, buildReplacePendingChange } = await import(
        `${PKG}/domain/domain/pending-change-service.ts`
      );
      const { buildDiffRefFromChange } = await import(`${PKG}/domain/presentation/builders.ts`);
      const { createCliDecisionPort } = await import(`${PKG}/ports/cli-decision-port.ts`);

      // 三处分离差异 → 3 块：改 A 段（mod）+ 改部署段（mod）+ 新增节（add）
      const oldContent = "# 设计文档\n\n## 内核\n\n旧策略段落 A。\n\n## 部署\n\n旧部署步骤。\n";
      const newContent =
        "# 设计文档\n\n## 内核\n\n新策略段落 B。\n\n## 部署\n\n新部署步骤。\n\n## 新增节\n\n补充内容 C。\n";
      const diffBlocks = computeReplaceDiffBlocks(oldContent, newContent);
      const change = buildReplacePendingChange({
        artifactId: "doc.md",
        sourceActor: "smoke-actor",
        oldContent,
        newContent,
        baseVersion: 3,
      });
      const req = {
        kind: "approve_blocks",
        changeId: change.id,
        artifactId: "doc.md",
        title: "设计文档.md v3 → v4",
        blocks: buildDiffRefFromChange(change).blocks,
        mode: "block",
      };
      const t0 = Date.now();
      const decision = await createCliDecisionPort(() => ctx).ask(req);
      log("execute.result", { decision, elapsedMs: Date.now() - t0 });
      const summary =
        decision.status === "resolved"
          ? `smoke result: resolved, ${decision.decisions.length} 块全决：` +
            decision.decisions.map((d) => `${d.blockId}=${d.decision}`).join(",")
          : `smoke result: ${decision.status}`;
      return { content: [{ type: "text", text: summary }], details: undefined };
    },
  });
}
