// 监控页：市场状态、每个标的的行情 / 档位 / 信号，成交后更新持仓。

import { $, api, dialogOpen, h, money, num, openDialog, pct, trend } from "./lib.js";

const TIERS = [
  { id: "down25", at: -0.25 },
  { id: "down15", at: -0.15 },
  { id: "up25", at: 0.25 },
  { id: "up35", at: 0.35 },
  { id: "up45", at: 0.45 },
  { id: "up60", at: 0.6 },
  { id: "up100", at: 1.0 },
];
const MIN = -0.32;
const MAX = 1.06;
const pos = (x) => `${((Math.min(MAX, Math.max(MIN, x)) - MIN) / (MAX - MIN)) * 100}%`;
const MARKET_NAME = { cn: "A股", hk: "港股", us: "美股" };

let last;
let loading = false;
export const latestStatus = () => last;
const listeners = [];
export const onStatus = (fn) => listeners.push(fn);

export async function loadStatus() {
  if (loading) return;
  loading = true;
  $("#refresh").disabled = true;
  try {
    last = await api("/api/status");
    if (last.missing) return renderMissing(last);
    render(last);
    listeners.forEach((fn) => fn(last));
  } catch (e) {
    $("#holdings").replaceChildren(h("div", { class: "card card-error" }, `加载失败：${e.message}`));
  } finally {
    loading = false;
    $("#refresh").disabled = false;
  }
}

function renderMarkets(data) {
  $("#markets").replaceChildren(
    ...data.markets.map((m) =>
      h(
        "span",
        { class: `chip ${m.open ? "open" : ""}`, title: `交易时段 ${m.sessions}${m.nextOpen ? `\n下次开盘 ${m.nextOpen}` : ""}` },
        h("span", { class: "light" }),
        `${m.name} ${m.open ? "交易中" : "休市"} · ${m.localTime}`,
      ),
    ),
  );
}

/** 还没有配置文件：引导到设置向导 */
function renderMissing(data) {
  renderMarkets(data);
  $("#summary").replaceChildren();
  $("#config-path").textContent = `配置文件：${data.configPath}（尚未创建）`;
  $("#holdings").replaceChildren(
    h(
      "div",
      { class: "card welcome" },
      h("div", { class: "card-title" }, "欢迎使用 gridbot"),
      h("p", { class: "muted" }, "还没有配置文件。用设置向导填写持仓、选择提醒渠道、接入 AI，大约 3 分钟。"),
      h("div", {}, h("a", { class: "btn primary", href: "#setup" }, "开始设置")),
    ),
  );
}

function render(data) {
  renderMarkets(data);
  $("#updated").textContent = `更新于 ${new Date(data.now).toLocaleTimeString("zh-CN", { hour12: false })}`;
  $("#config-path").textContent = `配置文件：${data.configPath}`;

  const items = data.check?.items ?? [];
  const s = data.settings;
  $("#summary").replaceChildren(
    stat("监控标的", items.length),
    signalStat(data),
    stat("提醒渠道", s.channels.length ? s.channels.join("、") : setupLink("未配置，去设置")),
    stat("AI", s.ai ? `${s.ai.name} · ${s.ai.model}` : setupLink("未配置，去设置")),
  );

  renderMonitor(data.monitor);

  if (data.checkError) {
    $("#holdings").replaceChildren(h("div", { class: "card card-error" }, data.checkError));
    return;
  }
  $("#holdings").replaceChildren(...items.map((item) => card(item, data.state[item.holding.symbol])));
}

const hhmm = (iso) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });

