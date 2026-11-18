import type { Config } from "./config.js";
import { evaluate } from "./core/engine.js";
import type { Evaluation, FxRate, Holding, Market, Quote } from "./core/types.js";
import { marketOf } from "./core/symbol.js";
import { quoteIsFresh } from "./market/hours.js";
import { getQuoteSource } from "./market/source.js";
import { fxSource } from "./market/fx.js";
import { loadState, saveState } from "./state.js";

export interface CheckItem {
  holding: Holding;
  quote?: Quote;
  evaluation?: Evaluation;
  /** 本次跳过的原因（如休市），跳过的标的不更新状态 */
  skipped?: string;
  error?: string;
}

export interface CheckResult {
  checkedAt: string;
  items: CheckItem[];
  /** 本次产生的交易信号总数 */
  signalCount: number;
}

export interface CheckOptions {
  /** 只检查这些市场的标的 */
  markets?: Market[];
  /** 行情日期不是当地今天时跳过（定时任务用于识别节假日休市） */
  requireFresh?: boolean;
  now?: Date;
  signal?: AbortSignal;
}

export interface PreparedCheck {
  result: CheckResult;
  /** 保存本次检查后的状态（已触发档位、网格位置）。在提醒发送成功后再调用，避免丢失提醒 */
  commit(): Promise<void>;
}

export async function prepareCheck(config: Config, opts: CheckOptions = {}): Promise<PreparedCheck> {
  const now = opts.now ?? new Date();
  const state = await loadState(config.statePath);
  const holdings = opts.markets
    ? config.watchlist.filter((h) => opts.markets!.includes(marketOf(h.symbol)))
    : config.watchlist;

  const hasConnect = holdings.some((h) => h.connect);
  // 港股通只在内地和香港都开市的日子交易：定时检查时用上证指数的行情日期判断内地是否开市
  const symbols = holdings.map((h) => h.symbol);
  if (hasConnect && opts.requireFresh) symbols.push(MAINLAND_PROBE);
  const [quotes, fx] = await Promise.all([
    symbols.length ? getQuoteSource(config.market.source).fetchQuotes(symbols, { signal: opts.signal }) : new Map<string, Quote>(),
    hasConnect ? fetchFx(opts.signal) : undefined,
  ]);
  const probe = quotes.get(MAINLAND_PROBE);
  const mainlandClosed = Boolean(probe && !quoteIsFresh(probe, now));

  const updatedAt = now.toISOString();
  const items: CheckItem[] = holdings.map((holding) => {
    const quote = quotes.get(holding.symbol);
    if (!quote) return { holding, error: "行情接口没有返回该代码，请检查代码是否正确" };
    if (opts.requireFresh && !quoteIsFresh(quote, now)) {
      return { holding, quote, skipped: `行情时间 ${quote.time} 不是今天，可能休市` };
    }
    if (opts.requireFresh && holding.connect && mainlandClosed) {
      return { holding, quote, skipped: "内地今日休市，港股通不开放交易" };
    }
    try {
      const evaluation = evaluate(holding, quote, state.symbols[holding.symbol], { fx });
      // 停牌等无有效价格时不更新状态
      if (!quote.suspended) state.symbols[holding.symbol] = { ...evaluation.nextState, updatedAt };
      return { holding, quote, evaluation };
    } catch (e) {
      return { holding, quote, error: (e as Error).message };
    }
  });

  // 清理已从 watchlist 移除的标的
  const active = new Set(config.watchlist.map((h) => h.symbol));
  for (const s of Object.keys(state.symbols)) if (!active.has(s)) delete state.symbols[s];

  return {
    result: {
      checkedAt: updatedAt,
      items,
      signalCount: items.reduce((n, i) => n + (i.evaluation?.signals.length ?? 0), 0),
    },
    commit: () => saveState(config.statePath, state),
  };
}

const MAINLAND_PROBE = "sh000001";

/** 获取港元兑人民币汇率；失败时返回 undefined（引擎会提示并不按资金限制） */
export async function fetchFx(signal?: AbortSignal): Promise<FxRate | undefined> {
  try {
    return await fxSource.fetchHkdCny({ signal });
  } catch {
    return undefined;
  }
}

/** 检查并立即保存状态（dryRun 时不保存） */
export async function runCheck(config: Config, opts: CheckOptions & { dryRun?: boolean } = {}): Promise<CheckResult> {
  const prepared = await prepareCheck(config, opts);
  if (!opts.dryRun) await prepared.commit();
  return prepared.result;
}
