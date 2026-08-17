import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ContextEvent,
  CreateAgentSessionOptions,
  SessionEntry as PiSessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentReply,
  ContextUsage,
  HarnessAdapter,
  NextStepToolDef,
  SessionEntry,
  SessionHandle,
  SessionStartOptions,
  SubagentRequest,
  SubagentResult,
} from "@pgoone/next-step-core";
import { translateToolDef } from "./tool-translation";

/**
 * HarnessAdapter 的 pi 实现（L2，正本 §5.1 六动作的 1:1 落点）。
 * 本包是全仓唯一 import pi 的地方（B1 红线）；本文件只做「pi 对象 ↔ L1 类型」
 * 翻译与接线，零领域判断（判断全在 L1）。
 *
 * 落点表（概设 §4）：
 * 1. startSession      → createAgentSession()（toolsWhitelist / excludeTools / systemPrompt / agentDir 透传）
 * 2. sendMessage       → session.prompt()
 * 3. registerTool      → pi.registerTool()（经 DefaultResourceLoader 的 inline extension factory）
 * 4. readSessionStream → session.subscribe() + sessionManager.getEntries()（直播 + 回放同通道）
 * 5. spawnSubagent     → 官方 examples/extensions/subagent 进程范式（本期实现 + 单测，不接线）
 * 6. getContextUsage   → extension 的 context 事件（每次 LLM 调用前的 messages 快照）
 */

/** context 事件携带的 message 类型（pi 的 AgentMessage 未从主入口导出，经 ContextEvent 取）。 */
type PiAgentMessage = ContextEvent["messages"][number];

/** 一个活动会话的全部接线状态（SessionHandle 对 L1 只暴露 id）。 */
type SessionRuntime = {
  session: AgentSession;
  options: SessionStartOptions;
  /** context 事件最新快照（动作 6 数据源；未触发过 LLM 调用前为 undefined）。 */
  lastContextMessages(): PiAgentMessage[] | undefined;
};

/** 可注入依赖（测试注入 inMemory SessionManager 与 stub 模型；生产用 pi 默认）。 */
export interface HarnessAdapterDeps {
  sessionManager?: CreateAgentSessionOptions["sessionManager"];
  model?: CreateAgentSessionOptions["model"];
  modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
  /** 子 Agent 进程启动器（默认 spawn node + pi cli.js；测试注入伪进程）。 */
  spawnProcess?: SpawnFn;
}

/** 子 Agent 进程抽象（官方 subagent 范式：stdout/stderr 行流 + close 事件）。 */
export type ChildLike = {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(): void;
};
export type SpawnFn = (command: string, args: string[], options: { cwd: string }) => ChildLike;

