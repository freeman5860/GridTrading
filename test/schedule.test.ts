import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckResult } from "../src/check.js";
import { parseConfig, parseInterval } from "../src/config.js";
import type { Quote } from "../src/core/types.js";
import { isMarketOpen, localTime, nextOpen, quoteIsFresh } from "../src/market/hours.js";
import { tencentSource } from "../src/market/tencent.js";
import { createEmailNotifier, emailConfigSchema, type Notifier } from "../src/notify/email.js";
import { renderSignalEmail } from "../src/notify/render.js";
import { nextBoundary, tick, watchedMarkets } from "../src/scheduler.js";

const at = (iso: string) => new Date(iso);

describe("交易时段", () => {
  it("A 股：上午、午休、下午、收盘", () => {
    expect(isMarketOpen("cn", at("2026-11-17T01:29:00Z"))).toBe(false); // 09:29
    expect(isMarketOpen("cn", at("2026-11-17T01:30:00Z"))).toBe(true); // 09:30
    expect(isMarketOpen("cn", at("2026-11-17T04:30:00Z"))).toBe(false); // 12:30 午休
    expect(isMarketOpen("cn", at("2026-11-17T07:00:00Z"))).toBe(true); // 15:00 收盘时刻
    expect(isMarketOpen("cn", at("2026-11-17T07:01:00Z"))).toBe(false); // 15:01
  });

  it("港股：12:00 午休、16:00 收盘", () => {
    expect(isMarketOpen("hk", at("2026-11-17T04:00:00Z"))).toBe(true); // 12:00
    expect(isMarketOpen("hk", at("2026-11-17T04:30:00Z"))).toBe(false); // 12:30
    expect(isMarketOpen("hk", at("2026-11-17T07:30:00Z"))).toBe(true); // 15:30（A 股已收盘）
    expect(isMarketOpen("hk", at("2026-11-17T08:01:00Z"))).toBe(false); // 16:01
  });

  it("美股：自动处理夏令时", () => {
    // 冬令时 EST = UTC−5
    expect(isMarketOpen("us", at("2026-11-17T14:29:00Z"))).toBe(false);
    expect(isMarketOpen("us", at("2026-11-17T14:30:00Z"))).toBe(true);
    expect(isMarketOpen("us", at("2026-11-17T21:00:00Z"))).toBe(true); // 16:00 收盘
    // 夏令时 EDT = UTC−4
    expect(isMarketOpen("us", at("2026-07-15T13:29:00Z"))).toBe(false);
    expect(isMarketOpen("us", at("2026-07-15T13:30:00Z"))).toBe(true);
  });

  it("周末休市，下一次开盘为周一", () => {
    const sat = at("2026-11-21T02:00:00Z");
    expect(isMarketOpen("cn", sat)).toBe(false);
    expect(nextOpen("cn", sat).toISOString()).toBe("2026-11-23T01:30:00.000Z");
    expect(nextOpen("us", sat).toISOString()).toBe("2026-11-23T14:30:00.000Z");
  });

  it("美股当地日期与北京时间不同", () => {
    // 北京时间 11-18 早上，纽约仍是 11-17 晚上
    expect(localTime("us", at("2026-11-18T00:30:00Z"))).toMatchObject({ date: "2026-11-17", hhmm: "19:30" });
  });

  it("根据行情日期识别休市日", () => {
    const now = at("2026-11-17T02:00:00Z");
    expect(quoteIsFresh({ market: "cn", time: "2026-11-17 10:00:00" }, now)).toBe(true);
    expect(quoteIsFresh({ market: "cn", time: "2026-11-16 15:00:00" }, now)).toBe(false);
  });

  it("检查间隔解析与对齐", () => {
    expect(parseInterval("15m")).toBe(900_000);
    expect(parseInterval("1h")).toBe(3_600_000);
    expect(parseInterval("90s")).toBe(90_000);
    expect(parseInterval(5)).toBe(300_000);
    expect(() => parseInterval("soon")).toThrow();
    const t = Date.parse("2026-11-17T02:07:12Z");
    expect(new Date(nextBoundary(t, 900_000)).toISOString()).toBe("2026-11-17T02:15:00.000Z");
  });
});

// ---------------- 定时检查（mock 行情） ----------------

