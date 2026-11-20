// 定时运行：交易时段内按间隔检查，有交易信号时发邮件。
// 每次检查前重新读取配置，交易后修改 position 不需要重启进程。

import { setTimeout as sleep } from "node:timers/promises";
import { prepareCheck, type CheckItem, type CheckResult } from "./check.js";
import { loadConfig, type Config } from "./config.js";
import { MARKETS, marketOf } from "./core/symbol.js";
import type { Market } from "./core/types.js";
import { isMarketOpen, localTime, nextOpen } from "./market/hours.js";
import type { Notifier } from "./notify/email.js";
import { channelsFor, combine, NotifyError, type SendReport } from "./notify/index.js";
import { renderSignalEmail, signalItems, type RenderedEmail } from "./notify/render.js";
import { emailComment } from "./ai/analyze.js";
import { reviewSignals } from "./ai/review.js";
import { createAIClient, describeAIError, PROVIDER_INFO, type AIClient } from "./ai/providers.js";

export const ALL_MARKETS: Market[] = ["cn", "hk", "us"];

export type TickOutcome =
  | { status: "closed"; nextOpen: { market: Market; at: Date }[] }
  | { status: "checked"; markets: Market[]; result: CheckResult; notified: boolean; report?: SendReport }
  | { status: "notify-failed"; markets: Market[]; result: CheckResult; error: string };

export interface TickDeps {
  now?: Date;
  /** 测试用：替换邮件发送 */
  notifier?: Notifier | null;
  /** 测试用：替换 AI 客户端 */
  ai?: AIClient | null;
}

/** 配置中需要监控、且有标的的市场 */
export function watchedMarkets(config: Config): Market[] {
  const configured = config.schedule.markets ?? ALL_MARKETS;
  const present = new Set(config.watchlist.map((h) => marketOf(h.symbol)));
  return configured.filter((m) => present.has(m));
}

export function notifierFor(config: Config) {
  return combine(channelsFor(config));
}

export async function tick(config: Config, deps: TickDeps = {}): Promise<TickOutcome> {
  const now = deps.now ?? new Date();
  const watched = watchedMarkets(config);
  const open = watched.filter((m) => isMarketOpen(m, now));
  if (!open.length) {
    return { status: "closed", nextOpen: watched.map((market) => ({ market, at: nextOpen(market, now) })) };
  }

  const prepared = await prepareCheck(config, { markets: open, requireFresh: true, now });
  const full = prepared.result;
  const notifier = deps.notifier === undefined ? notifierFor(config) : deps.notifier;

  // AI 暂缓中的档位：今天已经决策过的不再请 AI、不再提醒
  const deferredOf = (i: CheckItem) => prepared.state.symbols[i.holding.symbol]?.deferred ?? {};
  const today = (i: CheckItem) => localTime(marketOf(i.holding.symbol), now).date;
  for (const item of full.items) {
    for (const s of item.evaluation?.signals ?? []) {
      const d = s.layer === "tier" ? deferredOf(item)[s.ruleId] : undefined;
      if (d && d.date === today(item)) Object.assign(s, { quiet: true, review: d.review });
    }
  }

  // 交易信号先交给 AI 决策（执行 / 减量 / 暂缓），决策写入信号，随提醒发送并保存在待确认记录中
  if (config.ai?.review && full.items.some((i) => i.evaluation?.signals.some((s) => !s.quiet))) {
    let client: AIClient | null = null;
    try {
      client = deps.ai === undefined ? createAIClient(config.ai) : deps.ai;
    } catch (e) {
      markReviewError(full, describeAIError(e));
    }
    if (client) await reviewSignals(client, full.items, AbortSignal.timeout(180_000));
  }

  // 之前已暂缓、今天重新决策后仍然暂缓：不重复提醒（页面上可以看到最新决策）
  for (const item of full.items) {
    for (const s of item.evaluation?.signals ?? []) {
      if (!s.quiet && s.layer === "tier" && s.review?.decision === "hold" && deferredOf(item)[s.ruleId]) s.quiet = true;
    }
  }

  // 本次要提醒的信号（去掉 quiet 的）；状态保存使用完整结果
  const result = notifyView(full);
  const shouldNotify = notifier && (result.signalCount > 0 || config.notify?.always);

  let notified = false;
  let report: SendReport | undefined;
  if (shouldNotify) {
    try {
      report = (await notifier.send(await buildSignalEmail(config, result, deps.ai))) ?? undefined;
      notified = true;
    } catch (e) {
      // 所有渠道都失败：不保存状态，下次检查会重新产生这些信号并再次发送，避免"每轮只提醒一次"的信号丢失。
      // 只要有一个渠道成功就保存状态，否则成功的渠道会重复收到提醒。
      const error = e instanceof NotifyError ? e.message : (e as Error).message;
      return { status: "notify-failed", markets: open, result, error };
    }
  }
  await prepared.commit();
  return { status: "checked", markets: open, result, notified, report };
}

