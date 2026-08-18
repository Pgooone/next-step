import { existsSync, readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, isAbsolute, join, normalize } from "node:path";
import { createEntryAuditPort, type AuditSessionManager } from "@pgooone/next-step-pi/src/ports/audit-port.ts";
import {
  ArtifactError,
  ArtifactService,
} from "@pgooone/next-step-pi/src/domain/domain/artifact-service.ts";
import {
  PendingChangeError,
  PendingChangeStore,
  computeReplaceDiffBlocks,
  type DiffBlock,
} from "@pgooone/next-step-pi/src/domain/domain/pending-change-service.ts";
import { ProjectError, ProjectRegistry } from "@pgooone/next-step-pi/src/domain/domain/project-registry.ts";
import {
  checkExternalModification,
  mergeExternalAsProposal,
  rejectExternalModification,
} from "@pgooone/next-step-pi/src/domain/domain/external-modification-service.ts";
import {
  GateError,
  discardWithAudit,
  rollbackUndoWithAudit,
  rollbackWithAudit,
  type GateDeps,
} from "@pgooone/next-step-pi/src/domain/gate/pending-gate-service.ts";
import type { DecisionPort } from "@pgooone/next-step-pi/src/domain/gate/ports.ts";
import type { WebPanelJsonlEntry } from "./web-panel-audit";
import {
  buildApprovalResponse,
  buildArtifactResolved,
} from "@pgooone/next-step-pi/src/domain/audit/entries.ts";
import { buildProposalPresentation } from "@pgooone/next-step-pi/src/domain/presentation/builders.ts";

/**
 * L3 薄 server（T1-11，详细设计 §6 最小接口表 10 端点）。
 *
 * 壳零领域判断：每个端点 = 参数解析（校验用户输入）→ 直调 L1 领域服务 → 序列化返回。
 * 裁决规则 / 守卫 / 冲突全部在 L1（resolveAndMaterialize 的 baseVersion 校验、
 * rollback 的 PENDING_EXISTS 守卫、discard 的「无 pending 不可 discard」），本文件
 * 无任何 if 决策逻辑——唯一的分支是错误映射（code → HTTP 状态，序列化层职责，
 * 详设 §6 注释「code 由 API 层映射为 HTTP 状态」）与参数合法性校验（422）。
 * 写盘只发生在 L1（resolveAndMaterialize / rollback / reject 覆盖物化），server 不写
 * 领域存储；审计条目经 L2 工厂 createEntryAuditPort 落 web-panel.jsonl（写文件由
 * ./web-panel-audit 的 WebPanelSessionManager 完成，本文件不直接碰 pi）。
 *
 * 项目定位零判断：所有带 :id 的端点先调 ArtifactService.findArtifact(id) 跨项目反查
 * projectId（L1 提供），server 不做任何「该 artifact 属于哪个项目」的判断。
 */

/** Web server 依赖（全部可注入，测试用临时目录后端；生产装配见 ./index.ts）。 */
export type WebServerDeps = {
  registry: ProjectRegistry;
  artifactService: ArtifactService;
  pendingStore: PendingChangeStore;
  /**
   * L2 工厂入参的最小面（本仓直写实现 WebPanelSessionManager，见 ./web-panel-audit）。
   * 交叉面 readAll 供审计回放端点（T1-12，P1-4）取「确认过 N 块」计数。
   */
  auditSessionManager: AuditSessionManager & { readAll: () => WebPanelJsonlEntry[] };
  /** 静态资源目录（T1-12 前端产物 dist-web）；不传则无静态路由（测试用）。 */
  staticDir?: string;
};

/** EntryDecisionPort 第一期语义（详设 §2.2 冻结注记）：只记条目不阻塞。 */
const entryDecisionPort: DecisionPort = {
  async ask() {
    // 立即返回 deferred，不挂起、不等待、不轮询；approval_request 由 gate 在 ask 前
    // 统一写入（P1-3），本 stub 零职责。merge 端点经 proposeWithGate 走到这里。
    return { status: "deferred" };
  },
};

/** 请求上下文（路由匹配结果 + 解析后的 body/query）。 */
type RouteContext = {
  params: string[]; // 路径捕获组（decodeURIComponent 后）
  query: URLSearchParams;
  body: Record<string, unknown>;
};

