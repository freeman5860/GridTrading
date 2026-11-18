import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzePrompt,
  cleanSymbol,
  analyzeSystemPrompt,
  detectImageType,
  extractionSchema,
  holdingFromExtraction,
  parseJsonObject,
  readImage,
  stateFromTriggered,
} from "../src/ai/analyze.js";
import { AIError, createAIClient, describeAIError, withRetry, type AIClient, type ChatRequest } from "../src/ai/providers.js";
import { codesInText, prepareAnalysis } from "../src/ai/run.js";
import type { CheckResult } from "../src/check.js";
import { parseConfig } from "../src/config.js";
import type { Quote } from "../src/core/types.js";
import { tencentSource } from "../src/market/tencent.js";
import { buildSignalEmail } from "../src/scheduler.js";
import { saveState } from "../src/state.js";

/** 假的 AI 客户端：按顺序返回预设回复，并记录收到的请求 */
function fakeAI(...replies: (string | Error)[]): AIClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    provider: "claude",
    model: "fake-model",
    requests,
    async *stream(req) {
      requests.push(req);
      const r = replies.shift() ?? "";
      if (r instanceof Error) throw r;
      yield { t: "thinking", v: "思考中" };
      yield { t: "text", v: r };
    },
  };
}

const q = (symbol: string, price: number, extra: Partial<Quote> = {}): Quote => ({
  symbol,
  market: "cn",
  name: "沪深300ETF",
  price,
  prevClose: price,
  lotSize: 100,
  currency: "CNY",
  time: "2026-11-17 10:00:00",
  suspended: false,
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("提取结果解析", () => {
  it("容错解析模型输出中的 JSON", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('好的，结果如下：\n```json\n{"a": {"b": 2}}\n```')).toEqual({ a: { b: 2 } });
    expect(() => parseJsonObject("抱歉，我看不清")).toThrow(AIError);
    expect(() => parseJsonObject("{a:1}")).toThrow(/格式有误/);
  });

  it("数字字段兼容带单位和千分位的字符串", () => {
    const x = extractionSchema.parse({ basePrice: "4.00元", position: "10,000 份", cash: "HK$30,000", price: null });
    expect(x).toMatchObject({ basePrice: 4, position: 10000, cash: 30000, price: null });
  });

  it("转换为引擎持仓：规范化代码、解析网格间距", () => {
    const { holding, problems } = holdingFromExtraction({
      symbol: "510300",
      name: "沪深300ETF",
      basePrice: 4,
      position: 10000,
      cash: 20000,
      grid: { lower: 3.6, upper: 4.4, step: "2%", size: 1000 },
    });
    expect(problems).toEqual([]);
    expect(holding).toEqual({
      symbol: "sh510300",
      name: "沪深300ETF",
      basePrice: 4,
      position: 10000,
      cash: 20000,
      grid: { lower: 3.6, upper: 4.4, step: { type: "pct", value: 0.02 }, size: 1000 },
    });
  });

  it("修正小模型常见的代码错误", () => {
    expect(cleanSymbol("bj159915")).toBe("159915");
    expect(cleanSymbol("创业板ETF 159915")).toBe("159915");
    expect(cleanSymbol("510300.SH")).toBe("510300");
    expect(cleanSymbol("hk00700")).toBe("hk00700");
    expect(cleanSymbol("usAAPL")).toBe("usAAPL");
    expect(cleanSymbol("QQQ")).toBe("QQQ");
    expect(holdingFromExtraction({ symbol: "bj159915", basePrice: 2 }).holding?.symbol).toBe("sz159915");
  });

  it("缺少代码或基准价时列出问题，不生成持仓", () => {
    expect(holdingFromExtraction({ symbol: null, basePrice: 4 })).toEqual({ problems: ["没有识别到证券代码"] });
    expect(holdingFromExtraction({ symbol: "AAPL" }).problems).toEqual(["没有识别到基准价 / 持仓成本"]);
    expect(holdingFromExtraction({ symbol: "???", basePrice: 1 }).problems[0]).toContain("无法识别代码");
  });

  it("已触发档位只接受规则中的档位", () => {
    const h = { symbol: "sh510300", basePrice: 4, position: 0 };
    expect(stateFromTriggered(h, ["down15", "down99", "up25"])).toEqual({ basePrice: 4, triggered: ["down15", "up25"] });
    expect(stateFromTriggered(h, [])).toBeUndefined();
  });
});

