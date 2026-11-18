// AI 分析页：文字 + 截图（点击 / 拖拽 / 粘贴），流式显示识别、引擎计算和 AI 解读。

import { $, h, num, renderMarkdown } from "./lib.js";

const MAX_IMAGES = 6;
let images = []; // { id, url, mediaType, data }
let controller = null;

/** 浏览器端压缩为长边 ≤1600px 的 JPEG，控制上传大小 */
async function compress(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { id: crypto.randomUUID(), url, mediaType: "image/jpeg", data: url.split(",")[1] };
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length) return;
  try {
    images = [...images, ...(await Promise.all(list.map(compress)))].slice(0, MAX_IMAGES);
  } catch {
    showError("图片读取失败，请换一张试试");
  }
  renderThumbs();
}

function renderThumbs() {
  $("#thumbs").replaceChildren(
    ...images.map((img) =>
      h(
        "div",
        { class: "thumb" },
        h("img", { src: img.url, alt: "截图" }),
        h("button", { type: "button", "aria-label": "删除", onclick: () => ((images = images.filter((i) => i.id !== img.id)), renderThumbs()) }, "×"),
      ),
    ),
  );
  $("#pick").hidden = images.length >= MAX_IMAGES;
}

function showError(msg) {
  $("#ai-result").hidden = false;
  $("#ai-error").textContent = msg;
  $("#ai-error").hidden = false;
}

function fact(text, cls = "") {
  return h("span", { class: `fact ${cls}` }, text);
}

function renderExtracted(x) {
  const facts = [
    (x.name || x.symbol) && `识别：${[x.name, x.symbol].filter(Boolean).join(" ")}`,
    x.price && `现价 ${x.price}`,
    x.basePrice && `成本/基准 ${x.basePrice}`,
    x.position && `持仓 ${x.position}`,
    x.cash && `资金 ${x.cash}`,
    x.grid?.lower && x.grid?.upper && `网格 ${x.grid.lower}～${x.grid.upper}`,
  ].filter(Boolean);
  $("#ai-facts").append(...(facts.length ? facts : ["未识别到持仓信息"]).map((f) => fact(f)));
}

function renderEngine(v) {
  if (v.evaluation) {
    const sigs = v.evaluation.signals;
    $("#ai-facts").append(
      fact(
        `规则引擎：${sigs.length ? sigs.map((s) => `${s.action === "buy" ? "买入" : "卖出"} ${s.quantity} @ ${num(s.price)}`).join("，") : "不操作"}`,
        "engine",
      ),
    );
  }
  for (const p of v.problems ?? []) $("#ai-facts").append(fact(p));
}

async function submit() {
  const text = $("#ai-text").value.trim();
  const symbol = $("#ai-symbol").value;
  if (!text && !images.length && !symbol) return showError("请输入文字、上传截图，或选择一个标的");

  controller = new AbortController();
  $("#ai-submit").disabled = true;
  $("#ai-stop").hidden = false;
  $("#ai-result").hidden = false;
  $("#ai-error").hidden = true;
  $("#ai-meta").textContent = "";
  $("#ai-facts").replaceChildren();
  $("#ai-thinking").hidden = true;
  $("#ai-thinking").open = false;
  $("#ai-thinking-text").textContent = "";
  $("#ai-answer").replaceChildren();
  $("#ai-waiting").hidden = false;
  $("#ai-waiting-text").textContent = symbol && !text && !images.length ? "正在计算…" : "正在识别持仓并计算…";
  $("#ai-result").scrollIntoView({ behavior: "smooth", block: "start" });

  let answer = "";
  let pending = false;
  const flush = () => {
    pending = false;
    renderMarkdown($("#ai-answer"), answer);
  };

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, symbol, images: images.map(({ mediaType, data }) => ({ mediaType, data })) }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `请求失败（${res.status}）`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.t === "meta") $("#ai-meta").textContent = `使用 ${ev.v}`;
        else if (ev.t === "extracted") renderExtracted(ev.v);
        else if (ev.t === "engine") {
          renderEngine(ev.v);
          $("#ai-waiting-text").textContent = "AI 正在解读…";
        } else if (ev.t === "thinking") {
          $("#ai-thinking").hidden = false;
          $("#ai-thinking-text").textContent += ev.v;
        } else if (ev.t === "text") {
          $("#ai-waiting").hidden = true;
          answer += ev.v;
          if (!pending) {
            pending = true;
            requestAnimationFrame(flush); // 每帧最多渲染一次
          }
        } else if (ev.t === "error") showError(ev.v);
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") showError(e.message);
  } finally {
    flush();
    $("#ai-waiting").hidden = true;
    $("#ai-submit").disabled = false;
    $("#ai-stop").hidden = true;
    controller = null;
  }
}

/** 用最新的监控数据填充"分析配置中的标的"下拉框 */
export function updateSymbols(status) {
  const select = $("#ai-symbol");
  const current = select.value;
  const items = status.check?.items ?? [];
  select.replaceChildren(
    h("option", { value: "" }, "自动识别"),
    ...items.map((i) => h("option", { value: i.holding.symbol }, `${i.quote?.name ?? i.holding.name ?? ""} ${i.holding.symbol}`.trim())),
  );
  select.value = items.some((i) => i.holding.symbol === current) ? current : "";
  const ai = status.settings.ai;
  $("#ai-provider").textContent = ai ? `当前模型：${ai.name} · ${ai.model}（在配置文件的 ai 段修改）` : "未配置 AI：请在配置文件中添加 ai 段（provider、apiKey）后重启 serve";
  $("#ai-submit").disabled = !ai || controller !== null;
}

export function initAI(isActive) {
  const zone = $("#dropzone");
  $("#pick").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    addFiles(e.dataTransfer.files);
  });
  window.addEventListener("paste", (e) => {
    if (!isActive()) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      addFiles(files);
    }
  });
  $("#ai-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  });
  $("#ai-submit").addEventListener("click", submit);
  $("#ai-stop").addEventListener("click", () => controller?.abort());
  renderThumbs();
}
