// 设置向导：持仓 → 提醒渠道 → AI → 完成。保存时写回配置文件（保留注释），密钥从不回显到页面。

import { $, api, h } from "./lib.js";

const STEPS = [
  { id: "holdings", title: "持仓", desc: "监控哪些标的" },
  { id: "notify", title: "提醒渠道", desc: "有信号时通知你" },
  { id: "ai", title: "AI 分析", desc: "识别截图、解读信号" },
  { id: "done", title: "完成", desc: "开始监控" },
];

const MAIL_PRESETS = [
  { id: "qq", name: "QQ 邮箱", host: "smtp.qq.com", port: 465, passHint: "填「授权码」，不是 QQ 密码：QQ 邮箱网页版 → 设置 → 账号 → 开启 SMTP 服务后生成" },
  { id: "163", name: "163 邮箱", host: "smtp.163.com", port: 465, passHint: "填「授权码」：163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 后生成" },
  { id: "gmail", name: "Gmail", host: "smtp.gmail.com", port: 465, passHint: "填「应用专用密码」：Google 账号 → 安全性 → 两步验证 → 应用专用密码" },
  { id: "outlook", name: "Outlook", host: "smtp.office365.com", port: 587, passHint: "填账号密码或应用密码" },
  { id: "custom", name: "其他", host: "", port: 465, passHint: "SMTP 密码或授权码" },
];

const CHANNELS = {
  wecom: {
    name: "企业微信",
    help: "在企业微信群聊中：右上角「…」→ 添加群机器人 → 新建，复制 Webhook 地址。",
    fields: [{ key: "url", label: "机器人 Webhook 地址", secret: true, placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" }],
  },
  dingtalk: {
    name: "钉钉",
    help: "群设置 → 机器人 → 添加机器人 → 自定义。安全设置选「加签」时把密钥填在下面；选「自定义关键词」时关键词填 gridbot。",
    fields: [
      { key: "url", label: "机器人 Webhook 地址", secret: true, placeholder: "https://oapi.dingtalk.com/robot/send?access_token=…" },
      { key: "secret", label: "加签密钥（可选）", secret: true, placeholder: "SEC 开头的字符串" },
    ],
  },
  feishu: {
    name: "飞书",
    help: "群设置 → 群机器人 → 添加机器人 → 自定义机器人。开启「签名校验」时把密钥填在下面。",
    fields: [
      { key: "url", label: "机器人 Webhook 地址", secret: true, placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…" },
      { key: "secret", label: "签名校验密钥（可选）", secret: true },
    ],
  },
  telegram: {
    name: "Telegram",
    help: "找 @BotFather 发送 /newbot 创建机器人，得到 Bot Token；给你的机器人发一条消息后，访问 https://api.telegram.org/bot<Token>/getUpdates，返回内容中的 chat.id 就是 Chat ID。",
    fields: [
      { key: "botToken", label: "Bot Token", secret: true, placeholder: "123456:ABC-DEF…" },
      { key: "chatId", label: "Chat ID", placeholder: "如 123456789" },
    ],
  },
  bark: {
    name: "Bark（iOS）",
    help: "在 iPhone 上安装 Bark App，复制首页显示的推送地址。",
    fields: [{ key: "url", label: "推送地址", secret: true, placeholder: "https://api.day.app/你的Key" }],
  },
  serverchan: {
    name: "Server酱（微信）",
    help: "登录 sct.ftqq.com（微信扫码），在「SendKey」页面复制。",
    fields: [{ key: "sendKey", label: "SendKey", secret: true, placeholder: "SCT 或 sctp 开头" }],
  },
  webhook: {
    name: "通用 Webhook",
    help: "以 POST JSON {title, text, html} 发送到这个地址，适合接入自己的服务。",
    fields: [{ key: "url", label: "地址", secret: true, placeholder: "https://example.com/hook" }],
  },
};

const AI_UI = {
  claude: {
    label: "Claude",
    desc: "Anthropic，识图和分析能力强",
    keyHint: "在 console.anthropic.com 创建 API Key；推荐填 ${ANTHROPIC_API_KEY}，从环境变量读取",
    baseHint: "可选：使用代理时填写",
  },
  openai: {
    label: "ChatGPT / 兼容服务",
    desc: "OpenAI，或 DeepSeek、通义千问、Kimi 等",
    keyHint: "在 platform.openai.com 创建；兼容服务填对应平台的 Key。推荐填 ${OPENAI_API_KEY}",
    baseHint: "使用兼容服务时填写，如 DeepSeek：https://api.deepseek.com；通义千问：https://dashscope.aliyuncs.com/compatible-mode/v1；Kimi：https://api.moonshot.cn/v1",
    modelHint: "使用兼容服务时必须填写该平台的模型名",
  },
  gemini: {
    label: "Gemini",
    desc: "Google",
    keyHint: "在 aistudio.google.com 获取 API Key；推荐填 ${GEMINI_API_KEY}",
    baseHint: "可选：使用代理时填写",
  },
  local: {
    label: "本地模型",
    desc: "Ollama / LM Studio / vLLM，如 Qwen，免费、不需要 Key",
    keyHint: "一般不需要",
    baseHint: "Ollama 默认 http://127.0.0.1:11434/v1；LM Studio 为 :1234/v1；vLLM 为 :8000/v1",
    modelHint: "需要先下载模型，如 ollama pull qwen3；识别截图需要视觉模型，如 qwen2.5vl",
  },
};

let data = null; // GET /api/setup
let step = "holdings";
let hooks = { refresh: () => {}, goto: () => {} };

const DISMISS_KEY = "gridbot.setupDismissed";
function dismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* 隐私模式下无法保存，忽略 */
  }
}
function dismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

// ---------------- 表单小工具 ----------------

const val = (v) => (v === undefined || v === null ? "" : String(v));

function field(label, control, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint && h("span", { class: "hint" }, hint));
}

