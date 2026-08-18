/**
 * CLI 侧操作（T1-13 通道① + 冲突闭环）：L2 集成进程级复用六工具注册表
 * （buildDocTools，T1-10），对共享 fixture 目录（NS_E2E_DATA）执行
 * propose / materialize / read / submit-version。
 *
 * 与真 CLI 会话的差异（P2-3 覆盖论证，见 e2e/README.md）：
 * - 工具 execute 与真会话同一实现（doc-tools.ts），只是不经真模型与 pi 运行时；
 *   真机 S5 冒烟（真模型 + tmux）由 cli-smoke.sh 承载，verifier 双层验收时执行。
 * - CLI 审计落 NS_E2E_DATA/cli-session.jsonl（直写 JSONL，与 web-panel.jsonl 同构，
 *   P2-1：第三期才做跨文件合并，本期只断言各自文件内完整 + 共享 changeId 关联）。
 *
 * 子命令：
 *   create <title> <contentFile> [actor]  create_artifact（author = actor，落 v1）
 *   propose <artifactId> <newContentFile> [actor]   propose_edit（deferred 落盘）
 *   materialize <artifactId> <newContentFile> [actor]  propose_edit（resolved 全收物化）
 *   read <artifactId> [fromVersion] [toVersion] [actor]  只读三工具 + list_artifacts
 *                            结构化结果（JSON → stdout）；actor 缺省 e2e-cli-actor
 *   submit-version <artifactId> <contentFile> <note>  L1 直调提交新版（模拟另一通道版本前进；
 *                             写路径语义由 T1-10 单测覆盖，本卡用它构造 BASE_VERSION_CONFLICT 前置）
 * 用法：NS_E2E_DATA=<目录> node e2e/cli-ops.mjs <子命令> ...
 */
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("用法: NS_E2E_DATA=<目录> node e2e/cli-ops.mjs <propose|materialize|read|submit-version> ...");
  process.exit(2);
}

const SRC = `
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { NEXTSTEP_DIR_NAME } from "@pgoone/next-step-pi/src/domain/config/paths.ts";
import { ProjectRegistry } from "@pgoone/next-step-pi/src/domain/domain/project-registry.ts";
import { ArtifactService } from "@pgoone/next-step-pi/src/domain/domain/artifact-service.ts";
import { PendingChangeStore } from "@pgoone/next-step-pi/src/domain/domain/pending-change-service.ts";
import { createEntryAuditPort } from "@pgoone/next-step-pi/src/ports/audit-port.ts";
import { buildDocTools } from "@pgoone/next-step-pi/src/pi/doc-tools.ts";
import { WebPanelSessionManager } from "../server/web-panel-audit";

const dataDir = process.env.NS_E2E_DATA ?? join(homedir(), NEXTSTEP_DIR_NAME);
const [cmd, ...args] = process.argv.slice(2);

const registry = new ProjectRegistry(join(dataDir, "projects.json"));
const project = registry.list().find((p) => p.name === "demo");
if (!project) throw new Error("fixture demo 项目不存在——先跑 fixture-seed.mjs");
const artifactService = new ArtifactService(registry);
const pendingStore = new PendingChangeStore(registry, artifactService);
// CLI 侧审计落独立会话文件（P2-1：CLI 条目与 Web 条目各居其文件，跨文件关联本期只比 changeId）
const cliAudit = new WebPanelSessionManager(join(dataDir, "cli-session.jsonl"));
const auditPort = createEntryAuditPort(cliAudit);

// decisionPort stub：deferred = 落盘等 Web 处理；resolved = 全收（CLI 键盘全收语义）
const stubDecision = (mode: "deferred" | "resolved") => ({
  async ask(req: { blocks: { blockId: string }[] }) {
    if (mode === "deferred") return { status: "deferred" as const };
    return {
      status: "resolved" as const,
      decisions: req.blocks.map((b) => ({ blockId: b.blockId, decision: "accept" as const })),
    };
  },
});

// actor 参数位按子命令区分：create/propose/materialize 的 actor 在第 3 位，
// read 的第 3/4 位是版本区间（fromVersion/toVersion），actor 在第 5 位（缺省 e2e-cli-actor）
const actorArg = cmd === "read" ? args[3] : args[2];
const tools = buildDocTools({
  projectId: project.id,
  sourceActor: actorArg ?? "e2e-cli-actor",
  decisionPort: stubDecision("deferred"),
  auditPort,
  artifactService,
  pendingStore,
});
const byName = (n: string) => tools.find((t) => t.name === n);
const textOf = (r: { content: { type: string; text: string }[] }) => JSON.parse(r.content[0].text);

switch (cmd) {
  case "create": {
    const [title, contentFile, actor] = args;
    const out = await byName("create_artifact")!.execute(
      { kind: "design", title, content: readFileSync(contentFile, "utf-8") },
      undefined,
      undefined,
    );
    console.log("[cli-ops] create:", JSON.stringify(textOf(out)));
    break;
  }
  case "propose": {
    const [artifactId, contentFile, actor] = args;
    const out = await byName("propose_edit")!.execute({ id: artifactId, newContent: readFileSync(contentFile, "utf-8") }, undefined, undefined);
    console.log("[cli-ops] propose:", JSON.stringify(textOf(out)));
    break;
  }
  case "materialize": {
    const [artifactId, contentFile, actor] = args;
    // 换 resolved 全收的 decisionPort 重装（materialize = 键盘全收语义）
    const mTools = buildDocTools({
      projectId: project.id,
      sourceActor: actor ?? "e2e-cli-actor",
      decisionPort: stubDecision("resolved"),
      auditPort,
      artifactService,
      pendingStore,
    });
    const out = await mTools.find((t) => t.name === "propose_edit")!.execute({ id: artifactId, newContent: readFileSync(contentFile, "utf-8") }, undefined, undefined);
    console.log("[cli-ops] materialize:", JSON.stringify(textOf(out)));
    break;
  }
  case "read": {
    // read <artifactId> [fromVersion] [toVersion]：显式版本区间供 diff 断言（缺省 = 相邻上一版 → 当前版）
    const [artifactId, fromVersion, toVersion] = args;
    const list = textOf(await byName("list_artifacts")!.execute({}));
    const diffArgs = { artifactId };
    if (fromVersion !== undefined) diffArgs.fromVersion = Number(fromVersion);
    if (toVersion !== undefined) diffArgs.toVersion = Number(toVersion);
    const diff = textOf(await byName("get_artifact_diff")!.execute(diffArgs));
    const history = textOf(await byName("get_artifact_history")!.execute({ artifactId }));
    const mine = textOf(await byName("list_my_artifacts")!.execute({}));
    console.log(JSON.stringify({ list, diff, history, mine }));
    break;
  }
  case "submit-version": {
    const [artifactId, contentFile, note] = args;
    const artifact = artifactService.submitVersion(project.id, artifactId, {
      content: readFileSync(contentFile, "utf-8"),
      note: note ?? "外部通道提交",
    });
    console.log("[cli-ops] submit-version: v" + artifact.currentVersion);
    break;
  }
  default:
    throw new Error("未知子命令: " + cmd);
}
`;

const outfile = join(mkdtempSync(join(tmpdir(), "nextstep-e2e-cli-")), "cli-ops.js");
try {
  buildSync({
    stdin: { contents: SRC, resolveDir: import.meta.dirname, sourcefile: "cli-ops-src.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  execFileSync(process.execPath, [outfile, cmd, ...args], { stdio: "inherit" });
} finally {
  rmSync(outfile, { recursive: true, force: true });
}
