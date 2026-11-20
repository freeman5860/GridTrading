import { describe, expect, it } from "vitest";
import { connectDayStatus, dayStatus, usCalendar } from "../src/market/holidays.js";
import { isMarketOpen, nextOpen } from "../src/market/hours.js";

const at = (iso: string) => new Date(iso);

describe("节假日日历", () => {
  it("美股：按纽交所规则计算（与 2026 / 2027 官方日历一致）", () => {
    expect(Object.keys(usCalendar(2026).closed).sort()).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    ]);
    expect(Object.keys(usCalendar(2026).early).sort()).toEqual(["2026-11-27", "2026-12-24"]);
    // 2027：圣诞节周六 → 周五 12-24 补休；独立日周日 → 周一 7-5；六月节周六 → 周五 6-18
    expect(Object.keys(usCalendar(2027).closed).sort()).toEqual([
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    ]);
    // 2022 元旦是周六：不在 2021-12-31 补休
    expect(usCalendar(2022).closed["2021-12-31"]).toBeUndefined();
  });

  it("A 股、港股：官方休市安排；2027 年 A 股为暂定", () => {
    expect(dayStatus("cn", "2026-10-05")).toMatchObject({ closed: "国庆节", known: true });
    expect(dayStatus("cn", "2027-02-10")).toMatchObject({ closed: "春节", provisional: true });
    expect(dayStatus("hk", "2026-04-07")).toMatchObject({ closed: "复活节星期一翌日" });
    expect(dayStatus("hk", "2026-12-24")).toMatchObject({ halfDay: "平安夜" });
    expect(dayStatus("hk", "2028-01-03")).toEqual({ known: false });
  });

  it("港股通：A 股或港股休市都不交易（与沪深交易所公布的 2026 年安排一致）", () => {
    // 公告中港股开市但港股通不交易的日子 + 港股休市的日子
    for (const d of ["2026-04-03", "2026-04-07", "2026-05-25", "2026-07-01", "2026-10-19", "2026-12-25", "2026-10-02", "2026-02-20"]) {
      expect(connectDayStatus(d).closed, d).toBeTruthy();
    }
    expect(connectDayStatus("2026-10-02").closed).toBe("内地国庆节");
    expect(connectDayStatus("2026-12-24")).toMatchObject({ closed: undefined, halfDay: "平安夜" });
    expect(connectDayStatus("2026-11-19").closed).toBeUndefined();
  });

  it("交易时段：节假日休市，半日市只有上午，美股提前收市", () => {
    expect(isMarketOpen("cn", at("2026-10-05T02:00:00Z"))).toBe(false); // 国庆
    expect(isMarketOpen("hk", at("2026-10-05T02:00:00Z"))).toBe(true); // 香港照常
    expect(isMarketOpen("hk", at("2026-12-24T03:00:00Z"))).toBe(true); // 平安夜 11:00
    expect(isMarketOpen("hk", at("2026-12-24T06:00:00Z"))).toBe(false); // 平安夜 14:00 已收市
    expect(isMarketOpen("us", at("2026-11-27T17:30:00Z"))).toBe(true); // 感恩节次日 12:30
    expect(isMarketOpen("us", at("2026-11-27T18:30:00Z"))).toBe(false); // 13:30 已收市
    expect(isMarketOpen("us", at("2026-11-26T15:00:00Z"))).toBe(false); // 感恩节
  });

  it("下次开盘跳过长假", () => {
    // 2026-09-30 收市后，A 股下次开盘是 10-08（国庆 10-01～10-07 + 周末）
    expect(nextOpen("cn", at("2026-09-30T08:00:00Z")).toISOString()).toBe("2026-10-08T01:30:00.000Z");
    // 春节：2026-02-13（周五）收市后 → 02-24
    expect(nextOpen("cn", at("2026-02-13T08:00:00Z")).toISOString()).toBe("2026-02-24T01:30:00.000Z");
    // 港股午休中 → 13:00
    expect(nextOpen("hk", at("2026-11-19T04:30:00Z")).toISOString()).toBe("2026-11-19T05:00:00.000Z");
  });
});
