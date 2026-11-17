import type { Market } from "./types.js";

export interface MarketInfo {
  name: string;
  currency: "CNY" | "HKD" | "USD";
  defaultLot: number;
  timezone: string;
}

export const MARKETS: Record<Market, MarketInfo> = {
  cn: { name: "A股", currency: "CNY", defaultLot: 100, timezone: "Asia/Shanghai" },
  hk: { name: "港股", currency: "HKD", defaultLot: 100, timezone: "Asia/Hong_Kong" },
  us: { name: "美股", currency: "USD", defaultLot: 1, timezone: "America/New_York" },
};

export class SymbolError extends Error {}

/**
 * 把用户输入的各种代码写法规范化为 腾讯行情 的代码格式：
 *   A 股：sh510300 / 510300 / 510300.SH / SZ159915
 *   港股：hk00700 / hk700 / 00700 / 0700.HK
 *   美股：usAAPL / AAPL / aapl.us / BRK.B
 */
export function normalizeSymbol(input: string): { symbol: string; market: Market } {
  const raw = input.trim();
  let m: RegExpMatchArray | null;

  if ((m = raw.match(/^(sh|sz|bj)(\d{6})$/i))) {
    return { symbol: `${m[1]!.toLowerCase()}${m[2]}`, market: "cn" };
  }
  if ((m = raw.match(/^(\d{6})\.(sh|sz|bj)$/i))) {
    return { symbol: `${m[2]!.toLowerCase()}${m[1]}`, market: "cn" };
  }
  if ((m = raw.match(/^\d{6}$/))) {
    return { symbol: `${inferCnExchange(raw)}${raw}`, market: "cn" };
  }
  if ((m = raw.match(/^hk(\d{1,5})$/i)) || (m = raw.match(/^(\d{1,5})(?:\.hk)?$/i))) {
    return { symbol: `hk${m[1]!.padStart(5, "0")}`, market: "hk" };
  }
  if ((m = raw.match(/^us([a-z][a-z0-9.\-]*)$/i)) || (m = raw.match(/^([a-z][a-z0-9.\-]*?)(?:\.us)?$/i))) {
    const ticker = m[1]!.toUpperCase();
    if (ticker.length <= 10) return { symbol: `us${ticker}`, market: "us" };
  }
  throw new SymbolError(`无法识别的代码：${input}（示例：sh510300、hk00700、usAAPL）`);
}

/** 6 位纯数字代码推断交易所：5/6/9 开头为上交所，0/1/2/3 开头为深交所，4/8 开头为北交所 */
function inferCnExchange(code: string): "sh" | "sz" | "bj" {
  const c = code[0];
  if (c === "5" || c === "6" || c === "9") return "sh";
  if (c === "4" || c === "8") return "bj";
  return "sz";
}

export function marketOf(symbol: string): Market {
  return normalizeSymbol(symbol).market;
}
