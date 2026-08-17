import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { NEXTSTEP_DIR_NAME } from "../config/paths";
import { ProjectRegistry } from "./project-registry";
import { ArtifactService, type Artifact } from "./artifact-service";
import { splitLines, lcsDiff, type DiffOp } from "./lcs";

/**
 * 一个 diff 块 = 「只改了某一段」的最小单元。权威类型见 docs/03:79-86。
 * kind：add(纯新增) / del(纯删除) / mod(替换：旧行→新行)。
 * lines：该块涉及的行（add/mod 存新行，del 存旧行；mod 存新行、旧行进 oldLines 便于并排渲染）。
 * state：逐块确认状态，初始 pending；渲染层过滤 state≠pending 的块（docs/03:91）。
 */
export type DiffBlock = {
  id: string;
  kind: "add" | "del" | "mod";
  tag?: string;
  lines: string[];
  /** mod 块的旧行（add/del 块省略）；用于并排 Diff 展示「改成什么之前是什么」。 */
  oldLines?: string[];
  state: "pending" | "confirmed" | "rejected";
};

/**
 * 一次未确认的块级变更。权威类型见 docs/03:67-77。
 * op：replace(write 整文件替换) / patch(edit 局部替换)。
 * diff：原始改动数据（replace 存 {oldContent,newContent}；patch 存 edits[]），供回溯/并排。
 * sourceActor：哪个 agent 发起（D-D2-4 由工厂闭包注入，execute 的 ctx 不带身份）。
 * hitlMode：per_block 逐块确认（MVP 默认）/ whole 整体 / auto 自动。
 */
export type PendingChange = {
  id: string;
  artifactId: string;
  targetType: string;
  op: "replace" | "patch";
  diff: PendingChangeDiff;
  diffBlocks: DiffBlock[];
  sourceActor: string;
  hitlMode: "per_block" | "whole" | "auto";
  createdAt: string;
};

/** 原始改动数据：replace 携整文件新旧内容；patch 携 edit 列表。 */
export type PendingChangeDiff =
  | { kind: "replace"; oldContent: string; newContent: string }
  | { kind: "patch"; edits: { oldText: string; newText: string }[] };

/** 领域错误：code 由 API 层映射为 HTTP 状态（NOT_FOUND→404 / INVALID→422）。 */
export class PendingChangeError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "PendingChangeError";
  }
}

// ---------------------------------------------------------------------------
// 切块纯函数（聚块 → DiffBlock）。行级 LCS 算法（splitLines/lcsDiff/DiffOp）已抽到
// 无 node 依赖的 ./lcs，与内联渲染端 anchor.ts 共用同一实现（D-R7B-04）；这样既保证
// block.id 与 ops 对齐不漂移，又避免 server-only 链（node:fs）经 anchor 的值导入被拖进
// 客户端 bundle（第七轮·第二轮 bugfix）。
// ---------------------------------------------------------------------------

function makeBlock(
  kind: DiffBlock["kind"],
  lines: string[],
  oldLines?: string[],
): DiffBlock {
  return {
    id: randomUUID(),
    kind,
    lines,
    ...(oldLines !== undefined ? { oldLines } : {}),
    state: "pending",
  };
}

/**
 * 把 LCS 编辑序列聚成 DiffBlock 列表：
 * - 连续 del 段后紧跟连续 add 段 → 合并为一个 mod 块（lines=新行, oldLines=旧行）。
 * - 仅 del 段 → del 块；仅 add 段 → add 块。
 * - equal 段不产出块（未改动的行不进 PendingChange）。
 */
function groupOpsToBlocks(ops: DiffOp[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === "equal") {
      k++;
      continue;
    }
    // 收集一段连续的 del
    const dels: string[] = [];
    while (k < ops.length && ops[k].type === "del") {
      dels.push(ops[k].line);
      k++;
    }
    // 收集紧跟的一段连续 add
    const adds: string[] = [];
    while (k < ops.length && ops[k].type === "add") {
      adds.push(ops[k].line);
      k++;
    }
    if (dels.length > 0 && adds.length > 0) {
      blocks.push(makeBlock("mod", adds, dels));
    } else if (dels.length > 0) {
      blocks.push(makeBlock("del", dels));
    } else if (adds.length > 0) {
      blocks.push(makeBlock("add", adds));
    }
  }
  return blocks;
}

