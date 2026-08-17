/**
 * presentation 构建纯函数单测（T1-04 验收断言，对齐原型 managed-doc-panel 结构）：
 * - 5 块提案（1 修改 / 1 新增 / 1 删除 / 2 修改）→ Presentation 块数 / kind / tag / anchor / note
 *   与原型一致（badge「待确认 · 5 块」、tag「✏️ 修改 1/5」、anchor「§2.1 内核策略」…）。
 * - state 可表达 "rolledback"（P1-5 / S3④：回滚后 v4 提案块灰化标「未生效」）。
 * - 已确认 / 放弃 / 回滚报告 / 外部手改处理 各场景横幅与徽章。
 */
import { describe, expect, it } from "vitest";

import { buildReplacePendingChange, type PendingChange } from "../domain/pending-change-service";
import {
  buildApprovalRequestPresentation,
  buildApprovalResponseDiscardedPresentation,
  buildApprovalResponseResolvedPresentation,
  buildExternalResolvedPresentation,
  buildProposalPresentation,
  buildResolvedPresentation,
  buildRollbackReportPresentation,
  buildDiffRefFromChange,
  toDiffBlockPresentation,
  toVersionRows,
  withRolledbackState,
} from "./builders";
import type { DiffBlockPresentation, Presentation, PresentationBlock } from "./types";

const ARTIFACT = { title: "Next-Step v2.0 · 设计文档" };

/** 原型同构的 v3 → v4 文档（5 块：1 修改 / 1 新增 / 1 删除 / 2 修改，文档顺序）。 */
const OLD_CONTENT = `# Next-Step v2.0 · 设计文档

## §2 技术选型
### §2.1 内核策略
内核跟随 pi ^0.79.0。
发行形态：npm 个人账号发布。

## §3 架构 · 一核两壳
四层分层：L0 → L1 → L2 → L3。

## §4 旧部署方案
PM2 进程守护 + Nginx 反代。
手工部署清单与回滚脚本。

## §5 验收标准
### §5.1 确认交互
AC-1 确认交互仅逐块。

## 附录 A · 引用与来源
### 附录 A.1 内核引用
上游内核：pi ^0.79.0。`;

const NEW_CONTENT = `# Next-Step v2.0 · 设计文档

## §2 技术选型
### §2.1 内核策略
内核 fork 0.84.2 为基线。
发行形态：npm 个人账号发布。

### §2.3 Web 壳选型
Web 壳完全自建薄壳。

## §3 架构 · 一核两壳
四层分层：L0 → L1 → L2 → L3。

## §5 验收标准
### §5.1 确认交互
AC-1 确认交互分档：整块收 / 逐块 / 混合。

## 附录 A · 引用与来源
### 附录 A.1 内核引用
上游内核：pi 0.84.2（fork 基线）。`;

function buildChange(): PendingChange {
  return buildReplacePendingChange({
    artifactId: "a1",
    sourceActor: "designer",
    oldContent: OLD_CONTENT,
    newContent: NEW_CONTENT,
    baseVersion: 3,
  });
}

/** 物化成功后的现场：块 0/1/3 confirmed，块 2/4 rejected（3 收 2 拒）。 */
function settleChange(): PendingChange {
  const change = buildChange();
  const states = ["confirmed", "confirmed", "rejected", "confirmed", "rejected"] as const;
  change.diffBlocks.forEach((b, i) => (b.state = states[i]));
  return change;
}

type BannerBlock = Extract<PresentationBlock, { kind: "banner" }>;

/** 取正文里的 diff 块列表（无 diff 区则测试失败）。 */
function diffBlocks(p: Presentation): DiffBlockPresentation[] {
  for (const block of p.body) {
    if (block.kind === "diff") return block.diffRef.blocks;
  }
  throw new Error("presentation 无 diff 区");
}

/** 取正文里的第一个横幅（无横幅则测试失败）。 */
function banner(p: Presentation): BannerBlock {
  for (const block of p.body) {
    if (block.kind === "banner") return block;
  }
  throw new Error("presentation 无横幅");
}

