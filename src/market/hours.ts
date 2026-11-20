// 各市场交易时段判断（按交易所当地时间，自动处理美股夏令时），包含节假日和半日市（见 holidays.ts）。
// 日历没有覆盖的年份只按周末判断，定时任务另外用"行情时间是否为当地今天"来识别休市日（见 quoteIsFresh）。

import { MARKETS } from "../core/symbol.js";
import type { Market, Quote } from "../core/types.js";
import { dayStatus } from "./holidays.js";

/** 半日市 / 提前收市的收市时间 */
const HALF_DAY_END: Record<Market, number> = { cn: 11 * 60 + 30, hk: 12 * 60, us: 13 * 60 };

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

/** 当地某天是否交易：周末、节假日休市 */
export function isTradingDay(market: Market, t: Pick<LocalTime, "date" | "weekday">): boolean {
  return t.weekday !== 0 && t.weekday !== 6 && !dayStatus(market, t.date).closed;
}

/** 某天的交易时段（半日市只有上午 / 提前收市） */
function sessionsOn(market: Market, date: string): [number, number][] {
  if (!dayStatus(market, date).halfDay) return SESSIONS[market];
  const end = HALF_DAY_END[market];
  return SESSIONS[market].filter(([start]) => start < end).map(([start, e]) => [start, Math.min(e, end)]);
}

/** 是否处于交易时段（交易日 + 连续竞价时段，含节假日和半日市） */
export function isMarketOpen(market: Market, at: Date = new Date()): boolean {
  const t = localTime(market, at);
  if (!isTradingDay(market, t)) return false;
  return sessionsOn(market, t.date).some(([start, end]) => t.minutes >= start && t.minutes <= end);
}

/** 下一次开盘时间：按分钟查找，休市日直接跳到第二天（最多查 30 天，覆盖国庆、春节长假） */
export function nextOpen(market: Market, from: Date = new Date()): Date {
  let ms = Math.ceil(from.getTime() / 60_000) * 60_000;
  const limit = ms + 30 * 24 * 3_600_000;
  while (ms < limit) {
    const d = new Date(ms);
    const t = localTime(market, d);
    if (!isTradingDay(market, t)) {
      ms += (24 * 60 - t.minutes) * 60_000; // 跳到当地第二天 0 点
      continue;
    }
    const sessions = sessionsOn(market, t.date);
    const next = sessions.find(([, end]) => t.minutes <= end);
    if (!next) {
      ms += (24 * 60 - t.minutes) * 60_000;
      continue;
    }
    if (t.minutes >= next[0]) return d;
    ms += (next[0] - t.minutes) * 60_000;
  }
  throw new Error(`30 天内找不到 ${market} 的开盘时间`);
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
