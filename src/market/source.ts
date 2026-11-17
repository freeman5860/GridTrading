import type { Quote } from "../core/types.js";
import { tencentSource } from "./tencent.js";

export interface QuoteSource {
  name: string;
  /** 批量获取行情，key 为规范化代码；查不到的代码不出现在结果中 */
  fetchQuotes(symbols: string[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Map<string, Quote>>;
}

const SOURCES: Record<string, QuoteSource> = { tencent: tencentSource };

export function getQuoteSource(name = "tencent"): QuoteSource {
  const s = SOURCES[name];
  if (!s) throw new Error(`未知的行情来源：${name}（可选：${Object.keys(SOURCES).join("、")}）`);
  return s;
}