/** 文本 / 数字输入框，输入时同步到 obj[key]；清空时为 undefined */
function input(obj, key, attrs = {}) {
  const el = h("input", { type: "text", value: val(obj[key]), ...attrs });
  el.addEventListener("input", () => {
    const v = el.value.trim();
    obj[key] = v === "" ? undefined : attrs.type === "number" ? Number(v) : v;
  });
  return el;
}
const numInput = (obj, key, attrs = {}) => input(obj, key, { type: "number", step: "any", min: "0", inputmode: "decimal", ...attrs });

function checkbox(obj, key, label, onchange) {
  const el = h("input", { type: "checkbox", checked: !!obj[key] });
  el.addEventListener("change", () => {
    obj[key] = el.checked;
    onchange?.(el.checked);
  });
  return h("label", { class: "check" }, el, h("span", {}, label));
}

/**
 * 密钥输入框：页面拿不到已保存的密钥，只知道是否已设置。
 * 留空 = 保持原值；可以填密钥本身，也可以填 ${环境变量名}。
 */
function secretInput(obj, key, view, { label, hint, placeholder } = {}) {
  const v = view ?? { set: false };
  const el = h("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    value: v.env ? `\${${v.env}}` : "",
    placeholder: v.set && !v.env ? "已设置（留空保持不变）" : (placeholder ?? "直接粘贴，或填 ${环境变量名}"),
  });
  el.addEventListener("input", () => (obj[key] = el.value.trim() || undefined));
  const toggle = h("button", { type: "button", class: "btn small" }, "显示");
  toggle.addEventListener("click", () => {
    el.type = el.type === "password" ? "text" : "password";
    toggle.textContent = el.type === "password" ? "显示" : "隐藏";
  });
  let status;
  if (v.env) {
    status = v.envSet
      ? h("span", { class: "hint ok" }, `✓ 从环境变量 ${v.env} 读取`)
      : h("span", { class: "hint warn" }, `⚠ 环境变量 ${v.env} 当前没有值：请在启动 gridbot 的终端中设置后重启，或直接填写`);
  } else if (v.set) {
    status = h("span", { class: "hint ok" }, "✓ 已设置");
  }
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), h("div", { class: "input-row" }, el, toggle), status, hint && h("span", { class: "hint" }, hint));
}

