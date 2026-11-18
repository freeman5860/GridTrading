import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "../src/core/types.js";
import { tencentSource } from "../src/market/tencent.js";
import { allowedHosts, hostnameOf, startServer } from "../src/server/index.js";

const SECRET_KEY = "sk-test-SECRET-should-never-leak";
const SECRET_PASS = "smtp-SECRET-should-never-leak";

const CONFIG = `# 顶部注释
ai:
  provider: claude
  apiKey: ${SECRET_KEY}
notify:
  email: { host: smtp.qq.com, user: a@qq.com, pass: ${SECRET_PASS}, to: a@qq.com }
watchlist:
  - symbol: 510300   # 行内注释
    basePrice: 4
    position: 10000
  - { symbol: hk02800, basePrice: 20, position: 5000 }
`;

const quote = (symbol: string, price: number, market: Quote["market"]): Quote => ({
  symbol,
  market,
  name: symbol === "sh510300" ? "沪深300ETF" : "盈富基金",
  price,
  prevClose: price,
  lotSize: market === "hk" ? 500 : 100,
  currency: market === "hk" ? "HKD" : "CNY",
  time: "2026-11-18 10:00:00",
  suspended: false,
});

let server: Server;
let base: string;
let dir: string;
let configPath: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gridbot-serve-"));
  configPath = path.join(dir, "gridbot.yaml");
  server = await startServer({ configPath, host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  await writeFile(configPath, CONFIG);
  await rm(path.join(dir, ".gridbot"), { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(
    new Map([
      ["sh510300", quote("sh510300", 3.4, "cn")],
      ["hk02800", quote("hk02800", 20, "hk")],
    ]),
  );
});

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("安全", () => {
  it("Host 白名单", () => {
    expect(hostnameOf("127.0.0.1:8686")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:8686")).toBe("[::1]");
    expect(hostnameOf("LocalHost")).toBe("localhost");
    expect(allowedHosts("127.0.0.1").has("evil.com")).toBe(false);
    expect(allowedHosts("192.168.1.5").has("192.168.1.5")).toBe(true);
  });

  it("拒绝非本机 Host（防 DNS 重绑定）", async () => {
    // fetch 不允许改 Host 头，用 node:http 发请求
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      request(base + "/api/status", { headers: { Host: "evil.example.com" } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
  });

  it("拒绝跨站 POST 和非 JSON 请求", async () => {
    expect((await post("/api/holdings/sh510300/reset", {}, { Origin: "http://evil.example.com" })).status).toBe(403);
    const form = await fetch(base + "/api/holdings/sh510300", { method: "POST", body: "position=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(415);
  });

  it("页面带 CSP，接口从不返回密钥", async () => {
    const page = await fetch(base + "/");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const text = await (await fetch(base + "/api/status")).text();
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(SECRET_PASS);
  });

  it("不提供 web 目录以外的文件", async () => {
    expect((await fetch(base + "/../package.json")).status).toBe(404);
    expect((await fetch(base + "/%2e%2e/package.json")).status).toBe(404);
  });
});

describe("接口", () => {
  it("状态：市场、试运行的信号、配置摘要", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await (await fetch(base + "/api/status")).json();
    expect(data.markets.map((m: { market: string }) => m.market)).toEqual(["cn", "hk", "us"]);
    expect(data.check.signalCount).toBe(1);
    expect(data.settings.ai).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
    expect(data.settings.email).toEqual({ host: "smtp.qq.com", to: ["a@qq.com"] });
    // 试运行：不写状态文件
    await expect(readFile(path.join(dir, ".gridbot/state.json"), "utf8")).rejects.toThrow();
  });

  it("修改持仓写回配置并保留注释，非法值不写入", async () => {
    expect((await post("/api/holdings/510300", { position: 12000, cash: 5000 })).status).toBe(200);
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("# 顶部注释");
    expect(text).toContain("# 行内注释");
    expect(text).toContain("position: 12000");
    expect(text).toContain("cash: 5000");

    const bad = await post("/api/holdings/510300", { basePrice: 0 });
    expect(bad.status).toBe(400);
    expect(await readFile(configPath, "utf8")).toBe(text);

    expect((await post("/api/holdings/510300", { cash: null })).status).toBe(200);
    expect(await readFile(configPath, "utf8")).not.toContain("cash:");
  });

  it("已按信号成交：记录档位并更新持仓；没有信号时拒绝", async () => {
    const res = await post("/api/holdings/sh510300/execute", {});
    expect(await res.json()).toEqual({ ok: true, position: 11000 });
    const state = JSON.parse(await readFile(path.join(dir, ".gridbot/state.json"), "utf8"));
    expect(state.symbols.sh510300.triggered).toEqual(["down15"]);
    expect(await readFile(configPath, "utf8")).toContain("position: 11000");

    expect((await post("/api/holdings/sh510300/execute", {})).status).toBe(409);
    expect((await post("/api/holdings/hk02800/execute", {})).status).toBe(409);
  });

  it("部分成交时使用用户填写的持仓", async () => {
    await post("/api/holdings/sh510300/execute", { position: 10500 });
    expect(await readFile(configPath, "utf8")).toContain("position: 10500");
  });

  it("重置档位", async () => {
    await post("/api/holdings/sh510300/execute", {});
    expect((await post("/api/holdings/sh510300/reset", {})).status).toBe(200);
    const state = JSON.parse(await readFile(path.join(dir, ".gridbot/state.json"), "utf8"));
    expect(state.symbols.sh510300).toBeUndefined();
  });

  it("参数错误时返回清晰的错误", async () => {
    expect(await (await post("/api/holdings/usNOPE", { position: 1 })).json()).toEqual({ error: "配置的 watchlist 中没有 usNOPE" });
    expect((await post("/api/holdings/sh510300", { position: "abc" })).status).toBe(400);
    expect((await post("/api/analyze", { images: new Array(7).fill({ mediaType: "image/png", data: "x" }) })).status).toBe(400);
    expect((await post("/api/analyze", { images: [{ mediaType: "text/html", data: "x" }] })).status).toBe(400);
  });

  it("规则文本", async () => {
    const { markdown } = (await (await fetch(base + "/api/rules")).json()) as { markdown: string };
    expect(markdown).toContain("第一层：分档仓位管理");
  });
});
