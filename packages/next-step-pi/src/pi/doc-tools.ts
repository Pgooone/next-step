import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ArtifactService } from "../domain/domain/artifact-service";
import { ProjectRegistry } from "../domain/domain/project-registry";
import {
  computeReplaceDiffBlocks,
  PendingChangeStore,
  type PendingChange,
} from "../domain/domain/pending-change-service";
import { lcsDiff, splitLines } from "../domain/domain/lcs";
import { computeBlockAnchors } from "../domain/audit/source-refs";
import type { AuditPort, DecisionPort } from "../domain/gate/ports";
import { proposeWithGate, type ProposalOutcome } from "../domain/gate/pending-gate-service";
import type { NextStepToolDef, NextStepToolResult } from "./harness-adapter";

/**
 * T1-10 · 六工具注册表（详细设计 §4）——doc 会话的全部受管产物能力：
 *
 * - **提议三件套**（旧仓 doc-tools.ts 搬 + 改）：create_artifact / propose_edit / list_artifacts。
 *   propose_edit 的 execute 改为调 L1 闸门编排 proposeWithGate（T1-05）——落 baseVersion 正确的
 *   PendingChange → CliDecisionPort 逐块问询 → 全决物化 → 审计条目（approval_response /
 *   artifact_resolved 含 sourceRefs，M2a）；「完整新全文」promptGuidelines 双通道约束原样保留
 *   （旧仓 :166-168）；取消路径返回「已提案未确认，changeId=…，可用 Web 面板或重试处理」
 *   （P1-1①）；有未决 / 无变化时返回语义保留（旧仓 :178-192）。
 * - **只读三件套**（新写）：get_artifact_diff / list_my_artifacts / get_artifact_history——
 *   AC-1.4：执行路径零 pendingStore.save / submitVersion / rollback 调用，零审计写入。
 *
 * 返回统一 `{ content: [{ type: "text", text: JSON }] }`（模型唯一真读通道，旧仓 jsonResult 范式）；
 * 错误不抛未捕获，转文本返回（旧仓 errorResult 范式）。
 *
 * 闭包注入范式沿用旧仓 :44-51 DocToolDeps：projectId / sourceActor 在装配期注入
 * （execute 的 ctx 不带身份）；decisionPort / auditPort 为 L1 闸门依赖（详细设计 §2）。
 */

/** 工具工厂依赖（旧仓 :44-51 DocToolDeps 范式 + 闸门端口；后端可注入供 hermetic 测试）。 */
export type DocToolDeps = {
  /** 当前项目（提议工具按 id 操作受管文档时定位项目）。 */
  projectId: string;
  /** 哪个 agent 发起（写进 version.author / PendingChange.sourceActor / list_my_artifacts「名下」）。 */
  sourceActor: string;
  /** 闸门裁决端口（T1-09 CliDecisionPort；装配时经惰性 getContext 注入 execute 的 ctx）。 */
  decisionPort: DecisionPort;
  /** 审计条目写回（T1-07 AuditPort 的 pi 实现 = 会话 JSONL）。 */
  auditPort: AuditPort;
  artifactService?: ArtifactService;
  pendingStore?: PendingChangeStore;
  /**
   * execute 时点的 ExtensionContext 透出（T1-10）：装配方把 ctx 存进可变闭包，
   * 供 createCliDecisionPort(getContext) 惰性取用——决策交互画法在工具执行内可用。
   */
  onToolContext?: (ctx: ExtensionContext | undefined) => void;
};

/** 成功返回：结构化结果 JSON 化进 text content（模型唯一真读的通道）。 */
function jsonResult(payload: unknown): NextStepToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * 把工具执行中抛出的错误转成给模型看的 content text（而非让未捕获异常炸会话）。
 * artifactService/pendingStore/gate 可能抛 ArtifactError / PendingChangeError / GateError
 * （id 不存在=NOT_FOUND 等）——返回带错误说明的文本，让 agent 知道失败原因、能改正。
 */
function errorResult(action: string, e: unknown): NextStepToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return jsonResult({ error: `${action}失败：${message}` });
}

