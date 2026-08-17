import type { ArtifactVersion } from "../domain/artifact-service";
import { splitLines } from "../domain/lcs";
import type { DiffBlock, PendingChange } from "../domain/pending-change-service";
import {
  computeBlockAnchors,
  findHeadingUp,
  firstHeadingIn,
  type BlockAnchorInfo,
} from "../audit/source-refs";
import type {
  DiffBlockPresentation,
  DiffRef,
  Presentation,
  PresentationBlock,
  Row,
} from "./types";

/**
 * presentation 构建纯函数（详细设计 §1.4「presentation 由谁构建」）：
 * 输入领域状态（PendingChange / Artifact / 版本链）→ 输出 Presentation 纯数据，
 * L2/L3 只消费；本模块零 pi import、零 IO。第一期为六类审计条目各配一个构建函数
 * （artifact_proposed 与 approval_request 共享待确认面板结构——问询发生时面板仍是待确认态）。
 */

/** 原型 .block-tag 的块类型标签（「✏️ 修改」/「➕ 新增」/「➖ 删除」）。 */
const KIND_TAG: Record<DiffBlock["kind"], string> = {
  mod: "✏️ 修改",
  add: "➕ 新增",
  del: "➖ 删除",
};

/** 就近推导不出标题时的占位（H6：heading 尽力而为）。 */
const NO_HEADING_ANCHOR = "（无就近标题）";

/**
 * 块锚显示名（原型 .block-anchor）：add 块优先取**新内容里自带的节标题**
 * （新增节的标题行本就是 add 块内容的一部分，原型「§2.3 Web 壳选型」即此形态）；
 * 其余（及 add 未带标题时）取 oldContent 从锚区间首行向上的就近标题。
 */
function resolveBlockAnchor(block: DiffBlock, anchor: BlockAnchorInfo, oldLines: string[]): string {
  if (block.kind === "add") {
    const inBlock = firstHeadingIn(block.lines);
    if (inBlock !== undefined) return inBlock;
  }
  return (
    findHeadingUp(oldLines, Math.min(anchor.lineStart, oldLines.length)) ?? NO_HEADING_ANCHOR
  );
}

/** DiffBlock → DiffBlockPresentation 底层映射（tag 按 1 基全局序号编号，对齐原型「✏️ 修改 1/5」）。 */
export function toDiffBlockPresentation(
  block: DiffBlock,
  ctx: {
    index: number;
    total: number;
    anchor?: string;
    note?: string;
    state?: DiffBlockPresentation["state"];
  },
): DiffBlockPresentation {
  return {
    blockId: block.id,
    kind: block.kind,
    tag: `${KIND_TAG[block.kind]} ${ctx.index}/${ctx.total}`,
    anchor: ctx.anchor ?? NO_HEADING_ANCHOR,
    lines: block.lines,
    ...(block.oldLines !== undefined ? { oldLines: block.oldLines } : {}),
    state: ctx.state ?? block.state,
    ...(ctx.note !== undefined ? { note: ctx.note } : {}),
  };
}

/**
 * 从 PendingChange 构建待裁决 DiffRef：锚信息与 sourceRef 共用同一重放实现
 * （computeBlockAnchors，块与编辑组一一对应不漂移）。缺省版本区间 = 提案基底 → 基底+1。
 * 仅支持 op=replace（与物化路径一致；patch 在 computeBlockAnchors 处抛 INVALID）。
 */
export function buildDiffRefFromChange(
  change: PendingChange,
  opts?: { fromVersion?: number; toVersion?: number },
): DiffRef {
  const oldLines = splitLines(change.diff.kind === "replace" ? change.diff.oldContent : "");
  const anchors = computeBlockAnchors(change);
  const total = change.diffBlocks.length;
  return {
    artifactId: change.artifactId,
    fromVersion: opts?.fromVersion ?? change.baseVersion,
    toVersion: opts?.toVersion ?? change.baseVersion + 1,
    blocks: change.diffBlocks.map((block, i) =>
      toDiffBlockPresentation(block, {
        index: i + 1,
        total,
        anchor: resolveBlockAnchor(block, anchors[i], oldLines),
      }),
    ),
  };
}

/**
 * 把已构建的提案块统一盖「未生效」态（P1-5 / S3④）：回滚后被撤销的 v4 提案块
 * 灰化标「未生效」——state: "rolledback" + note，渲染器按数据画、零领域判断。
 */
export function withRolledbackState(
  blocks: DiffBlockPresentation[],
  fromVersion: number,
): DiffBlockPresentation[] {
  return blocks.map((b) => ({ ...b, state: "rolledback", note: `未生效（v${fromVersion} 提案）` }));
}

