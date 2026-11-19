// 买入信号的 AI 决策
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIClient, ChatRequest } from "../src/ai/providers.js";
import { describeHistory, historySource, parseKline, type Bar } from "../src/ai/review.js";
import { parseConfig } from "../src/config.js";
import type { Quote } from "../src/core/types.js";
import { tencentSource } from "../src/market/tencent.js";
import type { RenderedEmail } from "../src/notify/render.js";
import { tick } from "../src/scheduler.js";

afterEach(() => vi.restoreAllMocks());

function fakeAI(...replies: (string | Error)[]): AIClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    provider: "gemini",
    model: "gemini-4-hydrogen",
    requests,
    async *stream(req) {
      requests.push(req);
      const r = replies.shift() ?? "";
      if (r instanceof Error) throw r;
      yield { t: "text", v: r };
    },
  };
}

const bars = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, open: c, close: c, high: c + 1, low: c - 1 }));

describe("历史行情", () => {
  it("解析腾讯日 K（含前复权字段名和美股完整代码）", () => {
    const json = { data: { usQQQ: { day: [["2011-06-02", "57.18", "57.18", "57.4", "56.91", "1"]], qt: { usQQQ: ["x", "QQQ", "QQQ.OQ"] } } } };
    expect(parseKline(json, "usQQQ")).toMatchObject({ fullCode: "QQQ.OQ", bars: [{ date: "2011-06-02", close: 57.18 }] });
    const cn = { data: { sh510300: { qfqday: [["2026-11-19", "4.05", "4.03", "4.05", "4.01", "7"]] } } };
    expect(parseKline(cn, "sh510300").bars[0]).toEqual({ date: "2026-11-19", open: 4.05, close: 4.03, high: 4.05, low: 4.01 });
  });

  it("走势摘要：涨跌幅、均线、下跌天数", () => {
    const text = describeHistory(bars([100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90]));
    expect(text).toContain("近 5 日 -5.3%");
    expect(text).toContain("最近 10 个交易日中 10 天下跌");
    expect(describeHistory(bars([1, 2]))).toContain("没有足够");
  });
});

describe("定时检查中的 AI 决策", () => {
  const now = new Date("2026-11-17T02:00:00Z");
  const q = (price: number): Quote => ({
    symbol: "sh510300", market: "cn", name: "沪深300ETF", price, prevClose: price, lotSize: 100, currency: "CNY", time: "2026-11-17 10:00:00", suspended: false,
  });
  async function setup(ai = "ai: { provider: gemini, apiKey: k }\n") {
    const dir = await mkdtemp(path.join(tmpdir(), "gridbot-review-"));
    return parseConfig(`${ai}watchlist:\n  - { symbol: sh510300, basePrice: 4, position: 10000 }\n`, path.join(dir, "gridbot.yaml"));
  }
  const mails: RenderedEmail[] = [];
  const notifier = { send: async (m: RenderedEmail) => void mails.push(m) };
  afterEach(() => (mails.length = 0));

  it("买入信号：带上历史走势请 AI 决策，结论写入提醒和待确认记录", async () => {
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", q(3.4)]]));
    const history = vi.spyOn(historySource, "fetchHistory").mockResolvedValue(bars([4, 3.9, 3.8, 3.7, 3.6, 3.5, 3.4]));
    const ai = fakeAI(JSON.stringify({ decision: "hold", reason: "近期连续下跌，单边下跌中网格失效，建议等企稳" }));
    const config = await setup();
    const out = await tick(config, { now, notifier, ai });

    expect(out.status).toBe("checked");
    expect(history).toHaveBeenCalledWith("sh510300", 60, expect.anything());
    expect(ai.requests[0]!.prompt).toContain("<history>");
    expect(ai.requests[0]!.prompt).toContain("买入 1000 @ 3.4");
    expect(ai.requests[0]!.system).toContain("第一层：分档仓位管理");
    expect(mails[0]!.subject).toContain("（AI 建议暂缓）");
    expect(mails[0]!.text).toContain("AI 决策：建议暂缓（Gemini · gemini-4-hydrogen）——近期连续下跌");
    expect(mails[0]!.html).toContain("AI 决策：建议暂缓");

    const state = JSON.parse(await readFile(config.statePath, "utf8"));
    expect(state.symbols.sh510300.alerted.signals[0].review).toMatchObject({ decision: "hold" });
  });

  it("AI 失败时照常按规则提醒，并说明", async () => {
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", q(3.4)]]));
    vi.spyOn(historySource, "fetchHistory").mockRejectedValue(new Error("down"));
    const out = await tick(await setup(), { now, notifier, ai: fakeAI("not json") });
    expect(out).toMatchObject({ status: "checked", notified: true });
    expect(mails[0]!.text).toContain("AI 决策：AI 决策失败");
    expect(mails[0]!.subject).not.toContain("AI 建议");
  });

  it("卖出信号、关闭 reviewBuys、没有配置 AI 时不调用 AI", async () => {
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", q(5)]])); // +25% 卖出
    const ai = fakeAI();
    await tick(await setup(), { now, notifier, ai });
    expect(ai.requests).toHaveLength(0);

    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", q(3.4)]]));
    await tick(await setup("ai: { provider: gemini, apiKey: k, reviewBuys: false }\n"), { now, notifier, ai });
    await tick(await setup(""), { now, notifier, ai });
    expect(ai.requests).toHaveLength(0);
    expect(mails.at(-1)!.text).not.toContain("AI 决策");
  });
});
