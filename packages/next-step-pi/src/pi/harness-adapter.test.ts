import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DecisionPort, AuditPort } from "../domain/gate/ports";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessAdapter } from "./harness-adapter";
import type {
  AgentReply,
  ChildLike,
  ContextUsage,
  NextStepToolDef,
  SessionEntry,
  SessionHandle,
  SessionStartOptions,
  SpawnFn,
  SubagentRequest,
  SubagentResult,
} from "./harness-adapter";
import { createStubModel, type StubModel } from "./test-helpers";

/**
 * T1-07 验收断言：6 动作逐一在 SessionManager.inMemory() + stub 模型下可调用并返回预期。
 * spawnSubagent 用注入的伪进程（官方 subagent 范式的 stdout JSONL 事件流）；
 * getContextUsage 断言 usage 字段。
 */

/**
 * 六动作纪律形状（原 L1 契约接口形状逐字平移；ADR-001 B 废除显式接口后，
 * 此处以本地结构 type 保持「签名无漂移 + 无第 7 个动作」断言）。
 */
type AdapterContractShape = {
  startSession(options: SessionStartOptions): Promise<SessionHandle>;
  sendMessage(handle: SessionHandle, message: string): Promise<AgentReply>;
  registerTool(def: NextStepToolDef): void;
  readSessionStream(handle: SessionHandle, opts: { afterEntryId?: string }): AsyncIterable<SessionEntry>;
  spawnSubagent(handle: SessionHandle, req: SubagentRequest): Promise<SubagentResult>;
  getContextUsage(handle: SessionHandle): Promise<ContextUsage>;
};

const noOpDecisionPort: DecisionPort = { ask: async () => ({ status: "deferred" }) };
const noOpAuditPort: AuditPort = { append: async () => undefined };

function startOptions(overrides: Partial<Parameters<ReturnType<typeof createHarnessAdapter>["startSession"]>[0]> = {}) {
  return {
    cwd: process.cwd(),
    agentDir: "/tmp/nextstep-test-agent-dir",
    tools: [],
    toolsWhitelist: [],
    decisionPort: noOpDecisionPort,
    auditPort: noOpAuditPort,
    sourceActor: "test-actor",
    projectId: "test-project",
    ...overrides,
  };
}

let currentAdapter: ReturnType<typeof createHarnessAdapter> | undefined;

function newAdapter(stub: StubModel) {
  const adapter = createHarnessAdapter({
    sessionManager: SessionManager.inMemory(process.cwd()),
    model: stub.model,
    modelRuntime: stub.modelRuntime,
  });
  currentAdapter = adapter;
  return adapter;
}

afterEach(() => {
  currentAdapter?.dispose();
  currentAdapter = undefined;
});

describe("动作 1 · startSession → createAgentSession()", () => {
  it("返回 SessionHandle，systemPrompt 与 toolsWhitelist 透传到 pi 会话", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([{ text: "ok" }]);

    const handle = await adapter.startSession(
      startOptions({
        systemPrompt: "CUSTOM-SYSTEM-PROMPT-XYZ",
        toolsWhitelist: ["stub_tool"],
        tools: [
          {
            name: "stub_tool",
            description: "stub",
            parameters: { type: "object", properties: { msg: { type: "string" } } },
            execute: async () => ({ content: [{ type: "text", text: "stub tool ran" }] }),
          },
        ],
      }),
    );
    expect(typeof handle.id).toBe("string");
    expect(handle.id.length).toBeGreaterThan(0);

    await adapter.sendMessage(handle, "ping");
    // systemPrompt 以透传文本开头（pi 在其后追加 cwd 等环境段）；白名单内自定义工具暴露给模型
    expect(stub.calls[0].systemPrompt.startsWith("CUSTOM-SYSTEM-PROMPT-XYZ")).toBe(true);
    expect(stub.calls[0].tools.map((t) => t.name)).toContain("stub_tool");
  });

  it("excludeTools 透传：被排除的工具不出现在模型工具面", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([{ text: "ok" }]);

    const handle = await adapter.startSession(
      startOptions({
        toolsWhitelist: ["keep_tool", "drop_tool"],
        excludeTools: ["drop_tool"],
        tools: [
          { name: "keep_tool", description: "k", parameters: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: "k" }] }) },
          { name: "drop_tool", description: "d", parameters: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: "d" }] }) },
        ],
      }),
    );
    await adapter.sendMessage(handle, "ping");
    const names = stub.calls[0].tools.map((t) => t.name);
    expect(names).toContain("keep_tool");
    expect(names).not.toContain("drop_tool");
  });
});