/** 定时监控状态：控制台内置监控是否在运行、上次检查结果、下次检查时间 */
function renderMonitor(m) {
  const box = $("#monitor");
  box.hidden = !m;
  if (!m) return;
  if (!m.enabled) {
    box.className = "monitor off";
    box.replaceChildren(
      h("span", { class: "light" }),
      h("span", {}, "控制台未开启定时监控（--no-monitor），提醒需要由 gridbot run 或 GitHub Actions 发送"),
    );
    return;
  }
  const last = m.last;
  const bad = last && (last.status === "notify-failed" || last.status === "error" || last.failed?.length);
  box.className = `monitor ${bad ? "bad" : "on"}`;
  const every = m.interval ? `每 ${Math.round(m.interval / 60000)} 分钟` : "";
  const btn = h("button", { class: "btn small", disabled: m.busy }, m.busy ? "检查中…" : "立即检查并提醒");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "检查中…";
    try {
      await api("/api/monitor/check", {});
    } catch (e) {
      alert(e.message);
    }
    await loadStatus();
  });
  box.replaceChildren(
    h("span", { class: "light" }),
    h(
      "div",
      { class: "monitor-text" },
      h("b", {}, `定时监控运行中 ${every}`),
      h("span", { class: "muted" }, ` · 提醒发送到 ${m.channels.length ? m.channels.join("、") : "（未配置渠道）"}`),
      last && h("div", { class: "small" }, `${hhmm(last.at)} ${last.text}`),
      m.nextAt && last?.status !== "closed" && h("div", { class: "small muted" }, `下次检查 ${hhmm(m.nextAt)}`),
    ),
    btn,
  );
}

const setupLink = (text) => h("a", { href: "#setup", class: "setup-link" }, text);

/** 交易信号数：本次计算出的新信号 + 已提醒、待确认成交的信号 */
function signalStat(data) {
  if (!data.check) return stat("当前交易信号", "—");
  const pending = Object.values(data.state ?? {}).reduce((n, st) => n + (st.alerted?.signals.length ?? 0), 0);
  const total = data.check.signalCount + pending;
  return stat(pending ? "交易信号（含待确认）" : "当前交易信号", total, total > 0);
}

function stat(label, value, alert = false) {
  return h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: `value ${alert ? "alert" : ""}` }, value));
}

function card(item, state) {
  const { holding, quote, evaluation: ev } = item;
  const name = quote?.name ?? holding.name ?? holding.symbol;
  const market = holding.connect ? "港股通" : quote ? MARKET_NAME[quote.market] : "";
  const signals = ev?.signals ?? [];
  const alerted = state?.alerted;
  const digits = quote?.market === "us" ? 2 : 3; // 价格显示精度

  const head = h(
    "div",
    { class: "card-head" },
    h("div", {}, h("div", { class: "card-title" }, name), h("div", { class: "card-sub" }, [holding.symbol, market, quote && `每手 ${quote.lotSize}`, quote?.time].filter(Boolean).join(" · "))),
    quote &&
      h(
        "div",
        { class: "price" },
        h("div", { class: "big num" }, num(quote.price), " ", h("span", { class: "small muted" }, quote.currency)),
        ev && h("div", { class: `small num ${trend(ev.change)}` }, `相对基准 ${pct(ev.change)}`),
      ),
  );

  const body = [];
  if (item.error) body.push(h("div", { class: "card-error" }, item.error));
  else if (item.skipped) body.push(h("div", { class: "muted" }, `跳过：${item.skipped}`));

  if (ev) {
    body.push(
      h(
        "div",
        { class: "kv" },
        h(
          "div",
          {},
          h("span", {}, ev.basePriceHkd !== undefined ? "基准价（人民币）" : "基准价"),
          ev.basePriceHkd !== undefined ? [`¥${num(ev.basePrice)}`, h("span", { class: "sub" }, `≈ ${num(ev.basePriceHkd, 3)} HKD`)] : num(ev.basePrice),
        ),
        h("div", {}, h("span", {}, "持仓"), holding.position),
        h("div", {}, h("span", {}, holding.connect ? "可用资金（人民币）" : "可用资金"), holding.cash === undefined ? "不限" : holding.connect ? `¥${money(holding.cash)}` : money(holding.cash)),
      ),
    );
    if (holding.tiers !== false) body.push(ladder(ev.change, state?.triggered ?? []));

    body.push(
      signals.length
        ? h(
            "div",
            { class: "signals" },
            signals.map((s) => signalRow(s, quote)),
            h("div", { class: "small muted" }, `执行后预计持仓 ${holding.position} → ${ev.positionAfter}`),
          )
        : alerted
          ? null
          : h("div", { class: "nosignal" }, "当前不操作"),
    );
    if (alerted) {
      body.push(
        h(
          "div",
          { class: "signals alerted" },
          h("div", { class: "small alerted-head" }, `已于 ${new Date(alerted.at).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 提醒，等待确认成交`),
          alerted.signals.map((s) => signalRow(s, quote)),
          reviewBox(alerted.signals.find((s) => s.review)?.review),
          h("div", { class: "small muted" }, `全部成交后预计持仓 ${holding.position} → ${alerted.positionAfter}`),
        ),
      );
    }

    const next = [
      ev.nextTiers.down && `加仓档 ${num(ev.nextTiers.down.price, digits)}`,
      ev.nextTiers.up && `止盈档 ${num(ev.nextTiers.up.price, digits)}`,
      ev.grid?.nextBuy !== undefined && `网格买 ${num(ev.grid.nextBuy, digits)}`,
      ev.grid?.nextSell !== undefined && `网格卖 ${num(ev.grid.nextSell, digits)}`,
    ].filter(Boolean);
    if (next.length) body.push(h("div", { class: "next" }, `下一触发：${next.join(" · ")}`));

    if (ev.grid) {
      body.push(
        h(
          "div",
          {},
          h("div", { class: "small muted" }, `网格 ${ev.grid.levels.length} 格 · 已持网格仓 ${ev.grid.lots} 格`),
          h("div", { class: "grid-levels num" }, ev.grid.levels.map((l, i) => h("span", { class: i === ev.grid.anchor ? "anchor" : "" }, num(l, digits)))),
        ),
      );
    }
    const notes = ev.notes.filter((n) => n.level === "warn" || !n.text.startsWith("网格初始化"));
    if (notes.length) body.push(h("div", { class: "notes" }, notes.map((n) => h("div", { class: n.level }, n.text))));
  }

  const actions = h(
    "div",
    { class: "card-actions" },
    (signals.length > 0 || alerted) && h("button", { class: "btn small primary", onclick: () => confirmExecuted(holding, ev, alerted) }, "已按信号成交"),
    alerted && !signals.length && h("button", { class: "btn small", onclick: () => dismissAlerted(holding) }, "未成交，忽略"),
    h("button", { class: "btn small", onclick: () => editHolding(holding) }, "修改持仓"),
    h("button", { class: "btn small", onclick: () => resetHolding(holding, name) }, "重置档位"),
  );

  return h("div", { class: `card ${signals.length || alerted ? "has-signal" : ""}` }, head, body, actions);
}

