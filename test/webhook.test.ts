import { createHmac } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import type { Quote } from "../src/core/types.js";
import { tencentSource } from "../src/market/tencent.js";
import { channelsFor, combine } from "../src/notify/index.js";
import type { RenderedEmail } from "../src/notify/render.js";
import { buildRequest, createWebhookNotifier, dingtalkSign, feishuSign, truncateBytes, webhookSchema } from "../src/notify/webhook.js";
import { tick } from "../src/scheduler.js";

const msg: RenderedEmail = { subject: "【gridbot】1 个交易信号：沪深300ETF 买入 1000", text: "买入 1000 @ 3.4", html: "<p>买入</p>" };

// 假的平台接口：按路径返回各平台的成功 / 失败格式，并记录收到的请求
let server: Server;
let base: string;
const got: { path: string; body: string; type?: string }[] = [];
const REPLIES: Record<string, [number, unknown]> = {
  "/wecom/ok": [200, { errcode: 0, errmsg: "ok" }],
  "/wecom/bad": [200, { errcode: 93000, errmsg: "invalid webhook url" }],
  "/dingtalk/ok": [200, { errcode: 0, errmsg: "ok" }],
  "/dingtalk/bad": [200, { errcode: 310000, errmsg: "sign not match" }],
  "/feishu/ok": [200, { code: 0, msg: "success" }],
  "/feishu/bad": [200, { code: 19021, msg: "sign match fail" }],
  "/botTOKEN123/sendMessage": [200, { ok: true }],
  "/botBAD/sendMessage": [401, { ok: false, description: "Unauthorized" }],
  "/bark/KEY": [200, { code: 200, message: "success" }],
  "/hook": [204, ""],
  "/hook500": [500, "boom"],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = (req.url ?? "").split("?")[0]!;
      got.push({ path: req.url ?? "", body, type: req.headers["content-type"] });
      const [status, reply] = REPLIES[p] ?? [404, { error: "not found" }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof reply === "string" ? reply : JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  got.length = 0;
  vi.restoreAllMocks();
});

const hook = (cfg: unknown) => createWebhookNotifier(webhookSchema.parse(cfg));
const lastBody = () => JSON.parse(got.at(-1)!.body);