describe("图片", () => {
  it("按文件头识别格式", () => {
    expect(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(detectImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(detectImageType(Buffer.from("hello"))).toBeUndefined();
  });

  it("拒绝非图片文件", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gridbot-img-"));
    await writeFile(path.join(dir, "a.png"), "not an image");
    await expect(readImage(path.join(dir, "a.png"))).rejects.toThrow(/不是支持的图片格式/);
    await expect(readImage(path.join(dir, "missing.png"))).rejects.toThrow(/读取图片失败/);
  });
});

describe("分析流程", () => {
  async function config(extra = "") {
    const dir = await mkdtemp(path.join(tmpdir(), "gridbot-ai-"));
    return parseConfig(
      `ai: { provider: claude, apiKey: test }\nwatchlist:\n  - { symbol: sh510300, basePrice: 4, position: 10000 }\n${extra}`,
      path.join(dir, "gridbot.yaml"),
    );
  }

  it("从截图提取持仓 → 实时行情 → 引擎计算", async () => {
    const c = await config();
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sz159915", q("sz159915", 1.7)]]));
    const ai = fakeAI(JSON.stringify({ symbol: "159915", basePrice: 2, position: 5000, price: 1.75 }));
    const ctx = await prepareAnalysis(c, ai, { text: "我的创业板ETF", images: [] });

    expect(ctx.source).toBe("extracted");
    expect(ctx.holding?.symbol).toBe("sz159915");
    expect(ctx.evaluation?.price).toBe(1.7); // 用实时价，不用截图里的 1.75
    expect(ctx.evaluation?.signals.map((s) => [s.action, s.quantity])).toEqual([["buy", 500]]); // −15%
    expect(ai.requests[0]!.effort).toBe("low");

    const prompt = analyzePrompt("我的创业板ETF", ctx, 0);
    expect(prompt).toContain("<engine_result");
    expect(prompt).toContain("买入 500 @ 1.7");
    expect(prompt).toContain("<extracted>");
  });

  it("--symbol 指定配置中的标的时直接使用配置和已触发档位，不调用 AI 提取", async () => {
    const c = await config();
    await saveState(c.statePath, { version: 1, symbols: { sh510300: { basePrice: 4, triggered: ["down15"] } } });
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", q("sh510300", 3.4)]]));
    const ai = fakeAI();
    const ctx = await prepareAnalysis(c, ai, { symbol: "510300", images: [] });

    expect(ctx.source).toBe("config");
    expect(ai.requests).toHaveLength(0);
    expect(ctx.evaluation?.signals).toEqual([]); // −15% 已触发过
  });

  it("用户文字里写明的代码优先于模型识别的（模型写错时）", async () => {
    const c = await config();
    vi.spyOn(tencentSource, "fetchQuotes").mockImplementation(async (symbols) =>
      new Map(symbols.filter((s) => s === "sz159915").map((s) => [s, q(s, 2.3)])),
    );
    const ai = fakeAI(JSON.stringify({ symbol: "cd5000", basePrice: 2.8, position: 5000 }));
    const ctx = await prepareAnalysis(c, ai, { text: "我持有159915创业板ETF 5000份，成本2.8元", images: [] });
    expect(ctx.holding?.symbol).toBe("sz159915");
    expect(ctx.evaluation?.price).toBe(2.3);
  });

  it("从文字中找出代码", () => {
    expect(codesInText("我持有159915和 hk700、0700.HK，还有 usQQQ，成本2.8元 5000份")).toEqual(["sz159915", "hk00700", "usQQQ"]);
    expect(codesInText("沪深300ETF 10000 份")).toEqual([]);
  });

  it("行情查不到代码时说明原因", async () => {
    const c = await config();
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map());
    const ai = fakeAI(JSON.stringify({ symbol: "usZZZZ", basePrice: 10, position: 1 }));
    const ctx = await prepareAnalysis(c, ai, { text: "ZZZZ", images: [] });
    expect(ctx.problems.join()).toContain("行情接口没有找到代码 usZZZZ");
  });

  it("没有代码时按名称匹配 watchlist 中的标的", async () => {
    const c = await config();
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["sh510300", q("sh510300", 3.4, { name: "沪深300ETF华泰柏瑞" })]]));
    const ai = fakeAI(JSON.stringify({ symbol: null, name: "沪深300 ETF", basePrice: 4.8 }));
    const ctx = await prepareAnalysis(c, ai, { text: "我的沪深300ETF", images: [] });
    expect(ctx.source).toBe("config");
    expect(ctx.holding?.symbol).toBe("sh510300");
    expect(ctx.evaluation?.signals[0]).toMatchObject({ action: "buy", quantity: 1000 }); // 配置中基准价 4 → −15%
    expect(ctx.problems.join()).toContain("按名称");
  });

  it("名称匹配到多个标的时不猜测", async () => {
    const c = await config("  - { symbol: sh510310, basePrice: 2, position: 100 }\n");
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(
      new Map([
        ["sh510300", q("sh510300", 3.4, { name: "沪深300ETF华泰柏瑞" })],
        ["sh510310", q("sh510310", 1.9, { name: "沪深300ETF易方达" })],
      ]),
    );
    const ai = fakeAI(JSON.stringify({ symbol: null, name: "沪深300ETF", basePrice: 4.8 }));
    const ctx = await prepareAnalysis(c, ai, { text: "我的沪深300ETF", images: [] });
    expect(ctx.holding).toBeUndefined();
    expect(ctx.problems).toContain("没有识别到证券代码");
  });

  it("行情获取失败时退回截图中的现价，并说明原因", async () => {
    const c = await config();
    vi.spyOn(tencentSource, "fetchQuotes").mockRejectedValue(new Error("network down"));
    const ai = fakeAI(JSON.stringify({ symbol: "usQQQ", basePrice: 500, position: 10, price: 650 }));
    const ctx = await prepareAnalysis(c, ai, { text: "QQQ", images: [] });

    expect(ctx.evaluation?.price).toBe(650);
    expect(ctx.evaluation?.signals.map((s) => s.ruleId)).toEqual(["up25"]);
    expect(ctx.problems.join()).toContain("获取实时行情失败");
  });

  it("信息不足时不计算，把问题交给 AI 说明", async () => {
    const c = await config();
    const ai = fakeAI(JSON.stringify({ symbol: null, missing: ["持仓成本"] }));
    const ctx = await prepareAnalysis(c, ai, { text: "我该卖吗", images: [] });
    expect(ctx.evaluation).toBeUndefined();
    expect(analyzePrompt("我该卖吗", ctx, 0)).toContain("无法完整计算的原因");
  });

  it("没有任何输入时报错", async () => {
    await expect(prepareAnalysis(await config(), fakeAI(), { images: [] })).rejects.toThrow(/请提供截图/);
  });

  it("系统提示包含规则正文，并要求以引擎结果为准", async () => {
    const sys = await analyzeSystemPrompt();
    expect(sys).toContain("第一层：分档仓位管理");
    expect(sys).toContain("不要自行重新计算");
  });
});

