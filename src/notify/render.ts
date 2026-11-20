// 把一次检查结果渲染成邮件（主题 + 纯文本 + HTML）。只包含有交易信号的标的。

import type { CheckItem, CheckResult } from "../check.js";
import { formatPct } from "../core/engine.js";
import { MARKETS } from "../core/symbol.js";
import type { Evaluation, Signal, SignalReview } from "../core/types.js";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const DISCLAIMER = "以上信号由预设规则机械计算，仅供学习参考，不构成投资建议。市场有风险，投资需谨慎。";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const num = (n: number) => String(Number(n.toFixed(4)));
const money = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const actionText = (s: Signal) => (s.action === "buy" ? "买入" : "卖出");
const itemName = (i: CheckItem) => i.quote?.name ?? i.holding.name ?? i.holding.symbol;

const marketLabel = (i: CheckItem) => (i.holding.connect ? "港股通" : MARKETS[i.quote!.market].name);
const baseText = (ev: Evaluation) => (ev.basePriceHkd !== undefined ? `${num(ev.basePrice)} 元（≈ ${num(ev.basePriceHkd)} HKD）` : num(ev.basePrice));
/** AI 决策的简短说明：建议执行 / 建议减量为 N / 建议暂缓 / 决策失败 */
export const decisionText = (r: SignalReview) =>
  ({ execute: "建议执行", reduce: `建议减量为 ${r.quantity}`, hold: "建议暂缓", error: "决策失败" })[r.decision];
/** 同一标的的信号共用一段 AI 理由 */
const itemReview = (i: CheckItem) => i.evaluation!.signals.find((s) => s.review)?.review;
const reviewLine = (r: SignalReview) => (r.decision === "error" ? `AI 决策：${r.reason}` : `AI 理由${r.by ? `（${r.by}）` : ""}：${r.reason}`);
const signalReviewText = (s: Signal) => (s.review && s.review.decision !== "error" ? ` → AI ${decisionText(s.review)}` : "");
/** 主题中的 AI 结论：全部相同时直接写出，否则"部分暂缓 / 部分减量" */
function subjectReview(i: CheckItem): string {
  const rs = i.evaluation!.signals.map((s) => s.review).filter((r): r is SignalReview => !!r && r.decision !== "error");
  if (!rs.length) return "";
  const kinds = new Set(rs.map((r) => r.decision));
  if (kinds.size === 1) return rs[0]!.decision === "reduce" ? "（AI 建议减量）" : `（AI ${decisionText(rs[0]!)}）`;
  return kinds.has("hold") ? "（AI：部分暂缓）" : "（AI：部分减量）";
}
const cny = (s: Signal) => (s.amountCny !== undefined ? `（约 ${money(s.amountCny)} 元）` : "");

export function signalItems(result: CheckResult): CheckItem[] {
  return result.items.filter((i) => i.evaluation && i.evaluation.signals.length > 0);
}

