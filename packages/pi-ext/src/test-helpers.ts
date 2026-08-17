import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 集成测试 stub 模型基建（正本 §5 分层表：L2 测试 = SessionManager.inMemory() + stub 模型）。
 *
 * 经 ModelRuntime.registerProvider 注册一个零网络的 stub provider：
 * streamSimple 按脚本逐条弹出响应（文本 / toolCall），并记录每次 LLM 调用
 * 收到的 systemPrompt / tools / messages（「不进 LLM 上下文」类断言的数据源）。
 *
 * pi-ai 是 pi 的嵌套依赖、本包不直接依赖，故 AssistantMessageEventStream
 * （EventStream 语义：push 事件 + end(result) + [Symbol.asyncIterator] + result()）
 * 以结构兼容对象手写，事件序列对照 pi-ai faux provider 的官方实现。
 */

type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type StubStreamFn = NonNullable<ProviderConfig["streamSimple"]>;
type StreamReturn = ReturnType<StubStreamFn>;
/** pi-ai AssistantMessage（经 streamSimple 返回值的 result() 提取，避免直接依赖嵌套包）。 */
type AssistantMsg = StreamReturn extends { result(): Promise<infer R> } ? R : never;

/** 一次脚本化 LLM 响应：文本与/或工具调用。 */
export type StubResponse = {
  text?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  usage?: { input?: number; output?: number; totalTokens?: number };
};

/** stub 模型一次调用收到的上下文快照。 */
export type StubCall = {
  systemPrompt: string;
  tools: { name: string }[];
  messages: unknown[];
  serialized: string;
};

export interface StubModel {
  modelRuntime: ModelRuntime;
  model: NonNullable<CreateAgentSessionOptions["model"]>;
  calls: StubCall[];
  setResponses(responses: StubResponse[]): void;
}

const STUB_PROVIDER = "stub-prov";
const STUB_MODEL_ID = "stub-1";

function stubUsage(u?: StubResponse["usage"]) {
  const input = u?.input ?? 10;
  const output = u?.output ?? 5;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: u?.totalTokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function buildFinalMessage(response: StubResponse, model: { api: string; provider: string; id: string }): AssistantMsg {
  const content: Record<string, unknown>[] = [];
  if (response.text !== undefined) content.push({ type: "text", text: response.text });
  for (const call of response.toolCalls ?? []) {
    content.push({ type: "toolCall", id: `stub-call-${Math.random().toString(36).slice(2)}`, name: call.name, arguments: call.arguments });
  }
  const stopReason = (response.toolCalls ?? []).length > 0 ? "toolUse" : "stop";
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: stubUsage(response.usage),
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMsg;
}

/** 结构兼容 AssistantMessageEventStream（事件序列对照 pi-ai faux 的 streamWithDeltas）。 */
function assistantStream(finalMessage: AssistantMsg): StreamReturn {
  const events: unknown[] = [];
  const stream = {
    push: (event: unknown) => events.push(event),
    end: () => undefined,
    result: () => Promise.resolve(finalMessage),
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async (): Promise<IteratorResult<unknown>> =>
          index < events.length ? { done: false, value: events[index++] } : { done: true, value: undefined },
      };
    },
  } as unknown as {
    push: (event: unknown) => void;
    end: () => void;
    result: () => Promise<AssistantMsg>;
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
  };
  const pending = { ...finalMessage, content: [], stopReason: "pending" };
  stream.push({ type: "start", partial: pending });
  const blocks = (finalMessage as unknown as { content: { type: string; text?: string }[] }).content;
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex: index, partial: pending });
      stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: pending });
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: pending });
    } else {
      stream.push({ type: "toolcall_start", contentIndex: index, partial: pending });
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: pending });
    }
  });
  stream.push({ type: "done", reason: (finalMessage as unknown as { stopReason: string }).stopReason, message: finalMessage });
  return stream as unknown as StreamReturn;
}

export async function createStubModel(): Promise<StubModel> {
  const authTmp = mkdtempSync(path.join(tmpdir(), "nextstep-stub-auth-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(authTmp, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });

  const calls: StubCall[] = [];
  let pending: StubResponse[] = [];

  modelRuntime.registerProvider(STUB_PROVIDER, {
    name: "Stub Provider",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "stub-key",
    api: "stub-api" as ProviderConfig["api"],
    models: [
      {
        id: STUB_MODEL_ID,
        name: "Stub Model 1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
    streamSimple: ((model: Record<string, unknown>, context: Record<string, unknown>) => {
      calls.push({
        systemPrompt: String(context.systemPrompt ?? ""),
        tools: ((context.tools as { name: string }[] | undefined) ?? []).map((t) => ({ name: t.name })),
        messages: [...((context.messages as unknown[] | undefined) ?? [])],
        serialized: JSON.stringify(context),
      });
      const response = pending.shift() ?? { text: "(stub default)" };
      return assistantStream(buildFinalMessage(response, {
        api: String(model.api),
        provider: String(model.provider),
        id: String(model.id),
      }));
    }) as unknown as ProviderConfig["streamSimple"],
  });

  const model = modelRuntime.getModel(STUB_PROVIDER, STUB_MODEL_ID);
  if (model === undefined) throw new Error("stub model not registered");

  return {
    modelRuntime,
    model,
    calls,
    setResponses(responses: StubResponse[]) {
      pending = [...responses];
    },
  };
}