describe("邮件 AI 点评", () => {
  const result: CheckResult = {
    checkedAt: "2026-11-17T02:00:00.000Z",
    signalCount: 1,
    items: [
      {
        holding: { symbol: "sh510300", basePrice: 4, position: 10000 },
        quote: q("sh510300", 3.4),
        evaluation: {
          symbol: "sh510300",
          price: 3.4,
          basePrice: 4,
          change: -0.15,
          positionAfter: 11000,
          nextTiers: {},
          nextState: { basePrice: 4, triggered: ["down15"] },
          signals: [{ layer: "tier", action: "buy", quantity: 1000, price: 3.4, amount: 3400, ruleId: "down15", reason: "跌到 −15% 增持 10%" }],
          notes: [],
        },
      },
    ],
  };

  const cfg = (emailComment: boolean) =>
    parseConfig(`ai: { provider: gemini, apiKey: k, emailComment: ${emailComment} }\nwatchlist: [{ symbol: sh510300, basePrice: 4, position: 1 }]`, "/tmp/x/gridbot.yaml");

  it("开启后在邮件中附带点评", async () => {
    const mail = await buildSignalEmail(cfg(true), result, fakeAI("【沪深300ETF】跌到第一档，按计划小幅加仓。"));
    expect(mail.text).toContain("AI 点评（Claude · fake-model）");
    expect(mail.html).toContain("按计划小幅加仓");
  });

  it("点评失败不影响发送", async () => {
    const mail = await buildSignalEmail(cfg(true), result, fakeAI(new AIError("AI 服务当前繁忙（503）")));
    expect(mail.text).toContain("AI 点评生成失败：AI 服务当前繁忙");
    expect(mail.text).toContain("买入 1000");
  });

  it("未开启时不调用 AI", async () => {
    const ai = fakeAI("x");
    const mail = await buildSignalEmail(cfg(false), result, ai);
    expect(ai.requests).toHaveLength(0);
    expect(mail.text).not.toContain("AI 点评");
  });
});

describe("AI 客户端", () => {
  it("缺少 Key 时给出提示", () => {
    expect(() => createAIClient({ provider: "openai" })).toThrow(/未配置 ChatGPT 的 API Key/);
    expect(createAIClient({ provider: "claude", authToken: "t" }).model).toBe("claude-opus-5-5");
    expect(createAIClient({ provider: "gemini", apiKey: "k", model: "gemini-x" }).model).toBe("gemini-x");
  });

  it("只对可重试的状态码重试，最多 2 次", async () => {
    const ac = new AbortController();
    let calls = 0;
    const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
    await expect(withRetry(ac.signal, async () => (++calls < 3 ? Promise.reject(err(503)) : "ok"), [1, 1])).resolves.toBe("ok");
    expect(calls).toBe(3);

    calls = 0;
    await expect(withRetry(ac.signal, async () => (++calls, Promise.reject(err(503))), [1, 1])).rejects.toThrow("503");
    expect(calls).toBe(3);

    calls = 0;
    await expect(withRetry(ac.signal, async () => (++calls, Promise.reject(err(400))), [1, 1])).rejects.toThrow("400");
    expect(calls).toBe(1);
  });

  it("错误信息转换为中文", () => {
    expect(describeAIError(Object.assign(new Error("x"), { status: 429 }))).toContain("429");
    expect(describeAIError(new DOMException("This operation was aborted", "AbortError"))).toContain("超时");
    expect(describeAIError(new Error('{"error":{"message":"API key not valid. Please pass a valid API key."}}'))).toContain("API Key 无效");
  });
});
