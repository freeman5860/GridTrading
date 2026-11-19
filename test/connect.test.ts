// 港股通：行情为港元，基准价 / 可用资金 / 手续费为人民币
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCheck } from "../src/check.js";
import { parseConfig } from "../src/config.js";
import { evaluate } from "../src/core/engine.js";
import { estimateFill } from "../src/core/fill.js";
import type { Holding, Quote } from "../src/core/types.js";
import { fxSource, parseFx } from "../src/market/fx.js";
import { tencentSource } from "../src/market/tencent.js";
import { renderSignalEmail } from "../src/notify/render.js";

afterEach(() => vi.restoreAllMocks());

// 基准价 340 元，汇率 0.85 → 400 港元
const tencent: Holding = { symbol: "hk00700", basePrice: 340, position: 1000, cash: 20000, connect: true };
const fx = { rate: 0.85 };

describe("港股通引擎", () => {
  it("人民币资金按买入参考汇率（中间价 +3%）折算成港元，限制买入数量", () => {
    // 跌 15%：340 港元；规则应买 100 股 = 34000 港元
    // 20000 元 / (0.85 × 1.03) ≈ 22844 港元 → 只够 67 股，按每手 100 取整为 0
    const ev = evaluate(tencent, { price: 340, lotSize: 100 }, undefined, { fx });
    expect(ev.signals).toEqual([]);
    expect(ev.notes.map((n) => n.text).join()).toContain("可用资金只够买 0");
    expect(ev.notes.map((n) => n.text).join()).toContain("折合 22844");

    // 资金充足：40000 元 ≈ 45688 港元，足够买 100 股；附带人民币金额（按买入参考汇率）
    const ok = evaluate({ ...tencent, cash: 40000 }, { price: 340, lotSize: 100 }, undefined, { fx });
    expect(ok.signals[0]).toMatchObject({ action: "buy", quantity: 100, amount: 34000, amountCny: 29767 });
    expect(ok.fx).toEqual(fx);
    expect(ok.basePrice).toBe(340); // 显示人民币
    expect(ok.basePriceHkd).toBe(400);
    expect(ok.nextTiers.down).toEqual({ id: "down25", price: 300 }); // 档位价格为港元
  });

  it("按人民币计算涨跌幅：港股价格不变、港元升值也会接近档位", () => {
    // 现价 400 港元不变，汇率 0.85 → 0.9：人民币市值涨了 5.9%
    expect(evaluate(tencent, { price: 400, lotSize: 100 }, undefined, { fx: { rate: 0.9 } }).change).toBeCloseTo(0.0588, 3);
  });

  it("状态保存人民币基准价：汇率变化、加仓后改基准价都不会重复提醒", () => {
    const first = evaluate({ ...tencent, cash: 40000 }, { price: 340, lotSize: 100 }, undefined, { fx });
    expect(first.nextState).toMatchObject({ basePrice: 340, triggered: ["down15"] });
    const again = evaluate({ ...tencent, cash: 40000 }, { price: 330, lotSize: 100 }, first.nextState, { fx: { rate: 0.86 } });
    expect(again.signals).toEqual([]);
    expect(again.nextState.triggered).toEqual(["down15"]);

    // 实际场景：买入 100 股后把基准价改成新的持仓成本 → 不再提醒 −15%
    const lowered = evaluate({ ...tencent, basePrice: 330, position: 1100, cash: 10000 }, { price: 340, lotSize: 100 }, first.nextState, { fx });
    expect(lowered.signals).toEqual([]);
    expect(lowered.nextState).toMatchObject({ basePrice: 330, triggered: ["down15"] });
    expect(lowered.notes.map((n) => n.text).join()).toContain("基准价由 340 元改为 330 元，已触发档位保留");
  });

  it("卖出按卖出参考汇率（中间价 −3%）估算人民币金额", () => {
    const ev = evaluate(tencent, { price: 500, lotSize: 100 }, undefined, { fx });
    expect(ev.signals[0]).toMatchObject({ action: "sell", quantity: 100, amount: 50000, amountCny: 41225 });
  });

  it("没有汇率时无法计算（基准价是人民币）", () => {
    expect(() => evaluate(tencent, { price: 340, lotSize: 100 })).toThrow(/获取汇率失败/);
  });

  it("普通港股不受影响", () => {
    const ev = evaluate({ ...tencent, basePrice: 400, connect: undefined }, { price: 340, lotSize: 100 }, undefined, { fx });
    expect(ev.notes.map((n) => n.text).join()).toContain("可用资金只够买 0"); // 20000 港元 < 34000
    expect(ev.signals).toEqual([]);
    expect(ev.fx).toBeUndefined();
  });
});

