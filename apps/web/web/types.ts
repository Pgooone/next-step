/**
 * 前端类型（T1-12）：与 pi `presentation/types.ts` 同构的 JSON 契约类型。
 *
 * 数据经 server JSON 序列化传递（T1-11 端点直出 L1 数据），前端零 pi import
 * （红线：渲染器「只 fetch server 端点 + 画 presentation」，L1 服务只在 server 侧）。
 * 新增条目类型 = server 返回新 payload + 本文件同步类型，渲染器零改动（通用渲染器承重实证）。
 */

/** presentation 纯数据（pi presentation/types.ts 同构）。 */
export type Presentation = {
  title: string;
  badges: PresentationBadge[];
  body: PresentationBlock[];
};

export type PresentationBadge = { kind: "pending" | "ok"; text: string };

export type PresentationBlock =
  | { kind: "diff"; diffRef: DiffRef }
  | { kind: "rows"; rows: Row[] }
  | { kind: "banner"; tone: "warn" | "info" | "ok"; text: string; actions: string[] }
  | { kind: "text"; text: string };

export type DiffRef = {
  artifactId: string;
  fromVersion: number;
  toVersion: number;
  blocks: DiffBlockPresentation[];
};

export type DiffBlockPresentation = {
  blockId: string;
  kind: "add" | "del" | "mod";
  tag: string;
  anchor: string;
  lines: string[];
  oldLines?: string[];
  state: "pending" | "confirmed" | "rejected" | "rolledback";
  note?: string;
};

export type Row = { key: string; value: string; detail?: string };

// ---------------------------------------------------------------------------
// T1-11 server 端点响应（fetch 直连的 JSON 契约）
// ---------------------------------------------------------------------------

export type ArtifactMeta = {
  id: string;
  title: string;
  kind: string;
  currentVersion: number;
  content: string;
};

export type ArtifactVersion = {
  version: number;
  author: string;
  createdAt: string;
  note?: string;
};

export type ExternalStatus = { modified: boolean; onDiskExcerpt?: string };

/** GET /api/artifacts/:id */
export type ArtifactDetail = {
  artifact: ArtifactMeta;
  versions: ArtifactVersion[];
  external: ExternalStatus;
};

export type PendingChangeDto = {
  id: string;
  artifactId: string;
  targetType: string;
  op: "replace" | "patch";
  diffBlocks: {
    id: string;
    kind: "add" | "del" | "mod";
    lines: string[];
    oldLines?: string[];
    state: "pending" | "confirmed" | "rejected";
  }[];
  sourceActor: string;
  hitlMode: "per_block" | "whole" | "auto";
  createdAt: string;
  baseVersion: number;
};

/** GET /api/artifacts/:id/pending */
export type PendingEntry = { change: PendingChangeDto; presentation: Presentation };
export type PendingResp = { changes: PendingEntry[] };

/** 审计条目 data（web-panel.jsonl 条目 data 字段的跨 kind 视图；P1-4 回滚报告取数）。 */
export type AuditEntryData = {
  kind: string;
  changeId?: string;
  artifactId?: string;
  baseVersion?: number;
  diffBlockCount?: number;
  sourceActor?: string;
  newVersion?: number;
  acceptedBlocks?: string[];
  rejectedBlocks?: string[];
  note?: string;
};

/** GET /api/audit/replay */
export type AuditReplayResp = { entries: AuditEntryData[] };

/** POST /api/artifacts/:id/rollback 与 /rollback/undo */
export type RollbackResp = { fromVersion: number; toVersion: number; newVersion: number };

/** POST resolve */
export type ResolveResp = {
  materialized: boolean;
  change: PendingChangeDto;
  artifact: ArtifactMeta | null;
};

/** 外部 diff 快照（computeReplaceDiffBlocks 产物，T1-11 external/diff）。 */
export type ExternalDiffBlock = {
  id: string;
  kind: "add" | "del" | "mod";
  lines: string[];
  oldLines?: string[];
  state: "pending" | "confirmed" | "rejected";
};

/** GET /api/artifacts/:id/external/diff */
export type ExternalDiffResp = {
  modified: boolean;
  onDiskExcerpt?: string;
  diff: ExternalDiffBlock[];
};
