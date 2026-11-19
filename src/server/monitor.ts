// 控制台内置的定时监控：与 gridbot run 相同，在交易时段内按间隔检查，有信号时发送提醒。
// 每次检查前重新读取配置；没有配置文件或配置有误时等待，修好后自动继续。

import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { MARKETS } from "../core/symbol.js";
import { describeNextOpen, nextBoundary, notifierFor, tick, type TickOutcome } from "../scheduler.js";

export interface MonitorStatus {
  enabled: boolean;
  /** 正在检查 */
  busy: boolean;
  interval?: number;
  channels: string[];
  nextAt?: string;
  last?: {
    at: string;
    status: TickOutcome["status"] | "error";
    /** 给用户看的一句话 */
    text: string;
    signalCount?: number;
    sent?: string[];
    failed?: string[];
  };
}

export interface Monitor {
  status(): MonitorStatus;
  /** 立即检查一次（和定时检查互斥） */
  checkNow(): Promise<MonitorStatus>;
  stop(): void;
}

const RETRY_MS = 60_000;

export function startMonitor(opts: { configPath: string; log?: (line: string) => void; tickFn?: typeof tick }): Monitor {
  const log = opts.log ?? (() => {});
  const run = opts.tickFn ?? tick;
  const ac = new AbortController();
  const state: MonitorStatus = { enabled: true, busy: false, channels: [] };
  let chain: Promise<unknown> = Promise.resolve(); // 串行执行，定时检查和"立即检查"不会同时进行

  async function once(): Promise<number> {
    let config;
    try {
      config = await loadConfig(opts.configPath);
    } catch (e) {
      record("error", `无法读取配置：${(e as Error).message.split("\n")[0]}`);
      return RETRY_MS;
    }
    const notifier = notifierFor(config);
    state.interval = config.schedule.interval;
    state.channels = notifier?.channels.map((c) => c.name) ?? [];
    try {
      const outcome = await run(config);
      describe(outcome);
    } catch (e) {
      record("error", `检查失败，稍后重试：${(e as Error).message}`);
    }
    return config.schedule.interval;
  }

  function record(status: NonNullable<MonitorStatus["last"]>["status"], text: string, extra: Partial<NonNullable<MonitorStatus["last"]>> = {}) {
    const prev = state.last;
    state.last = { at: new Date().toISOString(), status, text, ...extra };
    // 休市期间只在状态变化时记日志
    if (!(status === "closed" && prev?.status === "closed")) log(text);
  }

  function describe(o: TickOutcome) {
    if (o.status === "closed") return record("closed", `休市中，下次开盘：${describeNextOpen(o.nextOpen)}`);
    const names = o.markets.map((m) => MARKETS[m].name).join("、");
    const n = o.result.signalCount;
    if (o.status === "notify-failed") {
      return record("notify-failed", `检查 ${names}：${n} 个交易信号，但所有提醒渠道都发送失败（${o.error}），下次检查会重试`, { signalCount: n });
    }
    const sent = o.report?.sent ?? [];
    const failed = o.report?.failed.map((f) => f.error) ?? [];
    let text = `检查 ${names}：${n ? `${n} 个交易信号` : "无交易信号"}`;
    if (o.notified) text += `，已发送到 ${sent.join("、") || "提醒渠道"}`;
    else if (n) text += "，未配置提醒渠道，没有发送";
    if (failed.length) text += `；${failed.join("；")}`;
    record("checked", text, { signalCount: n, sent, failed });
  }

  function guarded(): Promise<number> {
    const p = chain.then(async () => {
      state.busy = true;
      try {
        return await once();
      } finally {
        state.busy = false;
      }
    });
    chain = p.catch(() => undefined);
    return p;
  }

  (async () => {
    while (!ac.signal.aborted) {
      const wait = await guarded();
      const next = wait === RETRY_MS ? Date.now() + RETRY_MS : nextBoundary(Date.now(), wait);
      state.nextAt = new Date(next).toISOString();
      try {
        await sleep(next - Date.now(), undefined, { signal: ac.signal });
      } catch {
        break;
      }
    }
  })();

  return {
    status: () => structuredClone(state),
    async checkNow() {
      await guarded();
      return structuredClone(state);
    },
    stop: () => ac.abort(),
  };
}

export const disabledMonitor: Monitor = {
  status: () => ({ enabled: false, busy: false, channels: [] }),
  checkNow: async () => ({ enabled: false, busy: false, channels: [] }),
  stop: () => {},
};
