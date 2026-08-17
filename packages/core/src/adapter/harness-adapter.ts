import type { AuditPort, DecisionPort } from "../gate/ports";

// packages/core/src/adapter/harness-adapter.ts（L1 定义，纯 TS 类型）
// 六个动作全部有 pi 官方 1:1 落点；不预留第 7 个。L1 不 import pi，类型均为 L1 自有。

/** JSON Schema 纯数据（L1 自有类型）：工具参数 schema 只是一份数据，由 L2 翻译成 pi 的 TypeBox ToolDefinition。 */
export type JsonSchema = Record<string, unknown>;

export interface HarnessAdapter {
  /** 动作 1 · 起会话（落点：createAgentSession()）。options 含 cwd、agentDir、systemPrompt、工具白名单。 */
  startSession(options: SessionStartOptions): Promise<SessionHandle>;

  /** 动作 2 · 发消息（落点：session.prompt()）。返回本轮回复文本。 */
  sendMessage(handle: SessionHandle, message: string): Promise<AgentReply>;

  /** 动作 3 · 注册工具（落点：pi.registerTool()）。工具定义是 L1 纯数据 schema，L2 翻译成 ToolDefinition。 */
  registerTool(def: NextStepToolDef): void;

  /** 动作 4 · 读会话流（落点：session.subscribe() + ctx.sessionManager.getEntries()）。直播 + 回放同一条通道。 */
  readSessionStream(handle: SessionHandle, opts: { afterEntryId?: string }): AsyncIterable<SessionEntry>;

  /** 动作 5 · 派子 Agent（落点：官方 examples/extensions/subagent；第二期 M4 消费，本期实现 + 单测不接线）。 */
  spawnSubagent(handle: SessionHandle, req: SubagentRequest): Promise<SubagentResult>;

  /** 动作 6 · 取上下文用量（落点：context 事件）。L1 侧防御上下文膨胀（§8 风险「追溯链让 Agent 输出啰嗦」）。 */
  getContextUsage(handle: SessionHandle): Promise<ContextUsage>;
}

export type SessionStartOptions = {
  cwd: string;
  agentDir: string;
  systemPrompt?: string;
  tools: NextStepToolDef[]; // 注册进会话的自定义工具
  toolsWhitelist: string[]; // 能力层白名单（doc 模式物理禁 write/edit 的落点之一）
  excludeTools?: string[]; // 能力层显式排除（双保险）
  decisionPort: DecisionPort; // 闸门（详细设计 §3）
  auditPort: AuditPort; // 审计条目写回（详细设计 §2.3）
  sourceActor: string; // 本会话 Agent 身份（写入 version.author / sourceActor / list_my_artifacts 的「名下」）
  projectId: string; // 闭包注入的当前项目（旧仓 doc-tools.ts 同款装配范式）
};
export type SessionHandle = { id: string };
export type AgentReply = { text: string; turnEnd: boolean };
export type NextStepToolDef = {
  // L1 纯数据；L2 负责转 pi ToolDefinition
  name: string;
  description: string;
  parameters: JsonSchema;
  promptGuidelines?: string[]; // 旧仓 propose_edit 已验证的「整篇 vs 残篇」双通道约束
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<NextStepToolResult>;
};
export type NextStepToolResult = { content: { type: "text"; text: string }[] };
export type SessionEntry = { id: string; type: string; ts: string; payload: Record<string, unknown> };
export type SubagentRequest = { prompt: string; tools?: string[]; model?: string }; // 第二期细化
export type SubagentResult = { text: string; usage: ContextUsage };
export type ContextUsage = { totalTokens: number; inputTokens: number; outputTokens: number; entryCount: number };