/** 版本链抽屉行（原型 .vrow）：v4 / agent / 时间 · note。第一期无 Stage 概念，字段不造。 */
export function toVersionRows(versions: ArtifactVersion[]): Row[] {
  return versions.map((v) => ({
    key: `v${v.version}`,
    value: `agent: ${v.author}`,
    ...(v.note !== undefined ? { detail: `${v.createdAt} · ${v.note}` } : { detail: v.createdAt }),
  }));
}

/**
 * 待确认面板（artifact_proposed / approval_request 条目共用；原型初始态）：
 * 顶栏「v3 → v4」+ pending 徽章「待确认 · N 块」+ 文档内联 diff 区。
 * approval_request 写入时（ask 前）面板状态与提案落盘时相同，见 buildApprovalRequestPresentation。
 */
export function buildProposalPresentation(
  change: PendingChange,
  artifact: { title: string },
): Presentation {
  return {
    title: `📄 ${artifact.title} v${change.baseVersion} → v${change.baseVersion + 1}`,
    badges: [{ kind: "pending", text: `待确认 · ${change.diffBlocks.length} 块` }],
    body: [{ kind: "diff", diffRef: buildDiffRefFromChange(change) }],
  };
}

/**
 * approval_request 的问询面板：与提案面板同构（问询不改变面板数据，只多一条 pending 条目）。
 * CLI 汇总卡（D6 方案 A）/ Web 面板（方案 B）由两壳渲染器按同一份数据各自画法。
 */
export function buildApprovalRequestPresentation(
  change: PendingChange,
  artifact: { title: string },
): Presentation {
  return buildProposalPresentation(change, artifact);
}

/**
 * approval_response（status: resolved）的裁决横幅（原型 okBanner 写回文案）：
 * 接受 X 块 → 物化为 v{newVersion}；拒绝 Y 块 → 保留 v{baseVersion} 内容。
 */
export function buildApprovalResponseResolvedPresentation(
  change: PendingChange,
  artifact: { title: string },
  newVersion: number,
): Presentation {
  const accepted = change.diffBlocks.filter((b) => b.state === "confirmed").length;
  const rejected = change.diffBlocks.filter((b) => b.state === "rejected").length;
  const body: PresentationBlock[] = [
    {
      kind: "banner",
      tone: "ok",
      text:
        `已写回 approval_response（含逐块明细）：接受 ${accepted} 块 → 物化为 v${newVersion}；` +
        `拒绝 ${rejected} 块 → 保留 v${change.baseVersion} 内容。裁决已落入 append-only 会话日志。`,
      actions: [],
    },
  ];
  return {
    title: `📄 ${artifact.title} 当前 v${newVersion}（提案自 v${change.baseVersion}）`,
    badges: [{ kind: "ok", text: `已确认 · v${newVersion} 已物化` }],
    body,
  };
}

/**
 * approval_response（status: discarded，P1-2 discard 审计）的放弃横幅：
 * note 说明放弃原因（如「上游版本已变更，提案作废」）。
 */
export function buildApprovalResponseDiscardedPresentation(
  change: PendingChange,
  artifact: { title: string },
  note: string,
): Presentation {
  return {
    title: `📄 ${artifact.title} v${change.baseVersion} → v${change.baseVersion + 1}`,
    badges: [],
    body: [
      {
        kind: "banner",
        tone: "info",
        text: `提案已放弃（changeId=${change.id}）：${note}`,
        actions: [],
      },
    ],
  };
}

/**
 * artifact_resolved 的已确认面板（原型写回后终态）：成功横幅 + diff 终态块
 * （confirmed 块标注「sourceRef 已记」——M2a 落盘事实；rejected 块保留拒绝态）。
 */
export function buildResolvedPresentation(
  change: PendingChange,
  artifact: { title: string },
  newVersion: number,
): Presentation {
  const diffRef = buildDiffRefFromChange(change, { fromVersion: change.baseVersion, toVersion: newVersion });
  const blocks = diffRef.blocks.map((b) =>
    b.state === "confirmed" ? { ...b, note: "sourceRef 已记" } : b,
  );
  const accepted = blocks.filter((b) => b.state === "confirmed").length;
  const rejected = blocks.filter((b) => b.state === "rejected").length;
  return {
    title: `📄 ${artifact.title} 当前 v${newVersion}（提案自 v${change.baseVersion}）`,
    badges: [{ kind: "ok", text: `已确认 · v${newVersion} 已物化` }],
    body: [
      {
        kind: "banner",
        tone: "ok",
        text:
          `已写回 approval_response（含逐块明细）：接受 ${accepted} 块 → 物化为 v${newVersion}；` +
          `拒绝 ${rejected} 块 → 保留 v${change.baseVersion} 内容。裁决已落入 append-only 会话日志。`,
        actions: [],
      },
      { kind: "diff", diffRef: { ...diffRef, blocks } },
    ],
  };
}

