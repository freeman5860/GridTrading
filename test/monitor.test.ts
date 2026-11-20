import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeAlerted } from "../src/check.js";
import type { Signal } from "../src/core/types.js";
import { startMonitor, type Monitor } from "../src/server/monitor.js";
import type { TickOutcome } from "../src/scheduler.js";

let monitor: Monitor | undefined;
afterEach(() => monitor?.stop());

const result = (n: number) => ({ checkedAt: "", items: [], signalCount: n });
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
};

async function configFile(text = "notify:\n  webhooks: [{ type: bark, url: https://api.day.app/K }]\nwatchlist:\n  - { symbol: 510300, basePrice: 4, position: 100 }\n") {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "gridbot-mon-")), "gridbot.yaml");
  await writeFile(file, text);
  return file;
}

describe("控制台内置监控", () => {
  it("启动后立即检查一次并记录发送结果", async () => {
    const tickFn = vi.fn(async (): Promise<TickOutcome> => ({
      status: "checked", markets: ["cn"], result: result(2), notified: true, report: { sent: ["Bark"], failed: [] },
    }));
    monitor = startMonitor({ configPath: await configFile(), tickFn });
    await until(() => !!monitor!.status().last);
    const s = monitor.status();
    expect(tickFn).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ enabled: true, channels: ["Bark"], interval: 15 * 60_000 });
    expect(s.last?.text).toContain("2 个交易信号，已发送到 Bark");
    expect(new Date(s.nextAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("所有渠道失败、休市、没有配置文件时给出说明", async () => {
    let outcome: TickOutcome = { status: "notify-failed", markets: ["hk"], result: result(1), error: "Bark推送失败：HTTP 500" };
    monitor = startMonitor({ configPath: await configFile(), tickFn: async () => outcome });
    await until(() => !!monitor!.status().last);
    expect(monitor.status().last).toMatchObject({ status: "notify-failed" });
    expect(monitor.status().last?.text).toContain("下次检查会重试");

    outcome = { status: "closed", nextOpen: [{ market: "cn", at: new Date("2026-11-20T01:30:00Z") }] };
    expect((await monitor.checkNow()).last?.text).toContain("休市中");
    monitor.stop();

    monitor = startMonitor({ configPath: "/nonexistent/gridbot.yaml", tickFn: async () => outcome });
    await until(() => !!monitor!.status().last);
    expect(monitor.status().last).toMatchObject({ status: "error" });
  });

  it("立即检查与定时检查串行执行", async () => {
    let running = 0;
    let max = 0;
    const tickFn = async (): Promise<TickOutcome> => {
      max = Math.max(max, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { status: "checked", markets: ["cn"], result: result(0), notified: false };
    };
    monitor = startMonitor({ configPath: await configFile(), tickFn });
    await Promise.all([monitor.checkNow(), monitor.checkNow()]);
    expect(max).toBe(1);
  });
});

describe("待确认成交的信号", () => {
  const sig = (ruleId: string, qty: number, extra: Partial<Signal> = {}): Signal => ({ layer: "tier", action: "buy", quantity: qty, price: 1, amount: qty, ruleId, reason: "", ...extra });

  it("首次记录；同一档位的新决策替换旧记录，预计持仓按建议数量计算", () => {
    const first = mergeAlerted(undefined, [sig("down15", 100)], 1000, "t1");
    expect(first).toMatchObject({ at: "t1", positionAfter: 1100 });
    const next = mergeAlerted(first, [sig("down25", 200, { review: { decision: "reduce", quantity: 100, reason: "", by: "" } })], 1000, "t2");
    expect(next).toMatchObject({ at: "t1", positionAfter: 1200 });
    const replaced = mergeAlerted(next, [sig("down15", 100, { quiet: true, review: { decision: "hold", reason: "r", by: "" } })], 1000, "t3");
    expect(replaced.signals).toHaveLength(2);
    expect(replaced.signals[0]).not.toHaveProperty("quiet");
    expect(replaced.signals[0]!.review?.decision).toBe("hold");
  });
});
