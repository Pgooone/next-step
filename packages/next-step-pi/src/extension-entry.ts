import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { ProjectRegistry, ProjectError, type Project } from "./domain/domain/project-registry";
import { assembleDocSession } from "./pi/session-assembly";
import { translateToolDef } from "./pi/tool-translation";

/**
 * 发行轨 A · pi 扩展入口（default export factory，pi.dev 扩展语义）——
 * `pi install npm:@pgoone/next-step-pi` 一行安装即得六工具 + 闸门。
 *
 * 本文件是纯胶水，零领域逻辑（判断全在已验收的 domain / 装配模块）：
 *
 * 1. **项目装配**：cwd = 用户运行 pi 的目录 = 项目 root。经 ProjectRegistry 默认
 *    注册表（~/.nextstep/projects.json，NEXTSTEP_DIR_NAME 用户级目录常量）按 root
 *    查找已有项目复用（扩展每次启动都加载，不能重复建），无则 create 注册
 *    （同名不同 root 的 registry name 唯一契约冲突时，追加随机后缀兜底装配）。
 * 2. **doc 会话装配**：assembleDocSession（T1-10）——六工具闭包注入
 *    （projectId / sourceActor = "pi-agent"）+ CliDecisionPort 惰性 getContext 接线
 *    （T1-09：propose_edit execute 的 ctx 经 onToolContext 喂入，汇总卡 TUI 渲染）。
 * 3. **AuditPort 适配**：pi 扩展侧无 SessionManager 暴露，经 pi.appendEntry
 *    （= appendCustomEntry + emit，持久化且不进 LLM 上下文）适配轻量 sessionManager
 *    （T1-07 前置事实 4）。
 * 4. **注册与守卫**：六工具经 translateToolDef（L2 翻译层）逐个 pi.registerTool；
 *    tool_call 守卫（受管路径直写 → block）挂 pi.on("tool_call")（详设 §5.3）。
 *
 * 本文件只 import pi 的**类型**（编译期擦除），运行时零依赖 pi 核心模块——
 * 与 peerDependencies 声明（pi 官方 packages.md：核心包进 peer 不打包）一致。
 */
export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const registry = new ProjectRegistry();
  const project = resolveProjectForCwd(registry, cwd);
  const assembly = assembleDocSession({
    projectId: project.id,
    sourceActor: "pi-agent",
    cwd,
    // 轻量适配：pi.appendEntry 落会话 JSONL（customType "next-step" 由 createEntryAuditPort 统一）。
    // appendCustomEntry 契约返回条目 id，pi.appendEntry 无返回——适配面不消费该值，返回空串。
    sessionManager: {
      appendCustomEntry: (customType: string, data?: unknown) => {
        pi.appendEntry(customType, data);
        return "";
      },
    },
  });
  for (const tool of assembly.tools) {
    pi.registerTool(translateToolDef(tool));
  }
  pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult => assembly.toolCallGuard(event));
}

/**
 * 装配胶水：当前 cwd 对应哪个受管项目。root 已注册 → 复用（扩展每次启动都
 * 加载，直接 create 会踩 registry 的 name 唯一契约、第二次启动即炸）；
 * 未注册 → 以目录名注册新项目。同名不同 root 的极端冲突追加随机后缀兜底，
 * 保证扩展加载永不因项目装配炸掉 pi 启动。
 */
function resolveProjectForCwd(registry: ProjectRegistry, cwd: string): Project {
  const existing = registry.list().find((p) => p.root === cwd);
  if (existing !== undefined) return existing;
  const name = basename(cwd) || "nextstep";
  try {
    return registry.create({ name, root: cwd, createIfMissing: true });
  } catch (e) {
    if (e instanceof ProjectError && e.code === "INVALID") {
      return registry.create({
        name: `${name}-${randomUUID().slice(0, 4)}`,
        root: cwd,
        createIfMissing: true,
      });
    }
    throw e;
  }
}