/** 每一步底部的按钮：保存并继续 / 跳过 / 上一步，以及"保存并测试"这类附加操作 */
function stepFooter({ save, next, back, canSkip, extra }) {
  const err = h("div", { class: "error", hidden: true });
  const result = h("div", { class: "test-result", hidden: true });
  const buttons = [];

  const run = async (btn, fn) => {
    err.hidden = true;
    result.hidden = true;
    for (const b of buttons) b.disabled = true;
    const label = btn.textContent;
    btn.textContent = "处理中…";
    try {
      await fn();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      for (const b of buttons) b.disabled = false;
      btn.textContent = label;
    }
  };

  const saveAndReload = async () => {
    await save();
    data = await api("/api/setup");
    hooks.refresh();
  };

  if (back) buttons.push(h("button", { class: "btn", type: "button", onclick: () => go(back) }, "上一步"));
  if (canSkip) buttons.push(h("button", { class: "btn", type: "button", onclick: () => go(next) }, "跳过"));
  if (extra) {
    const b = h("button", { class: "btn", type: "button" }, extra.text);
    b.addEventListener("click", () =>
      run(b, async () => {
        await saveAndReload();
        result.replaceChildren(...(await extra.run()));
        result.hidden = false;
        updateStepper();
      }),
    );
    buttons.push(b);
  }
  const primary = h("button", { class: "btn primary", type: "button" }, "保存并继续");
  primary.addEventListener("click", () =>
    run(primary, async () => {
      await saveAndReload();
      go(next);
    }),
  );
  buttons.push(primary);

  return h("div", { class: "step-foot" }, result, err, h("div", { class: "row end" }, buttons));
}

const okLine = (ok, text) => h("div", { class: ok ? "ok-line" : "fail-line" }, ok ? "✓ " : "✗ ", text);

// ---------------- 第 1 步：持仓 ----------------

const blankHolding = () => ({ symbol: "", tiers: true, grid: null, fee: null });

function renderHoldings() {
  const items = data.watchlist.map((x) => structuredClone(x));
  if (!items.length) items.push(blankHolding());

  const list = h("div", { class: "editor-list" });
  const redraw = () => list.replaceChildren(...items.map((it, i) => holdingEditor(it, i, items, redraw)));
  redraw();

  const payload = () =>
    items.map((it) => ({
      symbol: it.symbol,
      name: it.name,
      basePrice: it.basePrice,
      position: it.position,
      cash: it.cash,
      connect: it.connect === true,
      tiers: it.tiers !== false,
      grid: it.grid ?? undefined,
      fee: it.fee ?? undefined,
    }));

  return h(
    "div",
    { class: "panel" },
    h("h2", { class: "h2" }, "第 1 步：填写持仓"),
    h(
      "p",
      { class: "muted small" },
      "gridbot 以「基准价」为中心计算：跌到加仓档提示买入，涨到止盈档提示卖出；可选的区间网格在价格区间内高抛低吸。详细规则见",
      h("a", { href: "#rules" }, "「规则」"),
      "页。",
    ),
    data.isExample &&
      h(
        "div",
        { class: "banner" },
        "下面是 gridbot init 生成的示例持仓，请改成你自己的，或 ",
        h("button", { class: "linkbtn", type: "button", onclick: () => (items.splice(0, items.length, blankHolding()), redraw()) }, "清空示例"),
        "。",
      ),
    list,
    h("div", {}, h("button", { class: "btn", type: "button", onclick: () => (items.push(blankHolding()), redraw()) }, "＋ 添加标的")),
    stepFooter({
      save: () => api("/api/setup/watchlist", { items: payload() }),
      next: "notify",
      canSkip: data.exists && data.watchlist.length > 0,
    }),
  );
}