describe("各平台推送", () => {
  it("企业微信：text 消息；errcode 非 0 视为失败", async () => {
    await hook({ type: "wecom", url: `${base}/wecom/ok` }).send(msg);
    expect(lastBody()).toEqual({ msgtype: "text", text: { content: `${msg.subject}\n\n${msg.text}` } });
    await expect(hook({ type: "wecom", url: `${base}/wecom/bad` }).send(msg)).rejects.toThrow("企业微信推送失败：invalid webhook url（errcode=93000）");
  });

  it("钉钉：加签参数附加在地址上", async () => {
    await hook({ type: "dingtalk", url: `${base}/dingtalk/ok?access_token=abc`, secret: "SEC123" }).send(msg);
    const u = new URL(base + got.at(-1)!.path);
    const ts = Number(u.searchParams.get("timestamp"));
    expect(u.searchParams.get("access_token")).toBe("abc");
    expect(u.searchParams.get("sign")).toBe(createHmac("sha256", "SEC123").update(`${ts}\nSEC123`).digest("base64"));
    expect(lastBody().msgtype).toBe("text");
    await expect(hook({ type: "dingtalk", url: `${base}/dingtalk/bad` }).send(msg)).rejects.toThrow("sign not match");
  });

  it("飞书：签名放在请求体中（秒级时间戳）", async () => {
    await hook({ type: "feishu", url: `${base}/feishu/ok`, secret: "S" }).send(msg);
    const b = lastBody();
    expect(b.msg_type).toBe("text");
    expect(b.timestamp).toMatch(/^\d{10}$/);
    expect(b.sign).toBe(createHmac("sha256", `${b.timestamp}\nS`).update("").digest("base64"));
    await expect(hook({ type: "feishu", url: `${base}/feishu/bad` }).send(msg)).rejects.toThrow("sign match fail");
  });

  it("签名算法", () => {
    expect(dingtalkSign("s", 1)).toBe(createHmac("sha256", "s").update("1\ns").digest("base64"));
    expect(feishuSign("s", 1)).toBe(createHmac("sha256", "1\ns").update("").digest("base64"));
  });

  it("Telegram：sendMessage；失败时不在错误中暴露 botToken", async () => {
    await hook({ type: "telegram", botToken: "TOKEN123", chatId: 42, apiBase: base }).send(msg);
    expect(got.at(-1)!.path).toBe("/botTOKEN123/sendMessage");
    expect(lastBody()).toMatchObject({ chat_id: 42, text: `${msg.subject}\n\n${msg.text}` });
    const err = await hook({ type: "telegram", botToken: "BAD", chatId: "1", apiBase: base }).send(msg).then(() => new Error("应当失败"), (e: Error) => e);
    expect(err.message).toBe("Telegram推送失败：HTTP 401");
  });

  it("Bark", async () => {
    await hook({ type: "bark", url: `${base}/bark/KEY` }).send(msg);
    expect(lastBody()).toMatchObject({ title: msg.subject, body: msg.text, group: "gridbot" });
  });

  it("Server酱：两种 SendKey 对应不同地址，表单提交", () => {
    const a = buildRequest(webhookSchema.parse({ type: "serverchan", sendKey: "SCT123abc" }), msg);
    expect(a.url).toBe("https://sctapi.ftqq.com/SCT123abc.send");
    expect(a.contentType).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(a.body).get("desp")).toBe(msg.text);
    expect(buildRequest(webhookSchema.parse({ type: "serverchan", sendKey: "sctp9527tABC" }), msg).url).toBe(
      "https://9527.push.ft07.com/send/sctp9527tABC.send",
    );
    expect(a.check({ code: 40001, message: "bad key" })).toContain("bad key");
  });

  it("通用 Webhook：POST JSON，自定义请求头，只看 HTTP 状态", async () => {
    await hook({ type: "webhook", url: `${base}/hook`, headers: { "X-Token": "t" } }).send(msg);
    expect(lastBody()).toEqual({ title: msg.subject, text: msg.text, html: msg.html });
    await expect(hook({ type: "webhook", url: `${base}/hook500` }).send(msg)).rejects.toThrow("HTTP 500");
  });

  it("网络失败时不在错误中暴露地址", async () => {
    const err = await hook({ type: "wecom", url: "http://127.0.0.1:9/cgi-bin/webhook/send?key=SECRET" }).send(msg).then(() => new Error("应当失败"), (e: Error) => e);
    expect(err.message).toBe("企业微信推送失败：网络请求失败");
    expect(err.message).not.toContain("SECRET");
  });

  it("企业微信按字节截断，不截出半个汉字", () => {
    const long = "网".repeat(2000); // 6000 字节
    const t = truncateBytes(long, 2048);
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(2048);
    expect(t).not.toContain("�");
    expect(t.endsWith("（内容过长已截断）")).toBe(true);
    const req = buildRequest(webhookSchema.parse({ type: "wecom", url: "https://x.com/a" }), { ...msg, text: long });
    expect(Buffer.byteLength(JSON.parse(req.body).text.content)).toBeLessThanOrEqual(2048);
  });

  it("配置校验", () => {
    expect(webhookSchema.safeParse({ type: "wecom", url: "ftp://x" }).success).toBe(false);
    expect(webhookSchema.safeParse({ type: "wechat", url: "https://x" }).success).toBe(false);
    expect(webhookSchema.safeParse({ type: "telegram", chatId: 1 }).success).toBe(false);
  });
});

describe("多渠道", () => {
  const cfg = (webhooks: string) =>
    mkdtemp(path.join(tmpdir(), "gridbot-wh-")).then((dir) =>
      parseConfig(`notify:\n  webhooks:\n${webhooks}\nwatchlist: [{ symbol: sh510300, basePrice: 4, position: 10000 }]`, path.join(dir, "gridbot.yaml")),
    );
  const quote: Quote = { symbol: "sh510300", market: "cn", name: "沪深300ETF", price: 3.4, prevClose: 3.4, lotSize: 100, currency: "CNY", time: "2026-11-17 10:00:00", suspended: false };
  const tue = new Date("2026-11-17T02:00:00Z");

  it("部分渠道失败：已发送成功的渠道算数，保存状态并报告失败的渠道", async () => {
    const config = await cfg(`    - { type: wecom, url: "${base}/wecom/ok" }\n    - { type: feishu, url: "${base}/feishu/bad", name: 飞书群 }`);
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", quote]]));
    const out = await tick(config, { now: tue });
    expect(out).toMatchObject({ status: "checked", notified: true, report: { sent: ["企业微信"], failed: [{ channel: "飞书群" }] } });
    expect(JSON.parse(await readFile(config.statePath, "utf8")).symbols.sh510300.triggered).toEqual(["down15"]);
  });

  it("全部渠道失败：不保存状态，下次重新提醒", async () => {
    const config = await cfg(`    - { type: wecom, url: "${base}/wecom/bad" }\n    - { type: dingtalk, url: "${base}/dingtalk/bad" }`);
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", quote]]));
    const out = await tick(config, { now: tue });
    expect(out.status).toBe("notify-failed");
    if (out.status === "notify-failed") expect(out.error).toContain("企业微信推送失败");
    await expect(readFile(config.statePath, "utf8")).rejects.toThrow();
  });

  it("没有配置任何渠道时返回 null", async () => {
    const config = await cfg("    []");
    expect(combine(channelsFor(config))).toBeNull();
  });
});