describe("动作 2 · sendMessage → session.prompt()", () => {
  it("返回本轮回复文本且 turnEnd = true", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([{ text: "hello from stub" }]);

    const handle = await adapter.startSession(startOptions());
    const reply = await adapter.sendMessage(handle, "say hello");
    expect(reply.text).toBe("hello from stub");
    expect(reply.turnEnd).toBe(true);
  });
});

describe("动作 3 · registerTool → pi.registerTool()", () => {
  it("注册的工具可被模型调用，参数经翻译层往返（execute 收到原始 args）", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    const executed: Record<string, unknown>[] = [];
    const echoTool: NextStepToolDef = {
      name: "echo_tool",
      description: "echoes msg",
      parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      execute: async (args) => {
        executed.push(args);
        return { content: [{ type: "text", text: `echo:${String(args.msg)}` }] };
      },
    };
    adapter.registerTool(echoTool);
    stub.setResponses([
      { toolCalls: [{ name: "echo_tool", arguments: { msg: "hi pi" } }] },
      { text: "done after tool" },
    ]);

    const handle = await adapter.startSession(startOptions({ toolsWhitelist: ["echo_tool"] }));
    const reply = await adapter.sendMessage(handle, "use the echo tool");
    expect(reply.text).toBe("done after tool");
    expect(executed).toEqual([{ msg: "hi pi" }]);
  });
});

describe("动作 4 · readSessionStream → session.subscribe() + getEntries()", () => {
  it("回放：消费全部既有条目（直播 + 回放同通道的回放侧）", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([{ text: "first" }, { text: "second" }]);
    const handle = await adapter.startSession(startOptions());
    await adapter.sendMessage(handle, "q1");
    await adapter.sendMessage(handle, "q2");

    const collected: string[] = [];
    const iterator = adapter.readSessionStream(handle, {})[Symbol.asyncIterator]();
    // pi 启动写 2 条 setup 条目（model_change / thinking_level_change）+ 2 轮对话 4 条 message
    for (let i = 0; i < 6; i++) {
      const next = await iterator.next();
      if (next.done) break;
      collected.push(next.value.type);
    }
    await iterator.return?.();
    expect(collected).toHaveLength(6);
    expect(collected.filter((t) => t === "message")).toHaveLength(4);
  });

  it("afterEntryId + 直播（切点续读）：切点前旧条目不误投，直播到达的是新条目", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([{ text: "first" }, { text: "second" }]);
    const handle = await adapter.startSession(startOptions());
    await adapter.sendMessage(handle, "q1");

    // 取切点：全量 4 条（model_change, thinking_level_change, user1, assistant1），从第 2 条后切
    const probe: string[] = [];
    const probeIter = adapter.readSessionStream(handle, {})[Symbol.asyncIterator]();
    for (let i = 0; i < 4; i++) {
      const next = await probeIter.next();
      probe.push(next.value.id);
    }
    await probeIter.return?.();

    const iterator = adapter.readSessionStream(handle, { afterEntryId: probe[1] })[Symbol.asyncIterator]();
    // 回放：恰 2 条（user1 + assistant1），id 与全量快照的切点尾部逐条相等；切点前 2 条 setup 不出现
    const replayIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      expect(next.value.type).toBe("message");
      replayIds.push(next.value.id);
    }
    expect(replayIds).toEqual(probe.slice(2));

    // 直播：并发 q2，到达的必须是新条目（message 且不在旧快照内），而非切点前旧条目（P1-2 回归判据）
    const sending = adapter.sendMessage(handle, "q2");
    const liveIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("live entry not delivered")), 3000)),
      ]);
      expect(next.done).toBe(false);
      expect(next.value.type).toBe("message");
      liveIds.push(next.value.id);
    }
    await sending;
    await iterator.return?.();

    for (const id of liveIds) {
      expect(probe).not.toContain(id); // 直播到达的是切点/快照之外的新条目
    }
  });

  it("直播中途订阅（先写后挂）：回放全部既有条目后直播续新，不丢不重", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([{ text: "first" }, { text: "second" }, { text: "third" }]);
    const handle = await adapter.startSession(startOptions());
    await adapter.sendMessage(handle, "q1"); // 订阅前已有一轮写入

    // 中途开流：先收全部既有（2 setup + user1 + assistant1 = 4 条）
    const iterator = adapter.readSessionStream(handle, {})[Symbol.asyncIterator]();
    const received: { id: string; type: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      received.push({ id: next.value.id, type: next.value.type });
    }

    // 订阅后继续一轮对话：直播续 2 条（q2 的 user + assistant）
    const sending = adapter.sendMessage(handle, "q2");
    for (let i = 0; i < 2; i++) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("live entry not delivered")), 3000)),
      ]);
      expect(next.done).toBe(false);
      received.push({ id: next.value.id, type: next.value.type });
    }
    await sending;
    await iterator.return?.();

    // 不丢：6 条（2 setup + 4 message）；不重：id 无重复；顺序：与 getEntries 写入序一致
    expect(received).toHaveLength(6);
    expect(new Set(received.map((e) => e.id)).size).toBe(6);
    expect(received.filter((e) => e.type === "message")).toHaveLength(4);
  });

  it("afterEntryId：只吐该条目之后的条目", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([{ text: "first" }, { text: "second" }]);
    const handle = await adapter.startSession(startOptions());
    await adapter.sendMessage(handle, "q1");
    await adapter.sendMessage(handle, "q2");

    const all: { id: string }[] = [];
    const iter0 = adapter.readSessionStream(handle, {})[Symbol.asyncIterator]();
    for (let i = 0; i < 6; i++) {
      const next = await iter0.next();
      if (next.done) break;
      all.push({ id: next.value.id });
    }
    await iter0.return?.();

    const afterSecond = all[1].id; // 第 2 条（thinking_level_change）之后 → 剩 4 条 message
    const tail: string[] = [];
    const iter = adapter.readSessionStream(handle, { afterEntryId: afterSecond })[Symbol.asyncIterator]();
    for (let i = 0; i < 4; i++) {
      const next = await iter.next();
      if (next.done) break;
      tail.push(next.value.id);
    }
    await iter.return?.();
    expect(tail).toEqual(all.slice(2).map((e) => e.id));
  });

  it("直播：订阅后新写入的对话条目实时到达（pi 0.84.2 对话消息不发 entry_appended，经差量比对入队），break 不死锁", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([{ text: "first" }, { text: "second" }]);
    const handle = await adapter.startSession(startOptions());
    await adapter.sendMessage(handle, "q1");

    const iterator = adapter.readSessionStream(handle, {})[Symbol.asyncIterator]();
    // 排干回放快照全量（2 setup + user1 + assistant1 = 4 条），确保后续到达的是直播而非快照余量
    const replay: string[] = [];
    for (let i = 0; i < 4; i++) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      replay.push(next.value.id);
    }

    // 直播：并发一条消息（q2 的 user + assistant 两条 message entry），订阅侧应实时收到
    const sending = adapter.sendMessage(handle, "q2");
    const live: { id: string; type: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("live entry not delivered")), 3000)),
      ]);
      expect(next.done).toBe(false);
      live.push({ id: next.value.id, type: next.value.type });
    }
    await sending;

    // 到达的是快照之外的新条目（type=message，id 与回放无重叠）
    expect(live.map((e) => e.type)).toEqual(["message", "message"]);
    for (const e of live) {
      expect(replay).not.toContain(e.id);
    }
    // break（return）必须立即返回而非挂在内部等待上
    await Promise.race([
      iterator.return?.(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("return deadlock")), 2000)),
    ]);
  });
});