function reviewBox(r) {
  if (!r) return null;
  const label = { execute: "AI 建议执行", hold: "AI 建议暂缓", error: "AI 决策失败" }[r.decision];
  return h(
    "div",
    { class: `review ${r.decision}` },
    h("b", {}, label),
    r.by && h("span", { class: "small muted" }, `（${r.by}）`),
    h("div", { class: "small" }, r.reason),
  );
}

function signalRow(s, quote) {
  return h(
    "div",
    { class: "signal" },
    h("span", { class: `act ${s.action}` }, s.action === "buy" ? "买入" : "卖出"),
    h("b", { class: "num" }, s.quantity),
    h("span", { class: "num" }, `@ ${num(s.price)} ≈ ${money(s.amount)} ${quote?.currency ?? ""}${s.amountCny !== undefined ? `（约 ¥${money(s.amountCny)}）` : ""}`),
    h("span", { class: "tag" }, s.layer === "tier" ? "分档" : "网格"),
    h("span", { class: "why" }, s.reason),
  );
}

/** 档位刻度：-25% ～ +100%，标出已触发档位和当前位置 */
function ladder(change, triggered) {
  return h(
    "div",
    { class: "ladder", title: `相对基准 ${pct(change)}` },
    h("div", { class: "track" }),
    h("div", { class: "zero", style: { left: pos(0) } }),
    TIERS.map((t) => [
      h("div", { class: `tick ${triggered.includes(t.id) ? "done" : ""}`, style: { left: pos(t.at) } }),
      h("div", { class: "tick-label", style: { left: pos(t.at) } }, `${t.at > 0 ? "+" : "−"}${Math.abs(t.at * 100)}%`),
    ]),
    h("div", { class: "marker", style: { left: pos(change) } }),
  );
}