type Route = { method: "GET" | "POST"; pattern: RegExp; handler: (ctx: RouteContext) => Promise<unknown> };

/** 路由表 = 详细设计 §6 最小接口表（P2-2 修订：无 GET /api/sessions，不回潮）。 */
function buildRoutes(deps: WebServerDeps, auditPort: ReturnType<typeof createEntryAuditPort>): Route[] {
  const { registry, artifactService, pendingStore } = deps;
  const gate: GateDeps = {
    artifactService,
    pendingStore,
    decisionPort: entryDecisionPort,
    auditPort,
    via: "web-panel", // Web 面板裁决通道注记（S1⑤），写进 approval_response.via
  };

  const locate = (artifactId: string) => {
    // L1 跨项目反查（契约路径无 projectId），NOT_FOUND 在此传播
    return artifactService.findArtifact(artifactId);
  };

  return [
    {
      // 项目下拉（H5：ProjectRegistry.list）+ 指定项目的 artifact 列表（面板打开入口）
      method: "GET",
      pattern: /^\/api\/artifacts$/,
      handler: async (ctx) => {
        const projects = registry.list();
        const projectId = ctx.query.get("projectId");
        const artifacts = projectId !== null ? artifactService.listArtifacts(projectId) : [];
        return { projects, artifacts };
      },
    },
    {
      // S1 内联渲染 / S3 版本链 / S4 手改检测（面板打开即检测）
      method: "GET",
      pattern: /^\/api\/artifacts\/([^/]+)$/,
      handler: async (ctx) => {
        const { projectId, artifact } = locate(ctx.params[0]);
        const versions = artifactService.listVersions(projectId, artifact.id);
        const external = checkExternalModification({ artifactService }, projectId, artifact.id);
        return { artifact: artifactService.getArtifact(projectId, artifact.id), versions, external };
      },
    },
    {
      // 待确认态（S1）：pending 列表 + presentation 构建（数据与审计条目同源）
      method: "GET",
      pattern: /^\/api\/artifacts\/([^/]+)\/pending$/,
      handler: async (ctx) => {
        const { projectId, artifact } = locate(ctx.params[0]);
        const changes = pendingStore.listPendingChanges(projectId, artifact.id);
        return {
          changes: changes.map((change) => ({
            change,
            presentation: buildProposalPresentation(change, artifact),
          })),
        };
      },
    },
    {
      // S1 写回 / S2 批量：面板直接写回（端点侧不经 DecisionPort——问的对象已是人）
      method: "POST",
      pattern: /^\/api\/artifacts\/([^/]+)\/pending\/([^/]+)\/resolve$/,
      handler: async (ctx) => {
        const { projectId } = locate(ctx.params[0]);
        const changeId = ctx.params[1];
        const action = ctx.body.action;
        if (action !== "accept" && action !== "reject") {
          throw new PendingChangeError("INVALID", `resolve action 必须为 "accept" 或 "reject"，收到: ${String(action)}`);
        }
        const blockId = ctx.body.blockId;
        if (blockId !== undefined && typeof blockId !== "string") {
          throw new PendingChangeError("INVALID", "blockId 必须为字符串");
        }
        const result = pendingStore.resolveAndMaterialize(projectId, ctx.params[0], changeId, {
          blockId,
          // 裁决词（面板/审计记账词）→ L1 动作词：参数翻译（L2 工具翻译层同职责），非领域决策
          action: action === "accept" ? "confirm" : "reject",
        });
        if (result.materialized && result.artifact) {
          // 全决物化成功 → 审计写回（S1⑤：每次裁决落入 append-only 日志）：
          // approval_response（via: web-panel，decisions 逐块完整）+ artifact_resolved（P2-1 数据源）。
          // decisions 从 change 终态推导（confirmed → accept / rejected → reject），记账永远块级（D6）。
          const decisions = result.change.diffBlocks.map((b) => ({
            blockId: b.id,
            decision: (b.state === "confirmed" ? "accept" : "reject") as "accept" | "reject",
          }));
          await auditPort.append(
            buildApprovalResponse({ changeId, artifactId: ctx.params[0], decisions, via: "web-panel" }),
          );
          await auditPort.append(buildArtifactResolved(result.change, result.artifact.currentVersion));
        }
        return { materialized: result.materialized, change: result.change, artifact: result.artifact ?? null };
      },
    },
    {
      // P1-2②：放弃一条未决提案（「无 pending 不可 discard」守卫在 L1）
      method: "POST",
      pattern: /^\/api\/artifacts\/([^/]+)\/pending\/([^/]+)\/discard$/,
      handler: async (ctx) => {
        const { projectId } = locate(ctx.params[0]);
        const changeId = ctx.params[1];
        const reason = ctx.body.reason;
        if (reason !== undefined && typeof reason !== "string") {
          throw new PendingChangeError("INVALID", "reason 必须为字符串");
        }
        await discardWithAudit(gate, projectId, ctx.params[0], changeId, {
          via: "web-panel",
          reason: reason ?? "面板放弃提案",
        });
        return { discarded: true, changeId };
      },
    },
    {
      // S3 回滚：有 pending 时守卫拒绝（GateError PENDING_EXISTS → 409，文案透传）
      method: "POST",
      pattern: /^\/api\/artifacts\/([^/]+)\/rollback$/,
      handler: async (ctx) => {
        const { projectId } = locate(ctx.params[0]);
        const version = ctx.body.version;
        if (typeof version !== "number" || !Number.isInteger(version)) {
          throw new PendingChangeError("INVALID", `version 必须为整数，收到: ${String(version)}`);
        }
        return rollbackWithAudit(gate, projectId, ctx.params[0], { version, via: "web-panel" });
      },
    },
    {
      // S3 撤销回滚（P2-8 契约）：version = 恢复目标版（原回滚的 fromVersion）
      method: "POST",
      pattern: /^\/api\/artifacts\/([^/]+)\/rollback\/undo$/,
      handler: async (ctx) => {
        const { projectId } = locate(ctx.params[0]);
        const version = ctx.body.version;
        if (typeof version !== "number" || !Number.isInteger(version)) {
          throw new PendingChangeError("INVALID", `version 必须为整数，收到: ${String(version)}`);
        }
        return rollbackUndoWithAudit(gate, projectId, ctx.params[0], { version, via: "web-panel" });
      },
    },
    {
      // S4 查看差异：外部手改检测 + 磁盘现状 vs 当前版的块级差异快照
      method: "GET",
      pattern: /^\/api\/artifacts\/([^/]+)\/external\/diff$/,
      handler: async (ctx) => {
        const { projectId } = locate(ctx.params[0]);
        const external = checkExternalModification({ artifactService }, projectId, ctx.params[0]);
        let diff: DiffBlock[] = [];
        if (external.modified) {
          const abs = artifactService.materializedAbsPath(projectId, ctx.params[0]);
          const onDisk = abs !== undefined ? readFileSync(abs, "utf-8") : "";
          const current = artifactService.getArtifact(projectId, ctx.params[0]);
          diff = computeReplaceDiffBlocks(current.content, onDisk);
        }
        return { modified: external.modified, onDiskExcerpt: external.onDiskExcerpt, diff };
      },
    },
    {
      // S4 以提案方式合并：外部内容转提案（落盘待确认，面板继续逐块）；审计在 L1 内写
      method: "POST",
      pattern: /^\/api\/artifacts\/([^/]+)\/external\/merge$/,
      handler: async (ctx) => {
        const { projectId } = locate(ctx.params[0]);
        return mergeExternalAsProposal(gate, projectId, ctx.params[0], { via: "web-panel" });
      },
    },
    {
      // S4 拒绝采纳：覆盖式物化恢复系统版（不生成新版本，H4）；审计在 L1 内写
      method: "POST",
      pattern: /^\/api\/artifacts\/([^/]+)\/external\/reject$/,
      handler: async (ctx) => {
        const { projectId } = locate(ctx.params[0]);
        const artifact = await rejectExternalModification(gate, projectId, ctx.params[0], { via: "web-panel" });
        return { artifact };
      },
    },
    {
      // T1-12 审计回放（P1-4 数据管线）：面板「确认过 N 块」读自家 web-panel.jsonl——
      // artifact_resolved.acceptedBlocks 计数 + artifact_proposed.diffBlockCount，非从版本 diff 重算。
      // 纯读取 + 按 artifactId 过滤（序列化层职责，无领域判断）。
      method: "GET",
      pattern: /^\/api\/audit\/replay$/,
      handler: async (ctx) => {
        const artifactId = ctx.query.get("artifactId");
        const entries = deps.auditSessionManager.readAll().map((e) => e.data);
        return {
          entries: artifactId !== null ? entries.filter((e) => e.artifactId === artifactId) : entries,
        };
      },
    },
  ];
}