describe("动作 5 · spawnSubagent → 官方 subagent 进程范式（实现 + 单测，不接线）", () => {
  function fakeSpawn(lines: string[], exitCode = 0): { spawnFn: SpawnFn; calls: { command: string; args: string[]; cwd: string }[]; killed: boolean[] } {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const killed: boolean[] = [];
    const spawnFn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      const listeners = { data: [] as ((c: Buffer | string) => void)[], close: [] as ((code: number | null) => void)[] };
      const proc: ChildLike = {
        stdout: { on: (_e, l) => listeners.data.push(l) },
        stderr: { on: () => undefined },
        on: (event: string, l: unknown) => {
          if (event === "close") listeners.close.push(l as (code: number | null) => void);
        },
        kill: () => {
          killed.push(true);
        },
      };
      queueMicrotask(() => {
        for (const line of lines) for (const l of listeners.data) l(`${line}\n`);
        for (const l of listeners.close) l(exitCode);
      });
      return proc;
    };
    return { spawnFn, calls, killed };
  }

  const assistantLine = (text: string, usage: { input: number; output: number; totalTokens: number }) =>
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason: "stop" },
    });

  it("spawn 参数按官方范式组装，结果聚合 text 与 usage 字段", async () => {
    const stub = await createStubModel();
    const adapter = createHarnessAdapter({
      sessionManager: SessionManager.inMemory(process.cwd()),
      model: stub.model,
      modelRuntime: stub.modelRuntime,
      spawnProcess: fakeSpawn([
        JSON.stringify({ type: "message_end", message: { role: "user", content: "task" } }),
        assistantLine("scout done", { input: 30, output: 12, totalTokens: 42 }),
      ]).spawnFn,
    });
    const handle = await adapter.startSession(startOptions());

    const result = await adapter.spawnSubagent(handle, { prompt: "go scout", tools: ["read", "grep"], model: "fast-model" });
    expect(result.text).toBe("scout done");
    expect(result.usage).toEqual({ totalTokens: 42, inputTokens: 30, outputTokens: 12, entryCount: 2 });
  });

  it("spawn 参数：--mode json -p --no-session + --model/--tools + prompt，cwd 取会话 cwd", async () => {
    const stub = await createStubModel();
    const fake = fakeSpawn([assistantLine("ok", { input: 1, output: 1, totalTokens: 2 })]);
    const adapter = createHarnessAdapter({
      sessionManager: SessionManager.inMemory(process.cwd()),
      model: stub.model,
      modelRuntime: stub.modelRuntime,
      spawnProcess: fake.spawnFn,
    });
    const handle = await adapter.startSession(startOptions({ cwd: "/tmp/subagent-cwd" }));
    await adapter.spawnSubagent(handle, { prompt: "do it", tools: ["read"], model: "m1" });

    expect(fake.calls).toHaveLength(1);
    const [invocation] = fake.calls;
    expect(invocation.cwd).toBe("/tmp/subagent-cwd");
    expect(invocation.command).toBe(process.execPath);
    const a = invocation.args;
    expect(a.slice(a.indexOf("--mode"), a.indexOf("--mode") + 2)).toEqual(["--mode", "json"]);
    expect(a).toContain("-p");
    expect(a).toContain("--no-session");
    expect(a[a.indexOf("--model") + 1]).toBe("m1");
    expect(a[a.indexOf("--tools") + 1]).toBe("read");
    expect(a[a.length - 1]).toBe("do it");
  });

  it("非零退出码：reject（回收语义：进程 close 后 promise 落定）", async () => {
    const stub = await createStubModel();
    const adapter = createHarnessAdapter({
      sessionManager: SessionManager.inMemory(process.cwd()),
      model: stub.model,
      modelRuntime: stub.modelRuntime,
      spawnProcess: fakeSpawn([], 1).spawnFn,
    });
    const handle = await adapter.startSession(startOptions());
    await expect(adapter.spawnSubagent(handle, { prompt: "boom" })).rejects.toThrow(/exited with code 1/);
  });
});

