// AI 决策：规则引擎产生交易信号（买入、卖出）后、发送提醒前，由 AI 逐个判断"执行 / 减量 / 暂缓"。
// AI 不能增加数量、不能改价格；减量只能按整手减少。暂缓的档位之后每个交易日重新决策一次。
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

const decisionSchema = z.preprocess(
  (v) =>
    typeof v === "string"
      ? (({ 执行: "execute", 减量: "reduce", 暂缓: "hold", buy: "execute", sell: "execute", wait: "hold" }) as Record<string, string>)[v.trim()] ?? v.trim().toLowerCase()
      : v,
  z.enum(["execute", "reduce", "hold"]),
);

const reviewSchema = z.object({
  signals: z.array(z.object({ id: z.coerce.number(), decision: decisionSchema, quantity: z.coerce.number().optional().nullable() })).optional(),
  /** 兼容只给出一个总体决策的回答 */
  decision: decisionSchema.optional(),
  reason: z.string().min(1),
});

async function reviewSystemPrompt(): Promise<string> {
  return `你是网格交易的决策助手。规则引擎已按下面的《网格交易规则》算出交易信号（方向、数量、价格），你要逐个信号决定：执行（execute）、减量执行（reduce）、还是暂缓（hold）。

<grid_rules>
${await loadRulesText()}
</grid_rules>

判断要点：
1. 对照规则的"适用条件"：单边行情中网格失效。
   - 买入：近期是否单边下跌（连续下跌、均线空头排列、跌破前低且没有企稳迹象）。明显单边下跌时暂缓，下跌放缓但未企稳时可减量。
   - 卖出：是否处于强势单边上涨（连续上涨、均线多头排列、放量突破），强势时可减量以免过早卖飞；趋势转弱、或 +100% 清仓档，应执行。
2. 跌破 −25% 时规则要求先复核基本面 / 投资逻辑，你无法确认时倾向暂缓，并说明需要用户核实什么。
3. 资金是否充足、加仓后仓位是否过重。
4. 减量时 quantity 必须是每手股数的整数倍，且小于规则数量；不能增加数量，不能改价格。
5. 不要编造新闻或基本面数据，只根据给出的数据判断。被暂缓的信号会在之后每个交易日重新请你决策一次。

只输出一个 JSON 对象，不要输出其他文字：
{"signals": [{"id": 信号编号, "decision": "execute" | "reduce" | "hold", "quantity": 减量后的数量（仅 reduce 时填写）}], "reason": "中文，100 字以内，说明主要依据和需要注意的风险"}`;
}

const actionText = (a: string) => (a === "buy" ? "买入" : "卖出");

/**
 * 对每个有待决策信号的标的调用一次 AI，把决策写入对应信号（signal.review）。
 * 跳过 quiet 的信号（今天已决策过、仍在暂缓中）。
 */
export async function reviewSignals(client: AIClient, items: CheckItem[], signal?: AbortSignal): Promise<void> {
  const by = `${PROVIDER_INFO[client.provider].name} · ${client.model}`;
  const targets = items.filter((i) => i.evaluation?.signals.some((s) => !s.quiet));
  if (!targets.length) return;
  const system = await reviewSystemPrompt();

  await Promise.all(
    targets.map(async (item) => {
      const ev = item.evaluation!;
      const pending = ev.signals.filter((s) => !s.quiet);
      const lot = item.quote?.lotSize && item.quote.lotSize > 0 ? item.quote.lotSize : 1;
      try {
        let history = "（获取历史行情失败）";
        try {
          history = describeHistory(await historySource.fetchHistory(item.holding.symbol, 60, signal));
        } catch {
          /* 没有历史行情也继续决策 */
        }
        const holding = { ...item.holding, name: item.quote?.name ?? item.holding.name };
        const list = pending
          .map((s, i) => `${i + 1}. ${actionText(s.action)} ${s.quantity} @ ${s.price}（${s.layer === "tier" ? "分档" : "网格"}：${s.reason}）`)
          .join("\n");
        const raw = await complete(client, {
          system,
          prompt:
            `<engine_result>\n${describeEvaluation(holding, item.quote, ev)}\n</engine_result>\n\n` +
            `<signals lot="${lot}">\n${list}\n</signals>\n\n<history>\n${history}\n</history>`,
          effort: "medium",
          json: true,
          signal,
        });
        const parsed = reviewSchema.safeParse(parseJsonObject(raw));
        if (!parsed.success) throw new Error("AI 返回的决策格式不正确");
        const { reason } = parsed.data;
        pending.forEach((s, i) => {
          const d = parsed.data.signals?.find((x) => x.id === i + 1) ?? (parsed.data.decision ? { decision: parsed.data.decision, quantity: undefined } : undefined);
          if (!d) {
            s.review = { decision: "error", reason: "AI 没有给出这个信号的决策，按规则信号提醒，请自行判断", by };
            return;
          }
          s.review = normalizeDecision(d.decision, d.quantity ?? undefined, s.quantity, lot, reason, by);
        });
      } catch (e) {
        for (const s of pending) s.review = { decision: "error", reason: `AI 决策失败（${describeAIError(e)}），按规则信号提醒，请自行判断`, by };
      }
    }),
  );
}

/** 校正减量数量：按整手向下取整；不小于规则数量视为执行，为 0 视为暂缓 */
export function normalizeDecision(decision: "execute" | "reduce" | "hold", quantity: number | undefined, ruleQty: number, lot: number, reason: string, by: string): SignalReview {
  if (decision !== "reduce") return { decision, reason, by };
  const q = quantity && quantity > 0 ? Math.floor(quantity / lot) * lot : 0;
  if (q >= ruleQty) return { decision: "execute", reason, by };
  if (q <= 0) return { decision: "hold", reason, by };
  return { decision: "reduce", quantity: q, reason, by };
}

export { effectiveQuantity } from "../core/fill.js";