/**
 * write（整文件替换）的切块：旧全文 vs 新全文 → 行级 diff → 聚块。
 * 内容完全相同 → 空块数组（无改动，调用方据此决定是否仍建 PendingChange）。
 */
export function computeReplaceDiffBlocks(oldContent: string, newContent: string): DiffBlock[] {
  return groupOpsToBlocks(lcsDiff(splitLines(oldContent), splitLines(newContent)));
}

/**
 * edit（局部替换）的切块：每个 {oldText,newText} 是一处独立改动，逐个切块。
 * 单个 edit 内部仍跑行级 diff（oldText 多行→newText 多行也能精确到行），
 * 再把该 edit 产出的块拼进总列表（保持 edit 顺序）。
 */
export function computeEditDiffBlocks(edits: { oldText: string; newText: string }[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  for (const e of edits) {
    blocks.push(...computeReplaceDiffBlocks(e.oldText, e.newText));
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 部分确认重建：applyResolvedBlocks（D4，§5.5「部分块确认部分拒绝」→ 重算新内容）
// ---------------------------------------------------------------------------

/**
 * 按逐块 state 从原文重建新内容（D4 核心纯函数）。
 *
 * 不在 DiffBlock 里存行号，而是**重放生成 diffBlocks 时的同一切块过程**：对 oldContent / newContent
 * 重跑 lcsDiff + 同一聚块循环，得到与 `change.diffBlocks` 一一对应、同序的「编辑组」，再按各块 state 取舍——
 * - equal 行：恒保留（未改动的正文）。
 * - confirmed：应用本块（add 块插新行 / del 块删旧行 / mod 块旧→新）。
 * - rejected / pending：保持原样（del/mod 留旧行；add 块不插）。
 *
 * 不变量（见单测）：全块 confirmed → 必等 newContent；全块 rejected/pending → 必等 oldContent。
 * 仅支持 op="replace"（MVP 唯一拦截路径，D-D2-5）；op="patch" 抛 INVALID。
 *
 * 健壮性：重算出的编辑组数若与 `diffBlocks.length` 不符（diffBlocks 与 diff 失配，理论不应发生），
 * 抛 INVALID 而非静默错配，避免按错位的 state 重建出污染内容。
 */
export function applyResolvedBlocks(change: PendingChange): string {
  if (change.diff.kind !== "replace") {
    throw new PendingChangeError("INVALID", `applyResolvedBlocks 仅支持 op=replace，收到 ${change.op}`);
  }
  const oldLines = splitLines(change.diff.oldContent);
  const ops = lcsDiff(oldLines, splitLines(change.diff.newContent));

  const out: string[] = [];
  let blockIdx = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === "equal") {
      out.push(ops[k].line);
      k++;
      continue;
    }
    // 一个「连续 del 段 + 紧跟连续 add 段」= 一个块（与 groupOpsToBlocks 对齐）
    const dels: string[] = [];
    while (k < ops.length && ops[k].type === "del") dels.push(ops[k++].line);
    const adds: string[] = [];
    while (k < ops.length && ops[k].type === "add") adds.push(ops[k++].line);

    const block = change.diffBlocks[blockIdx++];
    if (!block) {
      throw new PendingChangeError("INVALID", "diffBlocks 与 diff 失配：编辑组多于块数");
    }
    // confirmed → 取新行（adds，del 块为空）；否则保持原样 → 取旧行（dels，add 块为空）
    out.push(...(block.state === "confirmed" ? adds : dels));
  }
  if (blockIdx !== change.diffBlocks.length) {
    throw new PendingChangeError("INVALID", "diffBlocks 与 diff 失配：块数多于编辑组");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// PendingChange 组装 + 落盘
// ---------------------------------------------------------------------------

/** 组装一个 replace（write 拦截）PendingChange，不落盘（落盘由 store）。 */
export function buildReplacePendingChange(args: {
  artifactId: string;
  sourceActor: string;
  oldContent: string;
  newContent: string;
  hitlMode?: PendingChange["hitlMode"];
}): PendingChange {
  return {
    id: randomUUID(),
    artifactId: args.artifactId,
    targetType: "artifact",
    op: "replace",
    diff: { kind: "replace", oldContent: args.oldContent, newContent: args.newContent },
    diffBlocks: computeReplaceDiffBlocks(args.oldContent, args.newContent),
    sourceActor: args.sourceActor,
    hitlMode: args.hitlMode ?? "per_block",
    createdAt: new Date().toISOString(),
  };
}

/** 组装一个 patch（edit 拦截）PendingChange，不落盘（落盘由 store）。 */
export function buildPatchPendingChange(args: {
  artifactId: string;
  sourceActor: string;
  edits: { oldText: string; newText: string }[];
  hitlMode?: PendingChange["hitlMode"];
}): PendingChange {
  return {
    id: randomUUID(),
    artifactId: args.artifactId,
    targetType: "artifact",
    op: "patch",
    diff: { kind: "patch", edits: args.edits },
    diffBlocks: computeEditDiffBlocks(args.edits),
    sourceActor: args.sourceActor,
    hitlMode: args.hitlMode ?? "per_block",
    createdAt: new Date().toISOString(),
  };
}

/**
 * PendingChange 存储：随受管 artifact 落盘到 `<projectRoot>/.nextstep/artifacts/managed/<artifactId>/pending/<id>.json`，
 * 与 D1 的 `artifact.json` / `versions/<n>.json` 平级隔离（D-D2-3）。
 * 仿 dispatch-store 的「临时文件 + rename」原子写，单进程单用户、无 DB。
 * projectRoot 经注入的 ProjectRegistry 反查（project 不存在时 registry 抛 ProjectError NOT_FOUND）。
 */
export class PendingChangeStore {
  private readonly artifactService: ArtifactService;

  constructor(
    private readonly registry: ProjectRegistry = new ProjectRegistry(),
    artifactService?: ArtifactService,
  ) {
    // 物化新版本需读当前内容 / submitVersion；默认与本 store 共用同一 registry。
    this.artifactService = artifactService ?? new ArtifactService(registry);
  }

  /** `<projectRoot>/.nextstep/artifacts/managed/<artifactId>/pending`。 */
  private pendingDir(projectId: string, artifactId: string): string {
    return join(
      this.registry.get(projectId).root,
      NEXTSTEP_DIR_NAME,
      "artifacts",
      "managed",
      artifactId,
      "pending",
    );
  }

  private pendingPath(projectId: string, artifactId: string, id: string): string {
    return join(this.pendingDir(projectId, artifactId), `${id}.json`);
  }

  /** 落盘一条 PendingChange（原子写）。返回落盘的同一对象。 */
  save(projectId: string, change: PendingChange): PendingChange {
    const dir = this.pendingDir(projectId, change.artifactId);
    mkdirSync(dir, { recursive: true });
    this.atomicWrite(
      this.pendingPath(projectId, change.artifactId, change.id),
      `${JSON.stringify(change, null, 2)}\n`,
    );
    return change;
  }

  /**
   * 列某 artifact 下所有 PendingChange（扫 `pending/*.json`），供 ArtifactPanel 只读渲染。
   * pending 目录不存在（无任何待确认变更）→ 空数组（无变更是正常态，不抛错）。
   * 解析失败的条目跳过（不因单个坏文件拖垮整列表）；按 createdAt 升序便于稳定展示。
   */
  listPendingChanges(projectId: string, artifactId: string): PendingChange[] {
    const dir = this.pendingDir(projectId, artifactId); // registry.get 不存在 → ProjectError NOT_FOUND
    if (!existsSync(dir)) return [];
    const changes: PendingChange[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        changes.push(JSON.parse(readFileSync(join(dir, entry.name), "utf-8")) as PendingChange);
      } catch {
        // 跳过坏掉的 pending json，不让单个解析失败拖垮整列表
      }
    }
    changes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return changes;
  }

  /**
   * 逐块确认/拒绝（D4，§5.5）：把指定块的 state 置为 confirmed/rejected 后原子落盘，返回更新后的 PendingChange。
   * 契约 action 仅 confirm/reject（docs/04:25）；blockId 省略时对**全部尚为 pending 的块**统一置态
   * （满足「整体接受/拒绝」的便捷路径）。已 resolve 的块（state≠pending）幂等跳过，不回退已决状态。
   * blockId 给定但块不存在 → NOT_FOUND。
   */
  resolveBlock(
    projectId: string,
    artifactId: string,
    id: string,
    input: { blockId?: string; action: "confirm" | "reject" },
  ): PendingChange {
    const change = this.get(projectId, artifactId, id);
    const nextState: DiffBlock["state"] = input.action === "confirm" ? "confirmed" : "rejected";

    if (input.blockId !== undefined) {
      const block = change.diffBlocks.find((b) => b.id === input.blockId);
      if (!block) {
        throw new PendingChangeError("NOT_FOUND", `diff 块不存在: ${input.blockId}`);
      }
      block.state = nextState;
    } else {
      for (const block of change.diffBlocks) {
        if (block.state === "pending") block.state = nextState;
      }
    }

    this.atomicWrite(
      this.pendingPath(projectId, artifactId, id),
      `${JSON.stringify(change, null, 2)}\n`,
    );
    return change;
  }

  /** 删除一条 PendingChange（全块 resolve、内容已物化为新版后清理；不存在则静默）。 */
  remove(projectId: string, artifactId: string, id: string): void {
    const path = this.pendingPath(projectId, artifactId, id);
    if (existsSync(path)) rmSync(path);
  }

  /**
   * 逐块 resolve + 「全决则物化新版本」一步到位（D4，§5.5 AC⑤；写盘红线守门）。
   *
   * 先 `resolveBlock` 翻块 state；翻完后若该条 PendingChange **全部块非 pending**（D-D4-4「一组」=单条），
   * 则 `applyResolvedBlocks` 重建内容 → `ArtifactService.submitVersion`（If-Match 取当前 version 乐观锁）
   * 出新版 → `remove` 删该 pending（pending 目录只放未决，D-D4-5 倾向删）。**写盘只在此处发生**，
   * 路由层退成薄调用——杜绝「编辑工具直接写盘 / 未全决就写盘」，且本步可单测（注入 ArtifactService）。
   *
   * 返回 `{ change, materialized, artifact? }`：materialized=是否已出新版；物化时附新 Artifact 供前端刷新。
   */
  resolveAndMaterialize(
    projectId: string,
    artifactId: string,
    id: string,
    input: { blockId?: string; action: "confirm" | "reject" },
  ): { change: PendingChange; materialized: boolean; artifact?: Artifact } {
    const change = this.resolveBlock(projectId, artifactId, id, input);

    const allResolved = change.diffBlocks.every((b) => b.state !== "pending");
    if (!allResolved) {
      return { change, materialized: false };
    }

    const newContent = applyResolvedBlocks(change);
    const current = this.artifactService.getArtifact(projectId, artifactId); // 取当前 version 作 If-Match
    const artifact = this.artifactService.submitVersion(projectId, artifactId, {
      content: newContent,
      note: `apply pending ${id}`,
      ifMatch: current.version,
    });
    this.remove(projectId, artifactId, id);
    return { change, materialized: true, artifact };
  }

  /** 精确读一条 PendingChange；不存在抛 NOT_FOUND。 */
  get(projectId: string, artifactId: string, id: string): PendingChange {
    const path = this.pendingPath(projectId, artifactId, id);
    if (!existsSync(path)) {
      throw new PendingChangeError("NOT_FOUND", `pending change 不存在: ${id}`);
    }
    const raw = readFileSync(path, "utf-8");
    try {
      return JSON.parse(raw) as PendingChange;
    } catch {
      throw new PendingChangeError("INVALID", `pending change 解析失败: ${path}`);
    }
  }

  /** 「临时文件 + rename」原子落盘（仿 dispatch-store.atomicWrite）。 */
  private atomicWrite(filePath: string, content: string): void {
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, filePath);
  }
}
