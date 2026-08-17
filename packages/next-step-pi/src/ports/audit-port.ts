import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AuditEntryPayload } from "../domain/audit/entries";
import type { AuditPort } from "../domain/gate/ports";

/** AuditPort 落点的最小依赖面（真 CLI 扩展侧经 pi.appendEntry 适配；测试用 inMemory SessionManager）。 */
export type AuditSessionManager = Pick<SessionManager, "appendCustomEntry">;

/**
 * AuditPort 的 pi 实现（详细设计 §2.3）：appendEntry 自定义条目落会话 JSONL。
 *
 * pi 的 ExtensionAPI.appendEntry(customType, data) 在内部等价于
 * SessionManager.appendCustomEntry(customType, data)——写入 type:"custom" 条目，
 * 持久化且不进 LLM 上下文（pi session-manager 文档语义，§5.3 实证）。本工厂
 * 直接落在 SessionManager 上，供 CLI 扩展与 Web 薄 server 共用（Web 经本工厂
 * 获得 AuditPort，不直接 import pi——只有 L2 import pi，B1）。
 *
 * customType 统一为 "next-step"（与条目壳字段 ns 同名）：两壳按 customType
 * 过滤本产品条目、与第三方扩展条目（其他 customType）区分；条目 kind 等
 * 专属字段全部在 data（= AuditEntryPayload 整体，含 ns / kind / ts）。
 */
export function createEntryAuditPort(sessionManager: AuditSessionManager): AuditPort {
  return {
    async append(entry: AuditEntryPayload): Promise<void> {
      sessionManager.appendCustomEntry("next-step", entry);
    },
  };
}
