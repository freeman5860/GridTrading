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
    stat("当前交易信号", data.check?.signalCount ?? "—", (data.check?.signalCount ?? 0) > 0),
    stat("提醒渠道", s.channels.length ? s.channels.join("、") : setupLink("未配置，去设置")),
    stat("AI", s.ai ? `${s.ai.name} · ${s.ai.model}` : setupLink("未配置，去设置")),
  );

  if (data.checkError) {
    $("#holdings").replaceChildren(h("div", { class: "card card-error" }, data.checkError));
    return;
  }
  $("#holdings").replaceChildren(...items.map((item) => card(item, data.state[item.holding.symbol])));
}

const setupLink = (text) => h("a", { href: "#setup", class: "setup-link" }, text);

function stat(label, value, alert = false) {
  return h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: `value ${alert ? "alert" : ""}` }, value));
}

function card(item, state) {
  const { holding, quote, evaluation: ev } = item;
  const name = quote?.name ?? holding.name ?? holding.symbol;
  const market = holding.connect ? "港股通" : quote ? MARKET_NAME[quote.market] : "";
  const signals = ev?.signals ?? [];
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
        h("div", {}, h("span", {}, "基准价"), num(ev.basePrice)),
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
            signals.map((s) =>
              h(
                "div",
                { class: "signal" },
                h("span", { class: `act ${s.action}` }, s.action === "buy" ? "买入" : "卖出"),
                h("b", { class: "num" }, s.quantity),
                h("span", { class: "num" }, `@ ${num(s.price)} ≈ ${money(s.amount)} ${quote.currency}${s.amountCny !== undefined ? `（约 ¥${money(s.amountCny)}）` : ""}`),
                h("span", { class: "tag" }, s.layer === "tier" ? "分档" : "网格"),
                h("span", { class: "why" }, s.reason),
              ),
            ),
            h("div", { class: "small muted" }, `执行后预计持仓 ${holding.position} → ${ev.positionAfter}`),
          )
        : h("div", { class: "nosignal" }, "当前不操作"),
    );

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
    signals.length > 0 && h("button", { class: "btn small primary", onclick: () => confirmExecuted(holding, ev) }, "已按信号成交"),
    h("button", { class: "btn small", onclick: () => editHolding(holding) }, "修改持仓"),
    h("button", { class: "btn small", onclick: () => resetHolding(holding, name) }, "重置档位"),
  );

  return h("div", { class: `card ${signals.length ? "has-signal" : ""}` }, head, body, actions);
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

function confirmExecuted(holding, ev) {
  openDialog({
    title: "确认已成交",
    text: "将记录本次触发的档位（之后不再重复提醒），并把配置中的持仓更新为成交后的数量。部分成交时请填写实际持仓。",
    fields: [{ name: "position", label: "成交后的持仓", value: ev.positionAfter, step: "1", required: true }],
    okText: "确认",
    onOk: async ({ position }) => {
      await api(`/api/holdings/${encodeURIComponent(holding.symbol)}/execute`, { position });
      await loadStatus();
    },
  });
}

function editHolding(holding) {
  openDialog({
    title: `修改 ${holding.name ?? holding.symbol}`,
    text: "修改基准价会开始新一轮（已触发档位清零）。修改会写回配置文件，保留原有注释。",
    fields: [
      { name: "position", label: "持仓数量", value: holding.position, step: "1", required: true },
      { name: "basePrice", label: "基准价 P0", value: holding.basePrice, required: true },
      { name: "cash", label: `可用资金${holding.connect ? "（人民币）" : ""}（留空表示不限制）`, value: holding.cash ?? "" },
    ],
    okText: "保存",
    onOk: async (v) => {
      await api(`/api/holdings/${encodeURIComponent(holding.symbol)}`, v);
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
