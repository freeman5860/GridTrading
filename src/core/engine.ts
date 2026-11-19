// 规则引擎：把《网格交易规则》翻译成确定性代码。
// 第一层：分档仓位管理（相对基准价 P0 的涨跌幅）；第二层：区间小网格。两层同时触发时第一层优先。

import type {
  Evaluation,
  FxRate,
  GridConfig,
  GridState,
  Holding,
  Note,
  Quote,
  Signal,
  SymbolState,
  TierId,
} from "./types.js";

export interface TierRule {
  id: TierId;
  /** 触发阈值（相对 P0 的涨跌幅） */
  threshold: number;
  /** 买入/卖出比例（相对当时持仓），清仓为 1 */
  ratio: number;
  label: string;
}

/** 下跌加仓档：跌 15% 以内不操作 */
export const DOWN_TIERS: TierRule[] = [
  { id: "down15", threshold: -0.15, ratio: 0.1, label: "跌到 −15% 增持 10%" },
  { id: "down25", threshold: -0.25, ratio: 0.25, label: "跌到 −25% 再增持 25%" },
];

/** 上涨止盈档：涨 25% 以内继续持有；卖出比例按当时剩余持仓计算 */
export const UP_TIERS: TierRule[] = [
  { id: "up25", threshold: 0.25, ratio: 0.1, label: "涨到 +25% 卖出 10%" },
  { id: "up35", threshold: 0.35, ratio: 0.2, label: "涨到 +35% 卖出 20%" },
  { id: "up45", threshold: 0.45, ratio: 0.3, label: "涨到 +45% 卖出 30%" },
  { id: "up60", threshold: 0.6, ratio: 0.4, label: "涨到 +60% 卖出 40%" },
  { id: "up100", threshold: 1.0, ratio: 1, label: "涨到 +100% 清仓" },
];

const EPS = 1e-9;

export const round = (x: number, digits = 4) => Math.round(x * 10 ** digits) / 10 ** digits;

/** 按交易单位取整到最近的整手；恰好半手时向下取，避免实际买卖量超过规则比例 */
export const roundToLot = (qty: number, lot: number) => Math.max(0, Math.ceil(qty / lot - 0.5 - EPS) * lot);
/** 按交易单位向下取整（用于资金上限） */
export const floorToLot = (qty: number, lot: number) => Math.max(0, Math.floor(qty / lot + EPS) * lot);

export function initialState(holding: Holding): SymbolState {
  return { basePrice: holding.basePrice, triggered: [] };
}

/**
 * 港股通买入时按"买入参考汇率"冻结资金，比中间价高约 3%，资金是否足够按这个汇率保守估算。
 * （卖出参考汇率约低 3%，实际以交收日结算汇率为准）
 */
export const CONNECT_FX_BUFFER = 0.03;

export interface EvaluateOptions {
  /** 港股通标的需要的港元兑人民币汇率 */
  fx?: FxRate;
}

export function evaluate(holding: Holding, quote: Pick<Quote, "price" | "lotSize">, prev?: SymbolState, opts: EvaluateOptions = {}): Evaluation {
  if (holding.connect) return evaluateConnect(holding, quote, prev, opts.fx);
  return evaluateLocal(holding, quote, prev);
}

/**
 * 港股通：基准价、可用资金、手续费为人民币（与港股通账户显示的成本价一致），行情和下单价格为港元。
 * 按实时汇率把人民币折算成港元后用同一套规则计算，相当于用人民币计价的涨跌幅判断档位（包含汇率变化）。
 * 网格价位是挂单价，仍按港元填写。状态中的基准价保留人民币原值，避免汇率每天变化导致档位被重置。
 */
