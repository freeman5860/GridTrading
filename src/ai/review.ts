// AI 决策：规则引擎产生买入信号后、发送提醒前，由 AI 判断"执行"还是"暂缓"。
// AI 只做是否执行的判断，不改动数量和价格；数量始终以规则引擎为准。
// 判断依据：网格规则（含适用条件）、引擎计算结果、近 60 个交易日的日 K 走势。

import { z } from "zod";
import type { CheckItem } from "../check.js";
import type { SignalReview } from "../core/types.js";
import { describeEvaluation, loadRulesText, parseJsonObject } from "./analyze.js";
import { complete, describeAIError, PROVIDER_INFO, type AIClient } from "./providers.js";

// ---------------- 历史行情 ----------------

export interface Bar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
}

const KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=";

export function parseKline(json: unknown, key: string): { bars: Bar[]; fullCode?: string } {
  const data = (json as { data?: Record<string, Record<string, unknown>> })?.data?.[key];
  const rows = (data?.qfqday ?? data?.day ?? []) as unknown[];
  const bars = rows
    .filter((r): r is string[] => Array.isArray(r) && r.length >= 5)
    .map((r) => ({ date: r[0]!, open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]) }))
    .filter((b) => b.close > 0);
  // 美股需要带交易所后缀（如 QQQ.OQ），实时报价的第 3 个字段就是完整代码
  const qt = (data?.qt as Record<string, string[]> | undefined)?.[key];
  return { bars, fullCode: qt?.[2] };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(10_000);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { "User-Agent": "Mozilla/5.0 (compatible; gridbot)" } });
  if (!res.ok) throw new Error(`K 线接口返回 HTTP ${res.status}`);
  return res.json();
}

/** 近 days 个交易日的前复权日 K（腾讯公开接口） */
export async function fetchHistory(symbol: string, days = 60, signal?: AbortSignal): Promise<Bar[]> {
  const url = (code: string) => `${KLINE}${code},day,,,${days},qfq`;
  let { bars, fullCode } = parseKline(await fetchJson(url(symbol), signal), symbol);
  if (symbol.startsWith("us") && bars.length < days / 2 && fullCode?.includes(".")) {
    const code = `us${fullCode}`;
    ({ bars } = parseKline(await fetchJson(url(code), signal), code));
  }
  return bars.slice(-days);
}

export const historySource = { fetchHistory };

/** 把日 K 压缩成给 AI 看的走势摘要 */
export function describeHistory(bars: Bar[]): string {
  if (bars.length < 5) return "（没有足够的历史行情）";
  const closes = bars.map((b) => b.close);
  const last = closes.at(-1)!;
  const pct = (n: number) => {
    const from = closes.at(-1 - n);
    return from ? `${(((last - from) / from) * 100).toFixed(1)}%` : "—";
  };
  const ma = (n: number) => (closes.length >= n ? (closes.slice(-n).reduce((a, b) => a + b, 0) / n).toFixed(3) : "—");
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  const recent = closes.slice(-11); // 10 个交易日的涨跌需要 11 个收盘价
  const down = recent.filter((c, i, a) => i > 0 && c < a[i - 1]!).length;
  return [
    `近 ${bars.length} 个交易日（${bars[0]!.date} ～ ${bars.at(-1)!.date}）：最高 ${high}，最低 ${low}，最新收盘 ${last}`,
    `涨跌幅：近 5 日 ${pct(5)}，近 20 日 ${pct(20)}，近 ${bars.length - 1} 日 ${pct(bars.length - 1)}`,
    `均线：MA5 ${ma(5)}，MA20 ${ma(20)}，MA60 ${ma(60)}；最近 ${recent.length - 1} 个交易日中 ${down} 天下跌`,
    `最近 20 个交易日收盘价：${closes.slice(-20).join(", ")}`,
  ].join("\n");
}

// ---------------- 决策 ----------------

const reviewSchema = z.object({
  decision: z.preprocess(
    (v) => (typeof v === "string" ? ({ 执行: "execute", 暂缓: "hold", buy: "execute", wait: "hold" } as Record<string, string>)[v.trim()] ?? v.trim().toLowerCase() : v),
    z.enum(["execute", "hold"]),
  ),
  reason: z.string().min(1),
});

async function reviewSystemPrompt(): Promise<string> {
  return `你是网格交易的买入决策助手。规则引擎已按下面的《网格交易规则》算出买入信号（数量、价格已确定），你要决定这次买入是"执行"还是"暂缓"。

<grid_rules>
${await loadRulesText()}
</grid_rules>

判断要点：
1. 对照规则的"适用条件"：近期是否为单边下跌（如连续下跌、均线空头排列、跌破前低且没有企稳迹象），单边下跌中网格失效、应暂缓；
2. 跌破 −25% 时规则要求先复核基本面 / 投资逻辑，你无法确认时应倾向暂缓并说明需要用户核实什么；
3. 资金是否充足、加仓后仓位是否过重；
4. 不要改动数量和价格，不要编造新闻或基本面数据，只根据给出的数据判断。

只输出一个 JSON 对象，不要输出其他文字：
{"decision": "execute" 或 "hold", "reason": "中文，80 字以内，说明主要依据和需要注意的风险"}`;
}

/** 对每个有买入信号的标的调用一次 AI，把决策写入该标的的买入信号 */
export async function reviewBuys(client: AIClient, items: CheckItem[], signal?: AbortSignal): Promise<void> {
  const by = `${PROVIDER_INFO[client.provider].name} · ${client.model}`;
  const targets = items.filter((i) => i.evaluation?.signals.some((s) => s.action === "buy"));
  if (!targets.length) return;
  const system = await reviewSystemPrompt();

  await Promise.all(
    targets.map(async (item) => {
      const ev = item.evaluation!;
      let review: SignalReview;
      try {
        let history = "（获取历史行情失败）";
        try {
          history = describeHistory(await historySource.fetchHistory(item.holding.symbol, 60, signal));
        } catch {
          /* 没有历史行情也继续决策 */
        }
        const holding = { ...item.holding, name: item.quote?.name ?? item.holding.name };
        const raw = await complete(client, {
          system,
          prompt: `<engine_result>\n${describeEvaluation(holding, item.quote, ev)}\n</engine_result>\n\n<history>\n${history}\n</history>`,
          effort: "medium",
          json: true,
          signal,
        });
        const parsed = reviewSchema.safeParse(parseJsonObject(raw));
        if (!parsed.success) throw new Error("AI 返回的决策格式不正确");
        review = { ...parsed.data, by };
      } catch (e) {
        review = { decision: "error", reason: `AI 决策失败（${describeAIError(e)}），按规则信号提醒，请自行判断`, by };
      }
      for (const s of ev.signals) if (s.action === "buy") s.review = review;
    }),
  );
}