describe("buildProposalPresentation · 5 块提案（与原型结构一致）", () => {
  const change = buildChange();
  const p = buildProposalPresentation(change, ARTIFACT);

  it("顶栏：title 含版本区间，徽章「待确认 · 5 块」（原型 .doc-title / .badge.pending）", () => {
    expect(p.title).toBe("📄 Next-Step v2.0 · 设计文档 v3 → v4");
    expect(p.badges).toEqual([{ kind: "pending", text: "待确认 · 5 块" }]);
  });

  it("正文 = 一个 diff 区；DiffRef 版本区间 = 基底 → 基底+1", () => {
    expect(p.body).toHaveLength(1);
    expect(p.body[0]).toMatchObject({ kind: "diff" });
    const diff = p.body[0];
    if (diff?.kind === "diff") {
      expect(diff.diffRef).toMatchObject({ artifactId: "a1", fromVersion: 3, toVersion: 4 });
      expect(diff.diffRef.blocks).toHaveLength(5);
    }
  });

  it("块 kind 序列 = 1 修改 / 1 新增 / 1 删除 / 2 修改（文档顺序）", () => {
    expect(diffBlocks(p).map((b) => b.kind)).toEqual(["mod", "add", "del", "mod", "mod"]);
  });

  it("tag = 原型 .block-tag 格式（emoji + 中文 + 全局序号/总数）", () => {
    expect(diffBlocks(p).map((b) => b.tag)).toEqual([
      "✏️ 修改 1/5",
      "➕ 新增 2/5",
      "➖ 删除 3/5",
      "✏️ 修改 4/5",
      "✏️ 修改 5/5",
    ]);
  });

  it("anchor = 原型 .block-anchor（就近节标题；新增节取新内容自带标题）", () => {
    expect(diffBlocks(p).map((b) => b.anchor)).toEqual([
      "§2.1 内核策略",
      "§2.3 Web 壳选型",
      "§4 旧部署方案",
      "§5.1 确认交互",
      "附录 A.1 内核引用",
    ]);
  });

  it("lines / oldLines：mod 并排新旧行，del 存旧行，add 存新行；提案态无 note、state 全 pending", () => {
    const blocks = diffBlocks(p);
    expect(blocks[0]).toMatchObject({
      lines: ["内核 fork 0.84.2 为基线。"],
      oldLines: ["内核跟随 pi ^0.79.0。"],
      state: "pending",
    });
    expect(blocks[1].lines[0]).toBe("### §2.3 Web 壳选型");
    expect(blocks[1].oldLines).toBeUndefined();
    expect(blocks[2].lines).toEqual([
      "## §4 旧部署方案",
      "PM2 进程守护 + Nginx 反代。",
      "手工部署清单与回滚脚本。",
      "",
    ]);
    expect(blocks.every((b) => b.note === undefined && b.state === "pending")).toBe(true);
  });
});

describe("buildApprovalRequestPresentation", () => {
  it("与提案面板同构（问询不改变面板数据，P1-3：ask 前写入）", () => {
    const change = buildChange();
    expect(buildApprovalRequestPresentation(change, ARTIFACT)).toEqual(
      buildProposalPresentation(change, ARTIFACT),
    );
  });
});

describe("buildApprovalResponseResolvedPresentation", () => {
  it("裁决横幅：接受/拒绝块数与版本区间（原型 okBanner 文案）", () => {
    const p = buildApprovalResponseResolvedPresentation(settleChange(), ARTIFACT, 4);
    expect(p.badges).toEqual([{ kind: "ok", text: "已确认 · v4 已物化" }]);
    const b = banner(p);
    expect(b.tone).toBe("ok");
    expect(b.text).toContain("接受 3 块 → 物化为 v4");
    expect(b.text).toContain("拒绝 2 块 → 保留 v3 内容");
    expect(b.text).toContain("裁决已落入 append-only 会话日志");
  });
});

describe("buildApprovalResponseDiscardedPresentation", () => {
  it("放弃横幅：tone info，note 说明原因（P1-2）", () => {
    const p = buildApprovalResponseDiscardedPresentation(
      buildChange(),
      ARTIFACT,
      "上游版本已变更，提案作废",
    );
    const b = banner(p);
    expect(b.tone).toBe("info");
    expect(b.text).toContain("提案已放弃");
    expect(b.text).toContain("上游版本已变更，提案作废");
  });
});

describe("buildResolvedPresentation", () => {
  it("已确认面板：ok 横幅 + 终态块；confirmed 块 note「sourceRef 已记」（M2a 落盘事实）", () => {
    const change = settleChange();
    const p = buildResolvedPresentation(change, ARTIFACT, 4);
    expect(p.title).toBe("📄 Next-Step v2.0 · 设计文档 当前 v4（提案自 v3）");
    expect(p.badges).toEqual([{ kind: "ok", text: "已确认 · v4 已物化" }]);
    expect(banner(p).text).toContain("接受 3 块 → 物化为 v4");
    const blocks = diffBlocks(p);
    expect(blocks.map((b) => b.state)).toEqual([
      "confirmed",
      "confirmed",
      "rejected",
      "confirmed",
      "rejected",
    ]);
    expect(blocks[0].note).toBe("sourceRef 已记");
    expect(blocks[2].note).toBeUndefined();
  });
});

