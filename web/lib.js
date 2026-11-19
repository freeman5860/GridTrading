// 公共工具：DOM 构建、接口请求、Markdown 渲染、对话框。
// 页面上的动态内容都用 textContent / DOM API 构建；只有 Markdown 经过下面的安全渲染后才用 innerHTML。

import { Marked } from "/vendor/marked.js";

export const $ = (sel) => document.querySelector(sel);

/** h("div", { class: "x", onclick: fn, style: { left: "10%" } }, "text", child) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v); // CSSOM 赋值不受 CSP 的 inline style 限制
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// ---------------- 格式化 ----------------

export const num = (n, d = 4) => (n === undefined || n === null ? "—" : String(Number(Number(n).toFixed(d))));
export const pct = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;
export const money = (n) => Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export const trend = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");

// ---------------- Markdown（AI 输出可能被截图内容诱导，必须安全渲染） ----------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const marked = new Marked({
  gfm: true,
  renderer: {
    html(t) {
      return esc(t.text ?? t.raw ?? ""); // 原始 HTML 一律转义
    },
    link(t) {
      const text = this.parser.parseInline(t.tokens);
      // 只允许 http(s) 链接，屏蔽 javascript: 等协议
      return /^https?:\/\//i.test(t.href)
        ? `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text;
    },
    image(t) {
      return esc(t.text ?? ""); // 不加载外部图片
    },
  },
});

export function renderMarkdown(el, text) {
  el.innerHTML = marked.parse(text ?? "");
}

// ---------------- 对话框 ----------------

/**
 * 打开确认对话框。onOk 返回 Promise；出错时在对话框内显示错误，不关闭。
 * fields: [{ name, label, value, placeholder, step, hint }]
 * onInput(name, values, set)：某个输入框变化时调用，可用 set(name, value) 联动修改其他输入框
 */
export function openDialog({ title, text, fields = [], okText = "确定", onOk, onInput }) {
  const dialog = $("#dialog");
  $("#dialog-title").textContent = title;
  const body = $("#dialog-body");
  body.replaceChildren();
  if (text) body.append(h("p", { class: "muted" }, text));
  const inputs = {};
  for (const f of fields) {
    inputs[f.name] = h("input", {
      type: "number",
      step: f.step ?? "any",
      min: "0",
      value: f.value ?? "",
      placeholder: f.placeholder ?? "",
      required: f.required,
    });
    body.append(h("label", {}, h("span", {}, f.label), inputs[f.name], f.hint && h("small", { class: "muted" }, f.hint)));
  }
  const readValues = () => {
    const values = {};
    for (const [k, input] of Object.entries(inputs)) values[k] = input.value.trim() === "" ? null : Number(input.value);
    return values;
  };
  if (onInput) {
    const set = (name, v) => (inputs[name].value = v === undefined || v === null ? "" : String(v));
    for (const [k, input] of Object.entries(inputs)) input.addEventListener("input", () => onInput(k, readValues(), set));
  }
  const err = $("#dialog-error");
  err.hidden = true;
  const ok = $("#dialog-ok");
  ok.textContent = okText;
  ok.disabled = false;

  const form = $("#dialog-form");
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== "ok") return; // 取消
    e.preventDefault();
    const values = readValues();
    ok.disabled = true;
    try {
      await onOk(values);
      dialog.close();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      ok.disabled = false;
    }
  };
  dialog.showModal();
  inputs[fields[0]?.name]?.select();
}

export const dialogOpen = () => $("#dialog").open;
