/**
 * T1-13 S5 真机冒烟探针（pi extension factory，T1-10 probe 范式 + 工具调用事件留痕）
 *
 * 链路：真模型（deepseek，key 从 .env.pi-test 注入）→ doc 会话装配（assembleDocSession：
 * 六工具注册 + 受管路径 tool_call 守卫 + CliDecisionPort + AuditPort 落 pi.appendEntry）→
 * 模型调 create_artifact → 只读三工具（AC-1.1 结构化结果可观察）→ propose_edit →
 * tmux 真实按键逐块确认 → 全决物化 v2。
 *
 * S5 出口判据证据：
 * - AC-1.3：probe.log assembly.ready 记录 tools 六工具 + whitelist/excludeTools
 *   （物理无 write/edit/bash，另由 CLI 启动参数 --tools 白名单双证）
 * - AC-1.1/1.4：tool_execution_start 事件留痕三只读工具真实调用；零副作用由
 *   cli-smoke.sh 领域目录前后快照断言
 * - S5 期望③（唯一真相）：cli-smoke.sh 起临时 Web server 读同一数据目录断言版本链
 *
 * 证据：/tmp/t1-13-smoke/probe.log + smoke.pane（tmux 逐帧）+ 领域目录快照。
 */
import fs from "node:fs";

const WORK = "/tmp/t1-13-smoke";
const LOG = `${WORK}/probe.log`;
// 仓库绝对路径（pi 扩展 loader = jiti 跑 ts；域内相对导入经同一 loader 解析）
const PKG = "/home/pgoone/GitHubproject/nextstep重构/packages/next-step-pi/src";

const log = (tag: string, obj: unknown) => {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${tag} ${JSON.stringify(obj)}\n`);
};

export default function (pi: any) {
  pi.registerProvider("deepseek", {
    name: "DeepSeek (t1-13 smoke)",
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

  // 与 server 默认注册表同路径（~/.nextstep/projects.json 的 $WORK 投影）：
  // S5 期望③「CLI 与 Web 面板同一份真相」要求两通道读同一 registry + 同一领域存储
  const registry = new ProjectRegistry(`${WORK}/nextstep/projects.json`);
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
  // 工具调用事件留痕（AC-1.1 只读工具真实调用证据；T1-08 同事件名）
  pi.on("tool_execution_start", (event: any) => {
    log("tool.call", { toolName: event.toolName, args: event.args });
  });
  log("assembly.ready", {
    projectId: project.id,
    tools: assembly.tools.map((t) => t.name),
    whitelist: assembly.toolsWhitelist,
    excludeTools: assembly.excludeTools,
  });
}
