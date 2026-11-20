// 交易所节假日日历。
//
// - A 股：上交所 / 深交所休市安排。2026 年来自上证公告〔2025〕45号（2025-12-22）；
//   2027 年交易所尚未公布，暂按国务院办公厅 2027 年节假日安排（国办发明电〔2026〕10号）推算的工作日休市，标记为"暂定"。
// - 港股：港交所通告 CT/075/25（2026 年）、CT/077/26（2027 年），含半日市（只有上午交易）。
// - 美股：按纽交所规则计算（任意年份），含提前收市（13:00）。
// - 港股通（南向）：只在 A 股和港股都开市的日子交易；港股半日市当天下午不提供服务。
//   与沪深交易所公布的 2026 年港股通交易日安排一致。
// 日历没有覆盖的年份只按周末判断，定时检查另外用"行情日期是否为今天"识别休市（见 quoteIsFresh）。
// 每年年底交易所公布下一年安排后，在这里补充。

import type { Market } from "../core/types.js";

type Calendar = Record<number, Record<string, string>>;

const CN: Calendar = {
  2026: {
    "2026-01-01": "元旦", "2026-01-02": "元旦",
    "2026-02-16": "春节", "2026-02-17": "春节", "2026-02-18": "春节", "2026-02-19": "春节", "2026-02-20": "春节", "2026-02-23": "春节",
    "2026-04-06": "清明节",
    "2026-05-01": "劳动节", "2026-05-04": "劳动节", "2026-05-05": "劳动节",
    "2026-06-19": "端午节",
    "2026-09-25": "中秋节",
    "2026-10-01": "国庆节", "2026-10-02": "国庆节", "2026-10-05": "国庆节", "2026-10-06": "国庆节", "2026-10-07": "国庆节",
  },
  2027: {
    "2027-01-01": "元旦",
    "2027-02-05": "春节", "2027-02-08": "春节", "2027-02-09": "春节", "2027-02-10": "春节", "2027-02-11": "春节", "2027-02-12": "春节",
    "2027-04-05": "清明节",
    "2027-05-03": "劳动节", "2027-05-04": "劳动节", "2027-05-05": "劳动节",
    "2027-06-09": "端午节",
    "2027-09-15": "中秋节",
    "2027-10-01": "国庆节", "2027-10-04": "国庆节", "2027-10-05": "国庆节", "2027-10-06": "国庆节", "2027-10-07": "国庆节",
  },
};
/** 交易所尚未公布、按国务院节假日安排推算的年份 */
export const CN_PROVISIONAL = new Set([2027]);

const HK: Calendar = {
  2026: {
    "2026-01-01": "元旦", "2026-02-17": "农历新年", "2026-02-18": "农历新年", "2026-02-19": "农历新年",
    "2026-04-03": "耶稣受难节", "2026-04-06": "清明节翌日", "2026-04-07": "复活节星期一翌日", "2026-05-01": "劳动节",
    "2026-05-25": "佛诞翌日", "2026-06-19": "端午节", "2026-07-01": "香港特区成立纪念日", "2026-10-01": "国庆日",
    "2026-10-19": "重阳节翌日", "2026-12-25": "圣诞节",
  },
  2027: {
    "2027-01-01": "元旦", "2027-02-08": "农历新年", "2027-02-09": "农历新年", "2027-03-26": "耶稣受难节",
    "2027-03-29": "复活节星期一", "2027-04-05": "清明节", "2027-05-13": "佛诞", "2027-06-09": "端午节",
    "2027-07-01": "香港特区成立纪念日", "2027-09-16": "中秋节翌日", "2027-10-01": "国庆日", "2027-10-08": "重阳节",
    "2027-12-27": "圣诞节后第一个工作日",
  },
};
const HK_HALF: Calendar = {
  2026: { "2026-02-16": "农历除夕", "2026-12-24": "平安夜", "2026-12-31": "除夕" },
  2027: { "2027-02-05": "农历除夕", "2027-12-24": "平安夜", "2027-12-31": "除夕" },
};