/** 静态资源 Content-Type（仅前端产物需要的几种；未知类型回 text/plain）。 */
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** 静态文件服务（T1-12）：GET 且未命中 API 路由时从 staticDir 取文件，/ → index.html。 */
function serveStatic(staticDir: string, pathname: string, res: ServerResponse): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const abs = normalize(join(staticDir, rel));
  // 路径穿越防护：解析后必须仍在 staticDir 内（../ 逃逸 → 404，不外泄真实路径）
  if (isAbsolute(rel) || !abs.startsWith(normalize(staticDir))) {
    return sendJson(res, 404, { error: "NOT_FOUND", message: `未知资源: ${pathname}` });
  }
  if (!existsSync(abs)) {
    return sendJson(res, 404, { error: "NOT_FOUND", message: `未知资源: ${pathname}` });
  }
  res.writeHead(200, { "Content-Type": STATIC_TYPES[extname(abs)] ?? "text/plain; charset=utf-8" });
  res.end(readFileSync(abs));
}

/** 领域错误 → HTTP 状态映射（详设 §6 错误映射注释；序列化层职责，非领域判断）。 */
function mapError(err: unknown): { status: number; body: unknown } {
  if (err instanceof ArtifactError || err instanceof PendingChangeError || err instanceof ProjectError) {
    if (err.code === "NOT_FOUND") return { status: 404, body: { error: "NOT_FOUND", message: err.message } };
    if (err.code === "INVALID") return { status: 422, body: { error: "INVALID", message: err.message } };
    if (err.code === "VERSION_CONFLICT" || err.code === "EXTERNAL_MODIFIED") {
      return { status: 409, body: { error: err.code, message: err.message } };
    }
    if (err.code === "BASE_VERSION_CONFLICT") {
      return {
        status: 409,
        body: { error: "BASE_VERSION_CONFLICT", message: `${err.message}。请放弃当前提案（discard）后重新提案` },
      };
    }
  }
  if (err instanceof GateError && err.code === "PENDING_EXISTS") {
    return { status: 409, body: { error: "PENDING_EXISTS", message: err.message } };
  }
  // 未预期错误不泄原始信息（防路径/errno 泄漏）
  return { status: 500, body: { error: "INTERNAL", message: "服务器内部错误" } };
}