/** 与 src/core/fill.ts 相同：估算成交后的可用资金和持仓成本（港股通按中间价折算人民币） */
function estimateFill(holding, signals, position) {
  const unit = (s) => (s.fxRate ? s.price * s.fxRate : s.price);
  const buys = signals.filter((s) => s.action === "buy");
  const sells = signals.filter((s) => s.action === "sell");
  const avg = (list) => {
    const qty = list.reduce((n, s) => n + s.quantity, 0);
    return qty ? list.reduce((n, s) => n + unit(s) * s.quantity, 0) / qty : 0;
  };
  const planned = holding.position + buys.reduce((n, s) => n + s.quantity, 0) - sells.reduce((n, s) => n + s.quantity, 0);
  const after = position ?? planned;
  const net = after - holding.position;
  const bought = net > 0 ? net : 0;
  const sold = net < 0 ? -net : 0;
  const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    position: after,
    cash: holding.cash === undefined ? undefined : r(Math.max(0, holding.cash - bought * (avg(buys) || avg(sells)) + sold * (avg(sells) || avg(buys))), 2),
    basePrice: bought > 0 ? r((holding.basePrice * holding.position + bought * (avg(buys) || avg(sells))) / (holding.position + bought), 3) : holding.basePrice,
  };
}

function confirmExecuted(holding, ev, alerted) {
  const signals = [...(alerted?.signals ?? []), ...(ev?.signals ?? [])];
  const est = estimateFill(holding, signals);
  const cny = holding.connect ? "（人民币）" : "";
  openDialog({
    title: "确认已成交",
    text: "记录本次触发的档位（之后不再重复提醒），并更新配置中的持仓、可用资金和基准价。按信号参考价估算，部分成交或价格不同时请按券商显示修改。",
    fields: [
      { name: "position", label: "成交后的持仓", value: est.position, step: "1", required: true },
      holding.cash !== undefined && { name: "cash", label: `成交后的可用资金${cny}`, value: est.cash, hint: "买入减少、卖出增加；可按券商显示的可用资金修改" },
      { name: "basePrice", label: `基准价${cny}`, value: est.basePrice, required: true, hint: "买入后按新的持仓成本估算；已触发的档位保留，不会重复提醒" },
    ].filter(Boolean),
    okText: "确认",
    onInput: (name, v, set) => {
      if (name !== "position" || v.position === null) return;
      const e = estimateFill(holding, signals, v.position);
      if (holding.cash !== undefined) set("cash", e.cash);
      set("basePrice", e.basePrice);
    },
    onOk: async (v) => {
      await api(`/api/holdings/${encodeURIComponent(holding.symbol)}/execute`, v);
      await loadStatus();
    },
  });
}

function editHolding(holding) {
  openDialog({
    title: `修改 ${holding.name ?? holding.symbol}`,
    text: "修改会写回配置文件，保留原有注释。修改基准价时已触发的档位保留，不会重复提醒；要重新开始一轮请用「重置档位」。",
    fields: [
      { name: "position", label: "持仓数量", value: holding.position, step: "1", required: true },
      { name: "basePrice", label: `基准价 P0${holding.connect ? "（人民币）" : ""}`, value: holding.basePrice, required: true },
      { name: "cash", label: `可用资金${holding.connect ? "（人民币）" : ""}（留空表示不限制）`, value: holding.cash ?? "" },
    ],
    okText: "保存",
    onOk: async (v) => {
      await api(`/api/holdings/${encodeURIComponent(holding.symbol)}`, v);
      await loadStatus();
    },
  });
}

function dismissAlerted(holding) {
  openDialog({
    title: "忽略已提醒的信号",
    text: "表示这次没有按信号成交。持仓不变，这些档位仍算已触发（本轮不会再提醒）；如需重新开始，请用「重置档位」。",
    okText: "忽略",
    onOk: async () => {
      await api(`/api/holdings/${encodeURIComponent(holding.symbol)}/dismiss`, {});
      await loadStatus();
    },
  });
}

function resetHolding(holding, name) {
  openDialog({
    title: `重置 ${name}`,
    text: "清除已触发档位和网格位置，开始新一轮。持仓和基准价不变。",
    okText: "重置",
    onOk: async () => {
      await api(`/api/holdings/${encodeURIComponent(holding.symbol)}/reset`, {});
      await loadStatus();
    },
  });
}

export function initWatch(isActive) {
  $("#refresh").addEventListener("click", loadStatus);
  // 页面可见、在监控页且没有打开对话框时，每分钟自动刷新
  setInterval(() => {
    if (document.visibilityState === "visible" && isActive() && !dialogOpen()) loadStatus();
  }, 60_000);
  loadStatus();
}