function quote(symbol: string, price: number, time: string, market: Quote["market"] = "cn"): Quote {
  return {
    symbol,
    market,
    name: symbol,
    price,
    prevClose: price,
    lotSize: market === "us" ? 1 : 100,
    currency: market === "cn" ? "CNY" : market === "hk" ? "HKD" : "USD",
    time,
    suspended: false,
  };
}

async function setup(yamlBody: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "gridbot-"));
  return parseConfig(yamlBody, path.join(dir, "gridbot.yaml"));
}

const WATCH = `
watchlist:
  - { symbol: sh510300, basePrice: 4, position: 10000 }
  - { symbol: hk02800, basePrice: 20, position: 5000 }
  - { symbol: usQQQ, basePrice: 600, position: 10 }
`;

function mockQuotes(quotes: Quote[]) {
  return vi.spyOn(tencentSource, "fetchQuotes").mockImplementation(async (symbols) => {
    return new Map(quotes.filter((q) => symbols.includes(q.symbol)).map((q) => [q.symbol, q]));
  });
}

const sentMails: string[] = [];
const okNotifier: Notifier = { send: async (m) => void sentMails.push(m.subject) };
const failingNotifier: Notifier = {
  send: async () => {
    throw new Error("邮件发送失败：connect ECONNREFUSED");
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  sentMails.length = 0;
});

describe("定时检查 tick", () => {
  const tueMorning = at("2026-11-17T02:00:00Z"); // 北京 10:00：A 股、港股开盘，美股休市

  it("全部休市时不请求行情，返回各市场下次开盘时间", async () => {
    const config = await setup(WATCH);
    const spy = mockQuotes([]);
    const out = await tick(config, { now: at("2026-11-21T02:00:00Z"), notifier: okNotifier });
    expect(out.status).toBe("closed");
    expect(spy).not.toHaveBeenCalled();
    if (out.status === "closed") expect(out.nextOpen.map((n) => n.market)).toEqual(["cn", "hk", "us"]);
  });

  it("只检查开盘的市场；有信号时发邮件并保存状态", async () => {
    const config = await setup(WATCH);
    const spy = mockQuotes([
      quote("sh510300", 3.4, "2026-11-17 10:00:00"),
      quote("hk02800", 21, "2026-11-17 10:00:00", "hk"),
    ]);
    const out = await tick(config, { now: tueMorning, notifier: okNotifier });
    expect(spy.mock.calls[0]![0]).toEqual(["sh510300", "hk02800"]); // 不请求休市的美股
    expect(out).toMatchObject({ status: "checked", markets: ["cn", "hk"], notified: true });
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]).toContain("sh510300 买入 1000");

    const state = JSON.parse(await readFile(config.statePath, "utf8"));
    expect(state.symbols.sh510300.triggered).toEqual(["down15"]);

    // 同一档不再重复提醒
    await tick(config, { now: tueMorning, notifier: okNotifier });
    expect(sentMails).toHaveLength(1);
  });

  it("无信号时不发邮件", async () => {
    const config = await setup(WATCH);
    mockQuotes([quote("sh510300", 4, "2026-11-17 10:00:00"), quote("hk02800", 20, "2026-11-17 10:00:00", "hk")]);
    const out = await tick(config, { now: tueMorning, notifier: okNotifier });
    expect(out).toMatchObject({ status: "checked", notified: false });
    expect(sentMails).toHaveLength(0);
  });

  it("邮件发送失败时不保存状态，下次检查重新提醒", async () => {
    const config = await setup(WATCH);
    mockQuotes([quote("sh510300", 3.4, "2026-11-17 10:00:00"), quote("hk02800", 20, "2026-11-17 10:00:00", "hk")]);

    const failed = await tick(config, { now: tueMorning, notifier: failingNotifier });
    expect(failed.status).toBe("notify-failed");
    await expect(readFile(config.statePath, "utf8")).rejects.toThrow(); // 没有写入状态

    const retry = await tick(config, { now: tueMorning, notifier: okNotifier });
    expect(retry).toMatchObject({ status: "checked", notified: true });
    expect(sentMails).toHaveLength(1);
  });

  it("交易时段内行情仍是旧日期（节假日）时跳过，不判断也不更新状态", async () => {
    const config = await setup(WATCH);
    mockQuotes([quote("sh510300", 3.4, "2026-11-16 15:00:00"), quote("hk02800", 20, "2026-11-17 10:00:00", "hk")]);
    const out = await tick(config, { now: tueMorning, notifier: okNotifier });
    if (out.status === "closed") throw new Error("应为 checked");
    const cn = out.result.items.find((i) => i.holding.symbol === "sh510300")!;
    expect(cn.skipped).toContain("可能休市");
    expect(out.result.signalCount).toBe(0);
    const state = JSON.parse(await readFile(config.statePath, "utf8"));
    expect(state.symbols.sh510300).toBeUndefined();
  });

  it("schedule.markets 限制监控的市场", async () => {
    const config = await setup(WATCH + "schedule: { markets: [hk] }\n");
    expect(watchedMarkets(config)).toEqual(["hk"]);
    const spy = mockQuotes([quote("hk02800", 20, "2026-11-17 10:00:00", "hk")]);
    await tick(config, { now: tueMorning, notifier: okNotifier });
    expect(spy.mock.calls[0]![0]).toEqual(["hk02800"]);
  });
});