// ---------------- 美股（纽交所规则） ----------------

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
/** 某月第 n 个星期 w（n = -1 表示最后一个） */
function nthWeekday(y: number, m: number, w: number, n: number): number {
  if (n > 0) return 1 + ((w - weekdayOf(y, m, 1) + 7) % 7) + (n - 1) * 7;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((weekdayOf(y, m, last) - w + 7) % 7);
}
/** 复活节（公历，Anonymous Gregorian 算法） */
function easter(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1];
}
/** 固定日期的假日落在周末时：周六提前到周五，周日顺延到周一 */
function observed(y: number, m: number, d: number): string {
  const w = weekdayOf(y, m, d);
  const t = new Date(Date.UTC(y, m - 1, d + (w === 6 ? -1 : w === 0 ? 1 : 0)));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const usCache = new Map<number, { closed: Record<string, string>; early: Record<string, string> }>();
export function usCalendar(y: number) {
  let c = usCache.get(y);
  if (c) return c;
  const closed: Record<string, string> = {};
  // 元旦落在周六时纽交所不在前一年 12 月 31 日补休
  if (weekdayOf(y, 1, 1) !== 6) closed[observed(y, 1, 1)] = "元旦";
  closed[iso(y, 1, nthWeekday(y, 1, 1, 3))] = "马丁·路德·金纪念日";
  closed[iso(y, 2, nthWeekday(y, 2, 1, 3))] = "总统日";
  const [em, ed] = easter(y);
  const gf = new Date(Date.UTC(y, em - 1, ed - 2));
  closed[iso(y, gf.getUTCMonth() + 1, gf.getUTCDate())] = "耶稣受难日";
  closed[iso(y, 5, nthWeekday(y, 5, 1, -1))] = "阵亡将士纪念日";
  if (y >= 2022) closed[observed(y, 6, 19)] = "六月节";
  closed[observed(y, 7, 4)] = "独立日";
  closed[iso(y, 9, nthWeekday(y, 9, 1, 1))] = "劳动节";
  const thanks = nthWeekday(y, 11, 4, 4);
  closed[iso(y, 11, thanks)] = "感恩节";
  closed[observed(y, 12, 25)] = "圣诞节";

  const early: Record<string, string> = {};
  early[iso(y, 11, thanks + 1)] = "感恩节次日";
  const xmasEve = weekdayOf(y, 12, 24);
  if (xmasEve >= 1 && xmasEve <= 4) early[iso(y, 12, 24)] = "平安夜";
  const july4 = weekdayOf(y, 7, 4);
  if (july4 >= 2 && july4 <= 5) early[iso(y, 7, 3)] = "独立日前一天";
  c = { closed, early };
  usCache.set(y, c);
  return c;
}

// ---------------- 查询 ----------------

export interface DayStatus {
  /** 休市原因（节假日名称）；undefined 表示不是节假日 */
  closed?: string;
  /** 半日市 / 提前收市 */
  halfDay?: string;
  /** 日历是否覆盖这一年 */
  known: boolean;
  /** 按国务院安排推算，交易所尚未公布 */
  provisional?: boolean;
}

/** 某市场某天（当地日期 YYYY-MM-DD）的节假日情况，不含周末判断 */
export function dayStatus(market: Market, date: string): DayStatus {
  const y = Number(date.slice(0, 4));
  if (market === "us") {
    const c = usCalendar(y);
    return { closed: c.closed[date], halfDay: c.early[date], known: true };
  }
  const table = market === "cn" ? CN : HK;
  if (!table[y]) return { known: false };
  return {
    closed: table[y]![date],
    halfDay: market === "hk" ? HK_HALF[y]?.[date] : undefined,
    known: true,
    provisional: market === "cn" && CN_PROVISIONAL.has(y) ? true : undefined,
  };
}

/** 港股通（南向）某天：A 股或港股休市则不交易；港股半日市当天下午不提供服务 */
export function connectDayStatus(date: string): DayStatus {
  const cn = dayStatus("cn", date);
  const hk = dayStatus("hk", date);
  return {
    closed: cn.closed ? `内地${cn.closed}` : hk.closed ? `香港${hk.closed}` : undefined,
    halfDay: hk.halfDay,
    known: cn.known && hk.known,
    provisional: cn.provisional,
  };
}

/** 日历覆盖的年份说明 */
export function calendarCoverage(): string {
  const years = (t: Calendar) => Object.keys(t).join("、");
  const cnYears = Object.keys(CN).map((y) => (CN_PROVISIONAL.has(Number(y)) ? `${y}（暂定）` : y)).join("、");
  return `节假日日历：A 股 ${cnYears}，港股 ${years(HK)}，美股按纽交所规则计算；其他年份只按周末判断，并根据行情日期识别休市`;
}