function holdingEditor(it, i, items, redraw) {
  const quoteLine = h("div", { class: "quote-line small" });
  const base = numInput(it, "basePrice", { placeholder: "如 4.00" });
  let lastQuote; // { q, fx }：用于"用现价作为基准价"，港股通时折算成人民币

  let seq = 0;
  let looked;
  async function lookup() {
    const s = (it.symbol ?? "").trim();
    if (s === looked) return; // 代码没变（如点击"用现价"时输入框失焦）不重复查询
    looked = s;
    const my = ++seq;
    if (!s) return quoteLine.replaceChildren();
    quoteLine.replaceChildren(h("span", { class: "muted" }, "查询行情…"));
    try {
      const {
        quotes: [q],
        fx,
      } = await api(`/api/quote?symbols=${encodeURIComponent(s)}`);
      if (my !== seq) return;
      if (q.error) return quoteLine.replaceChildren(h("span", { class: "warn-text" }, q.error));
      lastQuote = { q, fx };
      setHK(q.market === "hk");
      drawQuote();
    } catch (e) {
      if (my === seq) quoteLine.replaceChildren(h("span", { class: "warn-text" }, e.message));
    }
  }
  function drawQuote() {
    if (!lastQuote) return;
    const { q, fx } = lastQuote;
    // 港股通：基准价为人民币，现价按汇率折算
    const cnyPrice = it.connect && fx ? Math.round(q.price * fx.rate * 1000) / 1000 : undefined;
    const usable = !it.connect || cnyPrice !== undefined;
    quoteLine.replaceChildren(
      h("span", { class: "ok-text" }, `✓ ${q.name}`),
      h("span", { class: "muted" }, ` · ${q.symbol} · 现价 ${q.price} ${q.currency}${cnyPrice !== undefined ? `（≈ ¥${cnyPrice}，汇率 ${fx.rate}）` : ""} · 每手 ${q.lotSize}`),
      " ",
      usable &&
        h(
          "button",
          {
            class: "linkbtn",
            type: "button",
            onclick: () => {
              it.basePrice = cnyPrice ?? q.price;
              base.value = String(it.basePrice);
            },
          },
          cnyPrice !== undefined ? "用现价（人民币）作为基准价" : "用现价作为基准价",
        ),
    );
  }
  const sym = input(it, "symbol", { placeholder: "如 510300、00700、AAPL", autocomplete: "off" });

  // 港股：可选"通过港股通买入"，此时可用资金和手续费为人民币
  const cashLabel = h("span", { class: "field-label" }, "");
  const cashHint = h("span", { class: "hint" }, "");
  const baseLabel = h("span", { class: "field-label" }, "");
  const baseHint = h("span", { class: "hint" }, "");
  const updateCash = () => {
    cashLabel.textContent = it.connect ? "可用资金（人民币）" : "可用资金";
    cashHint.textContent = it.connect ? "港股通账户里的人民币可用资金" : "该标的用于加仓的资金（标的币种）";
    baseLabel.textContent = it.connect ? "基准价 P0（人民币）" : "基准价 P0";
    baseHint.textContent =
      (it.connect ? "人民币，按实时汇率折算成港元比较。" : "") +
      "首次建仓均价或你认定的价格中枢；加仓后可改成新的持仓成本，已触发的档位保留，不会重复提醒";
    drawQuote();
  };
  updateCash();
  const connectRow = h(
    "div",
    { class: "connect-row", hidden: !it.connect && !/^(hk|\d{1,5}$)/i.test(it.symbol ?? "") },
    checkbox(it, "connect", "通过港股通买入（资金为人民币）", updateCash),
    h("span", { class: "hint" }, "基准价、可用资金、手续费按人民币填写（与港股通账户一致）；网格价格是挂单价，仍按港元填写。内地休市日港股通不交易，定时检查会自动跳过。"),
  );
  const setHK = (isHK) => {
    connectRow.hidden = !isHK;
    if (!isHK && it.connect) {
      it.connect = false;
      connectRow.querySelector("input").checked = false;
      updateCash();
    }
  };
  sym.addEventListener("change", lookup);
  if (it.symbol) lookup();

  const gridBox = h("div", { class: "sub-fields", hidden: !it.grid });
  if (it.grid) {
    const g = it.grid;
    gridBox.append(
      h(
        "div",
        { class: "form-grid" },
        field("区间下限", numInput(g, "lower", { placeholder: "如 3.6" })),
        field("区间上限", numInput(g, "upper", { placeholder: "如 4.4" })),
        field("网格间距", input(g, "step", { placeholder: "2% 或 0.05" }), "百分比（如 2%）或固定金额"),
        field("每格买卖数量", numInput(g, "size", { step: "1", placeholder: "如 500" }), "股 / 份，需是整手"),
        field("已持网格仓", numInput(g, "initialLots", { step: "1", placeholder: "0" }), "启用时已经买入的格数，不含底仓"),
      ),
    );
  }

  it.fee ??= {};
  const feeBox = h(
    "details",
    { class: "more", open: it.fee.rate !== undefined || it.fee.min !== undefined },
    h("summary", {}, "手续费（可选）"),
    h(
      "div",
      { class: "form-grid" },
      field("佣金费率", numInput(it.fee, "rate", { placeholder: "0.0001" }), "万一填 0.0001"),
      field("每笔最低收费", numInput(it.fee, "min", { placeholder: "5" })),
    ),
    h("span", { class: "hint" }, "用于检查网格每格的利润是否覆盖手续费。"),
  );

  return h(
    "div",
    { class: "editor" },
    h(
      "div",
      { class: "editor-head" },
      h("b", {}, `标的 ${i + 1}`),
      items.length > 1 && h("button", { class: "btn small", type: "button", onclick: () => (items.splice(i, 1), redraw()) }, "删除"),
    ),
    h(
      "div",
      { class: "form-grid" },
      h("div", { class: "field span2" }, h("span", { class: "field-label" }, "代码"), sym, quoteLine, h("span", { class: "hint" }, "A 股 / 港股 / 美股都可以，如 510300、sh510300、00700、hk00700、AAPL")),
      h("label", { class: "field" }, baseLabel, base, baseHint),
      field("当前持仓", numInput(it, "position", { step: "1", placeholder: "如 10000" }), "股 / 份，交易后在监控页更新"),
      h("label", { class: "field" }, cashLabel, numInput(it, "cash", { placeholder: "留空表示不限制" }), cashHint),
    ),
    connectRow,
    h(
      "div",
      { class: "checks" },
      checkbox(it, "tiers", "分档仓位管理（第一层，推荐开启）"),
      checkbox({ on: !!it.grid }, "on", "区间网格（第二层，可选）", (on) => {
        it.grid = on ? (it.grid ?? { step: "2%" }) : null;
        redraw();
      }),
    ),
    gridBox,
    feeBox,
  );
}

