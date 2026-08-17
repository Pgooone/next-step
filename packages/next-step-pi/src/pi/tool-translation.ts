import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NextStepToolDef } from "./harness-adapter";

/**
 * L2 翻译层（正本 §5.1 动作 3 的类型侧）：NextStepToolDef（L1 纯数据）→ pi ToolDefinition。
 * 零领域判断——字段一一对应，不存在的字段按 pi 要求补齐（label = name）。
 *
 * parameters 翻译：TypeBox 的 TSchema 在运行时就是 JSON Schema 对象
 * （pi 官方 Type.Object(...) 产出的即 JSON Schema），因此 L1 的 JsonSchema 纯数据
 * 可以直接作为 parameters 传入，只需类型侧的结构化收窄（typebox 是 pi 的嵌套
 * 依赖，本包不直接依赖它，故不 import Type 构建器）。
 */
export function translateToolDef(def: NextStepToolDef): ToolDefinition<any, any, any> {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    ...(def.promptGuidelines !== undefined ? { promptGuidelines: def.promptGuidelines } : {}),
    parameters: def.parameters as unknown as ToolDefinition<any, any, any>["parameters"],
    execute: async (_toolCallId, args, signal, _onUpdate, ctx) => {
      // ctx（ExtensionContext）透传：doc 装配的 propose_edit 在 execute 内把 ctx 喂给
      // CliDecisionPort 的惰性 getContext（T1-09 形态，T1-10 接线）。
      const result = await def.execute(
        args as Record<string, unknown>,
        signal ?? new AbortController().signal,
        ctx,
      );
      return { content: result.content, details: undefined };
    },
  };
}
