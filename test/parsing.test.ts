import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { normalizeSymbol } from "../src/core/symbol.js";
import { parseTencent } from "../src/market/tencent.js";

describe("代码规范化", () => {
  it.each([
    ["sh510300", "sh510300", "cn"],
    ["510300", "sh510300", "cn"],
    ["159915", "sz159915", "cn"],
    ["510300.SH", "sh510300", "cn"],
    ["SZ000001", "sz000001", "cn"],
    ["hk00700", "hk00700", "hk"],
    ["hk700", "hk00700", "hk"],
    ["2800", "hk02800", "hk"],
    ["0700.HK", "hk00700", "hk"],
    ["usAAPL", "usAAPL", "us"],
    ["aapl", "usAAPL", "us"],
    ["QQQ.US", "usQQQ", "us"],
    ["BRK.B", "usBRK.B", "us"],
  ])("%s → %s", (input, symbol, market) => {
    expect(normalizeSymbol(input)).toEqual({ symbol, market });
  });

  it("无法识别时报错", () => {
    expect(() => normalizeSymbol("1234567")).toThrow(/无法识别/);
    expect(() => normalizeSymbol("$$$")).toThrow(/无法识别/);
  });
});

describe("腾讯行情解析（真实响应样本）", () => {
  const body = new TextDecoder("gbk").decode(readFileSync(new URL("./fixtures/tencent-quotes.gbk.txt", import.meta.url)));
  const quotes = parseTencent(body);

  it("解析三个市场的行情", () => {
    expect([...quotes.keys()]).toEqual(["sh510300", "sz159915", "hk00700", "hk02800", "usAAPL", "usQQQ"]);
  });

  it("A 股：名称、价格、整手、币种、时间", () => {
    expect(quotes.get("sh510300")).toMatchObject({
      market: "cn",
      name: "沪深300ETF华泰柏瑞",
      price: 4.042,
      prevClose: 4.054,
      lotSize: 100,
      currency: "CNY",
      time: "2026-11-17 16:14:55",
      suspended: false,
    });
  });

  it("港股：从行情读取每手股数", () => {
    expect(quotes.get("hk00700")).toMatchObject({ name: "腾讯控股", lotSize: 100, currency: "HKD" });
    expect(quotes.get("hk02800")).toMatchObject({ name: "盈富基金", lotSize: 500 });
    expect(quotes.get("hk00700")!.time).toBe("2026-11-17 16:08:19");
  });

  it("美股：每手 1 股，美元", () => {
    expect(quotes.get("usAAPL")).toMatchObject({ name: "苹果", price: 352.78, lotSize: 1, currency: "USD" });
  });

  it("查不到的代码被忽略", () => {
    expect(parseTencent('v_pv_none_match="1";').size).toBe(0);
  });
});

describe("配置文件", () => {
  const yaml = (s: string) => parseConfig(s, "/tmp/demo/gridbot.yaml");

  it("规范化代码、解析网格间距、默认状态文件路径", () => {
    const c = yaml(`
watchlist:
  - symbol: 510300
    basePrice: 4
    position: 1000
    grid: { lower: 3.6, upper: 4.4, step: "2%", size: 100 }
  - symbol: AAPL
    basePrice: 200
    position: 10
    grid: { lower: 180, upper: 220, step: 5, size: 1 }
`);
    expect(c.watchlist.map((h) => h.symbol)).toEqual(["sh510300", "usAAPL"]);
    expect(c.watchlist[0]!.grid!.step).toEqual({ type: "pct", value: 0.02 });
    expect(c.watchlist[1]!.grid!.step).toEqual({ type: "abs", value: 5 });
    expect(c.statePath).toBe("/tmp/demo/.gridbot/state.json");
    expect(c.market.source).toBe("tencent");
  });

  it("代码不加引号也保持原样（000001 不会变成 1）", () => {
    const c = yaml(`
watchlist:
  - { symbol: 000001, basePrice: 10, position: 100 }
  - { symbol: 00700, basePrice: 300, position: 100 }
  - { symbol: 510300, basePrice: 4, position: 100 }
`);
    expect(c.watchlist.map((h) => h.symbol)).toEqual(["sz000001", "hk00700", "sh510300"]);
  });

  it("替换 ${ENV} 变量", () => {
    process.env.GRIDBOT_TEST_SECRET = "s3cret";
    const c = yaml(`
notify: { pass: "\${GRIDBOT_TEST_SECRET}" }
watchlist: [{ symbol: sh510300, basePrice: 4, position: 0 }]
`);
    expect(c.notify).toEqual({ pass: "s3cret" });
  });

  it("给出可读的校验错误", () => {
    expect(() => yaml(`watchlist: [{ symbol: "???", basePrice: -1, position: 0 }]`)).toThrow(/无法识别的代码|basePrice/);
    expect(() => yaml(`watchlist: []`)).toThrow(/至少需要一个标的/);
    expect(() =>
      yaml(`watchlist: [{ symbol: sh510300, basePrice: 4, position: 0 }, { symbol: 510300, basePrice: 4, position: 0 }]`),
    ).toThrow(/重复/);
    expect(() =>
      yaml(`watchlist: [{ symbol: sh510300, basePrice: 4, position: 0, grid: { lower: 5, upper: 4, step: 1, size: 100 } }]`),
    ).toThrow(/上限必须大于下限/);
  });
});
