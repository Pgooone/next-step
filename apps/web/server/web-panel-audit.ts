import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditEntryPayload } from "@pgoone/next-step-pi/src/domain/audit/entries.ts";

/**
 * Web 面板审计通道（T1-11，P2-1 裁量落地）——**直写固定会话文件 web-panel.jsonl**。
 *
 * ## 为什么不用 pi 的 SessionManager（前置事实 1，T1-07 §五）
 * pi 的 `_persist` 语义：**纯 custom 条目不触发 JSONL 落盘，首条 assistant 消息到场后才
 * 创建文件（此前缓冲全量补写）**。Web server 是独立进程，会话文件里永远不会出现
 * assistant 消息——若经 SessionManager 写审计，「append 后文件即刻可见」不成立，
 * 面板审计在启动后到首个对话前全部滞留内存。且构造 SessionManager 需直接 import pi
 * 包，违反「只有 L2 import pi」红线（B1 / 详设 §2.3）。故裁定**直写 JSONL**。
 *
 * ## 行格式对齐 pi（第三期跨文件合并的代价底线）
 * 本类实现 `Pick<SessionManager, "appendCustomEntry">` 签名（L2 工厂
 * `createEntryAuditPort` 只挑这个面），落盘行与 pi appendCustomEntry 产物同构：
 * `{ type:"custom", customType, data, id, parentId, timestamp }`——第三期合并审计时
 * 无需格式迁移，唯一缺口是 parentId 血缘（见下）。
 *
 * ## P2-1 裁量登记（对正本 §5.2 字面的实现裁量）
 * 正本「Web 想写就 fork(entryId) 分支」：第一期无 entry 级操作需求，固定文件替代真 fork。
 * 代价：无 parentId 血缘（parentId 恒 null）、跨文件审计合并推迟第三期（第一期不承诺）。
 * 单 writer 自守：web-panel.jsonl 唯一 writer = 本 server 进程（启动独占检查见
 * acquireWebPanelLock；单进程假设 P3）。
 */

/** 一行 web-panel.jsonl（与 pi 会话 JSONL 的 custom 条目同构，见文件头裁量登记）。 */
export type WebPanelJsonlEntry = {
  type: "custom";
  customType: string;
  data: AuditEntryPayload;
  id: string;
  parentId: string | null;
  timestamp: string;
};

/** 直写 JSONL 的审计落点：每行一个完整 custom 条目，append-only、写后立即可见。 */
export class WebPanelSessionManager {
  constructor(private readonly filePath: string) {}

  /** 对齐 `SessionManager.appendCustomEntry(customType, data)` 签名（返回条目 id）。 */
  appendCustomEntry(customType: string, data: unknown): string {
    const now = new Date().toISOString();
    const entry: WebPanelJsonlEntry = {
      type: "custom",
      customType,
      data: data as AuditEntryPayload,
      id: randomUUID(),
      parentId: null, // P2-1 裁量：固定文件无 fork 血缘
      timestamp: now,
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
    return entry.id;
  }

  /**
   * 审计回放（T1-12，P1-4 数据管线）：面板「确认过 N 块」与「撤销块数」从自家
   * web-panel.jsonl 回放取数（artifact_resolved.acceptedBlocks / artifact_proposed.diffBlockCount），
   * 非从版本 diff 重算。纯读取：逐行解析、append-only 顺序返回；文件不存在 → 空数组。
   */
  readAll(): WebPanelJsonlEntry[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line) as WebPanelJsonlEntry);
  }
}

/**
 * 单 writer 独占检查（P3）：web-panel.jsonl 同一时刻只允许一个 Web server 实例写。
 * `wx` 原子创建锁文件，已存在（另一实例在跑）→ 拒绝启动；返回释放函数（进程退出时调用）。
 * 锁文件与 web-panel.jsonl 同目录，测试每 server 独立 dataDir 互不干扰。
 */
export function acquireWebPanelLock(dataDir: string): () => void {
  const lockPath = join(dataDir, "web-panel.lock");
  mkdirSync(dataDir, { recursive: true }); // 首次启动目录可能不存在
  try {
    openSync(lockPath, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `web-panel.jsonl 单 writer 独占检查失败：锁文件已存在 ${lockPath}（P3：` +
          `第一期只允许一个 Web server 实例写审计文件，请先停止另一实例）`,
      );
    }
    throw e;
  }
  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* 退出时 best-effort 释放 */
    }
  };
}
