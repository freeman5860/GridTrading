import { describe, expect, it } from "vitest";
import { evaluate, gridLevels } from "../src/core/engine.js";
import type { Holding, SymbolState } from "../src/core/types.js";

const cn = (price: number) => ({ price, lotSize: 100 });
const lot1 = (price: number) => ({ price, lotSize: 1 });

const etf: Holding = { symbol: "sh510300", basePrice: 4, position: 10000 };

/** 模拟连续多次检查：每次把上次的状态带入，并按信号更新持仓（模拟用户已按建议成交） */
function simulate(h: Holding, prices: number[], lotSize = 100) {
  let state: SymbolState | undefined;
  let holding = { ...h };
  return prices.map((price) => {
    const ev = evaluate(holding, { price, lotSize }, state);
    state = ev.nextState;
    holding = { ...holding, position: ev.positionAfter };
    return ev;
  });
}

describe("第一层：分档仓位管理", () => {
  it("跌幅 15% 以内、涨幅 25% 以内不操作，并给出下一档价格", () => {
    for (const p of [3.5, 3.8, 4, 4.2, 4.6, 4.99]) {
      expect(evaluate(etf, cn(p)).signals).toEqual([]);
    }
    const ev = evaluate(etf, cn(3.5));
    expect(ev.nextTiers.down).toEqual({ id: "down15", price: 3.4 });
    expect(ev.nextTiers.up).toEqual({ id: "up25", price: 5 });
  });

  it("跌到 −15% 增持当前持仓的 10%", () => {
    const ev = evaluate(etf, cn(3.4));
    expect(ev.signals).toHaveLength(1);
    expect(ev.signals[0]).toMatchObject({ layer: "tier", action: "buy", quantity: 1000, price: 3.4, ruleId: "down15" });
    expect(ev.positionAfter).toBe(11000);
    expect(ev.nextState.triggered).toEqual(["down15"]);
  });

  it("每档每轮只触发一次，价格在档位附近来回不重复操作", () => {
    const evs = simulate(etf, [3.4, 3.45, 3.38, 3.5, 3.39]);
    expect(evs.flatMap((e) => e.signals)).toHaveLength(1);
  });

  it("跳空越过多档时依次执行，后一档按前一档执行后的持仓计算", () => {
    const ev = evaluate(etf, cn(2.8)); // −30%
    expect(ev.signals.map((s) => [s.ruleId, s.quantity])).toEqual([
      ["down15", 1000],
      ["down25", 2700], // 11000 × 25% = 2750，恰好半手时向下取整
    ]);
    expect(ev.notes.some((n) => n.text.includes("不再机械加仓"))).toBe(true);
    expect(ev.nextTiers.down).toBeUndefined();
  });

  it("可用资金不足时按资金下调买入数量（整手向下取整）", () => {
    const ev = evaluate({ ...etf, cash: 2000 }, cn(3.4));
    expect(ev.signals[0]!.quantity).toBe(500); // 2000 / 3.4 = 588 → 500
    expect(ev.notes.some((n) => n.level === "warn" && n.text.includes("可用资金"))).toBe(true);
  });

  it("上涨分批止盈：按规则文档示例 1000 → 900 → 720 → 504 → 302 → 清仓", () => {
    const h: Holding = { symbol: "usX", basePrice: 10, position: 1000 };
    const evs = simulate(h, [12.5, 13.5, 14.5, 16, 20], 1);
    expect(evs.map((e) => e.signals.map((s) => [s.ruleId, s.action, s.quantity]))).toEqual([
      [["up25", "sell", 100]],
      [["up35", "sell", 180]],
      [["up45", "sell", 216]],
      [["up60", "sell", 202]],
      [["up100", "sell", 302]],
    ]);
    expect(evs.map((e) => e.positionAfter)).toEqual([900, 720, 504, 302, 0]);
    expect(evs.at(-1)!.nextState.completed).toBe(true);
  });

  it("清仓后本轮结束，不再产生分档信号；重设基准价后开始新一轮", () => {
    const h: Holding = { symbol: "usX", basePrice: 10, position: 100 };
    const done = evaluate(h, lot1(20)).nextState;
    expect(evaluate({ ...h, position: 0 }, lot1(5), done).signals).toEqual([]);

    const again = evaluate({ ...h, basePrice: 20, position: 100 }, lot1(17), done);
    expect(again.nextState.completed).toBe(false);
    expect(again.signals[0]).toMatchObject({ ruleId: "down15", quantity: 10 });
    expect(again.notes.some((n) => n.text.includes("新一轮"))).toBe(true);
  });

  it("跳涨 +40% 同时执行 +25% 和 +35% 两档", () => {
    const ev = evaluate({ symbol: "usX", basePrice: 10, position: 1000 }, lot1(14));
    expect(ev.signals.map((s) => s.quantity)).toEqual([100, 180]);
    expect(ev.positionAfter).toBe(720);
  });

  it("港股按每手股数取整，不足一手时提示而不操作", () => {
    const hk: Holding = { symbol: "hk02800", basePrice: 20, position: 2000 };
    const small = evaluate(hk, { price: 25, lotSize: 500 }); // 2000 × 10% = 200 < 500
    expect(small.signals).toEqual([]);
    expect(small.notes.some((n) => n.text.includes("不足一手"))).toBe(true);

    const big = evaluate({ ...hk, position: 5000 }, { price: 25, lotSize: 500 });
    expect(big.signals[0]!.quantity).toBe(500);
  });

  it("整手取整：最近整手，恰好半手向下", () => {
    const ev = evaluate({ ...etf, position: 500 }, cn(3.4)); // 50 股 = 半手
    expect(ev.signals).toEqual([]);
    expect(evaluate({ ...etf, position: 600 }, cn(3.4)).signals[0]!.quantity).toBe(100); // 60 → 100
    expect(evaluate({ ...etf, position: 1400 }, cn(3.4)).signals[0]!.quantity).toBe(100); // 140 → 100
  });

  it("tiers: false 时只运行网格", () => {
    expect(evaluate({ ...etf, tiers: false }, cn(3)).signals).toEqual([]);
  });

  it("没有有效价格（停牌）时不做判断", () => {
    const ev = evaluate(etf, cn(0));
    expect(ev.signals).toEqual([]);
    expect(ev.notes[0]!.level).toBe("warn");
  });
});

