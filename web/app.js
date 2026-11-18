import { initAI, updateSymbols } from "./ai.js";
import { $, api, renderMarkdown } from "./lib.js";
import { initSetup, loadSetup, shouldAutoOpen } from "./setup.js";
import { initWatch, loadStatus, onStatus } from "./watch.js";

const TABS = ["watch", "ai", "rules", "setup"];
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
  if (tab === "setup") loadSetup(); // 每次进入都重新读取配置文件
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

// 优先使用地址栏锚点（#watch / #ai / #rules / #setup），其次是上次打开的标签页
let saved = location.hash.slice(1);
const fromHash = TABS.includes(saved);
if (!TABS.includes(saved)) {
  try {
    saved = localStorage.getItem("gridbot.tab") ?? "watch";
  } catch {
    saved = "watch";
  }
}
// 首次使用（没有配置文件或仍是示例配置）时直接打开设置向导
if (!fromHash && saved !== "setup" && (await shouldAutoOpen())) saved = "setup";
show(saved);
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

initSetup({ refresh: loadStatus, goto: show });
onStatus(updateSymbols);
initWatch(() => active === "watch");
initAI(() => active === "ai");