// ---------------- 第 2 步：提醒渠道 ----------------

function renderNotify() {
  const n = data.notify;
  const st = {
    email: n.email ? { ...n.email, pass: undefined } : null,
    passView: n.email?.pass,
    webhooks: n.webhooks.map((w) => ({ index: w.index, type: w.type, name: w.name, chatId: w.chatId, views: w.secrets })),
    always: n.always,
    interval: data.schedule.interval,
  };

  const emailBox = h("div");
  const drawEmail = () => emailBox.replaceChildren(emailCard(st, drawEmail));
  drawEmail();

  const hookList = h("div", { class: "editor-list" });
  const drawHooks = () => hookList.replaceChildren(...st.webhooks.map((w, i) => webhookCard(w, i, st, drawHooks)));
  drawHooks();

  const adder = h(
    "select",
    { class: "inline-select" },
    h("option", { value: "" }, "＋ 添加手机推送…"),
    Object.entries(CHANNELS).map(([type, c]) => h("option", { value: type }, c.name)),
  );
  adder.addEventListener("change", () => {
    if (!adder.value) return;
    st.webhooks.push({ type: adder.value, views: {} });
    adder.value = "";
    drawHooks();
  });

  const intervals = ["1m", "5m", "10m", "15m", "30m", "1h"];
  if (!intervals.includes(st.interval)) intervals.push(st.interval);
  const interval = h(
    "select",
    {},
    intervals.map((v) => h("option", { value: v, selected: v === st.interval }, v.replace("m", " 分钟").replace("h", " 小时"))),
  );
  interval.addEventListener("change", () => (st.interval = interval.value));

  const payload = () => ({
    email: st.email ? { host: st.email.host, port: st.email.port, user: st.email.user, pass: st.email.pass, from: st.email.from, to: st.email.to } : null,
    webhooks: st.webhooks.map((w) => ({ index: w.index, type: w.type, name: w.name, chatId: w.chatId, url: w.url, secret: w.secret, botToken: w.botToken, sendKey: w.sendKey })),
    always: st.always,
    interval: st.interval,
  });

  return h(
    "div",
    { class: "panel" },
    h("h2", { class: "h2" }, "第 2 步：提醒渠道"),
    h("p", { class: "muted small" }, "有交易信号时通过这些渠道通知你，可以同时配置多个。只要一个渠道发送成功就算已提醒。"),
    emailBox,
    hookList,
    h("div", {}, adder),
    h(
      "div",
      { class: "form-grid" },
      field("检查间隔", interval, "只在各市场交易时段内检查"),
    ),
    h("div", { class: "checks" }, checkbox(st, "always", "没有信号时也发送（不建议）")),
    h(
      "div",
      { class: "banner info" },
      "密钥会保存到配置文件 ",
      h("code", {}, data.configPath),
      "（已在 .gitignore 中，不会提交到 Git）。也可以填 ",
      h("code", {}, "${环境变量名}"),
      "，从环境变量读取。",
    ),
    stepFooter({
      save: () => api("/api/setup/notify", payload()),
      back: "holdings",
      next: "ai",
      canSkip: true,
      extra: {
        text: "保存并发送测试",
        run: async () => {
          const { results } = await api("/api/setup/test-notify", {});
          return [h("div", { class: "small muted" }, "测试结果（请到对应 App / 邮箱查收）："), ...results.map((r) => okLine(r.ok, r.ok ? `${r.channel}：已发送` : r.error))];
        },
      },
    }),
  );
}

