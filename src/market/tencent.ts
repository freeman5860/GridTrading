// 腾讯行情公开接口（免费、无需 Key，一次请求可同时查询 A 股 / 港股 / 美股）。
// 非官方接口，格式可能变化，所以解析逻辑集中在这里，并配有基于真实响应的测试。

import { MARKETS, normalizeSymbol } from "../core/symbol.js";
import type { Quote } from "../core/types.js";
import type { QuoteSource } from "./source.js";

const ENDPOINT = "https://qt.gtimg.cn/q=";
const BATCH = 50;

// 字段下标（以 "~" 分隔）
const F = { name: 1, price: 3, prevClose: 4, time: 30, hkLot: 60 } as const;

export function parseTencent(body: string): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const m of body.matchAll(/v_([A-Za-z0-9.\-]+)="([^"]*)"/g)) {
    const key = m[1]!;
    if (key === "pv_none_match") continue;
    const f = m[2]!.split("~");
    if (f.length < 35) continue;

    let parsed;
    try {
      parsed = normalizeSymbol(key);
    } catch {
      continue;
    }
    const { symbol, market } = parsed;
    const info = MARKETS[market];
    const price = Number(f[F.price]);
    const hkLot = Number(f[F.hkLot]);
    out.set(symbol, {
      symbol,
      market,
      name: f[F.name] ?? symbol,
      price: Number.isFinite(price) ? price : 0,
      prevClose: Number(f[F.prevClose]) || 0,
      lotSize: market === "hk" && hkLot > 0 ? hkLot : info.defaultLot,
      currency: info.currency,
      time: formatTime(f[F.time] ?? ""),
      suspended: !(price > 0),
    });
  }
  return out;
}

/** 统一时间格式为 YYYY-MM-DD HH:mm:ss（交易所当地时间） */
function formatTime(raw: string): string {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return raw.replaceAll("/", "-");
}

export const tencentSource: QuoteSource = {
  name: "tencent",
  async fetchQuotes(symbols, { signal, timeoutMs = 10_000 } = {}) {
    const result = new Map<string, Quote>();
    const unique = [...new Set(symbols)];
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH);
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(ENDPOINT + batch.join(","), {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; gridbot)" },
      });
      if (!res.ok) throw new Error(`腾讯行情接口返回 HTTP ${res.status}`);
      const body = new TextDecoder("gbk").decode(await res.arrayBuffer());
      for (const [k, v] of parseTencent(body)) result.set(k, v);
    }
    return result;
  },
};
