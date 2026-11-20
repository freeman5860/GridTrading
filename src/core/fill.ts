// 确认成交后估算新的持仓、可用资金和持仓成本（基准价）。
// 金额按信号参考价计算；港股通按中间价折算成人民币（实际以券商结算为准，用户可以修改）。

import type { Holding, Signal } from "./types.js";

export interface FillEstimate {
  position: number;
  cash?: number;
  basePrice: number;
}

/** 实际建议成交的数量：AI 建议减量时用 AI 的数量 */
export const effectiveQuantity = (s: Signal) => (s.review?.decision === "reduce" && s.review.quantity ? s.review.quantity : s.quantity);

/** 每股金额，单位与 cash / basePrice 相同（港股通为人民币） */
const unit = (s: Signal) => (s.fxRate ? s.price * s.fxRate : s.price);

/**
 * signals：本次确认的信号；position：实际成交后的持仓（部分成交时由用户填写，默认全部成交）。
 * 实际成交数量与信号不同时，按信号的平均价格估算。
 */
export function estimateFill(holding: Pick<Holding, "position" | "cash" | "basePrice">, signals: Signal[], position?: number): FillEstimate {
  const buys = signals.filter((s) => s.action === "buy");
  const sells = signals.filter((s) => s.action === "sell");
  const avg = (list: Signal[]) => {
    const qty = list.reduce((n, s) => n + effectiveQuantity(s), 0);
    return qty ? list.reduce((n, s) => n + unit(s) * effectiveQuantity(s), 0) / qty : 0;
  };
  const planned = holding.position + buys.reduce((n, s) => n + effectiveQuantity(s), 0) - sells.reduce((n, s) => n + effectiveQuantity(s), 0);
  const after = position ?? planned;
  const net = after - holding.position;
  const bought = net > 0 ? net : 0;
  const sold = net < 0 ? -net : 0;
  const buyUnit = avg(buys) || avg(sells);
  const sellUnit = avg(sells) || avg(buys);

  const cash = holding.cash === undefined ? undefined : round(Math.max(0, holding.cash - bought * buyUnit + sold * sellUnit), 2);
  // 买入摊薄持仓成本；卖出不改变成本
  const basePrice = bought > 0 ? round((holding.basePrice * holding.position + bought * buyUnit) / (holding.position + bought), 3) : holding.basePrice;
  return { position: after, cash, basePrice };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