/** 收集请求体并解析 JSON（空 body → {}；非法 JSON → 422）。 */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new PendingChangeError("INVALID", "请求体必须为 JSON 对象"));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new PendingChangeError("INVALID", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * 创建薄 server（可注入 deps，测试用临时目录后端 + listen(0)）。
 * 默认数据目录的 web-panel.jsonl 单 writer 独占检查由生产入口（./index.ts）负责（P3）。
 */
export function createWebServer(deps: WebServerDeps): Server {
  const auditPort = createEntryAuditPort(deps.auditSessionManager); // 经 L2 工厂获得 AuditPort（不直接 import pi）
  const routes = buildRoutes(deps, auditPort);

  return createHttpServer((req, res) => {
    (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname),
      );
      if (route) {
        const body = req.method === "POST" ? await readBody(req) : {};
        const ctx: RouteContext = {
          params: (url.pathname.match(route.pattern)?.slice(1) ?? []).map(decodeURIComponent),
          query: url.searchParams,
          body,
        };
        const result = await route.handler(ctx);
        return sendJson(res, 200, result);
      }
      // 未命中 API 路由：有静态目录则服务前端产物（T1-12），否则 404
      if (deps.staticDir !== undefined && req.method === "GET") {
        return serveStatic(deps.staticDir, url.pathname, res);
      }
      return sendJson(res, 404, { error: "NOT_FOUND", message: `未知路由: ${req.method} ${url.pathname}` });
    })().catch((err: unknown) => {
      const { status, body } = mapError(err);
      sendJson(res, status, body);
    });
  });
}