// ---------------------------------------------------------------------------
// 六个工具的 JSON Schema（JsonSchema 纯数据 = TypeBox 对象的 JSON 形态，
// 旧仓实证 parameters 用 typebox（doc-tools.ts:74-83）；T1-07 已定 JsonSchema 纯数据直传 pi）
// ---------------------------------------------------------------------------
const createArtifactSchema = {
  type: "object",
  properties: {
    kind: { type: "string" },
    title: { type: "string" },
    content: { type: "string" },
  },
  required: ["kind", "title", "content"],
} as const;

const proposeEditSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    newContent: { type: "string" },
  },
  required: ["id", "newContent"],
} as const;

const getArtifactDiffSchema = {
  type: "object",
  properties: {
    artifactId: { type: "string" },
    fromVersion: { type: "number" },
    toVersion: { type: "number" },
  },
  required: ["artifactId"],
} as const;

const listArtifactsSchema = { type: "object", properties: {} } as const;
const listMyArtifactsSchema = { type: "object", properties: {} } as const;

const getArtifactHistorySchema = {
  type: "object",
  properties: {
    artifactId: { type: "string" },
  },
  required: ["artifactId"],
} as const;

/**
 * 解析后端依赖（旧仓 :91-102 resolveBackends 原样搬）：默认文件后端、半注入防护——
 * 默认 pendingStore 与上行 artifactService 同源（同一 registry），消除
 * 「只注 artifactService 省 pendingStore → 读不到对方落的数据」footgun 的一半爆炸半径。
 */
function resolveBackends(deps: DocToolDeps): {
  artifactService: ArtifactService;
  pendingStore: PendingChangeStore;
} {
  const registry = new ProjectRegistry();
  const artifactService = deps.artifactService ?? new ArtifactService(registry);
  const pendingStore = deps.pendingStore ?? new PendingChangeStore(registry, artifactService);
  return { artifactService, pendingStore };
}

// ---------------------------------------------------------------------------
// 提议三件套（旧仓搬 + 改）
// ---------------------------------------------------------------------------

/** create_artifact：原样搬（旧仓 :105-142；registry 换 .nextstep 目录由 L1 服务承接）。 */
function makeCreateArtifactTool(
  projectId: string,
  sourceActor: string,
  artifactService: ArtifactService,
): NextStepToolDef {
  return {
    name: "create_artifact",
    description:
      "新建一个受管文档（如需求/PRD/设计），直接落第一版并物化成项目里的真实 .md 文件。" +
      "参数 kind（文档类型，如 crd/prd/design）、title（标题，将作为文件名）、content（首版完整正文）。" +
      "返回新文档的 id（后续 propose_edit 改它时用）、filePath、version。",
    parameters: createArtifactSchema,
    async execute(args) {
      try {
        const artifact = artifactService.createArtifact(projectId, {
          kind: String(args.kind ?? ""),
          title: String(args.title ?? ""),
          content: String(args.content ?? ""),
          author: sourceActor,
        });
        return jsonResult({
          id: artifact.id,
          filePath: artifact.filePath,
          version: artifact.currentVersion,
        });
      } catch (e) {
        return errorResult("创建文档", e);
      }
    },
  };
}

/**
 * propose_edit：改造（旧仓 :144-214）——execute 调 proposeWithGate（T1-05）。
 * 「完整新全文」promptGuidelines 双通道约束原样保留（旧仓 :166-168）。
 */
