import type { AuditEntryPayload } from "../audit/entries";
import type { DiffBlockPresentation } from "../presentation/types";

/**
 * L1 端口接口（详细设计 §2）：闸门（pending-gate）唯一依赖的边界类型。
 * 本文件零 pi import、零 UI 依赖（B1 / §2.1 红线：L1 领域代码只依赖接口，
 * 全仓闸门代码 grep 不到任何 UI 上下文引用；CLI 交互实现由 L2 的
 * CliDecisionPort 提供，T1-09；落盘由 L2 的 pi appendEntry 实现提供，T1-07）。
 */

/** 一次裁决请求（CliDecisionPort 据此画 D6 方案 A 汇总卡；Web 端面板即方案 B 内联）。 */
export type DecisionRequest = {
  kind: "approve_blocks";
  changeId: string;
  artifactId: string;
  title: string; // 「设计文档.md」v3 → v4
  /** 待裁决块（presentation 同源，两端口画法各异）。 */
  blocks: DiffBlockPresentation[];
  mode: "block" | "whole"; // 分档（D6）
};

/**
 * 一次裁决的结果，三分支：
 * - resolved：用户全决，decisions 逐块记账（D6 红线：记账永远块级）。
 * - deferred：挂起（EntryDecisionPort 第一期语义：只记条目不阻塞）。
 * - cancelled（P1-1①）：用户取消 / abort。调用方（gate，T1-05）收到后 **pending 保留**，
 *   工具返回「已提案未确认，changeId=…，可用 Web 面板或重试处理」——pending 不删、
 *   不死锁（重新提案被「查未决」挡时的出口是 discard，P1-2）。
 */
export type Decision =
  | { status: "resolved"; decisions: { blockId: string; decision: "accept" | "reject" }[] }
  | { status: "deferred" }
  | { status: "cancelled" };

/** 裁决端口：闸门只认它，不直接碰任何 UI（§2.1 红线，代码审查项：闸门代码 grep 不到 UI 上下文引用）。 */
export interface DecisionPort {
  ask(req: DecisionRequest): Promise<Decision>;
}

/**
 * 审计端口：L1 的 pending-gate / rollback / 外部手改处理在动作发生处经它写审计条目；
 * L2 提供 pi 实现（= appendEntry 写会话 JSONL，不进 LLM 上下文，T1-07）。
 */
export interface AuditPort {
  append(entry: AuditEntryPayload): Promise<void>;
}