function evaluateConnect(holding: Holding, quote: Pick<Quote, "price" | "lotSize">, prev: SymbolState | undefined, fx: FxRate | undefined): Evaluation {
  if (!(fx && fx.rate > 0)) throw new Error("港股通标的的基准价为人民币，需要港元兑人民币汇率：获取汇率失败，本次无法计算");
  const rate = fx.rate;
  const buyRate = rate * (1 + CONNECT_FX_BUFFER);
  const baseHkd = holding.basePrice / rate;

  const local: Holding = { ...holding, basePrice: baseHkd };
  const extra: Note[] = [];
  if (holding.cash !== undefined) local.cash = holding.cash / buyRate;
  if (holding.fee) local.fee = { ...holding.fee, min: holding.fee.min / rate };

  // 上次状态的基准价也是人民币，折算成港元交给同一套规则（基准价变化的处理与普通标的一致）
  const prevLocal = prev ? { ...structuredClone(prev), basePrice: prev.basePrice / rate } : undefined;

  const ev = evaluateLocal(local, quote, prevLocal);
  for (const n of ev.notes) {
    if (prev && n.text.startsWith("基准价由 ")) n.text = n.text.replace(/^基准价由 [\d.]+ 改为 [\d.]+/, `基准价由 ${prev.basePrice} 元改为 ${holding.basePrice} 元`);
  }
  extra.push({
    level: "info",
    text:
      `港股通：基准价 ${holding.basePrice} 元按汇率 ${rate} 折合 ${round(baseHkd, 3)} 港元` +
      (holding.cash !== undefined ? `；可用资金 ${round(holding.cash, 2)} 元按买入参考汇率约 ${round(buyRate)} 折合 ${round(local.cash!, 2)} 港元` : ""),
  });
  ev.notes.unshift(...extra);
  ev.basePrice = holding.basePrice;
  ev.basePriceHkd = round(baseHkd, 4);
  ev.nextState = { ...ev.nextState, basePrice: holding.basePrice };
  ev.fx = fx;
  for (const s of ev.signals) s.fxRate = rate;
  for (const s of ev.signals) s.amountCny = round(s.amount * rate * (s.action === "buy" ? 1 + CONNECT_FX_BUFFER : 1 - CONNECT_FX_BUFFER), 2);
  return ev;
}

function evaluateLocal(holding: Holding, quote: Pick<Quote, "price" | "lotSize">, prev?: SymbolState): Evaluation {
  const notes: Note[] = [];
  const signals: Signal[] = [];
  const lot = quote.lotSize > 0 ? quote.lotSize : 1;
  const price = quote.price;

  // 配置中的基准价变化（如加仓后改成新的持仓成本）：已触发档位保留，不会重复提醒；
  // 只有本轮已 +100% 清仓时，重设基准价才开始新一轮。其他情况要重新开始请用"重置档位"。
  let state: SymbolState = prev ? structuredClone(prev) : initialState(holding);
  if (Math.abs(state.basePrice - holding.basePrice) > EPS) {
    if (prev?.completed) {
      notes.push({ level: "info", text: `基准价由 ${prev.basePrice} 改为 ${holding.basePrice}，上一轮已清仓，开始新一轮` });
      state = { ...state, basePrice: holding.basePrice, triggered: [], completed: false };
    } else {
      if (prev?.triggered.length) notes.push({ level: "info", text: `基准价由 ${prev.basePrice} 改为 ${holding.basePrice}，已触发档位保留（要重新开始一轮请重置档位）` });
      state = { ...state, basePrice: holding.basePrice };
    }
  }

  const base = holding.basePrice;
  const change = (price - base) / base;
  let position = holding.position;
  let cash = holding.cash ?? Number.POSITIVE_INFINITY;

  const result: Evaluation = {
    symbol: holding.symbol,
    price,
    basePrice: base,
    change,
    signals,
    notes,
    positionAfter: position,
    nextTiers: {},
    nextState: state,
  };

  if (!(price > 0)) {
    notes.push({ level: "warn", text: "没有有效价格（可能停牌），本次不做判断" });
    return result;
  }

  // ---------------- 第一层：分档仓位管理 ----------------
  const triggered = new Set(state.triggered);
  if (holding.tiers !== false) {
    if (state.completed) {
      notes.push({ level: "info", text: "本轮已在 +100% 清仓，请在配置中重设基准价后开始新一轮" });
    } else {
      // 上涨档：一次越过多档时依次执行，卖出比例按每档执行时的剩余持仓计算
      for (const t of UP_TIERS) {
        if (change + EPS < t.threshold || triggered.has(t.id)) continue;
        triggered.add(t.id);
        const qty = t.ratio >= 1 ? position : Math.min(position, roundToLot(position * t.ratio, lot));
        if (qty > 0) {
          signals.push(tierSignal("sell", qty, price, t, change));
          position -= qty;
          if (t.ratio < 1) cash += qty * price;
        } else {
          notes.push({ level: "warn", text: `${t.label}：持仓不足一手（${lot}），本档不操作` });
        }
        if (t.id === "up100") {
          state.completed = true;
          notes.push({ level: "info", text: "已到 +100% 清仓档，本轮结束；之后请重设基准价" });
        }
      }

      // 下跌档
      for (const t of DOWN_TIERS) {
        if (change - EPS > t.threshold || triggered.has(t.id)) continue;
        triggered.add(t.id);
        let qty = roundToLot(position * t.ratio, lot);
        if (qty * price > cash + EPS) {
          const affordable = floorToLot(cash / price, lot);
          notes.push({
            level: "warn",
            text: `${t.label}：按规则应买 ${qty}，可用资金只够买 ${affordable}，已按可用资金下调`,
          });
          qty = affordable;
        }
        if (qty > 0) {
          signals.push(tierSignal("buy", qty, price, t, change));
          position += qty;
          cash -= qty * price;
        } else if (position === 0) {
          notes.push({ level: "info", text: `${t.label}：当前无持仓，按比例增持为 0` });
        } else {
          notes.push({ level: "warn", text: `${t.label}：计算数量不足一手或资金不足，本档不操作` });
        }
      }

      if (change < DOWN_TIERS.at(-1)!.threshold - EPS) {
        notes.push({ level: "warn", text: "已跌破 −25%：不再机械加仓，请先复核基本面 / 投资逻辑是否被破坏" });
      }
    }

    const nextUp = UP_TIERS.find((t) => !triggered.has(t.id) && change + EPS < t.threshold);
    const nextDown = DOWN_TIERS.find((t) => !triggered.has(t.id) && change - EPS > t.threshold);
    if (!state.completed) {
      if (nextUp) result.nextTiers.up = { id: nextUp.id, price: round(base * (1 + nextUp.threshold)) };
      if (nextDown) result.nextTiers.down = { id: nextDown.id, price: round(base * (1 + nextDown.threshold)) };
    }
  }
  state.triggered = [...UP_TIERS, ...DOWN_TIERS].map((t) => t.id).filter((id) => triggered.has(id));

  // ---------------- 第二层：区间小网格 ----------------
  if (holding.grid) {
    const tierFired = signals.length > 0;
    const g = evaluateGrid(holding.grid, price, lot, cash, state.grid, tierFired, holding.fee);
    signals.push(...g.signals);
    notes.push(...g.notes);
    for (const s of g.signals) {
      position += s.action === "buy" ? s.quantity : -s.quantity;
      cash += s.action === "buy" ? -s.amount : s.amount;
    }
    state.grid = g.state;
    result.grid = g.view;
  } else {
    delete state.grid;
  }

  state.lastPrice = price;
  result.positionAfter = position;
  result.nextState = state;
  return result;
}

