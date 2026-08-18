#!/usr/bin/env node
/**
 * T1-13 Web E2E 主驱动（可重复执行的 E2E 测试，非一次性脚本）：
 * 真浏览器（Playwright + 系统 Chrome）驱动 S1–S4 全场景 + 冲突闭环 + 通道①一致性
 * + 审计轻量断言，并产出截图收官组。
 *
 * 场景编排：每场景开头重跑共享 fixture 种子（fixture-seed.mjs，幂等）——
 * 「种子 → 场景序列」在同一 NS_E2E_DATA 上可反复执行；web-panel.jsonl 每场景
 * 清零重建，审计级计数断言不跨场景串扰。
 *
 * 环境（run-e2e.sh 统一导出）：
 *   NS_E2E_DATA  共享领域存储目录（CLI 读侧 / server / 种子三方共用，P2-10）
 *   PORT         server 端口（默认 8790）
 *   PW_EXECUTABLE 浏览器可执行路径（默认 /usr/bin/google-chrome）
 *   SHOTS_DIR    截图输出目录（默认 /tmp/ns-e2e-shots）
 *
 * 覆盖论证（P2-3）见 e2e/README.md：每个断言 ↔ PRD 剧本期望逐条对号。
 * 用法：node e2e/drive-e2e.mjs
 */
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { V2, V4, EXT_LINE_1, EXT_LINE_2, MIXED_V4_EXPECT } from "./fixture-content.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = `http://localhost:${process.env.PORT ?? 8790}`;
const DATA = process.env.NS_E2E_DATA;
if (!DATA) {
  console.error("缺少 NS_E2E_DATA（共享领域存储目录）——由 run-e2e.sh 导出");
  process.exit(2);
}
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/ns-e2e-shots";
const EXE = process.env.PW_EXECUTABLE ?? "/usr/bin/google-chrome";
const CLI_OPS = join(ROOT, "cli-ops.mjs");
const SEED = join(ROOT, "fixture-seed.mjs");

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------
const results = [];
let failures = 0;
let total = 0;
function check(name, cond, detail = "") {
  total++;
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path, opts) {
  const res = await fetch(BASE + path, opts);
  const data = await res.json();
  return { status: res.status, data };
}

function runCli(args) {
  const out = execFileSync(process.execPath, [CLI_OPS, ...args], {
    encoding: "utf-8",
    env: { ...process.env },
  });
  const lines = out.trim().split("\n");
  return lines[lines.length - 1];
}

