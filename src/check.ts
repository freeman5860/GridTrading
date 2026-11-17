import type { Config } from "./config.js";
import { evaluate } from "./core/engine.js";
import type { Evaluation, Holding, Quote } from "./core/types.js";
import { getQuoteSource } from "./market/source.js";
import { loadState, saveState } from "./state.js";

export interface CheckItem {
  holding: Holding;
  quote?: Quote;
  evaluation?: Evaluation;
  error?: string;
}

export interface CheckResult {
  checkedAt: string;
  items: CheckItem[];
  /** 本次产生的交易信号总数 */
  signalCount: number;
}

export async function runCheck(config: Config, opts: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<CheckResult> {
  const state = await loadState(config.statePath);
  const source = getQuoteSource(config.market.source);
  const quotes = await source.fetchQuotes(
    config.watchlist.map((h) => h.symbol),
    { signal: opts.signal },
  );
  const now = new Date().toISOString();

  const items: CheckItem[] = config.watchlist.map((holding) => {
    const quote = quotes.get(holding.symbol);
    if (!quote) return { holding, error: "行情接口没有返回该代码，请检查代码是否正确" };
    try {
      const evaluation = evaluate(holding, quote, state.symbols[holding.symbol]);
      // 停牌等无有效价格时不更新状态
      if (!quote.suspended) state.symbols[holding.symbol] = { ...evaluation.nextState, updatedAt: now };
      return { holding, quote, evaluation };
    } catch (e) {
      return { holding, quote, error: (e as Error).message };
    }
  });

  // 清理已从 watchlist 移除的标的
  const active = new Set(config.watchlist.map((h) => h.symbol));
  for (const s of Object.keys(state.symbols)) if (!active.has(s)) delete state.symbols[s];

  if (!opts.dryRun) await saveState(config.statePath, state);

  return {
    checkedAt: now,
    items,
    signalCount: items.reduce((n, i) => n + (i.evaluation?.signals.length ?? 0), 0),
  };
}