// ---------------- 邮件 ----------------

const sampleResult: CheckResult = {
  checkedAt: "2026-11-17T02:00:00.000Z",
  signalCount: 1,
  items: [
    {
      holding: { symbol: "sh510300", basePrice: 4, position: 10000 },
      quote: quote("sh510300", 3.4, "2026-11-17 10:00:00"),
      evaluation: {
        symbol: "sh510300",
        price: 3.4,
        basePrice: 4,
        change: -0.15,
        positionAfter: 11000,
        nextTiers: {},
        nextState: { basePrice: 4, triggered: ["down15"] },
        signals: [
          { layer: "tier", action: "buy", quantity: 1000, price: 3.4, amount: 3400, ruleId: "down15", reason: "跌到 −15% 增持 10%" },
        ],
        notes: [{ level: "warn", text: "<script>alert(1)</script> 资金提示" }],
      },
    },
    { holding: { symbol: "hk02800", basePrice: 20, position: 0 }, skipped: "休市" },
  ],
};

describe("邮件", () => {
  it("渲染主题、正文，并转义 HTML", () => {
    const mail = renderSignalEmail(sampleResult);
    expect(mail.subject).toBe("【gridbot】1 个交易信号：sh510300 买入 1000");
    expect(mail.text).toContain("买入 1000 @ 3.4");
    expect(mail.text).toContain("10000 → 11000");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.text).not.toContain("hk02800"); // 只包含有信号的标的
  });

  it("SMTP 配置校验：465 默认 SSL，空密码给出提示", () => {
    const c = emailConfigSchema.parse({ host: "smtp.qq.com", user: "a@qq.com", pass: "x", to: "b@qq.com" });
    expect(c).toMatchObject({ port: 465, secure: true, to: ["b@qq.com"] });
    expect(emailConfigSchema.parse({ host: "h", port: 587, user: "u", pass: "p", to: ["x@y.z"] }).secure).toBe(false);
    const bad = emailConfigSchema.safeParse({ host: "h", user: "u", pass: "", to: "x@y.z" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("环境变量");
  });

  it("通过真实 SMTP 协议发送到本地测试服务器", async () => {
    const received: string[] = [];
    let authUser = "";
    const server = new SMTPServer({
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      logger: false,
      onAuth(auth, _session, cb) {
        authUser = auth.username ?? "";
        cb(auth.password === "app-pass" ? null : new Error("bad password"), { user: auth.username });
      },
      onData(stream, _session, cb) {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          received.push(Buffer.concat(chunks).toString("utf8"));
          cb();
        });
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.server.address() as { port: number }).port;

    try {
      const cfg = emailConfigSchema.parse({ host: "127.0.0.1", port, secure: false, user: "bot@example.com", pass: "app-pass", to: ["me@example.com"] });
      await createEmailNotifier(cfg).send(renderSignalEmail(sampleResult));
      expect(authUser).toBe("bot@example.com");
      const mail = await simpleParser(received[0]!);
      expect(mail.subject).toBe("【gridbot】1 个交易信号：sh510300 买入 1000");
      expect(mail.from?.text).toContain("bot@example.com");
      expect(mail.text).toContain("买入 1000");
      expect(mail.html).toContain("跌到 −15% 增持 10%");

      const wrong = emailConfigSchema.parse({ ...cfg, pass: "wrong" });
      await expect(createEmailNotifier(wrong).send(renderSignalEmail(sampleResult))).rejects.toThrow(/邮件发送失败/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