function emailCard(st, redraw) {
  const on = checkbox({ on: !!st.email }, "on", "邮件", (v) => {
    st.email = v ? (st.email ?? { host: "smtp.qq.com", port: 465 }) : null;
    redraw();
  });
  if (!st.email) return h("div", { class: "editor" }, h("div", { class: "editor-head" }, on, h("span", { class: "muted small" }, "通过 SMTP 发送到你的邮箱")));

  const e = st.email;
  const preset = MAIL_PRESETS.find((p) => p.host && p.host === e.host) ?? MAIL_PRESETS.at(-1);
  const select = h(
    "select",
    {},
    MAIL_PRESETS.map((p) => h("option", { value: p.id, selected: p === preset }, p.name)),
  );
  select.addEventListener("change", () => {
    const p = MAIL_PRESETS.find((x) => x.id === select.value);
    e.host = p.host || undefined;
    e.port = p.port;
    redraw();
  });

  return h(
    "div",
    { class: "editor" },
    h("div", { class: "editor-head" }, on),
    h(
      "div",
      { class: "form-grid" },
      field("邮箱服务商", select),
      field("SMTP 服务器", input(e, "host", { placeholder: "smtp.example.com" })),
      field("端口", numInput(e, "port", { step: "1", placeholder: "465" }), "465 为 SSL，587 为 STARTTLS"),
      field("发件邮箱（登录账号）", input(e, "user", { type: "email", placeholder: "you@qq.com", autocomplete: "off" })),
      secretInput(e, "pass", st.passView, { label: "密码 / 授权码", hint: preset.passHint }),
      field("收件邮箱", input(e, "to", { placeholder: "you@qq.com" }), "多个用逗号分隔"),
    ),
  );
}

function webhookCard(w, i, st, redraw) {
  const c = CHANNELS[w.type] ?? { name: w.type, help: "", fields: [] };
  return h(
    "div",
    { class: "editor" },
    h(
      "div",
      { class: "editor-head" },
      h("b", {}, c.name),
      h("button", { class: "btn small", type: "button", onclick: () => (st.webhooks.splice(i, 1), redraw()) }, "删除"),
    ),
    h("p", { class: "hint" }, c.help),
    h(
      "div",
      { class: "form-grid" },
      c.fields.map((f) =>
        f.secret ? secretInput(w, f.key, w.views?.[f.key], { label: f.label, placeholder: f.placeholder }) : field(f.label, input(w, f.key, { placeholder: f.placeholder })),
      ),
      field("名称（可选）", input(w, "name", { placeholder: c.name }), "多个同类渠道时用来区分"),
    ),
  );
}

// ---------------- 第 3 步：AI ----------------