describe("港股通配置与检查", () => {
  const q = (symbol: string, market: Quote["market"], time: string, price = 340): Quote => ({
    symbol, market, name: symbol === "hk00700" ? "腾讯控股" : "上证指数", price, prevClose: price,
    lotSize: 100, currency: market === "hk" ? "HKD" : "CNY", time, suspended: false,
  });
  const cfg = async (connect = "true") =>
    parseConfig(
      `watchlist:\n  - { symbol: 700, basePrice: ${connect === "true" ? 340 : 400}, position: 1000, cash: 40000, connect: ${connect} }\n`,
      path.join(await mkdtemp(path.join(tmpdir(), "gridbot-connect-")), "gridbot.yaml"),
    );

  it("只有港股可以设置 connect", async () => {
    expect((await cfg()).watchlist[0]).toMatchObject({ symbol: "hk00700", connect: true });
    expect(() => parseConfig("watchlist:\n  - { symbol: 510300, basePrice: 4, position: 1, connect: true }\n", "x.yaml")).toThrow(/不是港股/);
  });

  it("解析腾讯汇率报价", () => {
    expect(parseFx('v_whHKDCNY="310~港元人民币~HKDCNY~0.8495~0~20261119004601~0.8492";')).toEqual({ rate: 0.8495, time: "2026-11-19 00:46:01" });
    expect(parseFx('v_whHKDCNY="310~x~HKDCNY~abc";')).toBeUndefined();
    expect(parseFx("v_pv_none_match=\"1\";")).toBeUndefined();
  });

  it("检查时获取汇率，信号附带人民币金额", async () => {
    vi.spyOn(fxSource, "fetchHkdCny").mockResolvedValue(fx);
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["hk00700", q("hk00700", "hk", "2026-11-17 10:00:00")]]));
    const { result } = await prepareCheck(await cfg());
    expect(result.items[0]!.evaluation?.signals[0]).toMatchObject({ quantity: 100, amountCny: 29767 });
    const mail = renderSignalEmail(result);
    expect(mail.text).toContain("港股通");
    expect(mail.text).toContain("约 29,767 元");
    expect(mail.text).toContain("基准价 340 元（≈ 400 HKD）");
  });

  it("获取汇率失败时该标的报错，不影响其他标的", async () => {
    vi.spyOn(fxSource, "fetchHkdCny").mockRejectedValue(new Error("down"));
    vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(new Map([["hk00700", q("hk00700", "hk", "2026-11-17 10:00:00")]]));
    const { result } = await prepareCheck(await cfg());
    expect(result.items[0]!.error).toContain("获取汇率失败");
  });

  it("定时检查：内地休市日跳过港股通标的", async () => {
    vi.spyOn(fxSource, "fetchHkdCny").mockResolvedValue(fx);
    const now = new Date("2026-11-17T02:00:00Z"); // 北京 / 香港 10:00
    const quotes = vi.spyOn(tencentSource, "fetchQuotes").mockResolvedValue(
      new Map([
        ["hk00700", q("hk00700", "hk", "2026-11-17 10:00:00")],
        ["sh000001", q("sh000001", "cn", "2026-11-16 15:00:00", 3300)], // 上证指数停在昨天：内地休市
      ]),
    );
    const closed = await prepareCheck(await cfg(), { requireFresh: true, now });
    expect(quotes.mock.calls[0]![0]).toContain("sh000001");
    expect(closed.result.items[0]!.skipped).toContain("港股通不开放");
    expect(closed.result.signalCount).toBe(0);

    quotes.mockResolvedValue(
      new Map([
        ["hk00700", q("hk00700", "hk", "2026-11-17 10:00:00")],
        ["sh000001", q("sh000001", "cn", "2026-11-17 10:00:00", 3300)],
      ]),
    );
    const open = await prepareCheck(await cfg(), { requireFresh: true, now });
    expect(open.result.signalCount).toBe(1);

    // 普通港股不检查内地是否开市
    quotes.mockClear();
    await prepareCheck(await cfg("false"), { requireFresh: true, now });
    expect(quotes.mock.calls[0]![0]).not.toContain("sh000001");
  });
});

describe("确认成交：估算可用资金和持仓成本", () => {
  const buy = (quantity: number, price: number, fxRate?: number) =>
    ({ layer: "tier", action: "buy", quantity, price, amount: quantity * price, ruleId: "down15", reason: "", fxRate }) as const;

  it("全部成交：买入扣减资金、摊薄成本", () => {
    expect(estimateFill({ position: 1000, cash: 50000, basePrice: 10 }, [buy(100, 8)])).toEqual({ position: 1100, cash: 49200, basePrice: 9.818 });
  });

  it("港股通：按中间价折算人民币", () => {
    // 你的场景：1400 股、成本 432.389 元，买入 100 @ 350.4 港元，汇率 0.8494 → 每股约 297.63 元
    const e = estimateFill({ position: 1400, cash: 86844, basePrice: 432.389 }, [buy(100, 350.4, 0.8494), buy(100, 350.4, 0.8494)], 1500);
    expect(e.position).toBe(1500);
    expect(e.cash).toBe(57081.02);
    expect(e.basePrice).toBe(423.405);
  });

  it("卖出增加资金、成本不变；没有配置资金时不估算", () => {
    const sell = { ...buy(100, 12), action: "sell" as const, ruleId: "up25" };
    expect(estimateFill({ position: 1000, cash: 0, basePrice: 10 }, [sell])).toEqual({ position: 900, cash: 1200, basePrice: 10 });
    expect(estimateFill({ position: 1000, basePrice: 10 }, [buy(100, 8)]).cash).toBeUndefined();
  });
});