function auditLines() {
  try {
    return readFileSync(join(DATA, "web-panel.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function cliAuditLines() {
  try {
    return readFileSync(join(DATA, "cli-session.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const data = (e) => e.data;

function seedScene() {
  execFileSync(process.execPath, [SEED, "--audit-only"], { stdio: "ignore", env: { ...process.env } });
  execFileSync(process.execPath, [SEED], { stdio: "inherit", env: { ...process.env } });
}

async function getArtifactId() {
  const { data: r } = await fetchJson("/api/artifacts");
  const { data: d } = await fetchJson(`/api/artifacts?projectId=${r.projects[0].id}`);
  return { projectId: r.projects[0].id, artifactId: d.artifacts[0].id };
}

async function matAbsPath(artifactId) {
  const { data: d } = await fetchJson(`/api/artifacts/${artifactId}`);
  return join(DATA, "demo-panel", d.artifact.filePath);
}

// ---------------------------------------------------------------------------
// 面板交互 helper（与 web-shot.mjs 同选择器语汇）
// ---------------------------------------------------------------------------
async function openPanel(page, artifactId) {
  await page.goto(`${BASE}/?artifact=${artifactId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".doc-title", { timeout: 8000 });
  await sleep(400);
}

async function pick(page, index, vote) {
  await page.locator(".block").nth(index).locator(`.pick.${vote}`).click();
  await sleep(250);
}

async function blocksState(page) {
  return page.$$eval(".block", (els) =>
    els.map((e) => ({ id: e.dataset.blockId, state: e.dataset.blockState, tag: e.querySelector(".block-tag")?.textContent })),
  );
}

async function readState(page) {
  return page.evaluate(() => {
    // 正文提取：排除块卡片与 add 块抽出的标题（回滚态卡片嵌在 article 内，
    // 其文本是提案块展示而非正文内容——「正文切换」断言必须只看正文行流）
    const art = document.querySelector("article.doc");
    let docText = art?.textContent ?? "";
    for (const el of art?.querySelectorAll(".block, .block-title") ?? []) {
      docText = docText.replace(el.textContent ?? "", "");
    }
    return JSON.stringify({
      badge: document.getElementById("statusBadge")?.textContent,
      count: document.querySelector(".fab .count")?.textContent,
      writebackDisabled: document.getElementById("writeback")?.disabled ?? null,
      hint: document.querySelector(".fab .hint")?.textContent ?? null,
      banners: [...document.querySelectorAll(".banner .msg")].map((e) => e.textContent),
      docText,
    });
  }).then(JSON.parse);
}

async function clickByText(page, selector, text) {
  const clicked = await page.evaluate(
    ([sel, t]) => {
      const els = [...document.querySelectorAll(sel)];
      const el = els.find((e) => e.textContent.includes(t));
      if (!el) return false;
      el.click();
      return true;
    },
    [selector, text],
  );
  if (!clicked) throw new Error(`未找到按钮: ${selector} 含 "${text}"`);
  await sleep(400);
}

async function waitBannerText(page, text, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const st = await readState(page);
    if (st.banners.some((b) => b.includes(text))) return st;
    await sleep(250);
  }
  const st = await readState(page);
  check(`等待横幅「${text}」出现`, false, JSON.stringify(st.banners));
  return st;
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
  console.log(`[shot] ${name}`);
}

// ---------------------------------------------------------------------------
// S1 · 主路径：逐块混合确认（对应 F1 / D6 确认分档）
// ---------------------------------------------------------------------------
async function s1MixedDecisions(page) {
  console.log("\n===== S1 主路径：逐块混合确认 =====");
  seedScene();
  const { artifactId } = await getArtifactId();
  await openPanel(page, artifactId);
  await shot(page, "s1-initial.png");

  // S1-①：5 块三色卡片内联呈现（1 修改 / 1 新增 / 1 删除 / 2 修改）
  let blocks = await blocksState(page);
  check("S1-①a 初始 5 块待确认卡片", blocks.length === 5 && blocks.every((b) => b.state === "pending"), JSON.stringify(blocks));
  // 语义词断言（避免 emoji code unit 差异：✏️ 带变体选择符为 2 units、➕ 不带为 1 unit）
  const tags = blocks.map((b) => b.tag ?? "");
  check(
    "S1-①b 块类型分布 1 修改 / 1 新增 / 1 删除 / 2 修改",
    tags[0].includes("修改") && tags[1].includes("新增") && tags[2].includes("删除") && tags[3].includes("修改") && tags[4].includes("修改"),
    tags.join(","),
  );
  let st = await readState(page);
  check("S1-①c 进度 0/5 + 待确认徽标", st.count === "0/5" && st.badge.includes("待确认 · 5 块"), `${st.count} ${st.badge}`);

  // S1-③：存在待定块时写回不可用
  check("S1-③ 待定时写回禁用", st.writebackDisabled === true, String(st.writebackDisabled));

  // 逐块 ✓✓✗ → 三色即时变化（S1-②）+ 进度 3/5
  await pick(page, 0, "yes");
  await pick(page, 1, "yes");
  await pick(page, 2, "no");
  blocks = await blocksState(page);
  const states = blocks.map((b) => b.state);
  check("S1-②a 逐块后三色可见（绿/红/黄）", states.includes("confirmed") && states.includes("rejected") && states.includes("pending"), states.join(","));
  st = await readState(page);
  check("S1-②b 进度 3/5 且写回仍禁用", st.count === "3/5" && st.writebackDisabled === true, `${st.count} ${st.writebackDisabled}`);
  await shot(page, "s1-mixed-3of5.png");

  // 回滚守卫：有待决提案时回滚被拒（面板禁用 + API 409 PENDING_EXISTS）
  await clickByText(page, "button", "🕘 版本链");
  const rbDisabled = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".vrow")];
    const btn = rows.find((r) => r.querySelector(".vnum")?.textContent === "v2")?.querySelector("button");
    return { disabled: btn?.disabled ?? null, title: btn?.title ?? "" };
  });
  check("S1-⑦ 有 pending 时回滚按钮禁用（面板守卫）", rbDisabled.disabled === true && rbDisabled.title.includes("有待确认提案未处理"), JSON.stringify(rbDisabled));
  await clickByText(page, "button", "关闭");
  const rb = await fetchJson(`/api/artifacts/${artifactId}/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 2 }),
  });
  check("S1-⑧ 有 pending 时 rollback API 拒绝（409 PENDING_EXISTS）", rb.status === 409 && rb.data.error === "PENDING_EXISTS", `${rb.status} ${rb.data.error}`);

  // 全决 5/5 → 写回激活（S1-③）
  await pick(page, 3, "yes");
  await pick(page, 4, "no");
  st = await readState(page);
  check("S1-③b 全决 5/5 写回激活", st.count === "5/5" && st.writebackDisabled === false, `${st.count} ${st.writebackDisabled}`);

  // 写回 → v4 物化（S1-④⑤）
  await page.click("#writeback");
  st = await waitBannerText(page, "接受 3 块 → 物化为 v4");
  check("S1-④a 写回横幅：接受 3 块 → 物化为 v4；拒绝 2 块", st.banners.some((b) => b.includes("接受 3 块 → 物化为 v4") && b.includes("拒绝 2 块 → 保留 v3")), st.banners.join("|"));
  check("S1-④b 徽标切换为已确认 v4", st.badge.includes("已确认 · v4 已物化"), st.badge);
  await shot(page, "s1-resolved-v4.png");

  // 版本链 append-only（S1-④c）
  const { data: ver } = await fetchJson(`/api/artifacts/${artifactId}`);
  check("S1-④c 版本链 v1–v4 append-only", ver.versions.length === 4 && ver.versions[3].version === 4, `len=${ver.versions.length}`);

  // 物化文件级断言：v4 = v3 + 被收块；被拒块不进（S1-④）
  const mat = readFileSync(await matAbsPath(artifactId), "utf-8");
  for (const t of MIXED_V4_EXPECT.mustContain) {
    check(`S1-④d 物化 v4 含被收块内容「${t.slice(0, 16)}…」`, mat.includes(t));
  }
  for (const t of MIXED_V4_EXPECT.mustAbsent) {
    check(`S1-④e 物化 v4 不含被拒块内容「${t.slice(0, 16)}…」`, !mat.includes(t));
  }

  // 审计文件级断言（S1-⑤：每次裁决落入 append-only 日志）
  const entries = auditLines().map(data);
  const resp = entries.filter((e) => e.kind === "approval_response");
  const resolved = entries.filter((e) => e.kind === "artifact_resolved");
  check("S1-⑤a approval_response 恰 1 条", resp.length === 1, `n=${resp.length}`);
  if (resp[0]) {
    const dec = resp[0].decisions;
    check(
      "S1-⑤b decisions 逐块完整（accept3/reject2 与点击一致）",
      dec.length === 5 &&
        dec.filter((d) => d.decision === "accept").length === 3 &&
        dec.filter((d) => d.decision === "reject").length === 2 &&
        resp[0].via === "web-panel",
      JSON.stringify(dec.map((d) => d.decision)),
    );
  }
  check("S1-⑤c artifact_resolved accepted=3 rejected=2 newVersion=4", resolved.length === 1 && resolved[0]?.acceptedBlocks?.length === 3 && resolved[0]?.rejectedBlocks?.length === 2 && resolved[0]?.newVersion === 4, JSON.stringify(resolved[0] && { a: resolved[0].acceptedBlocks.length, r: resolved[0].rejectedBlocks.length, v: resolved[0].newVersion }));

  // pending 清空
  const { data: pend } = await fetchJson(`/api/artifacts/${artifactId}/pending`);
  check("S1-⑥ 写回后 pending 清空", pend.changes.length === 0, `n=${pend.changes.length}`);

  return mat; // v4 内容快照（供 S3 撤销回滚逐字节对比）
}

// ---------------------------------------------------------------------------
// S2 · 批量档：全部接受 + 批量后单块翻转（混合档）
// ---------------------------------------------------------------------------
async function s2Bulk(page) {
  console.log("\n===== S2a 批量档：全部接受 =====");
  seedScene();
  const { artifactId } = await getArtifactId();
  await openPanel(page, artifactId);

  await page.click("#allYes");
  let blocks = await blocksState(page);
  let st = await readState(page);
  check("S2a-① 一键后 5 块全绿、进度 5/5、写回激活", blocks.every((b) => b.state === "confirmed") && st.count === "5/5" && st.writebackDisabled === false, st.count);
  await shot(page, "s2-all-accepted.png");

  await page.click("#writeback");
  st = await waitBannerText(page, "接受 5 块 → 物化为 v4");
  check("S2a-② 写回横幅接受 5 块", st.banners.some((b) => b.includes("接受 5 块")), st.banners.join("|"));
  const mat = readFileSync(await matAbsPath(artifactId), "utf-8");
  // splitLines 规范化（lcs.ts:26 弹出尾部空行）→ 物化内容为提案全文的无尾部换行形态（L1 既有语义）
  check("S2a-③ 物化 v4 = 提案全文逐字节（splitLines 规范化形态）", mat === V4, `len=${mat.length} vs ${V4.length}`);
  const entries = auditLines().map(data);
  const resolved = entries.find((e) => e.kind === "artifact_resolved");
  check("S2a-④ 审计 accepted=5 rejected=0", resolved?.acceptedBlocks?.length === 5 && resolved?.rejectedBlocks?.length === 0, JSON.stringify({ a: resolved?.acceptedBlocks?.length, r: resolved?.rejectedBlocks?.length }));

  console.log("\n===== S2b 批量后单块翻转（混合档） =====");
  seedScene();
  const { artifactId: aid2 } = await getArtifactId();
  await openPanel(page, aid2);
  await page.click("#allYes");
  await pick(page, 2, "no"); // 块 3（del §4）翻转拒绝
  blocks = await blocksState(page);
  st = await readState(page);
  const states = blocks.map((b) => b.state);
  // 进度 = 已有着落的块数（5 块都有票 → 5/5，其中 4 收 1 拒）；「混合档」语义由写回横幅与审计承载
  check("S2b-① 全收后单块翻转成立（4 confirmed + 1 rejected）", states.filter((s) => s === "confirmed").length === 4 && states.filter((s) => s === "rejected").length === 1 && st.count === "5/5", states.join(","));
  await page.click("#writeback");
  st = await waitBannerText(page, "接受 4 块");
  check("S2b-② 写回横幅接受 4 块、拒绝 1 块", st.banners.some((b) => b.includes("接受 4 块") && b.includes("拒绝 1 块")), st.banners.join("|"));
  const matB = readFileSync(await matAbsPath(aid2), "utf-8");
  check("S2b-③ 物化 v4 含 4 块新文案（§2.3 进）", matB.includes("### §2.3 Web 壳"));
  check("S2b-④ 物化 v4 保留 §4（del 块被翻转拒绝）", matB.includes("## §4 旧部署方案") && matB.includes("PM2 进程守护"));
  check("S2b-⑥ 物化 v4 含块 5 新文案（仅块 3 被翻转拒绝）", matB.includes("上游内核引用 pi 0.84.2（fork 基线）"), "");
  const resB = auditLines().map(data).find((e) => e.kind === "artifact_resolved");
  check("S2b-⑤ 审计 accepted=4 rejected=1", resB?.acceptedBlocks?.length === 4 && resB?.rejectedBlocks?.length === 1, JSON.stringify({ a: resB?.acceptedBlocks?.length, r: resB?.rejectedBlocks?.length }));
}

// ---------------------------------------------------------------------------
// S3 · 版本链与回滚（方案 C：正文切换 + 回滚报告 + 撤销回滚）
// ---------------------------------------------------------------------------
async function s3HistoryRollback(page, s1MatSnapshot) {
  console.log("\n===== S3 版本链与回滚 =====");
  seedScene();
  const { artifactId } = await getArtifactId();
  await openPanel(page, artifactId);

  // 混合裁决 3 收 2 拒 → v4（与 S1 同款，回滚报告「确认过 3 块」= P1-4 非巧合数值）
  await pick(page, 0, "yes");
  await pick(page, 1, "yes");
  await pick(page, 2, "no");
  await pick(page, 3, "yes");
  await pick(page, 4, "no");
  await page.click("#writeback");
  await waitBannerText(page, "接受 3 块 → 物化为 v4");

  // S3-①：版本链完整可见且归属正确
  await clickByText(page, "button", "🕘 版本链");
  const rows = await page.$$eval(".vrow", (els) =>
    els.map((e) => ({ v: e.querySelector(".vnum")?.textContent, info: e.querySelector(".vinfo")?.textContent ?? "", cur: e.querySelector(".vcur")?.textContent ?? null })),
  );
  check("S3-①a 抽屉 v1–v4 完整且 v4 标当前", rows.length === 4 && rows[0].v === "v4" && rows[0].cur === "当前" && rows[3].v === "v1", rows.map((r) => r.v).join(","));
  // 抽屉倒序渲染（v4→v1）：rows[1]=v3（技术选型定稿）、rows[2]=v2（补充验收标准）；渲染标题无 ## 前缀
  check("S3-①b 归属正确（author + note）", rows.every((r) => r.info.length > 0) && rows[1].info.includes("技术选型定稿") && rows[2].info.includes("补充验收标准"), JSON.stringify(rows.map((r) => r.info.slice(0, 30))));
  await shot(page, "s3-history.png");

  // S3-②：回滚 v2 → 新版本 v5（append-only）
  const ok = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".vrow")].find((r) => r.querySelector(".vnum")?.textContent === "v2");
    row?.querySelector("button")?.click();
    return !!row;
  });
  check("S3-② 回滚按钮可点（无 pending 守卫放行）", ok);
  await waitBannerText(page, "已回滚：v5 = v2 的内容");
  let st = await readState(page);
  check("S3-②b 回滚生成 v5（正文已切换）", st.badge.includes("已回滚 · v5") && st.badge.includes("= v2 的内容"), st.badge);
  // S3-④ 回滚报告：撤销 5 块、其中确认过 3 块（P1-4 审计回放取数，非巧合）
  check("S3-④a 回滚报告横幅：撤销 5 块 + 确认过 3 块", st.banners.some((b) => b.includes("5 块改动不在当前版本") && b.includes("确认过的 3 块")), st.banners.join("|"));
  // 渲染器标题行 = 去 ## 前缀的 label（bodyLineToNode）；回滚态正文全量渲染 v2 内容
  check("S3-④b 正文切换：被删 §4 段落恢复显示", st.docText.includes("PM2 进程守护") && st.docText.includes("§4 旧部署方案"), "");
  check("S3-④c 正文切换：新增 §2.3 段隐藏", !st.docText.includes("§2.3 Web 壳"), "");
  const rolled = await page.$$eval(".block.block-rolledback", (els) => els.length);
  const notes = await page.$$eval(".block-note", (els) => els.map((e) => e.textContent));
  check("S3-④d 5 块灰化标「未生效（v4 提案）」", rolled === 5 && notes.every((n) => n.includes("未生效（v4 提案）")), `rolled=${rolled} ${notes[0]}`);
  await shot(page, "s3-rolledback-v5.png");

  // S3-③：历史 append-only，v3/v4 保留
  const { data: ver } = await fetchJson(`/api/artifacts/${artifactId}`);
  check("S3-③ 版本链 5 版 append-only（v3/v4 保留）", ver.versions.length === 5 && ver.versions.map((v) => v.version).join(",") === "1,2,3,4,5", ver.versions.map((v) => v.version).join(","));

  // S3-⑤：撤销回滚 → v6 = v4 内容（逐字节），回滚版保留在链上
  await clickByText(page, "button", "撤销回滚");
  await waitBannerText(page, "已撤销回滚");
  const mat = readFileSync(await matAbsPath(artifactId), "utf-8");
  check("S3-⑤a 撤销后 v6 内容 = v4 内容逐字节（与 S1 同裁决物化一致）", s1MatSnapshot !== null && mat === s1MatSnapshot, `len=${mat.length} vs ${s1MatSnapshot?.length}`);
  st = await readState(page);
  // 撤销回滚 → inline 模式无卡片（displayBlocks=[]），正文 = v6（v4 内容：§2.3 段出现；
  // 3 收 2 拒的 v4 本就保留 §4，故不断言「§4 消失」——恢复形态由 ⑤a 逐字节 + 卡片数 0 承载）
  const blockCountAfter = await page.$$eval(".block", (els) => els.length);
  check("S3-⑤b 正文恢复 v4 形态（§2.3 段出现、提案卡片清空）", st.docText.includes("§2.3 Web 壳") && st.docText.includes("Web 壳完全自建薄壳") && blockCountAfter === 0, `blocks=${blockCountAfter}`);
  const { data: ver2 } = await fetchJson(`/api/artifacts/${artifactId}`);
  check("S3-⑤c 版本链 6 版、回滚版 v5 保留在链上", ver2.versions.length === 6 && ver2.versions.map((v) => v.version).join(",") === "1,2,3,4,5,6", ver2.versions.map((v) => v.version).join(","));
  await shot(page, "s3-undo-v6.png");
}