/** pi CLI 入口（spawnSubagent 的 --mode json 子进程载体）。 */
function piCliEntry(): { command: string; args: string[] } {
  // 生产（Node ≥20.6）：import.meta.resolve 走 "import" condition——pi 的 exports
  // 无 "require" 主入口，require.resolve 会报 No "exports" main defined。
  // vitest SSR 转换不提供 import.meta.resolve → 回退：按 Node 解析算法逐级向上定位包。
  let mainPath: string | undefined;
  if (typeof (import.meta as { resolve?: unknown }).resolve === "function") {
    mainPath = fileURLToPath(
      (import.meta as unknown as { resolve: (s: string) => string }).resolve("@earendil-works/pi-coding-agent"),
    );
  } else {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const candidate = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
      if (existsSync(candidate)) {
        mainPath = candidate;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (mainPath === undefined) throw new Error("cannot locate @earendil-works/pi-coding-agent (pi cli entry)");
  return { command: process.execPath, args: [path.resolve(path.dirname(mainPath), "cli.js")] };
}

/** pi SessionEntry → L1 SessionEntry（纯字段映射：timestamp→ts，其余进 payload）。 */
function translateEntry(entry: PiSessionEntry): SessionEntry {
  const { id, type, timestamp, ...rest } = entry as PiSessionEntry & Record<string, unknown>;
  return { id, type, ts: timestamp, payload: rest };
}

/** pi message content → 纯文本（子 Agent 结果聚合；text 块拼接）。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: string }).text) : ""))
    .join("");
}

/**
 * 创建 HarnessAdapter（L2 工厂）。返回类型是 L1 HarnessAdapter 的超集：
 * 6 个动作签名与 L1 定义逐字一致；dispose 是 L2 生命周期管理（释放底层
 * AgentSession），不是第 7 个动作（动作 = L1 领域对会话能力的需求面）。
 */
export function createHarnessAdapter(deps: HarnessAdapterDeps = {}): HarnessAdapter & { dispose(): void } {
  /** 动作 3 的 adapter 级注册表：registerTool 时刻记录，startSession 时经 pi.registerTool 注册进会话。 */
  const registeredTools: NextStepToolDef[] = [];
  const runtimes = new Map<string, SessionRuntime>();

  const adapter: HarnessAdapter & { dispose(): void } = {
    async startSession(options: SessionStartOptions): Promise<SessionHandle> {
      // inline extension factory = pi.registerTool / context 事件的唯一挂载点（官方 sdk 06-extensions 范式）
      const contextSnapshot: { messages?: PiAgentMessage[] } = {};
      const toolDefs: ToolDefinition<any, any, any>[] = [...registeredTools, ...options.tools].map(translateToolDef);
      const resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: options.agentDir,
        extensionFactories: [
          (pi) => {
            for (const def of toolDefs) pi.registerTool(def);
            pi.on("context", (event) => {
              contextSnapshot.messages = event.messages;
            });
          },
        ],
        // systemPrompt 透传（官方 sdk 03-custom-prompt 范式：完全替换 + 不追加 APPEND_SYSTEM.md）
        ...(options.systemPrompt !== undefined
          ? {
              systemPromptOverride: () => options.systemPrompt!,
              appendSystemPromptOverride: () => [] as string[],
            }
          : {}),
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd: options.cwd,
        agentDir: options.agentDir,
        tools: options.toolsWhitelist,
        ...(options.excludeTools !== undefined ? { excludeTools: options.excludeTools } : {}),
        resourceLoader,
        ...(deps.sessionManager !== undefined ? { sessionManager: deps.sessionManager } : {}),
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        ...(deps.modelRuntime !== undefined ? { modelRuntime: deps.modelRuntime } : {}),
      });

      const runtime: SessionRuntime = {
        session,
        options,
        lastContextMessages: () => contextSnapshot.messages,
      };
      runtimes.set(session.sessionId, runtime);
      return { id: session.sessionId };
    },

    async sendMessage(handle: SessionHandle, message: string): Promise<AgentReply> {
      const session = runtimeOf(handle, runtimes).session;
      await session.prompt(message); // session.prompt() 在本轮 agent run 结束后 resolve
      return { text: session.getLastAssistantText() ?? "", turnEnd: true };
    },

    registerTool(def: NextStepToolDef): void {
      registeredTools.push(def);
      // pi.registerTool 只在 extension factory 内可用，故注册在下一个 startSession 生效
      //（官方无 SDK 级动态注册途径；SessionStartOptions.tools 与本注册表合并去重由调用方保证）。
    },

    readSessionStream(handle: SessionHandle, opts: { afterEntryId?: string }): AsyncIterable<SessionEntry> {
      const session = runtimeOf(handle, runtimes).session;
      // 手写 async iterator（非 generator）：generator 挂起在内部 await 上时，
      // 消费者 break 触发的 return() 无法将其唤醒（Promise 永不 settle → 死锁）；
      // 手写 return() 直接 cancel 挂起的 next，直播流可被随时中断。
      return {
        [Symbol.asyncIterator](): AsyncIterator<SessionEntry> {
          const seen = new Set<string>();
          const queue: SessionEntry[] = [];
          let wake: (() => void) | undefined;
          let finished = false;
          let prepared = false;
          let diffScheduled = false;
          const replay: SessionEntry[] = [];
          let replayIndex = 0;

          // 直播触发器（pi 0.84.2 事件面实证）：对话消息只发 message_end（不发
          // entry_appended——后者仅 ExtensionAPI.appendEntry 一处发射）；thinking/
          // session_info/compaction 同理。且 _handleAgentEvent 先转发订阅者、后
          // appendMessage 持久化——订阅者收到事件时 getEntries() 还没有该条目。
          // 故事件只做唤醒，条目一律经 microtask 差量比对从 getEntries() 取
          // （同步块结束后条目必已入表）：直播与回放同源同 id，afterEntryId 语义不破。
          const TRIGGER_EVENTS = new Set([
            "message_end",
            "entry_appended",
            "thinking_level_changed",
            "session_info_changed",
            "compaction_end",
          ]);
          const runDiff = () => {
            let added = false;
            for (const entry of session.sessionManager.getEntries()) {
              if (seen.has(entry.id)) continue;
              seen.add(entry.id);
              queue.push(translateEntry(entry));
              added = true;
            }
            if (added) wake?.();
          };
          const scheduleDiff = () => {
            if (diffScheduled) return;
            diffScheduled = true;
            queueMicrotask(() => {
              diffScheduled = false;
              runDiff();
            });
          };
          // 先挂直播订阅再取回放快照：订阅与快照间隙的条目经 seen 去重，不丢不重
          const unsubscribe = session.subscribe((event) => {
            if (TRIGGER_EVENTS.has(event.type)) scheduleDiff();
          });
          const prepareReplay = () => {
            if (prepared) return;
            prepared = true;
            const entries = session.sessionManager.getEntries();
            let afterSeen = opts.afterEntryId === undefined;
            for (const entry of entries) {
              if (!afterSeen) {
                // 切点前条目：不进回放，且必须标记已见——否则末尾 runDiff 的
                // 全量差量会把它误判为新条目投进直播队列（P1-2）
                seen.add(entry.id);
                if (entry.id === opts.afterEntryId) afterSeen = true;
                continue;
              }
              seen.add(entry.id);
              replay.push(translateEntry(entry));
            }
            // 兜住「订阅后、prepare 前已有写入且 diff microtask 未跑」的窗口
            runDiff();
          };
          const close = () => {
            unsubscribe();
          };

          return {
            async next(): Promise<IteratorResult<SessionEntry>> {
              if (finished) return { done: true, value: undefined };
              prepareReplay();
              for (;;) {
                if (replayIndex < replay.length) return { done: false, value: replay[replayIndex++] };
                // 直播队列：入队方（runDiff）已按 seen 去重，直接吐出
                if (queue.length > 0) {
                  return { done: false, value: queue.shift()! };
                }
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                wake = undefined;
                if (finished) return { done: true, value: undefined };
              }
            },
            async return(): Promise<IteratorResult<SessionEntry>> {
              finished = true;
              wake?.();
              close();
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    async spawnSubagent(handle: SessionHandle, req: SubagentRequest): Promise<SubagentResult> {
      // 官方 examples/extensions/subagent 进程范式：pi --mode json -p --no-session，
      // stdout 逐行 JSON 事件流聚合 assistant 输出与 usage；进程 close 即回收。
      const runtime = runtimeOf(handle, runtimes);
      const spawnFn = deps.spawnProcess ?? defaultSpawn;
      const args: string[] = ["--mode", "json", "-p", "--no-session"];
      if (req.model !== undefined) args.push("--model", req.model);
      if (req.tools !== undefined && req.tools.length > 0) args.push("--tools", req.tools.join(","));
      args.push(req.prompt);

      const { command, args: baseArgs } = piCliEntry();
      const proc = spawnFn(command, [...baseArgs, ...args], { cwd: runtime.options.cwd });

      const messages: { role: string; text: string }[] = [];
      let finalText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;

      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        const processLine = (line: string) => {
          if (!line.trim()) return;
          let event: { type?: string; message?: { role?: string; content?: unknown; usage?: { input?: number; output?: number; totalTokens?: number } } };
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === "message_end" && event.message) {
            const msg = event.message;
            const text = textOf(msg.content);
            messages.push({ role: msg.role ?? "", text });
            if (msg.role === "assistant") {
              if (text !== "") finalText = text;
              const usage = msg.usage;
              if (usage) {
                inputTokens += usage.input || 0;
                outputTokens += usage.output || 0;
                totalTokens = usage.totalTokens || totalTokens;
              }
            }
          }
        };
        proc.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) processLine(line);
        });
        proc.stderr.on("data", () => {
          // 官方范式仅记录 stderr 供诊断；结果聚合以 stdout 事件流为准
        });
        proc.on("close", (code) => {
          if (buffer.trim()) processLine(buffer);
          if (code !== 0) {
            reject(new Error(`subagent exited with code ${code ?? "unknown"}`));
            return;
          }
          resolve();
        });
        proc.on("error", (err) => reject(err));
      });

      return {
        text: finalText,
        usage: { totalTokens, inputTokens, outputTokens, entryCount: messages.length },
      };
    },

    async getContextUsage(handle: SessionHandle): Promise<ContextUsage> {
      const runtime = runtimeOf(handle, runtimes);
      const session = runtime.session;
      const stats = session.getSessionStats();
      const contextTokens = session.getContextUsage()?.tokens;
      return {
        // totalTokens = 当前上下文占用估算（context 事件驱动；无快照时回退会话累计）
        totalTokens: contextTokens ?? stats.tokens.total,
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        entryCount:
          runtime.lastContextMessages()?.length ?? session.sessionManager.buildContextEntries().length,
      };
    },

    dispose(): void {
      for (const runtime of runtimes.values()) runtime.session.dispose();
      runtimes.clear();
    },
  };
  return adapter;
}

function runtimeOf(handle: SessionHandle, runtimes: Map<string, SessionRuntime>): SessionRuntime {
  const runtime = runtimes.get(handle.id);
  if (runtime === undefined) throw new Error(`unknown session handle: ${handle.id}`);
  return runtime;
}

const defaultSpawn: SpawnFn = (command, args, options) => {
  const proc = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
  return proc as unknown as ChildLike;
};
