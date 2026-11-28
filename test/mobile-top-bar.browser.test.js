import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 窄屏顶栏在真实浏览器里的几何：布局警告和修订记录按钮同时出现时，320/360px 下 More 曾被挤出
// 视口，用户无法发布或结束会话。断言的是用户能感知的结果：顶栏不撑宽页面、More 在视口内且
// 点击命中、菜单里的 End session 可见、修订记录抽屉不伸出视口；只有修订记录时同样成立。
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repoRoot, "test/fixtures/layout-audit");

const REVISIONS = `<script type="application/json" data-lavish-revisions>[
{"id":"r1","label":"Round 1","timestamp":"2026-11-28T10:00:00Z","summary":"Initial draft"},
{"id":"r2","label":"Round 2","timestamp":"2026-11-28T11:00:00Z","summary":"Tightened copy"},
{"id":"r3","label":"Round 3","timestamp":"2026-11-28T12:00:00Z","summary":"Added footer"}]</script>
<p data-lavish-revision="r1">One</p><p data-lavish-revision="r2">Two</p><p data-lavish-revision="r3">Three</p>`;

const CLEAN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clean</title>
<style>body{margin:0;padding:24px;background:#fff;color:#111;font-family:Georgia,serif}</style></head>
<body><h1>Plan</h1></body></html>`;

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

// 返回顶栏状态；More 的命中用 elementFromPoint 判断，被遮挡或在视口外都算点不到。
const BAR = `() => {
  const visible = (id) => { const el = document.getElementById(id); return !!el && !el.hidden; };
  const more = document.getElementById("moreButton").getBoundingClientRect();
  const hit = document.elementFromPoint(more.left + more.width / 2, more.top + more.height / 2);
  return JSON.stringify({
    pageWidth: document.documentElement.scrollWidth,
    warnings: visible("warningsWrap"),
    revisions: visible("revisionsWrap"),
    moreInside: more.left >= 0 && more.right <= innerWidth && more.top >= 0 && more.bottom <= innerHeight,
    moreHit: !!hit && !!hit.closest("#moreButton"),
  });
}`;

const OPEN_MENUS = `() => {
  const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; };
  document.getElementById("revisionsButton").click();
  const revisions = box("revisionsDrawer");
  document.getElementById("revisionsButton").click();
  document.getElementById("moreButton").click();
  const end = document.getElementById("end").getBoundingClientRect();
  return JSON.stringify({
    revisions,
    expanded: document.getElementById("moreButton").getAttribute("aria-expanded"),
    endInside: end.left >= 0 && end.right <= innerWidth && end.top >= 0 && end.bottom <= innerHeight,
    endHit: !!document.elementFromPoint(end.left + end.width / 2, end.top + end.height / 2)?.closest("#end"),
  });
}`;

test(
  "the phone top bar keeps More reachable when layout warnings and revisions both show",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-top-bar-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-top-bar-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    function wait(ms) {
      run("chrome-devtools-axi", ["wait", String(ms)], chromeEnv, ms + 45_000);
    }

    /** 打开会话并等到期望的按钮组合出现（布局审计是异步的），返回顶栏状态。 */
    function openAt(url, width, expectWarnings) {
      // emulate 需要已选中的页面，所以先打开再仿真，再重新打开让首屏按目标宽度布局。
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      run("chrome-devtools-axi", ["emulate", "--viewport", `${width}x760x3,mobile,touch`], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      let bar;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        wait(500);
        bar = evaluate(BAR);
        if (bar.revisions && bar.warnings === expectWarnings) break;
      }
      return bar;
    }

    function assertMoreReachable(bar, width, label) {
      const where = `${label} @${width}px: ${JSON.stringify(bar)}`;
      assert.ok(bar.pageWidth <= width, `top bar does not widen the page: ${where}`);
      assert.equal(bar.moreInside, true, `More is inside the viewport: ${where}`);
      assert.equal(bar.moreHit, true, `More receives the tap: ${where}`);
      const snapshot = run("chrome-devtools-axi", ["snapshot"], chromeEnv);
      assert.match(snapshot, /\bbutton "Annotate"/, where);
      assert.match(snapshot, /\bbutton "3 revisions"/, where);
      const menu = evaluate(OPEN_MENUS);
      assert.ok(
        menu.revisions.width > 0 && menu.revisions.left >= 0 && menu.revisions.right <= width,
        `the revisions drawer opens inside the viewport: ${where} ${JSON.stringify(menu.revisions)}`,
      );
      assert.equal(menu.expanded, "true", `More opens its menu: ${where}`);
      assert.equal(menu.endInside, true, `End session is inside the viewport: ${where}`);
      assert.equal(menu.endHit, true, `End session receives the tap: ${where}`);
    }

    try {
      const both = path.join(temp, "both.html");
      const clipping = await readFile(path.join(fixtures, "control-broken-clipping.html"), "utf8");
      await writeFile(both, clipping.replace("</body>", `${REVISIONS}</body>`));
      const revisionsOnly = path.join(temp, "revisions.html");
      await writeFile(revisionsOnly, CLEAN.replace("</body>", `${REVISIONS}</body>`));
      const urlFor = (file) => {
        const output = run(process.execPath, ["bin/lavish-axi.js", file, "--no-open"], lavishEnv);
        const url = output.match(/url:\s*"([^"]+)"/)?.[1];
        assert.ok(url, output);
        return url;
      };
      const bothUrl = urlFor(both);
      const revisionsUrl = urlFor(revisionsOnly);

      for (const width of [320, 360, 390]) {
        const bar = openAt(bothUrl, width, true);
        assert.equal(bar.warnings, true, `fixture raises a layout warning @${width}px`);
        assert.equal(bar.revisions, true, `fixture declares revisions @${width}px`);
        assertMoreReachable(bar, width, "warnings + revisions");
      }
      const bar = openAt(revisionsUrl, 320, false);
      assert.equal(bar.warnings, false);
      assertMoreReachable(bar, 320, "revisions only");
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
