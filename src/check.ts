import type { Config } from "./config.js";
import { evaluate } from "./core/engine.js";
import type { AlertedSignals, Evaluation, FxRate, Holding, Market, Quote, Signal, SymbolState, TierId } from "./core/types.js";
import { effectiveQuantity } from "./core/fill.js";
import { marketOf } from "./core/symbol.js";
import { localTime, quoteIsFresh } from "./market/hours.js";
import { connectDayStatus } from "./market/holidays.js";
import { getQuoteSource } from "./market/source.js";
import { fxSource } from "./market/fx.js";
import { loadState, saveState, type StateFile } from "./state.js";

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
  /** 本次检查后的状态（尚未保存） */
  state: StateFile;
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
  // 港股通只在内地和香港都开市的日子交易：优先查节假日日历；日历没有覆盖的年份，用上证指数的行情日期判断内地是否开市
  const connectDay = connectDayStatus(localTime("hk", now).date);
  const symbols = holdings.map((h) => h.symbol);
  if (hasConnect && opts.requireFresh && !connectDay.known) symbols.push(MAINLAND_PROBE);
  const [quotes, fx] = await Promise.all([
    symbols.length ? getQuoteSource(config.market.source).fetchQuotes(symbols, { signal: opts.signal }) : new Map<string, Quote>(),
    hasConnect ? fetchFx(opts.signal) : undefined,
  ]);
  const probe = quotes.get(MAINLAND_PROBE);
  const connectClosed = connectDay.known ? connectDay.closed : probe && !quoteIsFresh(probe, now) ? "内地今日休市" : undefined;

  const updatedAt = now.toISOString();
  const items: CheckItem[] = holdings.map((holding) => {
    const quote = quotes.get(holding.symbol);
    if (!quote) return { holding, error: "行情接口没有返回该代码，请检查代码是否正确" };
    if (opts.requireFresh && !quoteIsFresh(quote, now)) {
      return { holding, quote, skipped: `行情时间 ${quote.time} 不是今天，可能休市` };
    }
    if (opts.requireFresh && holding.connect && connectClosed) {
      return { holding, quote, skipped: `${connectClosed}，港股通不开放交易` };
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
    state,
    // 保存时根据信号（及 AI 决策）记录待确认信号和暂缓的档位；定时检查会在 AI 决策之后才调用
    commit: async () => {
      for (const item of items) {
        const st = state.symbols[item.holding.symbol];
        if (!st || !item.evaluation?.signals.length || item.quote?.suspended) continue;
        settleSignals(st, item.evaluation.signals, item.holding.position, localTime(marketOf(item.holding.symbol), now).date, updatedAt);
      }
      await saveState(config.statePath, state);
    },
  };
}

const MAINLAND_PROBE = "sh000001";

/**
 * 根据本次的信号更新状态：
 * - AI 暂缓的档位不算已触发（之后每个交易日重新决策），记录在 deferred；其他档位按引擎结果算已触发
 * - 信号记入"待确认成交"（同一档位的新决策替换旧记录），预计持仓按建议数量重新计算
 */
export function settleSignals(st: SymbolState, signals: Signal[], position: number, today: string, at: string): void {
  const deferred = { ...(st.deferred ?? {}) };
  let triggered = [...st.triggered];
  for (const s of signals) {
    if (s.layer !== "tier") continue;
    const hold = s.review ? s.review.decision === "hold" : Boolean(deferred[s.ruleId]); // 没有 AI 决策时（如手动 check）保持原样
    if (hold) {
      triggered = triggered.filter((id) => id !== s.ruleId);
      if (s.ruleId === "up100") st.completed = false;
      if (s.review) deferred[s.ruleId] = { date: today, review: s.review };
    } else {
      delete deferred[s.ruleId];
    }
  }
  st.triggered = triggered;
  if (Object.keys(deferred).length) st.deferred = deferred;
  else delete st.deferred;
  st.alerted = mergeAlerted(st.alerted, signals, position, at);
}

export function mergeAlerted(prev: AlertedSignals | undefined, signals: Signal[], position: number, at: string): AlertedSignals {
  const list = [...(prev?.signals ?? [])];
  for (const s of signals) {
    const i = s.layer === "tier" ? list.findIndex((x) => x.layer === "tier" && x.ruleId === s.ruleId) : -1;
    const { quiet: _quiet, ...clean } = s; // quiet 只在本次检查中使用
    if (i >= 0) list[i] = clean;
    else list.push(clean);
  }
  const positionAfter = list.reduce((p, s) => p + (s.action === "buy" ? 1 : -1) * effectiveQuantity(s), position);
  return { at: prev?.at ?? at, signals: list, positionAfter };
}

/** 确认成交或忽略后：这些信号的档位算已触发，不再暂缓，清除待确认记录 */
export function settleConfirmed(st: SymbolState, signals: Signal[]): void {
  for (const s of signals) {
    if (s.layer !== "tier") continue;
    if (!st.triggered.includes(s.ruleId as TierId)) st.triggered.push(s.ruleId as TierId);
    if (s.ruleId === "up100") st.completed = true;
    if (st.deferred) delete st.deferred[s.ruleId];
  }
  if (st.deferred && !Object.keys(st.deferred).length) delete st.deferred;
  delete st.alerted;
}

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
