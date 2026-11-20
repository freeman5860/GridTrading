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
    // 买入 1000 @ 3.4：持仓 11000，成本 (4×10000 + 3.4×1000) / 11000 ≈ 3.945（没配置 cash 时不改资金）
    expect(await res.json()).toEqual({ ok: true, position: 11000, basePrice: 3.945 });
    const state = JSON.parse(await readFile(path.join(dir, ".gridbot/state.json"), "utf8"));
    expect(state.symbols.sh510300.triggered).toEqual(["down15"]);
    expect(await readFile(configPath, "utf8")).toContain("position: 11000");

    expect((await post("/api/holdings/sh510300/execute", {})).status).toBe(409);
    expect((await post("/api/holdings/hk02800/execute", {})).status).toBe(409);
  });

  it("定时检查提醒过的信号：页面不再显示为新信号，但可以确认成交或忽略", async () => {
    const { runCheck } = await import("../src/check.js");
    const { loadConfig } = await import("../src/config.js");
    await runCheck(await loadConfig(configPath)); // 模拟定时检查发送提醒后保存状态
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await (await fetch(base + "/api/status")).json();
    expect(data.check.signalCount).toBe(0);
    expect(data.state.sh510300.alerted).toMatchObject({ positionAfter: 11000 });

    expect(await (await post("/api/holdings/sh510300/execute", { position: 10900, basePrice: 3.95 })).json()).toEqual({ ok: true, position: 10900, basePrice: 3.95 });
    let state = JSON.parse(await readFile(path.join(dir, ".gridbot/state.json"), "utf8"));
    expect(state.symbols.sh510300.alerted).toBeUndefined();
    expect(state.symbols.sh510300.triggered).toEqual(["down15"]);
    expect(await readFile(configPath, "utf8")).toContain("position: 10900");
    // 改了基准价也不会重复提醒
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after: any = await (await fetch(base + "/api/status")).json();
    expect(after.check.signalCount).toBe(0);
    expect((await post("/api/holdings/sh510300/execute", {})).status).toBe(409);

    // 忽略：持仓不变，档位仍算已触发
    await writeFile(configPath, CONFIG);
    await rm(path.join(dir, ".gridbot"), { recursive: true, force: true });
    await runCheck(await loadConfig(configPath));
    expect((await post("/api/holdings/sh510300/dismiss", {})).status).toBe(200);
    state = JSON.parse(await readFile(path.join(dir, ".gridbot/state.json"), "utf8"));
    expect(state.symbols.sh510300).toMatchObject({ triggered: ["down15"] });
    expect(state.symbols.sh510300.alerted).toBeUndefined();
    expect(await readFile(configPath, "utf8")).toContain("position: 10000");
  });

  it("AI 暂缓中的档位：页面不作为新信号重复显示，确认成交后结束暂缓", async () => {
    const hold = { decision: "hold", reason: "单边下跌", by: "m" };
    const { saveState } = await import("../src/state.js");
    await saveState(path.join(dir, ".gridbot/state.json"), {
      version: 1,
      symbols: {
        sh510300: {
          basePrice: 4, triggered: [],
          deferred: { down15: { date: "2026-11-17", review: hold } },
          alerted: { at: "2026-11-17T02:00:00Z", positionAfter: 11000, signals: [{ layer: "tier", action: "buy", quantity: 1000, price: 3.4, amount: 3400, ruleId: "down15", reason: "", review: hold }] },
        },
      },
    } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await (await fetch(base + "/api/status")).json();
    expect(data.check.signalCount).toBe(0);
    expect(data.state.sh510300.deferred.down15.review.decision).toBe("hold");

    expect(await (await post("/api/holdings/sh510300/execute", {})).json()).toMatchObject({ position: 11000 });
    const state = JSON.parse(await readFile(path.join(dir, ".gridbot/state.json"), "utf8"));
    expect(state.symbols.sh510300.triggered).toEqual(["down15"]);
    expect(state.symbols.sh510300.deferred).toBeUndefined();
  });

  it("没有开启监控时状态中说明", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await (await fetch(base + "/api/status")).json();
    expect(data.monitor).toMatchObject({ enabled: false });
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

describe("设置向导", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getSetup = async (): Promise<any> => (await fetch(base + "/api/setup")).json();
  const HOOK_KEY = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET-hook";

  it("读取配置：密钥只返回是否已设置，从不返回内容", async () => {
    vi.stubEnv("TG_TOKEN", "123:abc");
    await writeFile(configPath, CONFIG + `  - symbol: AAPL\n    basePrice: 200\n    position: 10\n    grid: { lower: 180, upper: 220, step: "2%", size: 1 }\n`);
    const saved = await post("/api/setup/notify", {
      email: { host: "smtp.qq.com", port: 465, user: "a@qq.com", to: "a@qq.com" },
      webhooks: [{ type: "wecom", url: HOOK_KEY }, { type: "telegram", botToken: "${TG_TOKEN}", chatId: "42" }],
    });
    expect(saved.status).toBe(200);
    const res = await fetch(base + "/api/setup");
    const text = await res.text();
    for (const s of [SECRET_KEY, SECRET_PASS, HOOK_KEY, "SECRET-hook"]) expect(text).not.toContain(s);
    const data = JSON.parse(text);
    expect(data.exists).toBe(true);
    expect(data.watchlist.map((h: { symbol: string }) => h.symbol)).toEqual(["510300", "hk02800", "AAPL"]);
    expect(data.watchlist[2].grid).toMatchObject({ lower: 180, step: "2%" });
    expect(data.notify.email.pass).toEqual({ set: true });
    expect(data.notify.webhooks[0].secrets.url).toEqual({ set: true });
    expect(data.notify.webhooks[1].secrets.botToken).toEqual({ set: true, env: "TG_TOKEN", envSet: true });
    expect(data.ai).toMatchObject({ provider: "claude", apiKey: { set: true } });
    vi.unstubAllEnvs();
  });

  it("保存持仓：保留注释和原有代码写法，支持增删", async () => {
    const res = await post("/api/setup/watchlist", {
      items: [
        { symbol: "sh510300", basePrice: 4.2, position: 9000, cash: 1000, tiers: true },
        { symbol: "QQQ", basePrice: 600, position: 5, tiers: false, grid: { lower: 560, upper: 680, step: "2%", size: 1 } },
      ],
    });
    expect(res.status).toBe(200);
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("# 顶部注释");
    expect(text).toContain("# 行内注释");
    expect(text).toContain("symbol: 510300");
    expect(text).toContain("basePrice: 4.2");
    expect(text).not.toContain("hk02800");
    expect(text).toContain("symbol: QQQ");
    expect(text).toContain("tiers: false");
    expect(text).toMatch(/step: "?2%"?/);
    // 密钥原样保留
    expect(text).toContain(SECRET_KEY);
  });

  it("保存持仓：港股通标记", async () => {
    await post("/api/setup/watchlist", { items: [{ symbol: "hk02800", basePrice: 20, position: 5000, cash: 10000, connect: true }] });
    expect(await readFile(configPath, "utf8")).toContain("connect: true");
    expect((await getSetup()).watchlist[0]).toMatchObject({ symbol: "hk02800", connect: true });
    await post("/api/setup/watchlist", { items: [{ symbol: "hk02800", basePrice: 20, position: 5000, connect: false }] });
    expect(await readFile(configPath, "utf8")).not.toContain("connect");
    // A 股不能设置港股通
    expect((await post("/api/setup/watchlist", { items: [{ symbol: "510300", basePrice: 4, position: 1, connect: true }] })).status).toBe(400);
  });

  it("保存持仓：非法值返回错误且不写入", async () => {
    const before = await readFile(configPath, "utf8");
    expect((await post("/api/setup/watchlist", { items: [] })).status).toBe(400);
    expect((await post("/api/setup/watchlist", { items: [{ symbol: "510300", basePrice: 0, position: 1 }] })).status).toBe(400);
    expect((await post("/api/setup/watchlist", { items: [{ symbol: "510300", basePrice: "abc", position: 1 }] })).status).toBe(400);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("保存提醒渠道：密钥留空保持原值，按序号保留推送渠道的密钥", async () => {
    await post("/api/setup/notify", { email: { host: "smtp.163.com", port: 465, user: "b@163.com", to: "b@163.com, c@163.com" }, webhooks: [{ type: "bark", url: "https://api.day.app/KEY1" }], interval: "5m" });
    let text = await readFile(configPath, "utf8");
    expect(text).toContain(SECRET_PASS);
    expect(text).toContain("smtp.163.com");
    expect(text).toContain("c@163.com");
    expect(text).toContain("interval: 5m");

    // 修改名称、不填地址：地址保持不变
    await post("/api/setup/notify", { email: null, webhooks: [{ index: 0, type: "bark", name: "我的手机" }] });
    text = await readFile(configPath, "utf8");
    expect(text).toContain("https://api.day.app/KEY1");
    expect(text).toContain("我的手机");
    expect(text).not.toContain("email");

    // 新增渠道缺少地址：校验失败
    expect((await post("/api/setup/notify", { webhooks: [{ type: "wecom" }] })).status).toBe(400);

    await post("/api/setup/notify", { email: null, webhooks: [] });
    expect(await readFile(configPath, "utf8")).not.toContain("notify");
  });

  it("保存 AI：同一服务保留 Key，更换服务不沿用旧 Key", async () => {
    await post("/api/setup/ai", { ai: { provider: "claude", model: "claude-sonnet-5-5" } });
    let text = await readFile(configPath, "utf8");
    expect(text).toContain(SECRET_KEY);
    expect(text).toContain("claude-sonnet-5-5");

    await post("/api/setup/ai", { ai: { provider: "local", model: "qwen3" } });
    text = await readFile(configPath, "utf8");
    expect(text).not.toContain(SECRET_KEY);
    expect(text).toContain("provider: local");

    await post("/api/setup/ai", { ai: null });
    expect(await readFile(configPath, "utf8")).not.toMatch(/^ai:/m);
  });

  it("没有配置文件：状态提示需要设置，保存持仓后创建配置", async () => {
    await rm(configPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status: any = await (await fetch(base + "/api/status")).json();
    expect(status.missing).toBe(true);
    expect((await getSetup()).exists).toBe(false);

    expect((await post("/api/setup/watchlist", { items: [{ symbol: "510300", basePrice: 4, position: 100 }] })).status).toBe(200);
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("interval: 15m");
    expect(text).toContain('symbol: "510300"');
    expect((await getSetup()).exists).toBe(true);
  });

  it("行情查询", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { quotes }: any = await (await fetch(base + "/api/quote?symbols=510300,hk2800,!!")).json();
    expect(quotes[0]).toMatchObject({ symbol: "sh510300", name: "沪深300ETF", price: 3.4 });
    expect(quotes[1]).toMatchObject({ symbol: "hk02800" });
    expect(quotes[2].error).toBeTruthy();
  });

  it("测试提醒 / AI：未配置时给出提示", async () => {
    await writeFile(configPath, "watchlist:\n  - { symbol: 510300, basePrice: 4, position: 1 }\n");
    expect(await (await post("/api/setup/test-notify", {})).json()).toEqual({ error: "还没有配置提醒渠道" });
    expect(await (await post("/api/setup/test-ai", {})).json()).toEqual({ error: "还没有配置 AI" });
  });
});
