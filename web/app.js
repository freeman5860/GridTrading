import { initAI, updateSymbols } from "./ai.js";
import { $, api, renderMarkdown } from "./lib.js";
import { initWatch, onStatus } from "./watch.js";

const TABS = ["watch", "ai", "rules"];
let active = "watch";
let rulesLoaded = false;

function show(tab) {
  if (!TABS.includes(tab)) tab = "watch";
  active = tab;
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== tab;
    document.querySelector(`[data-tab="${t}"]`).setAttribute("aria-selected", String(t === tab));
  }
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  try {
    localStorage.setItem("gridbot.tab", tab);
  } catch {
    /* 隐私模式下无法保存，忽略 */
  }
  if (tab === "rules" && !rulesLoaded) loadRules();
}

async function loadRules() {
  try {
    const { markdown } = await api("/api/rules");
    renderMarkdown($("#rules"), markdown);
    rulesLoaded = true;
  } catch (e) {
    $("#rules").textContent = `加载失败：${e.message}`;
  }
}

for (const btn of document.querySelectorAll("[data-tab]")) {
  btn.addEventListener("click", () => show(btn.dataset.tab));
}

// 优先使用地址栏锚点（#watch / #ai / #rules），其次是上次打开的标签页
let saved = location.hash.slice(1);
if (!TABS.includes(saved)) {
  try {
    saved = localStorage.getItem("gridbot.tab") ?? "watch";
  } catch {
    saved = "watch";
  }
}
show(saved);
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

onStatus(updateSymbols);
initWatch(() => active === "watch");
initAI(() => active === "ai");