describe("buildRollbackReportPresentation · S3④ 回滚报告", () => {
  const undoBlocks = buildDiffRefFromChange(settleChange(), { fromVersion: 3, toVersion: 4 }).blocks;

  it("回滚：info 横幅（撤销明细 + 确认数）+ 两个动作；提案块盖 rolledback「未生效」", () => {
    const p = buildRollbackReportPresentation({
      artifactId: "a1",
      artifactTitle: "设计文档.md",
      fromVersion: 4,
      toVersion: 2,
      newVersion: 5,
      undoing: false,
      blockCount: 5,
      confirmedCount: 3,
      blocks: undoBlocks,
    });
    expect(p.title).toBe("📄 设计文档.md 当前 v5（自 v2 回滚）");
    expect(p.badges).toEqual([{ kind: "ok", text: "已回滚 · v5 = v2 的内容" }]);
    const b = banner(p);
    expect(b.tone).toBe("info");
    expect(b.text).toContain("已回滚：v5 = v2 的内容");
    expect(b.text).toContain("v4 的 5 块改动不在当前版本");
    expect(b.text).toContain("确认过的 3 块一并撤销");
    expect(b.actions).toEqual(["查看 v5 ↔ v4 差异", "撤销回滚（恢复 v4 内容）"]);
    const blocks = diffBlocks(p);
    expect(blocks.every((x) => x.state === "rolledback")).toBe(true);
    expect(blocks.every((x) => x.note === "未生效（v4 提案）")).toBe(true);
  });

  it("撤销回滚：ok 横幅（正文恢复），blocks 原样不灰化", () => {
    const p = buildRollbackReportPresentation({
      artifactId: "a1",
      artifactTitle: "设计文档.md",
      fromVersion: 4,
      toVersion: 4,
      newVersion: 6,
      undoing: true,
      blockCount: 5,
      confirmedCount: 3,
      blocks: undoBlocks,
    });
    expect(p.title).toBe("📄 设计文档.md 当前 v6（撤销回滚 = v4 内容）");
    const b = banner(p);
    expect(b.tone).toBe("ok");
    expect(b.text).toContain("已撤销回滚：v6 = v4 内容");
    expect(b.text).toContain("含你确认的 3 块");
    expect(b.text).toContain("回滚版 v5 保留在版本链上");
    expect(diffBlocks(p).every((x) => x.state !== "rolledback")).toBe(true);
  });
});

describe("buildExternalResolvedPresentation · H3 第六类", () => {
  it("merge → info 横幅：转为提案走逐块确认通道", () => {
    const p = buildExternalResolvedPresentation({ artifactTitle: "设计文档.md", action: "merge" });
    const b = banner(p);
    expect(b.tone).toBe("info");
    expect(b.text).toContain("外部手改已转为提案");
  });

  it("reject → ok 横幅：恢复系统版、版本链不变；note 附注", () => {
    const p = buildExternalResolvedPresentation({
      artifactTitle: "设计文档.md",
      action: "reject",
      note: "用户确认丢弃编辑器直写",
    });
    const b = banner(p);
    expect(b.tone).toBe("ok");
    expect(b.text).toContain("已拒绝采纳外部手改");
    expect(b.text).toContain("版本链不变");
    expect(b.text).toContain("（用户确认丢弃编辑器直写）");
  });
});

describe("底层映射与行列表", () => {
  it("toDiffBlockPresentation：state / note 可覆盖（rolledback 可表达，P1-5）", () => {
    const change = buildChange();
    const block = toDiffBlockPresentation(change.diffBlocks[0], {
      index: 1,
      total: 5,
      anchor: "§2.1 内核策略",
      state: "rolledback",
      note: "未生效（v4 提案）",
    });
    expect(block).toMatchObject({
      tag: "✏️ 修改 1/5",
      anchor: "§2.1 内核策略",
      state: "rolledback",
      note: "未生效（v4 提案）",
    });
  });

  it("withRolledbackState：批量盖未生效态", () => {
    const blocks = buildDiffRefFromChange(buildChange()).blocks;
    const rolled = withRolledbackState(blocks, 4);
    expect(rolled.every((b) => b.state === "rolledback" && b.note === "未生效（v4 提案）")).toBe(true);
  });

  it("toVersionRows：版本链行 key/value/detail（第一期无 Stage 概念）", () => {
    const rows = toVersionRows([
      {
        id: "v1",
        artifactId: "a1",
        version: 3,
        content: "…",
        author: "designer",
        note: "技术选型定稿",
        createdAt: "2026-08-16T10:00:00.000Z",
      },
      { id: "v2", artifactId: "a1", version: 4, content: "…", author: "user", createdAt: "2026-08-17T10:00:00.000Z" },
    ]);
    expect(rows).toEqual([
      { key: "v3", value: "agent: designer", detail: "2026-08-16T10:00:00.000Z · 技术选型定稿" },
      { key: "v4", value: "agent: user", detail: "2026-08-17T10:00:00.000Z" },
    ]);
  });
});