function tierSignal(action: "buy" | "sell", quantity: number, price: number, t: TierRule, change: number): Signal {
  return {
    layer: "tier",
    action,
    quantity,
    price,
    amount: round(quantity * price, 2),
    ruleId: t.id,
    reason: `${t.label}（当前 ${formatPct(change)}）`,
  };
}

export const formatPct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;

// ---------------- 网格 ----------------

/** 生成网格价位：固定金额为等差，百分比为等比；从下限开始，不超过上限 */
export function gridLevels(cfg: GridConfig): number[] {
  if (!(cfg.lower > 0) || !(cfg.upper > cfg.lower)) throw new Error("网格区间无效：需要 0 < 下限 < 上限");
  if (!(cfg.step.value > 0)) throw new Error("网格间距必须大于 0");
  const levels: number[] = [];
  for (let i = 0, p = cfg.lower; p <= cfg.upper * (1 + EPS); i++) {
    levels.push(round(p));
    p = cfg.step.type === "abs" ? cfg.lower + (i + 1) * cfg.step.value : cfg.lower * (1 + cfg.step.value) ** (i + 1);
    if (levels.length > 500) throw new Error("网格格数过多（>500），请调大间距");
  }
  if (levels.length < 2) throw new Error("网格间距过大，区间内不足 2 个价位");
  return levels;
}

function gridKey(cfg: GridConfig): string {
  return JSON.stringify([cfg.lower, cfg.upper, cfg.step.type, cfg.step.value, cfg.size]);
}

function nearestIndex(levels: number[], price: number): number {
  let best = 0;
  for (let i = 1; i < levels.length; i++) {
    if (Math.abs(levels[i]! - price) < Math.abs(levels[best]! - price)) best = i;
  }
  return best;
}

