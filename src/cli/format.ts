import { styleText } from "node:util";
import type { CheckItem, CheckResult } from "../check.js";
import { formatPct } from "../core/engine.js";
import { MARKETS } from "../core/symbol.js";
import type { Quote, Signal } from "../core/types.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
type Style = Parameters<typeof styleText>[0];
const s = (style: Style, text: string) => (color ? styleText(style, text) : text);

const num = (n: number, d = 3) => {
  const fixed = n.toFixed(d);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
};
const money = (n: number, cur: string) => `${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${cur}`;

// A 股习惯：涨红跌绿；买入红、卖出绿（与网格示意图一致）
const changeStyle = (x: number): Style => (x > 0 ? "red" : x < 0 ? "green" : "gray");

function signalLine(sig: Signal, cur: string) {
  const tag = sig.action === "buy" ? s(["bold", "red"], "买入") : s(["bold", "green"], "卖出");
  const layer = s("gray", sig.layer === "tier" ? "[分档]" : "[网格]");
  const cny = sig.amountCny !== undefined ? s("gray", `（约 ${money(sig.amountCny, "元")}）`) : "";
  return `  ${tag} ${s("bold", String(sig.quantity))} @ ${num(sig.price)}  ≈ ${money(sig.amount, cur)}${cny}  ${layer} ${sig.reason}`;
}

export function formatItem(item: CheckItem): string {
  const { holding, quote, evaluation: ev } = item;
  const title = `${quote?.name ?? holding.name ?? ""} ${s("gray", holding.symbol)}`.trim();
  const lines: string[] = [s("bold", title)];

  if (item.error) {
    lines.push(s("yellow", `  ⚠ ${item.error}`));
    return lines.join("\n");
  }
  if (item.skipped) {
    lines.push(s("gray", `  跳过：${item.skipped}`));
    return lines.join("\n");
  }
  if (!quote || !ev) return lines.join("\n");

  const cur = quote.currency;
  lines.push(
    `  现价 ${s("bold", num(quote.price))} ${cur}  基准价 ${num(ev.basePrice)}  ` +
      `相对基准 ${s(changeStyle(ev.change), formatPct(ev.change))}  ` +
      s("gray", `${holding.connect ? "港股通" : MARKETS[quote.market].name} · 每手 ${quote.lotSize} · ${quote.time}`),
  );

  if (ev.signals.length) {
    for (const sig of ev.signals) lines.push(signalLine(sig, cur));
    lines.push(s("gray", `  执行后预计持仓：${holding.position} → ${ev.positionAfter}（交易后请更新配置中的 position）`));
  } else {
    lines.push(s("gray", "  不操作"));
  }

  const next: string[] = [];
  if (ev.nextTiers.down) next.push(`加仓档 ${num(ev.nextTiers.down.price)}`);
  if (ev.nextTiers.up) next.push(`止盈档 ${num(ev.nextTiers.up.price)}`);
  if (ev.grid?.nextBuy !== undefined) next.push(`网格买 ${num(ev.grid.nextBuy)}`);
  if (ev.grid?.nextSell !== undefined) next.push(`网格卖 ${num(ev.grid.nextSell)}`);
  if (next.length) lines.push(s("gray", `  下一触发：${next.join(" · ")}`));
  if (ev.grid) {
    lines.push(s("gray", `  网格：${ev.grid.levels.length} 格（${ev.grid.levels.map((l) => num(l)).join(" / ")}），已持网格仓 ${ev.grid.lots} 格`));
  }

  for (const n of ev.notes) lines.push(n.level === "warn" ? s("yellow", `  ⚠ ${n.text}`) : s("gray", `  · ${n.text}`));
  return lines.join("\n");
}

export function formatCheck(result: CheckResult, dryRun: boolean): string {
  const header = `检查时间 ${new Date(result.checkedAt).toLocaleString("zh-CN", { hour12: false })}` +
    `  ·  ${result.items.length} 个标的  ·  ${result.signalCount ? s(["bold", "red"], `${result.signalCount} 个交易信号`) : "无交易信号"}` +
    (dryRun ? s("yellow", "  ·  试运行，未保存状态") : "");
  return [header, "", ...result.items.map(formatItem).flatMap((t) => [t, ""]), s("gray", DISCLAIMER)].join("\n");
}

export function formatQuote(q: Quote): string {
  const chg = q.prevClose > 0 ? (q.price - q.prevClose) / q.prevClose : 0;
  return `${q.name} ${s("gray", q.symbol)}  ${s("bold", num(q.price))} ${q.currency}  ` +
    `${s(changeStyle(chg), formatPct(chg))}  ${s("gray", `${MARKETS[q.market].name} · 每手 ${q.lotSize} · ${q.time}${q.suspended ? " · 停牌/无成交" : ""}`)}`;
}

export const DISCLAIMER = "以上信号由预设规则机械计算，仅供学习参考，不构成投资建议。";