function makeProposeEditTool(
  deps: DocToolDeps,
  artifactService: ArtifactService,
  pendingStore: PendingChangeStore,
): NextStepToolDef {
  const gateDeps = {
    artifactService,
    pendingStore,
    decisionPort: deps.decisionPort,
    auditPort: deps.auditPort,
    via: "cli-keyboard" as const,
  };
  return {
    name: "propose_edit",
    description:
      "对一个【已存在】的受管文档提议一次修改：不直接写盘，而是转成待确认变更（PendingChange），" +
      "由用户在界面上逐块确认 ✓/✗ 后才生成新版本。" +
      "参数 id（目标文档 id，用 list_artifacts 查；用户若用标题/文件名指代，请先 list_artifacts 按 title 挑出 id）、" +
      "newContent。" +
      "⚠️ newContent 必须是【完整的新全文】：未改动的段落必须逐字保留、不得改写或省略未提及的内容。" +
      "系统用 LCS 只把真正变化的块切出来给用户确认，所以你内部仍要回整篇；若回残篇/片段，" +
      "其余正文会被判为删除、造成满屏噪声。" +
      "返回 changeId（无变化时为 null）、diffBlockCount、note。",
    // promptGuidelines（D-V2-09，对抗 review 加固）：把 coreIssue 命门（整篇 vs 残篇）的硬约束
    // 同时挂到系统提示层、工具激活期常驻，与逐 call 的 description 形成双通道冗余。
    promptGuidelines: [
      "调用 propose_edit 时 newContent 必须是【完整的新全文】：未改动段落逐字保留，禁止只回片段/残篇，否则其余正文会被判为删除、造成满屏噪声。",
    ],
    parameters: proposeEditSchema,
    async execute(args, _signal, ctx) {
      try {
        // execute 时点的 ctx 透给 CliDecisionPort 的惰性 getContext（T1-09 形态接线）。
        deps.onToolContext?.(ctx);
        const outcome = await proposeWithGate(gateDeps, deps.projectId, {
          artifactId: String(args.id ?? ""),
          newContent: String(args.newContent ?? ""),
          sourceActor: deps.sourceActor,
        });
        return jsonResult(proposeResult(outcome));
      } catch (e) {
        // 常见：id 不存在 → readCurrentContent 抛 NOT_FOUND。提示 agent 先 list_artifacts 核对 id。
        return errorResult("提议修改（请确认 id 是否正确，可先用 list_artifacts 核对）", e);
      }
    },
  };
}

/**
 * ProposalOutcome → §4 工具契约 { changeId | null, diffBlockCount, note }：
 * - materialized / unconfirmed / deferred → changeId 实际值（note 承载取消/等待语义）。
 * - pending_exists / no_change → changeId: null（旧仓 :178-192 语义：null = 已有未决 / 无变化）。
 */
function proposeResult(outcome: ProposalOutcome): {
  changeId: string | null;
  diffBlockCount: number;
  note: string;
} {
  switch (outcome.status) {
    case "materialized":
    case "unconfirmed":
    case "deferred":
      return {
        changeId: outcome.changeId,
        diffBlockCount: outcome.diffBlockCount,
        note: outcome.message,
      };
    case "pending_exists":
    case "no_change":
      return {
        changeId: null,
        diffBlockCount: outcome.diffBlockCount,
        note: outcome.message,
      };
  }
}

