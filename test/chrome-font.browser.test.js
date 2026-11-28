// 从真实评审会话验证外壳加载 Geist；字体路由的 HTTP 契约由 server.test.js 单独验证。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { serve } from "../src/server.js";

const run = promisify(execFile);

test(
  "the review shell registers and loads the bundled Geist face with swap",
  { skip: process.env.LAVISH_AXI_BROWSER_E2E !== "1", timeout: 160_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-chrome-font-"));
    const chromeEnv = {
      ...process.env,
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "0",
      CHROME_DEVTOOLS_AXI_BROWSER_URL: "",
      CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: "",
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-chrome-font-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(dir, "chrome"),
    };
    /** 执行隔离浏览器命令，返回实际页面结果；每条命令都有超时。 */
    const chrome = (...args) => run("chrome-devtools-axi", args, { env: chromeEnv, timeout: 45_000 });

    try {
      const file = path.join(dir, "review.html");
      await writeFile(file, '<!doctype html><meta charset="utf-8"><h1>Font review</h1>');
      const server = await serve({
        port: 0,
        hosts: ["127.0.0.1"],
        linkHost: "127.0.0.1",
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
      });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const res = await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file }),
        });
        assert.equal(res.status, 200);
        const { key } = await res.json();
        await chrome("open", `${base}/session/${key}`);
        // 读取浏览器实际注册的 FontFace；仅加载字体路由不能证明样式生效。
        const { stdout } = await chrome(
          "eval",
          `async () => {
            await document.fonts.ready;
            const face = [...document.fonts].find((face) => face.family === "Geist" && face.display === "swap");
            if (!face) return "geist-swap-face-missing";
            await face.load();
            return face.status === "loaded" ? "geist-swap-face-loaded" : face.status;
          }`,
        );
        const result = stdout.match(/^result:\s*("(?:[^"\\]|\\.)*")$/m)?.[1];
        assert.ok(result, stdout);
        assert.equal(JSON.parse(JSON.parse(result)), "geist-swap-face-loaded");
      } finally {
        try {
          await chrome("stop");
        } finally {
          await server.close();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