describe("第二层：区间小网格", () => {
  // 狐利示例：基准价 2 元，区间 1.6～2.4 元，间距 0.2 元，每格 500 股
  const fox: Holding = {
    symbol: "sh510000",
    basePrice: 2,
    position: 0,
    tiers: false, // 示例只演示网格本身
    grid: { lower: 1.6, upper: 2.4, step: { type: "abs", value: 0.2 }, size: 500 },
  };

  it("生成等差 / 等比网格价位", () => {
    expect(gridLevels(fox.grid!)).toEqual([1.6, 1.8, 2, 2.2, 2.4]);
    expect(gridLevels({ lower: 100, upper: 121, step: { type: "pct", value: 0.1 }, size: 1 })).toEqual([100, 110, 121]);
    expect(() => gridLevels({ lower: 2, upper: 1, step: { type: "abs", value: 0.1 }, size: 1 })).toThrow();
  });

  it("复现示例表：先下跌再上涨，每次买点都比卖点低，无网格仓时上涨不卖", () => {
    const evs = simulate(fox, [2.0, 1.8, 1.6, 1.8, 2.0, 2.2, 2.4]);
    const steps = evs.map((e) => e.signals.map((s) => `${s.action}@${s.price}x${s.quantity}`));
    expect(steps).toEqual([
      [], // 初始化，锚点 2.0
      ["buy@1.8x500"], // 第 1 份底仓
      ["buy@1.6x500"], // 第 2 份底仓
      ["sell@1.8x500"], // 卖第 1 份
      ["sell@2x500"], // 卖第 2 份
      [], // 无网格仓，不操作
      [],
    ]);
    expect(evs[5]!.notes.some((n) => n.text.includes("不卖出"))).toBe(true);
    expect(evs.at(-1)!.grid).toMatchObject({ anchor: 4, lots: 0 });
  });

  it("一次跌穿多格时逐格买入，跌破下限后暂停并提示", () => {
    const [, ev] = simulate(fox, [2.0, 1.5]);
    expect(ev!.signals.map((s) => s.price)).toEqual([1.8, 1.6]);
    expect(ev!.notes.some((n) => n.text.includes("跌破网格下限"))).toBe(true);
  });

  it("网格资金不足时停止继续买入", () => {
    const [, ev] = simulate({ ...fox, cash: 1000 }, [2.0, 1.5]); // 只够 1.8 × 500 = 900
    expect(ev!.signals.map((s) => s.price)).toEqual([1.8]);
  });

  it("两层同时触发时第一层优先，网格本次不操作并重设锚点", () => {
    const both: Holding = { ...fox, tiers: true, position: 10000 };
    const [, ev] = simulate(both, [2.0, 1.66]); // −17%，同时跌穿网格 1.8
    expect(ev!.signals.map((s) => s.layer)).toEqual(["tier"]);
    expect(ev!.grid!.anchor).toBe(0); // 锚点移到离 1.66 最近的 1.6
  });

  it("网格参数变化时重新初始化", () => {
    const [first] = simulate(fox, [2.0]);
    const changed = { ...fox, grid: { ...fox.grid!, size: 1000 } };
    const ev = evaluate(changed, cn(1.8), first!.nextState);
    expect(ev.signals).toEqual([]);
    expect(ev.notes.some((n) => n.text.includes("重新初始化"))).toBe(true);
  });

  it("每格利润低于往返手续费 3 倍时提示", () => {
    const tiny: Holding = { ...fox, grid: { ...fox.grid!, step: { type: "abs", value: 0.01 }, size: 100 }, fee: { rate: 0.0001, min: 5 } };
    const ev = evaluate({ ...tiny, grid: { ...tiny.grid!, upper: 1.7 } }, cn(1.65));
    expect(ev.notes.some((n) => n.text.includes("手续费"))).toBe(true);
  });

  it("每格数量不是整手时按整手计算", () => {
    const ev = evaluate({ ...fox, grid: { ...fox.grid!, size: 250 } }, cn(2));
    expect(ev.notes.some((n) => n.text.includes("整数倍"))).toBe(true);
  });
});