// ---------------------------------------------------------------------------
// S4 · 异常路径：外部手改检测（EXTERNAL_MODIFIED / AC 通行）
// ---------------------------------------------------------------------------
async function s4ExternalModified(page) {
  console.log("\n===== S4 外部手改检测与三动作 =====");
  seedScene();
  const { artifactId } = await getArtifactId();
  const matPath = await matAbsPath(artifactId);
  const v3Content = readFileSync(matPath, "utf-8");

  // 绕过系统直写物化文件
  writeFileSync(matPath, v3Content + "\n" + EXT_LINE_1 + "\n", "utf-8");
  await openPanel(page, artifactId);
  let st = await readState(page);
  check("S4-① 警告横幅 EXTERNAL_MODIFIED + 文件名", st.banners.some((b) => b.includes("EXTERNAL_MODIFIED") && b.includes("检测到外部手改")), st.banners.join("|"));
  const excerpt = await page.textContent(".ext-excerpt").catch(() => "");
  // onDiskExcerpt = 磁盘现状首行摘录（T1-06 义务 3 消费）；断言摘录块存在且非空
  check("S4-② 磁盘现状预览非空（onDiskExcerpt 消费）", excerpt.includes("磁盘现状预览：") && excerpt.length > 20, excerpt.slice(0, 40));
  check("S4-③a 版本操作冻结：写回禁用 + 冻结提示", st.writebackDisabled === true && (st.hint ?? "").includes("外部手改待处理"), `${st.writebackDisabled} ${st.hint}`);
  await clickByText(page, "button", "🕘 版本链");
  const rb = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".vrow")];
    const btn = rows.find((r) => r.querySelector(".vnum")?.textContent === "v2")?.querySelector("button");
    return { disabled: btn?.disabled ?? null, title: btn?.title ?? "" };
  });
  check("S4-③b 版本操作冻结：回滚按钮禁用（title 含外部手改）", rb.disabled === true && rb.title.includes("外部手改"), JSON.stringify(rb));
  await clickByText(page, "button", "关闭");
  await shot(page, "s4-warning.png");

  // 动作 1：查看 diff（不得静默覆盖/丢弃——差异可见）
  await clickByText(page, "button", "查看 diff");
  const diffTxt = await page.textContent(".diff-view").catch(() => "");
  check("S4-④ 查看 diff：差异明细含外部行（ins）", diffTxt.includes(EXT_LINE_1), diffTxt.slice(0, 60));

  // 守卫：以提案方式合并被既有 pending 拦截（P1-7 先决分支，数据层不动）
  await clickByText(page, "button", "以提案方式合并");
  await sleep(500);
  const { data: pendGuard } = await fetchJson(`/api/artifacts/${artifactId}/pending`);
  const { data: detGuard } = await fetchJson(`/api/artifacts/${artifactId}`);
  check(
    "S4-⑤ merge 守卫：既有 pending 时拦截（pending 未变、磁盘外部内容保留、modified 仍 true）",
    pendGuard.changes.length === 1 && pendGuard.changes[0].change.sourceActor !== "external-merge" &&
      readFileSync(matPath, "utf-8").includes(EXT_LINE_1) && detGuard.external.modified === true,
    `pending=${pendGuard.changes.length} actor=${pendGuard.changes[0]?.change.sourceActor} modified=${detGuard.external.modified}`,
  );
  // 注：merge 被拦截时面板误报「已转为提案」并清除 extMode（面板消费 pending_exists 的已知瑕疵，
  // T1-13 报告 P3 登记）——重新打开面板恢复警告横幅，继续拒绝采纳路径
  await openPanel(page, artifactId);

  // 动作 2：拒绝采纳 → 磁盘恢复系统版（版本号不变，H4 不生成幽灵版本）
  await clickByText(page, "button", "拒绝采纳，恢复系统版本");
  await sleep(600);
  const restored = readFileSync(matPath, "utf-8");
  const { data: detRej } = await fetchJson(`/api/artifacts/${artifactId}`);
  check("S4-⑥a 拒绝采纳后磁盘恢复系统版逐字节（= v3 内容）", restored === v3Content, `len=${restored.length} vs ${v3Content.length}`);
  check("S4-⑥b 版本号不变（仍 v3，不生成幽灵版本）", detRej.artifact.currentVersion === 3 && detRej.external.modified === false, `v=${detRej.artifact.currentVersion} modified=${detRej.external.modified}`);
  await shot(page, "s4-rejected.png");
  const extRej = auditLines().map(data).filter((e) => e.kind === "artifact_external_resolved" && e.action === "reject");
  check("S4-⑥c 审计 artifact_external_resolved action=reject 留痕", extRej.length === 1, `n=${extRej.length}`);

  // 先处理遗留 pending（全部接受 → v4），再走 merge 完整通道
  await pick(page, 0, "yes");
  await pick(page, 1, "yes");
  await pick(page, 2, "yes");
  await pick(page, 3, "yes");
  await pick(page, 4, "yes");
  await page.click("#writeback");
  await waitBannerText(page, "接受 5 块 → 物化为 v4");
  const v4Content = readFileSync(matPath, "utf-8");

  // 动作 3：以提案方式合并（再次手改 → merge → 转提案）
  writeFileSync(matPath, v4Content + "\n" + EXT_LINE_2 + "\n", "utf-8");
  await openPanel(page, artifactId);
  await clickByText(page, "button", "以提案方式合并");
  await sleep(700);
  const { data: pendM } = await fetchJson(`/api/artifacts/${artifactId}/pending`);
  check("S4-⑦ merge 转提案成功：pending 出现且 sourceActor=external-merge", pendM.changes.length === 1 && pendM.changes[0].change.sourceActor === "external-merge", `n=${pendM.changes.length} actor=${pendM.changes[0]?.change.sourceActor}`);
  const srcLabels = await page.$$eval(".block-src", (els) => els.map((e) => e.textContent));
  check("S4-⑧ 卡片带「外部手改合并」来源标识", srcLabels.some((t) => t.includes("外部手改合并")), srcLabels.join(","));
  const extMerge = auditLines().map(data).filter((e) => e.kind === "artifact_external_resolved" && e.action === "merge");
  check("S4-⑨ 审计 artifact_external_resolved action=merge 留痕", extMerge.length === 1, `n=${extMerge.length}`);
  await shot(page, "s4-merged.png");

  // 合并提案走同一条确认通道：全收 → 物化（外部内容由提案承载）
  await page.click("#allYes");
  await page.click("#writeback");
  await waitBannerText(page, "接受 1 块 → 物化为 v5");
  const matFinal = readFileSync(matPath, "utf-8");
  check("S4-⑩ 合并写回物化 v5 = 外部全文（不静默丢弃，splitLines 规范化形态）", matFinal === v4Content + "\n" + EXT_LINE_2, `len=${matFinal.length}`);
}

