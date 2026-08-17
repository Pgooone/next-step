/**
 * 演示种子数据（T1-12 截图/走查 fixture）：造「设计文档.md」v1→v3 + 一条 v4 提案（5 块）。
 *
 * 数据落在生产默认目录（~/.nextstep/，H5 与 CLI/Web server 共用）：
 * - projects.json：demo 项目（root = ~/.nextstep/demo-panel，同名项目已存在则删除重建，幂等）
 * - artifact：Next-Step v2.0 · 设计文档（md），v1 初稿 → v2 补验收标准 → v3 技术选型定稿
 * - 提案：v3 → v4（1 修改 / 1 新增 / 1 删除 / 2 修改 = 5 块，sourceActor: designer），
 *   pending 落盘 + 审计（artifact_proposed + approval_request）
 *
 * 5 块分布（与原型 managed-doc-panel.html 对齐）：
 *   1. mod §2.1 内核策略   2. add §2.3 Web 壳   3. del §4 旧部署方案
 *   4. mod §5.1 确认交互   5. mod 附录 A.1 内核引用
 *
 * 用法：npm run seed:demo（apps/web），或 node scripts/seed-demo.mjs
 */
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = `
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { NEXTSTEP_DIR_NAME } from "@pgoone/next-step-pi/src/domain/config/paths.ts";
import { ProjectRegistry } from "@pgoone/next-step-pi/src/domain/domain/project-registry.ts";
import { ArtifactService } from "@pgoone/next-step-pi/src/domain/domain/artifact-service.ts";
import { PendingChangeStore } from "@pgoone/next-step-pi/src/domain/domain/pending-change-service.ts";
import { createEntryAuditPort } from "@pgoone/next-step-pi/src/ports/audit-port.ts";
import { proposeWithGate, type GateDeps } from "@pgoone/next-step-pi/src/domain/gate/pending-gate-service.ts";
import { WebPanelSessionManager } from "../server/web-panel-audit";

const dataDir = join(homedir(), NEXTSTEP_DIR_NAME);
console.log("[seed] dataDir =", dataDir);
const registry = new ProjectRegistry(join(dataDir, "projects.json"));

// 同名演示项目 → 删除重建（幂等；root 目录在项目内，仅删项目目录不碰用户其他数据）。
// 注意：受管数据目录名用 NEXTSTEP_DIR_NAME 常量（= "nextstep"，无点——T1-06 登记口径；
// 注释里的 .nextstep 与实现无点存在张力，以常量终值为准），删错目录会残留旧 artifact。
const existing = registry.list().find((p) => p.name === "demo");
if (existing) {
  rmSync(join(existing.root, NEXTSTEP_DIR_NAME), { recursive: true, force: true });
  registry.remove(existing.id);
}
const project = registry.create({ name: "demo", root: join(dataDir, "demo-panel"), createIfMissing: true });

const artifactService = new ArtifactService(registry);
const pendingStore = new PendingChangeStore(registry);
const auditManager = new WebPanelSessionManager(join(dataDir, "web-panel.jsonl"));
const gate: GateDeps = {
  artifactService,
  pendingStore,
  decisionPort: { async ask() { return { status: "deferred" }; } }, // Entry 端口语义：落盘待确认
  auditPort: createEntryAuditPort(auditManager),
  via: "web-panel",
};

// 文档结构（每节间恰一空行；§2.2 发行形态为不变小节，隔离 §2.1 mod 与 §2.3 add，
// 避免 lcs「del 段 + 紧跟 add 段合并为 mod」吞掉独立新增块）：
// - v1 初稿（需求阶段）：§1/§2/§2.1/§2.2/§3
// - v2（需求阶段补验收标准）= v1 + §4/§5/§5.1/附录 A；v3（设计阶段定稿）= v2 同内容
// - v4 提案 = v2 上恰好 5 块改动：1 mod §2.1 / 1 add §2.3 / 1 del §4 / 1 mod §5.1 / 1 mod A.1
const V1 = [
  "# Next-Step v2.0 · 设计文档",
  "",
  "## §1 概述",
  "",
  "本地多 Agent 产线：把「一句想法」变成「可动工的设计包 + 可评审的原型」。",
  "",
  "## §2 技术选型",
  "",
  "领域逻辑全部住在不认识 UI、也不认识 pi 的纯 TS 内核（L1）里；CLI 和 Web 只是两个壳（L3）。",
  "",
  "### §2.1 内核策略",
  "",
  "策略基线：内核跟随 pi ^0.79.0（不 fork，纯扩展叠加）。",
  "",
  "### §2.2 发行形态",
  "",
  "npm 个人账号发布，npm i -g 后运行 nextstep 命令即得装好全部修改的发行版。",
  "",
  "## §3 架构 · 一核两壳",
  "",
  "四层分层：L0 上游 pi → L1 领域内核 → L2 适配层 → L3 双壳。",
].join("\\n");

const V2 = [
  ...V1.split("\\n"),
  "",
  "## §4 旧部署方案",
  "",
  "PM2 进程守护 + Nginx 反代 + 手工部署清单（共 15 行流程与回滚脚本）。",
  "",
  "## §5 验收标准",
  "",
  "每条需求必须有可断言的验收标准（F6），否则不进范围。",
  "",
  "### §5.1 确认交互",
  "",
  "AC-1 确认交互仅逐块 ✓/✗。",
  "",
  "## 附录 A · 引用与来源",
  "",
  "上游内核引用 pi monorepo（MIT）。",
  "",
  "### A.1 内核引用",
  "",
  "上游内核引用 pi ^0.79.0。",
].join("\\n");

// v4 提案：5 块改动（1 mod §2.1 / 1 add §2.3 / 1 del §4 / 1 mod §5.1 / 1 mod 附录 A.1）
const V4 = [
  "# Next-Step v2.0 · 设计文档",
  "",
  "## §1 概述",
  "",
  "本地多 Agent 产线：把「一句想法」变成「可动工的设计包 + 可评审的原型」。",
  "",
  "## §2 技术选型",
  "",
  "领域逻辑全部住在不认识 UI、也不认识 pi 的纯 TS 内核（L1）里；CLI 和 Web 只是两个壳（L3）。",
  "",
  "### §2.1 内核策略",
  "",
  "策略基线：内核 fork pi 0.84.2 为基线：改动只限品牌与发行层，领域逻辑仍全走扩展层（D1 拍板）。",
  "",
  "### §2.2 发行形态",
  "",
  "npm 个人账号发布，npm i -g 后运行 nextstep 命令即得装好全部修改的发行版。",
  "",
  // §2.3 新增区不加空行（标题紧贴内容）：避免 LCS 与邻区行结构同构交错配对，保证独立 add 块
  "### §2.3 Web 壳",
  "Web 壳完全自建薄壳：不 fork pi-web，壳职责收窄为「读会话 JSONL → 渲染 presentation 纯数据 → 写回 approval_response」，壳零领域判断（D8 拍板）。",
  "",
  "## §3 架构 · 一核两壳",
  "",
  "四层分层：L0 上游 pi → L1 领域内核 → L2 适配层 → L3 双壳。",
  "",
  "## §5 验收标准",
  "",
  "每条需求必须有可断言的验收标准（F6），否则不进范围。",
  "",
  "### §5.1 确认交互",
  "",
  "AC-1 确认交互分档：整块收 / 逐块 / 混合（先全收再打回单块）；交互可分档，记账永远块级（D6 拍板）。",
  "",
  "## 附录 A · 引用与来源",
  "",
  "上游内核引用 pi monorepo（MIT）。",
  "",
  "### A.1 内核引用",
  "",
  "上游内核引用 pi 0.84.2（fork 基线）；跟进纪律：UPSTREAM.md 对照 + 内核 diff 最小化清单（D1/D9 拍板）。",
].join("\\n");

const artifact = artifactService.createArtifact(project.id, {
  kind: "md",
  title: "Next-Step v2.0 · 设计文档",
  content: V1 + "\\n",
});
artifactService.submitVersion(project.id, artifact.id, { content: V2 + "\\n", note: "补充验收标准（需求阶段）" });
artifactService.submitVersion(project.id, artifact.id, { content: V2 + "\\n", note: "技术选型定稿（设计阶段）" });

const outcome = await proposeWithGate(gate, project.id, {
  artifactId: artifact.id,
  newContent: V4 + "\\n",
  sourceActor: "designer",
});
if (outcome.status !== "deferred") {
  console.error(\`种子提案失败: \${JSON.stringify(outcome)}\`);
  process.exit(1);
}
if (outcome.diffBlockCount !== 5) {
  const changes = pendingStore.listPendingChanges(project.id, artifact.id);
  for (const c of changes) {
    c.diffBlocks.forEach((b, i) => {
      console.error(\`块\${i + 1} \${b.kind} old=\${JSON.stringify(b.oldLines)} new=\${JSON.stringify(b.lines)}\`);
    });
  }
  console.error(\`期望 5 块改动，实际 \${outcome.diffBlockCount}——v3/v4 内容需调整\`);
  process.exit(1);
}
console.log(\`[seed-demo] 完成：project=\${project.id} artifact=\${artifact.id}（设计文档 v3 → v4，5 块待确认）\`);
console.log(\`[seed-demo] changeId=\${outcome.changeId} 数据目录=\${dataDir}\`);
`;

// esbuild 打包（与 build-server 同因：L1 内部 .ts 扩展 import 需 bundle）→ 临时产物 → node 执行
const outfile = join(mkdtempSync(join(tmpdir(), "nextstep-seed-")), "seed-demo.js");
try {
  buildSync({
    stdin: { contents: SRC, resolveDir: import.meta.dirname, sourcefile: "seed-demo-src.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  execFileSync(process.execPath, [outfile], { stdio: "inherit" });
} finally {
  rmSync(outfile, { recursive: true, force: true });
}