export function renderSignalEmail(result: CheckResult, opts: { comment?: string; commentBy?: string } = {}): RenderedEmail {
  const items = signalItems(result);
  const time = new Date(result.checkedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });

  // 主题：最多列出 3 个标的的第一个动作，例如 "沪深300ETF 买入 1000、腾讯控股 卖出 100"
  const brief = items.slice(0, 3).map((i) => {
    const s = i.evaluation!.signals[0]!;
    return `${itemName(i)} ${actionText(s)} ${s.quantity}${subjectReview(i)}`;
  });
  const subject =
    `【gridbot】${result.signalCount} 个交易信号：${brief.join("、")}` + (items.length > 3 ? ` 等 ${items.length} 个标的` : "");

  const text = [
    `检查时间：${time}（北京时间）`,
    "",
    ...items.flatMap((i) => {
      const ev = i.evaluation!;
      const q = i.quote!;
      return [
        `■ ${itemName(i)}（${i.holding.symbol}，${marketLabel(i)}）`,
        `  现价 ${num(q.price)} ${q.currency}，基准价 ${baseText(ev)}，相对基准 ${formatPct(ev.change)}`,
        ...ev.signals.map(
          (s) => `  ${actionText(s)} ${s.quantity} @ ${num(s.price)}，约 ${money(s.amount)} ${q.currency}${cny(s)}（${s.reason}）${signalReviewText(s)}`,
        ),
        ...(itemReview(i) ? [`  ${reviewLine(itemReview(i)!)}`] : []),
        `  执行后预计持仓：${i.holding.position} → ${ev.positionAfter}，成交后请更新配置中的 position`,
        ...ev.notes.filter((n) => n.level === "warn").map((n) => `  ⚠ ${n.text}`),
        "",
      ];
    }),
    ...(opts.comment ? [`AI 点评${opts.commentBy ? `（${opts.commentBy}）` : ""}：`, opts.comment, ""] : []),
    DISCLAIMER,
  ].join("\n");

  const card = (i: CheckItem) => {
    const ev = i.evaluation!;
    const q = i.quote!;
    const rows = ev.signals
      .map((s) => {
        const color = s.action === "buy" ? "#d6332b" : "#1a8f4c";
        return `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;color:${color};font-weight:600;white-space:nowrap">${actionText(s)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${s.quantity}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${num(s.price)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${money(s.amount)} ${q.currency}${s.amountCny !== undefined ? `<div style="color:#888;font-size:12px">约 ${money(s.amountCny)} 元</div>` : ""}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#555">${s.layer === "tier" ? "分档" : "网格"} · ${esc(s.reason)}${s.review && s.review.decision !== "error" ? `<div style="font-weight:600;color:${s.review.decision === "execute" ? "#1a8f4c" : "#b45309"}">AI ${esc(decisionText(s.review))}</div>` : ""}</td>
</tr>`;
      })
      .join("");
    const warns = ev.notes
      .filter((n) => n.level === "warn")
      .map((n) => `<div style="margin-top:6px;color:#b45309">⚠ ${esc(n.text)}</div>`)
      .join("");
    const chgColor = ev.change > 0 ? "#d6332b" : ev.change < 0 ? "#1a8f4c" : "#555";
    return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 14px">
  <div style="font-size:16px;font-weight:600">${esc(itemName(i))} <span style="color:#888;font-weight:400;font-size:13px">${esc(i.holding.symbol)} · ${marketLabel(i)}</span></div>
  <div style="margin:6px 0 10px;color:#444;font-size:14px">现价 <b>${num(q.price)}</b> ${q.currency} · 基准价 ${baseText(ev)} · 相对基准 <b style="color:${chgColor}">${formatPct(ev.change)}</b></div>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <tr style="background:#f6f7f9;color:#666"><th style="padding:6px 8px;text-align:left">操作</th><th style="padding:6px 8px;text-align:right">数量</th><th style="padding:6px 8px;text-align:right">参考价</th><th style="padding:6px 8px;text-align:right">金额</th><th style="padding:6px 8px;text-align:left">规则</th></tr>
    ${rows}
  </table>
  ${(() => {
    const r = itemReview(i);
    if (!r) return "";
    const color = r.decision === "execute" ? "#1a8f4c" : r.decision === "error" ? "#888" : "#b45309";
    return `<div style="margin-top:10px;padding:8px 10px;border-radius:8px;background:#f6f7f9;font-size:14px"><b style="color:${color}">${r.decision === "error" ? "AI 决策失败" : "AI 理由"}</b>${r.by ? `<span style="color:#888;font-size:12px">（${esc(r.by)}）</span>` : ""}<div style="color:#444;margin-top:2px">${esc(r.reason)}</div></div>`;
  })()}
  <div style="margin-top:8px;color:#666;font-size:13px">执行后预计持仓：${i.holding.position} → <b>${ev.positionAfter}</b>，成交后请更新配置中的 position</div>
  ${warns}
</div>`;
  };

  const html = `<!doctype html><html><body style="margin:0;padding:16px;background:#fff;color:#16181d;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:680px;margin:0 auto">
  <div style="font-size:18px;font-weight:700;margin-bottom:4px">gridbot：${result.signalCount} 个交易信号</div>
  <div style="color:#888;font-size:13px;margin-bottom:16px">检查时间 ${esc(time)}（北京时间）</div>
  ${items.map(card).join("\n")}
  ${
    opts.comment
      ? `<div style="background:#f6f7f9;border-radius:10px;padding:12px 16px;margin-top:4px;font-size:14px;line-height:1.7"><div style="font-weight:600;margin-bottom:4px">AI 点评${opts.commentBy ? `<span style="color:#888;font-weight:400;font-size:12px">（${esc(opts.commentBy)}）</span>` : ""}</div>${esc(opts.comment).replace(/\n/g, "<br>")}</div>`
      : ""
  }
  <div style="color:#999;font-size:12px;margin-top:16px">${DISCLAIMER}</div>
</div></body></html>`;

  return { subject, text, html };
}

export function renderTestEmail(): RenderedEmail {
  const text = "这是一封来自 gridbot 的测试邮件。收到说明 SMTP 配置正确，之后有交易信号时会发送到这个邮箱。";
  return {
    subject: "【gridbot】测试邮件",
    text,
    html: `<p style="font-family:sans-serif">${text}</p>`,
  };
}