// ---------------------------------------------------------------------------
// E5 · 异常分支：BASE_VERSION_CONFLICT → discard → 重提案（通道①交叉）
// ---------------------------------------------------------------------------
async function e5ConflictLoop(page) {
  console.log("\n===== E5 BASE_VERSION_CONFLICT → discard → 重提案 =====");
  seedScene();
  const { artifactId } = await getArtifactId();
  const v4File = join(DATA, "tmp-v4.md");
  const v4bFile = join(DATA, "tmp-v4b.md");
  writeFileSync(v4File, V4 + "\n", "utf-8");
  const V4B = V4 + "\n\n### §2.4 冲突后重提案\n经 discard 后重新提案的内容。\n";
  writeFileSync(v4bFile, V4B, "utf-8");

  // 另一通道（CLI 侧 L1 直调）提交 v4 → 提案基底过期
  const sv = runCli(["submit-version", artifactId, v4File, "外部通道提交 v4（模拟另一通道全收物化）"]);
  check("E5-① 另一通道提交 v4（基底过期前置）", sv.includes("v4"), sv);
  const { data: detBefore } = await fetchJson(`/api/artifacts/${artifactId}`);
  check("E5-①b 版本链现为 v1–v4", detBefore.versions.length === 4, `len=${detBefore.versions.length}`);

  // 面板写回 → 409 BASE_VERSION_CONFLICT（pending 保留现场，P1-2）
  await openPanel(page, artifactId);
  await page.click("#allYes");
  await page.click("#writeback");
  const stFail = await waitBannerText(page, "写回失败");
  // UI 人话文案（前端错误映射不暴露错误码）；错误码由 API 级断言（E5-②b）兜底
  check("E5-② 写回被拒：横幅提示上游版本已变更 + 引导 discard", stFail.banners.some((b) => b.includes("上游版本已变更") && b.includes("请放弃当前提案")), stFail.banners.join("|"));
  await shot(page, "e5-conflict-409.png");
  const { data: pendKeep } = await fetchJson(`/api/artifacts/${artifactId}/pending`);
  check("E5-③ 冲突后 pending 保留现场（未静默删除）", pendKeep.changes.length === 1 && pendKeep.changes[0].change.baseVersion === 3, `n=${pendKeep.changes.length} base=${pendKeep.changes[0]?.change.baseVersion}`);
  // API 级：resolve 直调 409 + BASE_VERSION_CONFLICT（数据层错误码 = 前端文案的真相源）
  const clashRes = await fetchJson(`/api/artifacts/${artifactId}/pending/${pendKeep.changes[0].change.id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "accept" }),
  });
  check("E5-②b 写回 API 拒绝 409 BASE_VERSION_CONFLICT", clashRes.status === 409 && clashRes.data.error === "BASE_VERSION_CONFLICT", `${clashRes.status} ${clashRes.data.error}`);

  // 放弃提案（discard 出口，P1-2②）
  await clickByText(page, "button", "🗑 放弃提案");
  await sleep(700);
  const { data: pendAfter } = await fetchJson(`/api/artifacts/${artifactId}/pending`);
  const disc = auditLines().map(data).filter((e) => e.kind === "approval_response" && e.status === "discarded");
  check("E5-④ discard 生效：pending 清空", pendAfter.changes.length === 0, `n=${pendAfter.changes.length}`);
  check("E5-⑤ 审计 approval_response discarded（decisions=[] + 放弃原因）", disc.length === 1 && disc[0].decisions.length === 0 && typeof disc[0].note === "string", JSON.stringify(disc[0] && { d: disc[0].decisions.length, note: disc[0].note }));

  // CLI 重提案（propose_edit，deferred）→ Web 面板写回（通道①交叉：CLI 提案 → Web 裁决）
  const prop = runCli(["propose", artifactId, v4bFile, "e2e-cli-actor"]);
  const propJson = JSON.parse(prop.replace(/^\[cli-ops\] propose: /, ""));
  const changeId2 = propJson.changeId;
  check("E5-⑥ CLI 重提案成功（changeId 非空，diffBlockCount=1）", typeof changeId2 === "string" && propJson.diffBlockCount === 1, JSON.stringify(propJson));
  // 写回前缓存 Web 侧 presentation（通道① diff 对比基准）
  const { data: pendNew } = await fetchJson(`/api/artifacts/${artifactId}/pending`);
  const webBlocks = pendNew.changes[0].presentation.body.find((b) => b.kind === "diff")?.diffRef.blocks ?? [];
  await openPanel(page, artifactId);
  const stNew = await readState(page);
  check("E5-⑦ 面板重载出现新提案（待确认 · 1 块）", stNew.badge.includes("待确认 · 1 块"), stNew.badge);
  await shot(page, "e5-reproposed.png");
  await page.click("#allYes");
  await page.click("#writeback");
  await waitBannerText(page, "接受 1 块 → 物化为 v5");

  // E5 审计完整性（P2-1 轻量断言）：CLI/Web 条目各自文件内完整 + changeId 关联
  const wEntries = auditLines().map(data);
  const cEntries = cliAuditLines().map(data);
  const wResp = wEntries.find((e) => e.kind === "approval_response" && e.changeId === changeId2);
  const wRes = wEntries.find((e) => e.kind === "artifact_resolved" && e.changeId === changeId2);
  check("E5-⑧ Web 侧条目完整：approval_response(resolved,via=web-panel) + artifact_resolved(newVersion=5)", !!wResp && wResp.status === "resolved" && wResp.via === "web-panel" && !!wRes && wRes.newVersion === 5, JSON.stringify({ resp: wResp?.status, res: wRes?.newVersion }));
  const cProp = cEntries.find((e) => e.kind === "artifact_proposed" && e.changeId === changeId2);
  const cReq = cEntries.find((e) => e.kind === "approval_request" && e.changeId === changeId2);
  check("E5-⑨ CLI 侧条目完整：artifact_proposed + approval_request 同 changeId", !!cProp && cProp.baseVersion === 4 && !!cReq && cReq.requester === "cli", JSON.stringify({ base: cProp?.baseVersion, req: cReq?.requester }));
  check("E5-⑩ 跨文件关联：同一 changeId 在两文件成对出现（P2-1，不承诺跨文件排序合并）", cProp !== undefined && cReq !== undefined && wResp !== undefined && wRes !== undefined, changeId2);

  // 通道① Web→CLI：CLI 读侧与 Web API 同一份领域数据
  const cli = JSON.parse(runCli(["read", artifactId, "4", "5"]));
  const { data: detWeb } = await fetchJson(`/api/artifacts/${artifactId}`);
  const histCli = cli.history.versions;
  const histWeb = detWeb.versions;
  const sameHist = histCli.length === histWeb.length && histCli.every((v, i) => {
    const w = histWeb[i];
    return v.version === w.version && v.author === w.author && v.createdAt === w.createdAt && (v.note ?? null) === (w.note ?? null);
  });
  check("E5-⑪ 通道① Web→CLI：get_artifact_history 与 Web API versions 逐字段一致", sameHist, `cli=${histCli.length} web=${histWeb.length}`);
  const cliDiff = cli.diff;
  // 两通道 schema 不同（CLI 块 = kind/lines/oldLines/lineStart/lineEnd；Web 块 =
  // blockId/kind/tag/anchor/lines/oldLines/state），可比字段 = kind + lines + oldLines 有无
  const sameBlocks =
    cliDiff.blocks.length === webBlocks.length &&
    cliDiff.blocks.every((b, i) => {
      const w = webBlocks[i];
      return b.kind === w.kind && JSON.stringify(b.lines) === JSON.stringify(w.lines) && (b.oldLines === undefined) === (w.oldLines === undefined);
    });
  check("E5-⑫ 通道① Web→CLI：get_artifact_diff 与 Web presentation 块逐字段一致（kind/lines/oldLines）", sameBlocks, `cli=${cliDiff.blocks.length} web=${webBlocks.length}`);
  // 锚点表示不同（CLI = 行区间，Web = 标题锚）：含块内标题的块（add 新节）断言
  // Web anchor = CLI 块首标题行 label——同一 add 块的标题锚跨通道一致
  const headingOf = (lines) => {
    for (const l of lines ?? []) {
      const m = /^(#{1,6})\s+(.*)$/.exec(l.trim());
      if (m && m[2].trim()) return m[2].trim();
    }
    return null;
  };
  const anchorOk = cliDiff.blocks.every((b, i) => {
    const h = headingOf(b.lines);
    return h === null || webBlocks[i].anchor === h;
  });
  check("E5-⑫b 锚点一致：CLI 块标题行 label = Web anchor", anchorOk, JSON.stringify({ cli: cliDiff.blocks[0], web: webBlocks[0] }));
  check("E5-⑬ CLI list_artifacts 读出新版本 v5", cli.list[0]?.currentVersion === 5, JSON.stringify(cli.list[0]));

  // 审计完整性遍历：各自文件内条目必备字段
  const required = (e) => e.ns === "next-step" && typeof e.ts === "string" && typeof e.kind === "string" && typeof e.artifactId === "string";
  const webAll = wEntries.every(required);
  const cliAll = cEntries.every(required);
  check("E5-⑭ 审计各自文件内完整性（ns/ts/kind/artifactId 必备字段遍历）", webAll && cliAll && wEntries.length >= 2 && cEntries.length >= 2, `web=${wEntries.length} cli=${cEntries.length}`);
}

// ---------------------------------------------------------------------------
// C6 · 通道① CLI→Web：CLI 物化 → Web 面板读同一份数据
// ---------------------------------------------------------------------------
async function c6CliToWeb(page) {
  console.log("\n===== C6 通道① CLI→Web（CLI 物化 → 面板重载一致） =====");
  seedScene();
  const { artifactId, projectId } = await getArtifactId();
  const v4bFile = join(DATA, "tmp-v4b.md");
  const V4B = V4 + "\n\n### §2.4 CLI 侧二次提案\nCLI 侧物化通道验证段落。\n";
  writeFileSync(v4bFile, V4B, "utf-8");

  await openPanel(page, artifactId);
  // AC-1.2：UI 块数参照先拿（pending presentation，物化前）
  const { data: pendInit } = await fetchJson(`/api/artifacts/${artifactId}/pending`);
  const webBlocks0 = pendInit.changes[0].presentation.body.find((b) => b.kind === "diff")?.diffRef.blocks ?? [];

  // 先经 Web 清场（seed 的 pending 全收 → v4 物化），CLI 才有 v4 版本快照可读
  await page.click("#allYes");
  await page.click("#writeback");
  await waitBannerText(page, "接受 5 块 → 物化为 v4");
  // AC-1.2：get_artifact_diff(v3,v4)（v4 已物化）与 UI 块数/kind 序列一致——两通道同一切块实现
  const cli0 = JSON.parse(runCli(["read", artifactId, "3", "4"]));
  check("C6-① AC-1.2：get_artifact_diff(v3,v4) 与 UI 块数一致（5 块 mod/add/del/mod/mod）", cli0.diff.blocks.length === webBlocks0.length && JSON.stringify(cli0.diff.blocks.map((b) => b.kind)) === JSON.stringify(webBlocks0.map((b) => b.kind)), `${cli0.diff.blocks.length} vs ${webBlocks0.length}`);

  const mat = runCli(["materialize", artifactId, v4bFile, "e2e-cli-actor"]);
  check("C6-② CLI 侧物化成功（键盘全收语义 → v5）", mat.includes("已确认并物化为 v5"), mat);
  const cliEntries = cliAuditLines().map(data);
  check("C6-②b CLI 侧审计：approval_response(via=cli-keyboard) + artifact_resolved(newVersion=5)", cliEntries.some((e) => e.kind === "approval_response" && e.via === "cli-keyboard") && cliEntries.some((e) => e.kind === "artifact_resolved" && e.newVersion === 5), "");

  await openPanel(page, artifactId);
  const st = await readState(page);
  check("C6-③ 面板重载显示 CLI 物化的 v5（正文含 §2.4 CLI 侧二次提案）", st.badge.includes("已确认 · v5 已物化") && st.docText.includes("CLI 侧物化通道验证段落"), st.badge);
  const { data: det } = await fetchJson(`/api/artifacts/${artifactId}`);
  check("C6-④ 版本链含 CLI 物化版（v1–v5，v5 note=apply pending）", det.versions.length === 5 && det.versions[4].version === 5 && det.versions[4].note.includes("apply pending"), det.versions[4].note);

  // 通道① CLI 读 vs Web API 逐字段（同一份领域数据）
  const cli = JSON.parse(runCli(["read", artifactId, "4", "5"]));
  const { data: apiList } = await fetchJson(`/api/artifacts?projectId=${projectId}`);
  const a = apiList.artifacts[0];
  check("C6-⑤ 通道① CLI→Web：list_artifacts 与 Web API artifacts 逐字段一致（id/title/kind/currentVersion）", cli.list.length === 1 && cli.list[0].id === a.id && cli.list[0].title === a.title && cli.list[0].kind === a.kind && cli.list[0].currentVersion === a.currentVersion, JSON.stringify(cli.list[0]));
  const sameHist = cli.history.versions.length === det.versions.length && cli.history.versions.every((v, i) => {
    const w = det.versions[i];
    return v.version === w.version && v.author === w.author && v.createdAt === w.createdAt && (v.note ?? null) === (w.note ?? null);
  });
  check("C6-⑥ 通道① CLI→Web：get_artifact_history 与 Web API versions 逐字段一致", sameHist, `cli=${cli.history.versions.length} web=${det.versions.length}`);

  // C6-⑦ 修正：seed 文档全链 author=user（物化路径旧仓语义 author=user），e2e-cli-actor
  // 名下本无版本——「名下」断言需先由 CLI create_artifact 建立归属前提（AC-1.1 建文档结构化）
  const mineFile = join(DATA, "tmp-mine.md");
  const mineFile2 = join(DATA, "tmp-mine2.md");
  writeFileSync(mineFile, "## 我的文档\nCLI 侧创建的受管文档。\n", "utf-8");
  writeFileSync(mineFile2, "## 我的文档\nCLI 侧创建的受管文档（v2 内容）。\n", "utf-8");
  const created = JSON.parse(runCli(["create", "CLI 侧文档", mineFile, "e2e-cli-actor"]).replace(/^\[cli-ops\] create: /, ""));
  check("C6-⑥b CLI create_artifact 结构化返回（id + v1）", typeof created.id === "string" && created.version === 1, JSON.stringify(created));
  const mat2 = runCli(["materialize", created.id, mineFile2, "e2e-cli-actor"]);
  check("C6-⑥c CLI 对自有文档二次提案物化 → v2", mat2.includes("已确认并物化为 v2"), mat2);
  const mineNow = JSON.parse(runCli(["read", created.id, "1", "2"])).mine;
  check("C6-⑦ list_my_artifacts 读到 e2e-cli-actor 名下产物（lastChange v2）", mineNow.length === 1 && mineNow[0].id === created.id && mineNow[0].lastChange.version === 2, JSON.stringify(mineNow[0]));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  mkdirSync(SHOTS, { recursive: true });
  console.log(`[e2e] BASE=${BASE} DATA=${DATA} EXE=${EXE} SHOTS=${SHOTS}`);

  const browser = await chromium.launch({
    executablePath: EXE,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 2000 } });
  page.on("dialog", (d) => d.accept().catch(() => {})); // 回滚/放弃确认一律接受

  try {
    // S1：返回 v4（3 收 2 拒）内容快照供 S3 撤销回滚逐字节对比
    const s1MatSnapshot = await s1MixedDecisions(page);
    await s2Bulk(page);
    await s3HistoryRollback(page, s1MatSnapshot);
    await s4ExternalModified(page);
    await e5ConflictLoop(page);
    await c6CliToWeb(page);
  } catch (e) {
    check("主流程无异常", false, String(e?.stack ?? e));
    console.error(e);
  } finally {
    await browser.close();
  }

  // 汇总
  console.log(`\n===== E2E 汇总 =====`);
  console.log(`总断言 ${total}，失败 ${failures}`);
  if (failures > 0) {
    for (const r of results) if (r.startsWith("FAIL")) console.log(r);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E 驱动崩溃:", e);
  process.exit(1);
});