function markReviewError(result: CheckResult, error: string) {
  for (const i of result.items)
    for (const s of i.evaluation?.signals ?? []) if (!s.quiet) s.review = { decision: "error", reason: `AI 决策失败（${error}），按规则信号提醒，请自行判断`, by: "" };
}

/** 只保留需要提醒的信号 */
function notifyView(result: CheckResult): CheckResult {
  const items = result.items.map((i) =>
    i.evaluation && i.evaluation.signals.some((s) => s.quiet) ? { ...i, evaluation: { ...i.evaluation, signals: i.evaluation.signals.filter((s) => !s.quiet) } } : i,
  );
  return { ...result, items, signalCount: items.reduce((n, i) => n + (i.evaluation?.signals.length ?? 0), 0) };
}

/** 渲染信号邮件；开启 ai.emailComment 时附带 AI 点评，点评失败不影响发送 */
export async function buildSignalEmail(config: Config, result: CheckResult, aiOverride?: AIClient | null): Promise<RenderedEmail> {
  if (!config.ai?.emailComment || result.signalCount === 0) return renderSignalEmail(result);
  try {
    const client = aiOverride === undefined ? createAIClient(config.ai) : aiOverride;
    if (!client) return renderSignalEmail(result);
    const comment = await emailComment(client, signalItems(result), AbortSignal.timeout(120_000));
    return renderSignalEmail(result, { comment, commentBy: `${PROVIDER_INFO[client.provider].name} · ${client.model}` });
  } catch (e) {
    return renderSignalEmail(result, { comment: `（AI 点评生成失败：${describeAIError(e)}）` });
  }
}

export function describeNextOpen(list: { market: Market; at: Date }[]): string {
  const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return list
    .map(({ market, at }) => {
      const t = localTime(market, at);
      const local = `${MARKETS[market].name} ${t.date.slice(5)} ${days[t.weekday]} ${t.hhmm}`;
      if (market === "cn") return local;
      const bj = localTime("cn", at); // A 股时区即北京时间
      return `${local}（当地时间，北京时间 ${bj.date.slice(5)} ${bj.hhmm}）`;
    })
    .join("；");
}

export interface LoopOptions {
  configPath: string;
  signal: AbortSignal;
  /** 覆盖配置中的间隔（毫秒） */
  interval?: number;
  log: (line: string) => void;
  /** 每次检查完成后的回调（CLI 用来打印详情） */
  onTick?: (outcome: TickOutcome) => void;
}

/** 下一个与间隔对齐的时间点（如 15 分钟间隔对齐到 :00 / :15 / :30 / :45） */
export function nextBoundary(now: number, interval: number): number {
  return Math.floor(now / interval) * interval + interval;
}

export async function runLoop(opts: LoopOptions): Promise<void> {
  let config: Config | undefined;
  let lastStatus: TickOutcome["status"] | undefined;

  while (!opts.signal.aborted) {
    try {
      config = await loadConfig(opts.configPath);
    } catch (e) {
      if (!config) throw e;
      opts.log(`⚠ 配置文件读取失败，继续使用上一次的配置：${(e as Error).message}`);
    }

    const interval = opts.interval ?? config.schedule.interval;
    try {
      const outcome = await tick(config);
      if (outcome.status === "closed") {
        // 休市期间只在状态变化时提示一次，避免刷屏
        if (lastStatus !== "closed") opts.log(`休市中。下次开盘：${describeNextOpen(outcome.nextOpen)}`);
      } else {
        opts.onTick?.(outcome);
      }
      lastStatus = outcome.status;
    } catch (e) {
      lastStatus = undefined;
      opts.log(`⚠ 本次检查失败，将在下次重试：${(e as Error).message}`);
    }

    const wait = nextBoundary(Date.now(), interval) - Date.now();
    try {
      await sleep(wait, undefined, { signal: opts.signal });
    } catch {
      break; // 收到退出信号
    }
  }
}
