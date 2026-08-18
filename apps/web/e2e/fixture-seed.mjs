/**
 * E2E 共享 fixture 种子（T1-13，P2-10）：造「demo」项目 + 设计文档 v1→v3 +
 * 一条 v4 提案（5 块，deferred 落盘）——与 seed-demo.mjs 同构，数据目录参数化。
 *
 * 共享目录机制：E2E 的 CLI 读侧（cli-ops.mjs）、Web server、本种子三方共用
 * NS_E2E_DATA 指向的同一领域存储目录（run-e2e.sh 统一导出）。同一目录上
 * 「种子 → 场景序列」可反复执行（幂等：同名 demo 项目删除重建）。
 *
 * 用法：NS_E2E_DATA=<目录> node e2e/fixture-seed.mjs [--audit-only]
 *   - 缺省 NS_E2E_DATA = ~/nextstep（与生产默认一致，seed-demo 行为不变）
 *   - --audit-only：只清 web-panel.jsonl（驱动在场景间重置审计基线用）
 *
 * 5 块分布（与原型 managed-doc-panel.html 对齐）：
 *   1. mod §2.1 内核策略   2. add §2.3 Web 壳   3. del §4 旧部署方案
 *   4. mod §5.1 确认交互   5. mod 附录 A.1 内核引用
 */
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V1, V2, V4 } from "./fixture-content.mjs";

const AUDIT_ONLY = process.argv.includes("--audit-only");

const SRC = `
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { NEXTSTEP_DIR_NAME } from "@pgoone/next-step-pi/src/domain/config/paths.ts";
import { ProjectRegistry } from "@pgoone/next-step-pi/src/domain/domain/project-registry.ts";
import { ArtifactService } from "@pgoone/next-step-pi/src/domain/domain/artifact-service.ts";
import { PendingChangeStore } from "@pgoone/next-step-pi/src/domain/domain/pending-change-service.ts";
import { createEntryAuditPort } from "@pgoone/next-step-pi/src/ports/audit-port.ts";
import { proposeWithGate, type GateDeps } from "@pgoone/next-step-pi/src/domain/gate/pending-gate-service.ts";
import { WebPanelSessionManager } from "../server/web-panel-audit";

const dataDir = process.env.NS_E2E_DATA ?? join(homedir(), NEXTSTEP_DIR_NAME);
console.log("[seed] dataDir =", dataDir);

// --audit-only：清 web-panel.jsonl（驱动在场景间重置审计基线，保证各场景
// 「approval_response 恰 1 条」等审计级断言不跨场景串扰）
const auditPath = join(dataDir, "web-panel.jsonl");
if (process.argv.includes("--audit-only")) {
  rmSync(auditPath, { force: true });
  console.log("[seed] 已清空审计文件:", auditPath);
  process.exit(0);
}

const registry = new ProjectRegistry(join(dataDir, "projects.json"));

// 同名演示项目 → 删除重建（幂等；root 目录在项目内，仅删项目目录不碰用户其他数据）
const existing = registry.list().find((p) => p.name === "demo");
if (existing) {
  rmSync(join(existing.root, NEXTSTEP_DIR_NAME), { recursive: true, force: true });
  registry.remove(existing.id);
}
const project = registry.create({ name: "demo", root: join(dataDir, "demo-panel"), createIfMissing: true });

const artifactService = new ArtifactService(registry);
const pendingStore = new PendingChangeStore(registry);
const auditManager = new WebPanelSessionManager(auditPath);
const gate: GateDeps = {
  artifactService,
  pendingStore,
  decisionPort: { async ask() { return { status: "deferred" }; } },
  auditPort: createEntryAuditPort(auditManager),
  via: "web-panel",
};

// 文档结构（每节间恰一空行；§2.2 发行形态为不变小节，隔离 §2.1 mod 与 §2.3 add，
// 避免 lcs「del 段 + 紧跟 add 段合并为 mod」吞掉独立新增块）：
// - v1 初稿（需求阶段）：§1/§2/§2.1/§2.2/§3
// - v2（需求阶段补验收标准）= v1 + §4/§5/§5.1/附录 A；v3（设计阶段定稿）= v2 同内容
// - v4 提案 = v2 上恰好 5 块改动：1 mod §2.1 / 1 add §2.3 / 1 del §4 / 1 mod §5.1 / 1 mod A.1
const V1 = __V1__;
const V2 = __V2__;
const V4 = __V4__;

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
  console.error(\`期望 5 块改动，实际 \${outcome.diffBlockCount}——v3/v4 内容需调整\`);
  process.exit(1);
}
console.log(\`[seed] 完成：project=\${project.id} artifact=\${artifact.id}（设计文档 v3 → v4，5 块待确认）\`);
console.log(\`[seed] changeId=\${outcome.changeId}\`);
`;

// esbuild 打包（与 seed-demo 同因：L1 内部 .ts 扩展 import 需 bundle）→ 临时产物 → node 执行
// 内容常量经模板注入（fixture-content.mjs 单一来源，驱动断言同源）
const outfile = join(mkdtempSync(join(tmpdir(), "nextstep-e2e-seed-")), "seed.js");
try {
  const injected = SRC
    .replace("__V1__", JSON.stringify(V1))
    .replace("__V2__", JSON.stringify(V2))
    .replace("__V4__", JSON.stringify(V4));
  buildSync({
    stdin: { contents: injected, resolveDir: import.meta.dirname, sourcefile: "fixture-seed-src.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  execFileSync(process.execPath, [outfile, ...(AUDIT_ONLY ? ["--audit-only"] : [])], {
    stdio: "inherit",
    env: { ...process.env },
  });
} finally {
  rmSync(outfile, { recursive: true, force: true });
}