function renderAI() {
  const saved = data.ai;
  const st = { provider: saved?.provider ?? null };
  const loadFields = (p) => {
    const same = saved && saved.provider === p;
    Object.assign(st, {
      provider: p,
      model: same ? saved.model : undefined,
      baseURL: same ? saved.baseURL : undefined,
      emailComment: same ? saved.emailComment : (st.emailComment ?? false),
      reviewBuys: same ? saved.reviewBuys !== false : (st.reviewBuys ?? true),
      apiKey: undefined,
      authToken: undefined,
      keyView: same ? saved.apiKey : undefined,
      tokenView: same ? saved.authToken : undefined,
    });
  };
  loadFields(st.provider);

  const box = h("div", { class: "stack" });
  const draw = () => box.replaceChildren(...aiFields(st, loadFields, draw));
  draw();

  return h(
    "div",
    { class: "panel" },
    h("h2", { class: "h2" }, "第 3 步：AI 分析（可选）"),
    h("p", { class: "muted small" }, "AI 用来对买入信号做决策（结合近 60 个交易日走势判断执行还是暂缓）、识别持仓截图、解读信号。买卖数量始终由规则引擎计算，AI 不改动。"),
    box,
    stepFooter({
      save: () =>
        api("/api/setup/ai", {
          ai: st.provider
            ? { provider: st.provider, apiKey: st.apiKey, authToken: st.authToken, model: st.model, baseURL: st.baseURL, emailComment: st.emailComment, reviewBuys: st.reviewBuys }
            : null,
        }),
      back: "notify",
      next: "done",
      canSkip: true,
      extra: {
        text: "保存并测试连接",
        run: async () => {
          if (!st.provider) return [h("div", { class: "muted small" }, "未启用 AI，无需测试")];
          const r = await api("/api/setup/test-ai", {});
          return [okLine(r.ok, r.ok ? `${r.model} 连接成功${r.reply ? `，回复：${r.reply}` : ""}` : r.error)];
        },
      },
    }),
  );
}

function aiFields(st, loadFields, redraw) {
  const choices = h(
    "div",
    { class: "choices" },
    [...Object.entries(AI_UI), [null, { label: "暂不使用", desc: "之后可以随时回来设置" }]].map(([id, ui]) =>
      h(
        "button",
        {
          type: "button",
          class: `choice ${st.provider === id ? "selected" : ""}`,
          "aria-pressed": String(st.provider === id),
          onclick: () => {
            loadFields(id);
            redraw();
          },
        },
        h("b", {}, ui.label),
        h("span", { class: "small muted" }, ui.desc),
      ),
    ),
  );
  if (!st.provider) return [choices];

  const ui = AI_UI[st.provider];
  const info = data.providers[st.provider];
  const fields = [
    secretInput(st, "apiKey", st.keyView, {
      label: st.provider === "local" ? "API Key（可选）" : "API Key",
      hint: ui.keyHint,
      placeholder: st.provider === "local" ? "一般不需要" : undefined,
    }),
    field("模型", input(st, "model", { placeholder: info.defaultModel }), ui.modelHint ?? `留空使用默认模型 ${info.defaultModel}`),
    field("API 地址", input(st, "baseURL", { placeholder: info.baseURL }), ui.baseHint),
  ];
  const more = [];
  if (st.provider === "claude") {
    more.push(
      h(
        "details",
        { class: "more", open: !!st.tokenView?.set },
        h("summary", {}, "高级：代理网关"),
        h("div", { class: "form-grid" }, secretInput(st, "authToken", st.tokenView, { label: "Bearer Token（可代替 API Key）", hint: "仅在代理网关要求 Bearer 认证时填写" })),
      ),
    );
  }
  return [
    choices,
    h("div", { class: "form-grid" }, fields),
    ...more,
    h(
      "div",
      { class: "checks" },
      checkbox(st, "reviewBuys", "买入信号先由 AI 决策（执行 / 暂缓），结论随提醒发送"),
      checkbox(st, "emailComment", "提醒中附带 AI 点评（每次提醒调用一次 AI，可能产生费用）"),
    ),
  ];
}

// ---------------- 完成 ----------------

