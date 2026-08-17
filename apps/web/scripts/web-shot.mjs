/**
 * 面板截图驱动（T1-12 视觉核验输入）：headless-shell + CDP 驱动真实交互，
 * 产出 ≥3 张状态截图（初始态 / 混合裁决中 / 写回后 / 回滚态）。
 *
 * 零依赖（Node >=21 原生 WebSocket）：起 headless-shell（--remote-debugging-port）→
 * CDP 导航 + 点击 + 处理 confirm 对话框 → Page.captureScreenshot 全页 PNG。
 * 用法：node scripts/web-shot.mjs [输出目录]（默认 /tmp/nsw-shots）
 * 前置：server 已起（PORT=8787）+ seed 数据已造（node scripts/seed-demo.mjs）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/nsw-shots";
const BASE = "http://localhost:8787";
const SHELL = join(
  process.env.HOME,
  ".cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
);
const DEBUG_PORT = 9223;

mkdirSync(OUT, { recursive: true });

/** 起 headless-shell 并等 CDP 就绪。 */
async function launchShell() {
  const proc = spawn(
    SHELL,
    [
      "--headless",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1440,3400",
      `--remote-debugging-port=${DEBUG_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) return proc;
    } catch {
      /* 未就绪，重试 */
    }
    await sleep(200);
  }
  throw new Error("headless-shell CDP 未就绪");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小 CDP 客户端（id 自增 + 事件等待）。 */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else if (msg.method) {
        const list = this.waiters.get(msg.method) ?? [];
        this.waiters.set(msg.method, []);
        for (const w of list) w.resolve(msg.params);
      }
    };
  }
  async open() {
    if (this.ws.readyState === WebSocket.CONNECTING) {
      await new Promise((r) => (this.ws.onopen = r));
    }
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method) {
    return new Promise((resolve) => {
      const list = this.waiters.get(method) ?? [];
      list.push({ resolve });
      this.waiters.set(method, list);
    });
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  const shellProc = await launchShell();
  const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === "page");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // 导航
  await cdp.send("Page.navigate", { url: BASE + "/" });
  await sleep(2500); // 面板 fetch + 渲染

  const shot = async (name) => {
    const r = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
    console.log(`[shot] ${name}`);
  };

  const click = async (selector, index = 0) => {
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        if (els.length <= ${index}) return false;
        els[${index}].click();
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(600);
  };

  const clickByText = async (selector, text) => {
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = els.find((e) => e.textContent.includes(${JSON.stringify(text)}));
        if (!el) return false;
        el.click();
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(600);
  };

  const readState = async () => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        badge: document.getElementById('statusBadge')?.textContent,
        count: document.querySelector('.fab .count')?.textContent,
        writebackDisabled: document.querySelector('#writeback')?.disabled ?? null,
        blocks: [...document.querySelectorAll('.block')].map(b => b.dataset.blockId + ':' + b.className.match(/block-(\\w+)/)?.[1]),
        rollbackBanner: document.querySelector('.banner.info .msg')?.textContent ?? null,
        okBanner: document.querySelector('.banner.ok .msg')?.textContent ?? null,
      })`,
      returnByValue: true,
    });
    return JSON.parse(r.result.value);
  };

  // ── 1. 初始态（5 块待确认） ──────────────────────────────────────
  await shot("01-initial.png");
  console.log("[state] 初始:", JSON.stringify(await readState()));

  // ── 2. 混合裁决中：块 1✓ 2✓ 3✗（三色可见，3/5，写回禁用） ───────
  await click(".block:nth-of-type(1) .pick.yes");
  await click(".block:nth-of-type(2) .pick.yes");
  await click(".block:nth-of-type(3) .pick.no");
  await shot("02-mixed-3of5.png");
  console.log("[state] 混合裁决:", JSON.stringify(await readState()));

  // ── 3. 全决（3✓ 2✗）→ 写回激活 → 写回物化 v4 ─────────────────────
  await click(".block:nth-of-type(4) .pick.yes");
  await click(".block:nth-of-type(5) .pick.no");
  await shot("03-resolved-ready.png");
  console.log("[state] 全决:", JSON.stringify(await readState()));
  await click("#writeback");
  await sleep(1200);
  await shot("04-resolved.png");
  console.log("[state] 写回后:", JSON.stringify(await readState()));

  // ── 4. 回滚：版本链 → 回滚到 v3（confirm 自动接受）→ 回滚报告态 ─────
  // confirm() 同步阻塞页面 JS：先启动事件驱动的自动接受循环，再触发点击
  const autoAccept = (async () => {
    for (;;) {
      await cdp.once("Page.javascriptDialogOpening");
      await cdp.send("Page.handleJavaScriptDialog", { accept: true });
    }
  })();
  await clickByText("button", "🕘 版本链");
  await sleep(600);
  await clickByText("button", "回滚到此版");
  await sleep(1500);
  await shot("05-rolledback.png");
  console.log("[state] 回滚后:", JSON.stringify(await readState()));

  cdp.close();
  shellProc.kill();
  console.log(`[done] 截图输出目录: ${OUT}`);
}

main().catch((e) => {
  console.error("截图失败:", e);
  process.exit(1);
});