describe("动作 6 · getContextUsage → context 事件（实现 + 单测，无消费点）", () => {
  it("对话前：entryCount 回退 buildContextEntries（pi 的 2 条 setup 条目），token 全 0", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    const handle = await adapter.startSession(startOptions());
    const usage = await adapter.getContextUsage(handle);
    // pi 启动写入 model_change + thinking_level_change 两条 setup 条目（无对话条目）
    expect(usage.entryCount).toBe(2);
    expect(usage.totalTokens).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  it("对话后：usage 字段非零、entryCount = context 事件快照的消息数", async () => {
    const stub = await createStubModel();
    const adapter = newAdapter(stub);
    stub.setResponses([
      { text: "one", usage: { input: 11, output: 7, totalTokens: 18 } },
      { text: "two", usage: { input: 13, output: 9, totalTokens: 22 } },
    ]);
    const handle = await adapter.startSession(startOptions());
    await adapter.sendMessage(handle, "q1");

    const usage = await adapter.getContextUsage(handle);
    expect(usage.inputTokens).toBe(11);
    expect(usage.outputTokens).toBe(7);
    expect(usage.totalTokens).toBeGreaterThanOrEqual(18);
    // context 事件在 LLM 调用前触发：一轮对话后快照 = [user1]（assistant1 在调用之后产生）
    expect(usage.entryCount).toBe(1);
    await adapter.sendMessage(handle, "q2");
    // 第二轮调用前快照 = [user1, assistant1, user2]
    expect((await adapter.getContextUsage(handle)).entryCount).toBe(3);
  });
});

describe("6 动作纪律", () => {
  it("无第 7 个动作：实现对象可赋值给六动作纪律形状（签名无漂移）", async () => {
    const stub = await createStubModel();
    const adapter: AdapterContractShape = newAdapter(stub);
    const methods = Object.keys(adapter).sort();
    expect(methods).toEqual(
      [
        "dispose",
        "getContextUsage",
        "readSessionStream",
        "registerTool",
        "sendMessage",
        "spawnSubagent",
        "startSession",
      ].sort(),
    );
  });
});