/** list_artifacts：原样搬（旧仓 :216-252）。 */
function makeListArtifactsTool(projectId: string, artifactService: ArtifactService): NextStepToolDef {
  return {
    name: "list_artifacts",
    description:
      "列出当前项目里所有受管文档（只读）。用户用标题/文件名指代某文档、而你需要它的 id 时，" +
      "先用本工具按 title 挑出对应的 id，再 propose_edit。" +
      "返回 [{ id, title, kind, currentVersion, filePath }]（filePath 是相对项目根的路径，可用 read 工具读该文档正文；旧文档可能无 filePath）。",
    parameters: listArtifactsSchema,
    async execute() {
      try {
        const artifacts = artifactService.listArtifacts(projectId);
        return jsonResult(
          // filePath（相对项目根）透传：模型按需用 read 工具读正文（轻读，非全量拼接）。
          artifacts.map((a) => ({
            id: a.id,
            title: a.title,
            kind: a.kind,
            currentVersion: a.currentVersion,
            filePath: a.filePath,
          })),
        );
      } catch (e) {
        return errorResult("列出文档", e);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 只读三件套（新写，AC-1.1 / AC-1.4）
// ---------------------------------------------------------------------------

/**
 * get_artifact_diff（新写，详设 §4 #4）：读 versions 快照 → lcsDiff → groupOpsToBlocks，
 * 与 PendingChange 同一切块实现——块数天然一致（AC-1.2）。行号与 sourceRef 共用
 * computeBlockAnchors 唯一实现（构造轻量 PendingChange 重放，零重复算法）。
 *
 * 缺省参数 = 相邻上一版 → 当前版；边界（P2-9）：currentVersion=1 无上一版 →
 * 空 blocks + note「无上一版本可对比」。零 pending / 版本副作用（AC-1.4）。
 */
function makeGetArtifactDiffTool(projectId: string, artifactService: ArtifactService): NextStepToolDef {
  return {
    name: "get_artifact_diff",
    description:
      "读取某受管文档两个版本之间的差异（只读，不产生任何变更）：" +
      "参数 artifactId（目标文档 id）、fromVersion / toVersion（可选，缺省 = 相邻上一版 → 当前版）。" +
      "返回 { artifactId, fromVersion, toVersion, blocks }——blocks 为改动块数组，每块含 " +
      "kind（add/del/mod）、lines（add/mod 为新行、del 为旧行）、oldLines（仅 mod）、" +
      "lineStart / lineEnd（基于旧版内容的 1 基行区间）。首版（无上一版）返回空 blocks。",
    parameters: getArtifactDiffSchema,
    async execute(args) {
      try {
        const id = String(args.artifactId ?? "");
        const artifact = artifactService.getArtifact(projectId, id);
        // 缺省 = 相邻上一版 → 当前版；currentVersion=1 无上一版 → 边界（P2-9）
        if (args.fromVersion === undefined && artifact.currentVersion === 1) {
          return jsonResult({
            artifactId: id,
            fromVersion: 1,
            toVersion: 1,
            blocks: [],
            note: "无上一版本可对比",
          });
        }
        const fromVersion =
          args.fromVersion === undefined ? artifact.currentVersion - 1 : Number(args.fromVersion);
        const toVersion = args.toVersion === undefined ? artifact.currentVersion : Number(args.toVersion);
        if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) || fromVersion < 1 || fromVersion >= toVersion) {
          return jsonResult({
            artifactId: id,
            fromVersion,
            toVersion,
            blocks: [],
            note: `版本区间无效（需 1 ≤ fromVersion < toVersion ≤ v${artifact.currentVersion}）`,
          });
        }
        const from = artifactService.getVersion(projectId, id, fromVersion); // NOT_FOUND 由外层 errorResult 兜
        const to = artifactService.getVersion(projectId, id, toVersion);
        return jsonResult(diffBetweenVersions(id, from.content, to.content, fromVersion, toVersion));
      } catch (e) {
        return errorResult("获取版本差异", e);
      }
    },
  };
}

/**
 * 两个版本内容 → §4 契约 diff 块（kind/lines/oldLines/lineStart/lineEnd）。
 * 与 PendingChange 同一实现（computeReplaceDiffBlocks + computeBlockAnchors），
 * AC-1.2 断言「get_artifact_diff(v2,v3) 块按全收应用后重建 = v3 内容」的块序/内容因此天然对齐。
 */
function diffBetweenVersions(
  artifactId: string,
  oldContent: string,
  newContent: string,
  fromVersion: number,
  toVersion: number,
): { artifactId: string; fromVersion: number; toVersion: number; blocks: unknown[] } {
  const blocks = computeReplaceDiffBlocks(oldContent, newContent);
  // 轻量 PendingChange 重放 computeBlockAnchors（行号唯一实现，source-refs.ts）：
  // 只依赖 diff + diffBlocks 两个字段，其余字段不参与计算。
  const pseudoChange = {
    id: "diff",
    artifactId,
    targetType: "artifact",
    op: "replace",
    diff: { kind: "replace", oldContent, newContent },
    diffBlocks: blocks,
    sourceActor: "",
    hitlMode: "per_block",
    createdAt: "",
    baseVersion: fromVersion,
  } as PendingChange;
  const anchors = computeBlockAnchors(pseudoChange);
  return {
    artifactId,
    fromVersion,
    toVersion,
    blocks: blocks.map((b, i) => ({
      kind: b.kind,
      lines: b.lines,
      ...(b.oldLines !== undefined ? { oldLines: b.oldLines } : {}),
      lineStart: anchors[i].lineStart,
      lineEnd: anchors[i].lineEnd,
    })),
  };
}

/**
 * list_my_artifacts（新写，详设 §4 #5）：当前 Agent（sourceActor 闭包注入）名下产物
 * + 当前版本 + 最近改动摘要（末版 note/author/createdAt——回滚 author=user、note 格式
 * 旧仓语义保持，P3）。「名下」= create_artifact 的 sourceActor 或任一版本 author 含该 actor。
 */
function makeListMyArtifactsTool(projectId: string, sourceActor: string, artifactService: ArtifactService): NextStepToolDef {
  return {
    name: "list_my_artifacts",
    description:
      "列出当前 Agent 名下创建的受管文档（只读）：带最近改动摘要（末版 note/author/createdAt）。" +
      "「名下」= 建文档或任一版本由本 Agent 写入。" +
      "返回 [{ id, title, kind, currentVersion, filePath, lastChange: { version, note?, author, createdAt } }]。",
    parameters: listMyArtifactsSchema,
    async execute() {
      try {
        const artifacts = artifactService.listArtifacts(projectId);
        const mine: unknown[] = [];
        for (const a of artifacts) {
          const versions = artifactService.listVersions(projectId, a.id);
          if (!versions.some((v) => v.author === sourceActor)) continue;
          const last = versions[versions.length - 1];
          mine.push({
            id: a.id,
            title: a.title,
            kind: a.kind,
            currentVersion: a.currentVersion,
            filePath: a.filePath,
            lastChange: {
              version: last.version,
              ...(last.note !== undefined ? { note: last.note } : {}),
              author: last.author,
              createdAt: last.createdAt,
            },
          });
        }
        return jsonResult(mine);
      } catch (e) {
        return errorResult("列出我的文档", e);
      }
    },
  };
}

/**
 * get_artifact_history（新写，详设 §4 #6）：版本链升序 + 每版归属。
 * stage 第一期无 Stage 概念 → 字段预留省略（不造字段）。
 */
function makeGetArtifactHistoryTool(projectId: string, artifactService: ArtifactService): NextStepToolDef {
  return {
    name: "get_artifact_history",
    description:
      "读取某受管文档的完整版本链（只读，升序）：每版含 version / note? / author / createdAt。" +
      "参数 artifactId（目标文档 id）。返回 { artifactId, title, versions: [...] }。",
    parameters: getArtifactHistorySchema,
    async execute(args) {
      try {
        const id = String(args.artifactId ?? "");
        const artifact = artifactService.getArtifact(projectId, id);
        const versions = artifactService.listVersions(projectId, id); // 升序（旧仓 :257-268）
        return jsonResult({
          artifactId: id,
          title: artifact.title,
          versions: versions.map((v) => ({
            version: v.version,
            ...(v.note !== undefined ? { note: v.note } : {}),
            author: v.author,
            createdAt: v.createdAt,
          })),
        });
      } catch (e) {
        return errorResult("获取版本历史", e);
      }
    },
  };
}

/**
 * 装配六工具（闭包注入 deps）。返回顺序固定
 * [create_artifact, propose_edit, list_artifacts, get_artifact_diff, list_my_artifacts, get_artifact_history]
 * （测试断言依赖）。
 */
export function buildDocTools(deps: DocToolDeps): NextStepToolDef[] {
  const { projectId, sourceActor } = deps;
  const { artifactService, pendingStore } = resolveBackends(deps);
  return [
    makeCreateArtifactTool(projectId, sourceActor, artifactService),
    makeProposeEditTool(deps, artifactService, pendingStore),
    makeListArtifactsTool(projectId, artifactService),
    makeGetArtifactDiffTool(projectId, artifactService),
    makeListMyArtifactsTool(projectId, sourceActor, artifactService),
    makeGetArtifactHistoryTool(projectId, artifactService),
  ];
}
