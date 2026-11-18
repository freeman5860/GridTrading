// 各市场交易时段判断（按交易所当地时间，自动处理美股夏令时）。
// 不内置节假日日历：定时任务另外用"行情时间是否为当地今天"来识别休市日（见 quoteIsFresh）。

import { MARKETS } from "../core/symbol.js";
import type { Market, Quote } from "../core/types.js";

/** 连续交易时段（当地时间，分钟数），收盘时刻包含在内以便取到收盘价 */
const SESSIONS: Record<Market, [number, number][]> = {
  cn: [
    [9 * 60 + 30, 11 * 60 + 30],
    [13 * 60, 15 * 60],
  ],
  hk: [
    [9 * 60 + 30, 12 * 60],
    [13 * 60, 16 * 60],
  ],
  us: [[9 * 60 + 30, 16 * 60]],
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  /** 0 = 周日 */
  weekday: number;
  /** 当天 0 点起的分钟数 */
  minutes: number;
  /** HH:mm */
  hhmm: string;
}

export function localTime(market: Market, at: Date): LocalTime {
  const parts = Object.fromEntries(formatter(MARKETS[market].timezone).formatToParts(at).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday!),
    minutes: hour * 60 + minute,
    hhmm: `${String(hour).padStart(2, "0")}:${parts.minute}`,
  };
}

/** 是否处于交易时段（工作日 + 连续竞价时段；不识别节假日） */
export function isMarketOpen(market: Market, at: Date = new Date()): boolean {
  const t = localTime(market, at);
  if (t.weekday === 0 || t.weekday === 6) return false;
  return SESSIONS[market].some(([start, end]) => t.minutes >= start && t.minutes <= end);
}

/** 下一次开盘时间（按分钟逐步查找，最多 8 天） */
export function nextOpen(market: Market, from: Date = new Date()): Date {
  const start = Math.ceil(from.getTime() / 60_000) * 60_000;
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const d = new Date(start + i * 60_000);
    if (isMarketOpen(market, d)) return d;
  }
  throw new Error(`8 天内找不到 ${market} 的开盘时间`);
}

/**
 * 行情是否为"当地今天"的数据。交易时段内若行情日期仍是之前的日期，说明今天休市（节假日），
 * 此时不应拿旧价格去判断和更新状态。
 */
export function quoteIsFresh(quote: Pick<Quote, "market" | "time">, at: Date = new Date()): boolean {
  return quote.time.slice(0, 10) === localTime(quote.market, at).date;
}

export function describeSessions(market: Market): string {
  const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return SESSIONS[market].map(([a, b]) => `${f(a)}–${f(b)}`).join("、");
}