/**
 * artifact_rollback 的回滚报告（S3④ 数据源；confirmedCount 由调用方从审计回放取，
 * P1-4 定案方案 a——「确认过 N 块」只在 artifact_resolved 条目里）。
 *
 * - undoing=false：info 横幅（撤销明细 +「查看差异 / 撤销回滚」动作）+ blocks 盖「未生效」灰化态。
 * - undoing=true：ok 横幅（正文恢复、确认块生效），blocks 原样使用（不再灰化）。
 */
export function buildRollbackReportPresentation(args: {
  artifactId: string;
  artifactTitle: string;
  fromVersion: number; // 被撤销的提案版（原型文案中的 v4）
  toVersion: number; // 回滚目标版（撤销回滚 = 恢复到该版）
  newVersion: number; // 本次动作生成的版（= fromVersion 或上一版 + 1）
  undoing: boolean;
  blockCount: number; // 被撤销提案的块数
  confirmedCount: number; // 其中确认过的块数（审计回放 acceptedBlocks 数）
  blocks?: DiffBlockPresentation[]; // 被撤销的提案块（S3④ 灰化标注）
}): Presentation {
  if (args.undoing) {
    const body: PresentationBlock[] = [
      {
        kind: "banner",
        tone: "ok",
        text:
          `已撤销回滚：v${args.newVersion} = v${args.toVersion} 内容（含你确认的 ${args.confirmedCount} 块，正文已恢复）。` +
          `回滚版 v${args.newVersion - 1} 保留在版本链上可随时再回滚。`,
        actions: [],
      },
    ];
    if (args.blocks !== undefined) {
      body.push({
        kind: "diff",
        diffRef: { artifactId: args.artifactId, fromVersion: args.fromVersion, toVersion: args.toVersion, blocks: args.blocks },
      });
    }
    return {
      title: `📄 ${args.artifactTitle} 当前 v${args.newVersion}（撤销回滚 = v${args.toVersion} 内容）`,
      badges: [{ kind: "ok", text: `当前 v${args.newVersion}（撤销回滚 = v${args.toVersion} 内容）` }],
      body,
    };
  }
  const body: PresentationBlock[] = [
    {
      kind: "banner",
      tone: "info",
      text:
        `已回滚：v${args.newVersion} = v${args.toVersion} 的内容（正文已切换）。` +
        `v${args.fromVersion} 的 ${args.blockCount} 块改动不在当前版本——其中你确认过的 ${args.confirmedCount} 块一并撤销；` +
        `版本链完整保留，操作记录已写入会话日志（appendEntry）。`,
      actions: [`查看 v${args.newVersion} ↔ v${args.fromVersion} 差异`, `撤销回滚（恢复 v${args.fromVersion} 内容）`],
    },
  ];
  if (args.blocks !== undefined) {
    body.push({
      kind: "diff",
      diffRef: {
        artifactId: args.artifactId,
        fromVersion: args.fromVersion,
        toVersion: args.newVersion,
        blocks: withRolledbackState(args.blocks, args.fromVersion),
      },
    });
  }
  return {
    title: `📄 ${args.artifactTitle} 当前 v${args.newVersion}（自 v${args.toVersion} 回滚）`,
    badges: [{ kind: "ok", text: `已回滚 · v${args.newVersion} = v${args.toVersion} 的内容` }],
    body,
  };
}

/**
 * artifact_external_resolved（H3 第六类）的处理结果横幅：
 * - merge：外部手改已转为提案，走同一条逐块确认通道（S4）。
 * - reject：拒绝采纳，物化文件恢复为当前版内容、版本链不变（H4：不生成幽灵新版本）。
 */
export function buildExternalResolvedPresentation(args: {
  artifactTitle: string;
  action: "merge" | "reject";
  note?: string;
}): Presentation {
  const text =
    args.action === "merge"
      ? `外部手改已转为提案：改动以新提案块呈现，走同一条逐块确认通道。`
      : `已拒绝采纳外部手改：物化文件已恢复为当前版内容，版本链不变（不生成新版本）。`;
  return {
    title: `📄 ${args.artifactTitle}`,
    badges: [],
    body: [
      {
        kind: "banner",
        tone: args.action === "merge" ? "info" : "ok",
        text: args.note !== undefined ? `${text}（${args.note}）` : text,
        actions: [],
      },
    ],
  };
}
