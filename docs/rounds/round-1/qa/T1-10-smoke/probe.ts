/**
 * T1-10 真模型端到端冒烟探针（pi extension factory，T1-09 probe 范式）
 *
 * 链路：真模型（deepseek，key 从 .env.pi-test 注入）→ doc 会话装配（assembleDocSession：
 * 六工具注册 + 受管路径 tool_call 守卫 + CliDecisionPort 惰性 ctx 注入 + AuditPort 落
 * pi.appendEntry）→ 模型调 create_artifact（落 v1 + 物化）→ 模型调 propose_edit
 * （execute 内 proposeWithGate → 汇总卡弹出）→ tmux 真实按键逐块确认 → 全决物化 v2。
 *
 * 这是「F1 纯 CLI 端到端成立」出口判据的首次真实验证：能力层白名单由 CLI `--tools`
 * 参数承载（六工具名，物理无 write/edit/bash），守卫与汇总卡在真会话里生效。
 *
 * 证据：/tmp/t1-10-smoke/probe.log（装配/守卫拦截事件）+ smoke.pane（tmux 逐帧）
 * + 领域目录（物化 .md + versions/*.json，由 tui-smoke.sh 断言）。
 */
import fs from "node:fs";

const WORK = "/tmp/t1-10-smoke";
const LOG = `${WORK}/probe.log`;
// 仓库绝对路径（pi 扩展 loader = jiti 跑 ts；域内相对导入经同一 loader 解析）
const PKG = "/home/pgoone/GitHubproject/nextstep重构/packages/next-step-pi/src";

const log = (tag: string, obj: unknown) => {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${tag} ${JSON.stringify(obj)}\n`);
};

export default function (pi: any) {
  pi.registerProvider("deepseek", {
    name: "DeepSeek (t1-10 smoke)",
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

  // 顶层同步装配（pi loader = jiti，require 仓库 ts 路径与 execute 内动态 import 同一解析器）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ProjectRegistry } = require(`${PKG}/domain/domain/project-registry.ts`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ArtifactService } = require(`${PKG}/domain/domain/artifact-service.ts`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PendingChangeStore } = require(`${PKG}/domain/domain/pending-change-service.ts`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { assembleDocSession } = require(`${PKG}/pi/session-assembly.ts`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { translateToolDef } = require(`${PKG}/pi/tool-translation.ts`);

  const registry = new ProjectRegistry(`${WORK}/projects.json`);
  const project = registry.create({ name: "smoke", root: WORK, createIfMissing: true });
  const artifactService = new ArtifactService(registry);
  const pendingStore = new PendingChangeStore(registry, artifactService);
  const assembly = assembleDocSession({
    projectId: project.id,
    sourceActor: "smoke-agent",
    cwd: WORK,
    // 真 CLI 扩展侧无 SessionManager 暴露（ExtensionAPI 无此字段）——轻量适配到
    // pi.appendEntry（T1-07 前置事实 4：appendEntry = appendCustomEntry + emit，不进 LLM 上下文）
    sessionManager: { appendCustomEntry: (customType: string, data?: unknown) => pi.appendEntry(customType, data) },
    artifactService,
    pendingStore,
  });

  for (const tool of assembly.tools) {
    pi.registerTool(translateToolDef(tool));
  }
  pi.on("tool_call", (event: any) => {
    const result = assembly.toolCallGuard(event);
    if (result && result.block) {
      log("guard.block", { toolName: event.toolName, path: event.input?.path, reason: result.reason });
    }
    return result;
  });
  log("assembly.ready", {
    projectId: project.id,
    tools: assembly.tools.map((t) => t.name),
    whitelist: assembly.toolsWhitelist,
    excludeTools: assembly.excludeTools,
  });
}