function evaluateGrid(
  cfg: GridConfig,
  price: number,
  lot: number,
  cashIn: number,
  prev: GridState | undefined,
  tierFired: boolean,
  fee?: Holding["fee"],
) {
  const notes: Note[] = [];
  const signals: Signal[] = [];
  const levels = gridLevels(cfg);
  const key = gridKey(cfg);
  let cash = cashIn;

  let size = cfg.size;
  if (size % lot !== 0) {
    const fixed = Math.max(lot, floorToLot(size, lot));
    notes.push({ level: "warn", text: `每格数量 ${size} 不是交易单位 ${lot} 的整数倍，按 ${fixed} 计算` });
    size = fixed;
  }

  if (fee) {
    const cell = levels[1]! - levels[0]!;
    const roundTrip = 2 * Math.max(fee.min, fee.rate * levels[0]! * size);
    if (cell * size < 3 * roundTrip) {
      notes.push({
        level: "warn",
        text: `每格利润约 ${round(cell * size, 2)}，低于往返手续费 ${round(roundTrip, 2)} 的 3 倍，建议加大间距或每格数量`,
      });
    }
  }

  let state: GridState;
  if (!prev || prev.key !== key) {
    state = { anchor: nearestIndex(levels, price), lots: cfg.initialLots ?? 0, key };
    notes.push({
      level: "info",
      text: `${prev ? "网格参数已变化，重新初始化" : "网格初始化"}：锚点 ${levels[state.anchor]}，已持网格仓 ${state.lots} 格`,
    });
  } else {
    state = { ...prev };
    if (tierFired) {
      // 第一层优先：本次不执行网格，并把锚点移到现价附近，避免之后补发过期的网格信号
      state.anchor = nearestIndex(levels, price);
      notes.push({ level: "info", text: "本次已触发分档操作，第一层优先，网格暂不操作（锚点已移到现价附近）" });
    } else {
      // 价格下穿锚点下方的格子：逐格买入（跌破下限后不再继续买）
      while (state.anchor > 0 && price <= levels[state.anchor - 1]! + EPS) {
        const lvl = levels[state.anchor - 1]!;
        if (size * lvl > cash + EPS) {
          notes.push({ level: "warn", text: `网格买入 ${lvl}：可用资金不足，暂停网格买入` });
          break;
        }
        state.anchor--;
        state.lots++;
        cash -= size * lvl;
        signals.push(gridSignal("buy", size, lvl, `网格下跌一格，在 ${lvl} 买入一份`));
      }
      // 价格上穿锚点上方的格子：逐格卖出，每笔卖出必须对应一笔更低价位的买入
      while (state.anchor < levels.length - 1 && price + EPS >= levels[state.anchor + 1]!) {
        const lvl = levels[state.anchor + 1]!;
        state.anchor++;
        if (state.lots > 0) {
          state.lots--;
          cash += size * lvl;
          signals.push(gridSignal("sell", size, lvl, `网格上涨一格，在 ${lvl} 卖出一份（对应下方一格的买入）`));
        } else {
          notes.push({ level: "info", text: `涨到 ${lvl}：没有对应的网格买入（无网格仓），不卖出` });
        }
      }
    }
  }

  if (price < cfg.lower - EPS) {
    notes.push({ level: "warn", text: `跌破网格下限 ${cfg.lower}：暂停网格买入，交给第一层规则；请评估是否仍为震荡行情` });
  } else if (price > cfg.upper + EPS) {
    notes.push({ level: "warn", text: `突破网格上限 ${cfg.upper}：网格停止，底仓交给第一层规则；请评估是否需要重设区间` });
  }

  const view = {
    levels,
    anchor: state.anchor,
    lots: state.lots,
    nextBuy: state.anchor > 0 ? levels[state.anchor - 1] : undefined,
    nextSell: state.anchor < levels.length - 1 && state.lots > 0 ? levels[state.anchor + 1] : undefined,
  };
  return { signals, notes, state, view };
}

function gridSignal(action: "buy" | "sell", quantity: number, price: number, reason: string): Signal {
  return {
    layer: "grid",
    action,
    quantity,
    price,
    amount: round(quantity * price, 2),
    ruleId: `grid-${action}`,
    reason,
  };
}
