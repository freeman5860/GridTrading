// 核心领域类型。规则引擎是纯函数：输入（持仓配置 + 行情 + 上次状态）→ 输出（信号 + 新状态），不做任何 IO。

export type Market = "cn" | "hk" | "us";

export interface Quote {
  /** 规范化后的代码，如 sh510300 / hk00700 / usAAPL */
  symbol: string;
  market: Market;
  name: string;
  price: number;
  prevClose: number;
  /** 交易单位：A 股 100，港股按个股每手股数，美股 1 */
  lotSize: number;
  currency: "CNY" | "HKD" | "USD";
  /** 行情时间（交易所当地时间的原始字符串） */
  time: string;
  /** 价格为 0，通常是停牌或无成交 */
  suspended: boolean;
}

export type GridStep = { type: "abs"; value: number } | { type: "pct"; value: number };

export interface GridConfig {
  /** 区间下限 L */
  lower: number;
  /** 区间上限 U */
  upper: number;
  /** 间距：固定金额或百分比 */
  step: GridStep;
  /** 每格买卖数量（股/份） */
  size: number;
  /** 启用网格时已持有的网格仓位格数（不含底仓），默认 0 */
  initialLots?: number;
}

export interface FeeConfig {
  /** 佣金费率，如 0.0001 表示万 1 */
  rate: number;
  /** 每笔最低收费 */
  min: number;
}

export interface Holding {
  symbol: string;
  name?: string;
  /** 基准价 P0 */
  basePrice: number;
  /** 当前持仓数量（股/份），交易后由用户更新 */
  position: number;
  /** 该标的可用资金（与标的同币种），不填视为不限制 */
  cash?: number;
  /** 是否启用第一层分档仓位管理，默认 true */
  tiers?: boolean;
  /** 第二层区间小网格，不填则不启用 */
  grid?: GridConfig;
  fee?: FeeConfig;
}

export type TierId = "down15" | "down25" | "up25" | "up35" | "up45" | "up60" | "up100";

export interface GridState {
  /** 当前锚点所在的网格档位下标 */
  anchor: number;
  /** 当前持有的网格仓位格数（每格 size 股），卖出必须有对应的买入 */
  lots: number;
  /** 网格参数指纹，参数变化时重新初始化 */
  key: string;
}

export interface SymbolState {
  /** 本轮使用的基准价；配置中的基准价变化时视为新一轮，重置已触发档位 */
  basePrice: number;
  /** 本轮已触发（已提醒）的档位，每档每轮只触发一次 */
  triggered: TierId[];
  /** 已触发 +100% 清仓，本轮结束 */
  completed?: boolean;
  grid?: GridState;
  lastPrice?: number;
  updatedAt?: string;
}

export interface Signal {
  layer: "tier" | "grid";
  action: "buy" | "sell";
  quantity: number;
  /** 参考价格：分档信号为现价，网格信号为该格挂单价 */
  price: number;
  amount: number;
  ruleId: string;
  reason: string;
}

export interface Note {
  level: "info" | "warn";
  text: string;
}

export interface Evaluation {
  symbol: string;
  price: number;
  basePrice: number;
  /** 相对基准价的涨跌幅，如 -0.15 */
  change: number;
  signals: Signal[];
  notes: Note[];
  /** 执行完信号后的预计持仓 */
  positionAfter: number;
  /** 最近的未触发档位，方便展示"下一档在哪" */
  nextTiers: { up?: { id: TierId; price: number }; down?: { id: TierId; price: number } };
  grid?: { levels: number[]; anchor: number; lots: number; nextBuy?: number; nextSell?: number };
  nextState: SymbolState;
}
