// 买入信号的 AI 决策
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIClient, ChatRequest } from "../src/ai/providers.js";
import { describeHistory, historySource, normalizeDecision, parseKline, type Bar } from "../src/ai/review.js";
import { settleConfirmed } from "../src/check.js";
import { parseConfig } from "../src/config.js";
import type { Quote, TierId } from "../src/core/types.js";
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
  const day1 = new Date("2026-11-17T02:00:00Z"); // 北京 10:00
  const day2 = new Date("2026-11-18T02:00:00Z");
  const day3 = new Date("2026-11-19T02:00:00Z");
  const q = (price: number, date = "2026-11-17"): Quote => ({
    symbol: "sh510300", market: "cn", name: "沪深300ETF", price, prevClose: price, lotSize: 100, currency: "CNY", time: `${date} 10:00:00`, suspended: false,
  });
  const quoteAt = (price: number, date: string) => vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", q(price, date)]]));
  async function setup(ai = "ai: { provider: gemini, apiKey: k }\n") {
    const dir = await mkdtemp(path.join(tmpdir(), "gridbot-review-"));
    return parseConfig(`${ai}watchlist:\n  - { symbol: sh510300, basePrice: 4, position: 10000 }\n`, path.join(dir, "gridbot.yaml"));
  }
  const decide = (decision: string, extra: object = {}, reason = "理由") => JSON.stringify({ signals: [{ id: 1, decision, ...extra }], reason });
  const mails: RenderedEmail[] = [];
  const notifier = { send: async (m: RenderedEmail) => void mails.push(m) };
  const state = async (c: { statePath: string }) => JSON.parse(await readFile(c.statePath, "utf8")).symbols.sh510300;
  afterEach(() => (mails.length = 0));

  it("暂缓：提醒中写明，档位不算已触发；当天不再询问，之后每个交易日重新决策，建议执行时再提醒", async () => {
    const history = vi.spyOn(historySource, "fetchHistory").mockResolvedValue(bars([4, 3.9, 3.8, 3.7, 3.6, 3.5, 3.4]));
    const config = await setup();
    quoteAt(3.4, "2026-11-17");
    const ai = fakeAI(decide("hold", {}, "近期连续下跌，单边下跌中网格失效，建议等企稳"), decide("hold", {}, "仍在下跌"), decide("execute", {}, "已企稳"));

    await tick(config, { now: day1, notifier, ai });
    expect(history).toHaveBeenCalledWith("sh510300", 60, expect.anything());
    expect(ai.requests[0]!.prompt).toContain("<history>");
    expect(ai.requests[0]!.prompt).toContain('<signals lot="100">\n1. 买入 1000 @ 3.4');
    expect(ai.requests[0]!.system).toContain("第一层：分档仓位管理");
    expect(mails[0]!.subject).toContain("（AI 建议暂缓）");
    expect(mails[0]!.text).toContain("→ AI 建议暂缓");
    expect(mails[0]!.text).toContain("AI 理由（Gemini · gemini-4-hydrogen）：近期连续下跌");
    let st = await state(config);
    expect(st.triggered).toEqual([]);
    expect(st.deferred.down15).toMatchObject({ date: "2026-11-17", review: { decision: "hold" } });
    expect(st.alerted.signals[0].review.decision).toBe("hold");

    // 同一天再次检查：不请 AI、不提醒
    await tick(config, { now: new Date("2026-11-17T02:15:00Z"), notifier, ai });
    expect(ai.requests).toHaveLength(1);
    expect(mails).toHaveLength(1);

    // 第二天：重新决策，仍暂缓 → 不提醒，更新决策日期
    quoteAt(3.35, "2026-11-18");
    const out = await tick(config, { now: day2, notifier, ai });
    expect(ai.requests).toHaveLength(2);
    expect(out).toMatchObject({ status: "checked", notified: false });
    expect(mails).toHaveLength(1);
    st = await state(config);
    expect(st.deferred.down15).toMatchObject({ date: "2026-11-18", review: { reason: "仍在下跌" } });

    // 第三天：建议执行 → 提醒，档位算已触发
    quoteAt(3.38, "2026-11-19");
    await tick(config, { now: day3, notifier, ai });
    expect(mails).toHaveLength(2);
    expect(mails[1]!.subject).toContain("（AI 建议执行）");
    st = await state(config);
    expect(st.triggered).toEqual(["down15"]);
    expect(st.deferred).toBeUndefined();
    expect(st.alerted.signals).toHaveLength(1);
    expect(st.alerted.signals[0].review.decision).toBe("execute");
  });

  it("减量：按整手取整，提醒中写明，待确认的预计持仓按减量后的数量", async () => {
    vi.spyOn(historySource, "fetchHistory").mockResolvedValue([]);
    quoteAt(3.4, "2026-11-17");
    const config = await setup();
    await tick(config, { now: day1, notifier, ai: fakeAI(decide("reduce", { quantity: 550 })) });
    expect(mails[0]!.subject).toContain("（AI 建议减量）");
    expect(mails[0]!.text).toContain("→ AI 建议减量为 500");
    const st = await state(config);
    expect(st.triggered).toEqual(["down15"]);
    expect(st.alerted.positionAfter).toBe(10500);
  });

  it("卖出信号也请 AI 决策", async () => {
    vi.spyOn(historySource, "fetchHistory").mockResolvedValue([]);
    quoteAt(5, "2026-11-17"); // +25%
    const ai = fakeAI(decide("execute"));
    await tick(await setup(), { now: day1, notifier, ai });
    expect(ai.requests[0]!.prompt).toContain("1. 卖出 1000 @ 5");
    expect(mails[0]!.text).toContain("→ AI 建议执行");
  });

  it("AI 失败时照常按规则提醒，并说明", async () => {
    vi.spyOn(historySource, "fetchHistory").mockRejectedValue(new Error("down"));
    quoteAt(3.4, "2026-11-17");
    const config = await setup();
    const out = await tick(config, { now: day1, notifier, ai: fakeAI("not json") });
    expect(out).toMatchObject({ status: "checked", notified: true });
    expect(mails[0]!.text).toContain("AI 决策：AI 决策失败");
    expect(mails[0]!.subject).not.toContain("AI 建议");
    expect((await state(config)).triggered).toEqual(["down15"]);
  });

  it("关闭 review（含旧名称 reviewBuys）、没有配置 AI 时不调用 AI", async () => {
    quoteAt(3.4, "2026-11-17");
    const ai = fakeAI();
    await tick(await setup("ai: { provider: gemini, apiKey: k, review: false }\n"), { now: day1, notifier, ai });
    await tick(await setup("ai: { provider: gemini, apiKey: k, reviewBuys: false }\n"), { now: day1, notifier, ai });
    await tick(await setup(""), { now: day1, notifier, ai });
    expect(ai.requests).toHaveLength(0);
    expect(mails.at(-1)!.text).not.toContain("AI");
  });
});

describe("决策校正与确认", () => {
  it("减量数量按整手向下取整；不小于规则数量视为执行，为 0 视为暂缓", () => {
    expect(normalizeDecision("reduce", 550, 1000, 100, "r", "m")).toMatchObject({ decision: "reduce", quantity: 500 });
    expect(normalizeDecision("reduce", 1200, 1000, 100, "r", "m").decision).toBe("execute");
    expect(normalizeDecision("reduce", 50, 1000, 100, "r", "m").decision).toBe("hold");
  });

  it("忽略 / 确认成交后，暂缓的档位算已触发，不再每天决策", () => {
    const st = {
      basePrice: 4, triggered: [] as TierId[],
      deferred: { down15: { date: "2026-11-17", review: { decision: "hold" as const, reason: "", by: "" } } },
      alerted: { at: "", positionAfter: 11000, signals: [{ layer: "tier" as const, action: "buy" as const, quantity: 1000, price: 3.4, amount: 3400, ruleId: "down15", reason: "" }] },
    };
    settleConfirmed(st, st.alerted.signals);
    expect(st).toEqual({ basePrice: 4, triggered: ["down15"] });
  });
});
