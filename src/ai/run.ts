import { fetchFx, prepareCheck } from "../check.js";
import type { Config } from "../config.js";
import { evaluate } from "../core/engine.js";
import { MARKETS, normalizeSymbol } from "../core/symbol.js";
import type { Holding, Quote, SymbolState } from "../core/types.js";
import { getQuoteSource } from "../market/source.js";
import { loadState } from "../state.js";
import {
  extractHolding,
  holdingFromExtraction,
  stateFromTriggered,
  type AnalysisContext,
  cleanSymbol,
  type Extraction,
} from "./analyze.js";
import { AIError, type AIClient, type ImageInput } from "./providers.js";

export interface AnalyzeInput {
  /** 指定 watchlist 中的标的：直接使用配置里的持仓和已触发档位 */
  symbol?: string;
  text?: string;
  images: ImageInput[];
  signal?: AbortSignal;
}

/** 准备分析上下文：确定持仓 → 拉取实时行情 → 规则引擎计算（不保存状态） */
export async function prepareAnalysis(config: Config, client: AIClient, input: AnalyzeInput): Promise<AnalysisContext> {
  const hasInput = Boolean(input.text?.trim()) || input.images.length > 0;
  if (!input.symbol && !hasInput) throw new AIError("请提供截图、文字描述，或用 --symbol 指定配置中的标的");

  let holding: Holding | undefined;
  let state: SymbolState | undefined;
  let extraction: Extraction | undefined;
  let source: AnalysisContext["source"] = "none";
  const problems: string[] = [];

  const symbol = input.symbol ? normalizeSymbol(input.symbol).symbol : undefined;
  const configured = symbol ? config.watchlist.find((h) => h.symbol === symbol) : undefined;

  if (configured) {
    holding = configured;
    state = (await loadState(config.statePath)).symbols[configured.symbol];
    source = "config";
  } else if (hasInput) {
    extraction = await extractHolding(client, input);

    // 截图/文字里没有提到任何标的（如"明天可以加仓吗"）：按配置中的全部持仓分析
    if (!symbol && !extraction.symbol && !extraction.name && !codesInText(input.text).length) {
      return portfolioContext(config, input.signal);
    }

    // 没识别出代码但有名称：按名称匹配 watchlist（用行情里的证券名称），唯一匹配时使用配置中的持仓
    if (!symbol && !extraction.symbol && extraction.name) {
      const match = await matchWatchlistByName(config, extraction.name, input.signal);
      if (match) {
        problems.push(`截图/文字中没有代码，按名称"${extraction.name}"匹配到配置中的 ${match.symbol}`);
        const configuredState = (await loadState(config.statePath)).symbols[match.symbol];
        return finish(config, match, configuredState, extraction, problems, "config", input.signal);
      }
    }

    // 用户文字里明确写出的代码比模型识别的更可靠（小模型经常把代码写错）
    const fromText = symbol ? [] : codesInText(input.text);
    const chosen = symbol ?? (await pickQuotedSymbol(config, [...fromText, extraction.symbol ?? ""], input.signal));
    const built = holdingFromExtraction(extraction, chosen);
    problems.push(...built.problems);
    if (built.holding) {
      holding = built.holding;
      state = stateFromTriggered(holding, extraction.triggered);
      source = "extracted";
    }
  } else {
    problems.push(`${symbol} 不在配置的 watchlist 中，且没有提供截图或文字`);
  }

  if (!holding) return { extraction, problems, source };
  return finish(config, holding, state, extraction, problems, source, input.signal);
}

/** 配置中全部持仓的引擎结果（试运行，不保存状态，使用已触发档位） */
async function portfolioContext(config: Config, signal?: AbortSignal): Promise<AnalysisContext> {
  try {
    const { result } = await prepareCheck(config, { signal });
    return { portfolio: result.items, problems: [], source: "config" };
  } catch (e) {
    return { problems: [`获取实时行情失败：${(e as Error).message}`], source: "none" };
  }
}

/** 从用户文字中找出明确的证券代码：6 位数字、hk + 数字、us + 字母、或 0700.HK 这类写法 */
export function codesInText(text: string | undefined): string[] {
  if (!text) return [];
  const found = text.match(/(?<![0-9A-Za-z])(?:(?:sh|sz|bj)?\d{6}|hk\d{1,5}|\d{4,5}\.hk|us[A-Z]{1,5})(?![0-9A-Za-z])/gi) ?? [];
  const out: string[] = [];
  for (const f of found) {
    try {
      const s = normalizeSymbol(f).symbol;
      if (!out.includes(s)) out.push(s);
    } catch {
      /* 忽略 */
    }
  }
  return out;
}

/** 依次尝试候选代码，返回第一个能查到行情的；都查不到时返回第一个候选 */
async function pickQuotedSymbol(config: Config, candidates: string[], signal?: AbortSignal): Promise<string | undefined> {
  const list: string[] = [];
  for (const c of candidates) {
    const cleaned = cleanSymbol(c);
    if (!cleaned) continue;
    try {
      const s = normalizeSymbol(cleaned).symbol;
      if (!list.includes(s)) list.push(s);
    } catch {
      /* 无法识别的候选跳过 */
    }
  }
  if (list.length <= 1) return list[0] ?? (candidates.find(Boolean) || undefined);
  try {
    const quotes = await getQuoteSource(config.market.source).fetchQuotes(list, { signal });
    return list.find((s) => quotes.has(s)) ?? list[0];
  } catch {
    return list[0];
  }
}

const normName = (s: string) => s.replace(/[\s()（）\-·]/g, "").toUpperCase();

async function matchWatchlistByName(config: Config, name: string, signal?: AbortSignal): Promise<Holding | undefined> {
  const target = normName(name);
  if (target.length < 2) return undefined;
  let quotes: Map<string, Quote>;
  try {
    quotes = await getQuoteSource(config.market.source).fetchQuotes(config.watchlist.map((h) => h.symbol), { signal });
  } catch {
    return undefined;
  }
  const hits = config.watchlist.filter((h) => {
    const n = normName(h.name ?? quotes.get(h.symbol)?.name ?? "");
    return n.length >= 2 && (n.includes(target) || target.includes(n));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

async function finish(
  config: Config,
  holding: Holding,
  state: SymbolState | undefined,
  extraction: Extraction | undefined,
  problems: string[],
  source: AnalysisContext["source"],
  signal?: AbortSignal,
): Promise<AnalysisContext> {
  // 优先使用实时行情；拉取失败时退回截图中识别的现价
  let quote: Quote | undefined;
  try {
    quote = (await getQuoteSource(config.market.source).fetchQuotes([holding.symbol], { signal })).get(holding.symbol);
  } catch (e) {
    problems.push(`获取实时行情失败：${(e as Error).message}`);
  }
  if (!quote && !problems.some((p) => p.startsWith("获取实时行情失败"))) {
    problems.push(`行情接口没有找到代码 ${holding.symbol}，请确认代码是否正确`);
  }
  const price = quote && !quote.suspended ? quote.price : (extraction?.price ?? undefined);
  if (!(price && price > 0)) {
    problems.push("没有可用的现价（实时行情和截图中都没有）");
    return { holding, quote, extraction, problems, source };
  }
  if (!quote) problems.push("未获取到实时行情，使用截图中识别的现价");

  const market = normalizeSymbol(holding.symbol).market;
  const fx = holding.connect ? await fetchFx(signal) : undefined;
  const evaluation = evaluate(holding, { price, lotSize: quote?.lotSize ?? MARKETS[market].defaultLot }, state, { fx });
  return { holding, quote, evaluation, extraction, problems, source };
}