function renderDone() {
  dismiss();
  const n = data.notify;
  const channels = [n.email && "邮件", ...n.webhooks.map((w) => w.name ?? data.channelNames[w.type] ?? w.type)].filter(Boolean);
  const cmd = (t) => h("code", { class: "cmd" }, t);
  return h(
    "div",
    { class: "panel" },
    h("h2", { class: "h2" }, "设置完成"),
    h(
      "div",
      { class: "summary-list" },
      okLine(data.watchlist.length > 0, `持仓：${data.watchlist.length} 个标的`),
      okLine(channels.length > 0, `提醒渠道：${channels.length ? channels.join("、") : "未配置（不会收到提醒）"}`),
      okLine(!!data.ai, `AI：${data.ai ? `${data.providers[data.ai.provider]?.name ?? data.ai.provider} · ${data.ai.model || data.providers[data.ai.provider]?.defaultModel}` : "未配置"}`),
    ),
    h("h3", { class: "h3" }, "接下来"),
    h(
      "ol",
      { class: "next-steps" },
      h("li", {}, "在「监控」页查看每个标的的档位和当前信号；成交后点「已按信号成交」更新持仓。"),
      h(
        "li",
        {},
        "保持控制台（gridbot serve）运行，就会在交易时段按间隔自动检查并发送提醒；监控页顶部可以看到上次检查结果。也可以不开网页，单独运行 ",
        cmd("gridbot run"),
        "。",
      ),
      h("li", {}, "不想让电脑一直开着？可以用 GitHub Actions 免费定时运行，见 docs/github-actions.md。"),
    ),
    h(
      "div",
      { class: "row end" },
      h("button", { class: "btn", type: "button", onclick: () => go("holdings") }, "返回修改"),
      h("button", { class: "btn primary", type: "button", onclick: () => hooks.goto("watch") }, "去监控页"),
    ),
  );
}

// ---------------- 框架 ----------------

const isDone = (id) =>
  ({
    holdings: data.exists && !data.isExample && data.watchlist.length > 0,
    notify: !!data.notify.email || data.notify.webhooks.length > 0,
    ai: !!data.ai,
    done: false,
  })[id];

function updateStepper() {
  $("#stepper").replaceChildren(
    ...STEPS.map((s, i) =>
      h(
        "li",
        { class: `${s.id === step ? "active" : ""} ${isDone(s.id) ? "done" : ""}` },
        h(
          "button",
          { type: "button", disabled: !data.exists && s.id !== "holdings", onclick: () => go(s.id) },
          h("span", { class: "step-num" }, isDone(s.id) ? "✓" : i + 1),
          h("span", { class: "step-text" }, h("b", {}, s.title), h("span", { class: "small muted" }, s.desc)),
        ),
      ),
    ),
  );
}

function render() {
  updateStepper();
  const notice = [];
  if (!data.exists) {
    notice.push(h("div", { class: "banner" }, "欢迎使用 gridbot！还没有配置文件，完成第 1 步后会创建 ", h("code", {}, data.configPath), "。"));
  } else if (data.error) {
    notice.push(h("div", { class: "error pre" }, `当前配置文件有错误，保存时会一并校验：\n${data.error}`));
  } else if (data.isExample && step === "holdings") {
    notice.push(
      h(
        "div",
        { class: "banner" },
        "当前使用的是示例配置。跟着向导改成你自己的持仓，配置好提醒渠道和 AI。 ",
        h("button", { class: "linkbtn", type: "button", onclick: () => (dismiss(), hooks.goto("watch")) }, "稍后再说"),
      ),
    );
  }
  $("#setup-notice").replaceChildren(...notice);
  const view = { holdings: renderHoldings, notify: renderNotify, ai: renderAI, done: renderDone }[step];
  $("#setup-body").replaceChildren(view());
}

function go(id) {
  step = id;
  render();
  $("#tab-setup").scrollIntoView({ block: "start" });
}

export async function loadSetup() {
  try {
    data = await api("/api/setup");
    render();
  } catch (e) {
    $("#setup-body").replaceChildren(h("div", { class: "card card-error" }, `加载失败：${e.message}`));
  }
}

/** 首次使用（没有配置文件，或还是未修改的示例配置）时自动打开向导 */
export async function shouldAutoOpen() {
  try {
    const d = await api("/api/setup");
    return !d.exists || (d.isExample && !dismissed());
  } catch {
    return false;
  }
}

export function initSetup(opts) {
  hooks = opts;
}
