// AI 分析流程：
//   1. 提取：从截图 / 文字中提取持仓信息（JSON）
//   2. 计算：用规则引擎（确定性代码）计算档位和数量，并拉取实时行情
//   3. 解读：把引擎结果交给 AI 解释、判断适用性和风险。AI 不重新计算数量
// 截图里的数据由模型识别，可能出错，所以提取结果会原样展示给用户核对。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CheckItem } from "../check.js";
import { evaluate, formatPct } from "../core/engine.js";
import { MARKETS, normalizeSymbol } from "../core/symbol.js";
import type { Evaluation, GridStep, Holding, Quote, SymbolState, TierId } from "../core/types.js";
import { AIError, complete, type AIClient, type ImageInput } from "./providers.js";

// ---------------- 规则文本 ----------------

let rulesCache: string | undefined;
/** 规则正文与引擎共用 docs/rules.md（源码和编译后的 dist 都位于仓库根目录下两级） */
export async function loadRulesText(): Promise<string> {
  rulesCache ??= await readFile(new URL("../../docs/rules.md", import.meta.url), "utf8");
  return rulesCache;
}

// ---------------- 图片 ----------------

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 6;

export function detectImageType(buf: Buffer): ImageInput["mediaType"] | undefined {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export async function readImage(file: string): Promise<ImageInput> {
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    throw new AIError(`读取图片失败：${file}`);
  }
  const mediaType = detectImageType(buf);
  if (!mediaType) throw new AIError(`${path.basename(file)} 不是支持的图片格式（JPG / PNG / WebP / GIF）`);
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new AIError(`${path.basename(file)} 超过 5MB，请压缩或截取关键区域后再试`);
  }
  return { mediaType, data: buf.toString("base64") };
}

// ---------------- 第 1 步：提取 ----------------

const num = z.preprocess((v) => {
  if (typeof v === "string") {
    const n = Number(v.replace(/[,，\s元股份$¥]|HK\$|港元|港币|美元/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return v;
}, z.number().nullable().optional());

const TIER_IDS = ["down15", "down25", "up25", "up35", "up45", "up60", "up100"] as const;

export const extractionSchema = z.object({
  symbol: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  price: num,
  basePrice: num,
  position: num,
  cash: num,
  grid: z
    .object({ lower: num, upper: num, step: z.union([z.number(), z.string()]).nullable().optional(), size: num })
    .nullable()
    .optional(),
  triggered: z.array(z.string()).nullable().optional(),
  missing: z.array(z.string()).nullable().optional(),
});

export type Extraction = z.infer<typeof extractionSchema>;

const EXTRACT_SYSTEM = `你负责从用户提供的截图（行情、持仓、交易记录、K 线等）和文字中提取持仓信息，供后续的规则引擎计算。
只输出一个 JSON 对象，不要输出任何其他文字或代码块标记。字段如下，读不清或没有提到的填 null，不要猜测：
{
  "symbol": "证券代码，带市场前缀：A 股 sh/sz/bj + 6 位数字，港股 hk + 5 位数字，美股 us + 代码，例如 sh510300、hk00700、usAAPL",
  "name": "证券名称",
  "price": 现价（数字）,
  "basePrice": 基准价或持仓成本价（数字）,
  "position": 持仓数量，单位股/份（数字）,
  "cash": 可用资金（数字）,
  "grid": { "lower": 网格下限, "upper": 网格上限, "step": 间距（数字金额，或 "2%" 这样的百分比字符串）, "size": 每格数量 } 或 null,
  "triggered": 用户说已经执行过的档位，取值 down15 / down25 / up25 / up35 / up45 / up60 / up100,
  "missing": ["做出建议还缺少的关键信息，用中文简短描述"]
}
数字只写数值，不带单位和千分位逗号。`;

/** 容错地从模型输出中取出第一个 JSON 对象（兼容带 \`\`\`json 代码块或前后有说明文字的情况） */
export function parseJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AIError("AI 没有返回可解析的 JSON");
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new AIError("AI 返回的 JSON 格式有误");
  }
}

export async function extractHolding(
  client: AIClient,
  input: { text?: string; images: ImageInput[]; signal?: AbortSignal },
): Promise<Extraction> {
  const raw = await complete(client, {
    system: EXTRACT_SYSTEM,
    prompt: input.text?.trim() ? `用户描述：\n${input.text}` : "请从截图中提取持仓信息。",
    images: input.images,
    effort: "low",
    json: true,
    signal: input.signal,
  });
  const parsed = extractionSchema.safeParse(parseJsonObject(raw));
  if (!parsed.success) throw new AIError("AI 提取的持仓信息格式不正确");
  return parsed.data;
}

function parseStep(v: number | string | null | undefined): GridStep | undefined {
  if (typeof v === "number" && v > 0) return { type: "abs", value: v };
  if (typeof v === "string") {
    const pct = v.trim().match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (pct) return { type: "pct", value: Number(pct[1]) / 100 };
    const n = Number(v);
    if (n > 0) return { type: "abs", value: n };
  }
  return undefined;
}

/**
 * 修正模型给出的代码：只保留代码本身（小模型常写成"创业板ETF 159915"），
 * 并且 6 位 A 股代码按数字重新判断交易所（小模型经常把交易所前缀写错，如把 159915 写成 bj159915）。
 */
export function cleanSymbol(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const cn = s.match(/(?:^|[^0-9])(?:sh|sz|bj)?(\d{6})(?:\.(?:sh|sz|bj))?(?![0-9])/i);
  if (cn && !/^hk/i.test(s)) return cn[1];
  const token = s.match(/(?:hk|us)?[A-Za-z0-9.]+(?:\.(?:hk|us))?/gi)?.find((t) => /\d|^[A-Z]{1,5}$|^(hk|us)/i.test(t));
  return token ?? s;
}

/** 把提取结果转成引擎可用的持仓；缺少代码或基准价时返回 undefined */
export function holdingFromExtraction(x: Extraction, symbolOverride?: string): { holding?: Holding; problems: string[] } {
  const problems: string[] = [];
  let symbol: string | undefined;
  const rawSymbol = cleanSymbol(symbolOverride ?? x.symbol ?? undefined);
  if (rawSymbol) {
    try {
      symbol = normalizeSymbol(rawSymbol).symbol;
    } catch {
      problems.push(`无法识别代码 ${rawSymbol}`);
    }
  } else {
    problems.push("没有识别到证券代码");
  }
  if (!(x.basePrice && x.basePrice > 0)) problems.push("没有识别到基准价 / 持仓成本");
  if (!symbol || !(x.basePrice && x.basePrice > 0)) return { problems };

  const holding: Holding = {
    symbol,
    name: x.name ?? undefined,
    basePrice: x.basePrice,
    position: x.position && x.position > 0 ? x.position : 0,
    ...(x.cash && x.cash > 0 ? { cash: x.cash } : {}),
  };
  const g = x.grid;
  const step = parseStep(g?.step);
  if (g && g.lower && g.upper && g.upper > g.lower && g.size && g.size > 0 && step) {
    holding.grid = { lower: g.lower, upper: g.upper, step, size: Math.round(g.size) };
  }
  return { holding, problems };
}

export function stateFromTriggered(holding: Holding, triggered?: string[] | null): SymbolState | undefined {
  const ids = (triggered ?? []).filter((t): t is TierId => (TIER_IDS as readonly string[]).includes(t));
  return ids.length ? { basePrice: holding.basePrice, triggered: ids } : undefined;
}

// ---------------- 第 3 步：解读 ----------------

/** 把引擎结果写成给 AI 看的简明文本 */
export function describeEvaluation(holding: Holding, quote: Pick<Quote, "price" | "lotSize" | "currency" | "market" | "time"> | undefined, ev: Evaluation): string {
  const lines = [
    `标的：${holding.name ?? ""} ${holding.symbol}${quote ? `（${MARKETS[quote.market].name}，每手 ${quote.lotSize}，${quote.currency}）` : ""}`,
    `现价 ${ev.price}${quote?.time ? `（行情时间 ${quote.time}）` : ""}，基准价 ${ev.basePrice}，相对基准 ${formatPct(ev.change)}`,
    `当前持仓 ${holding.position}${holding.cash !== undefined ? `，可用资金 ${holding.cash}` : "，可用资金未知"}`,
  ];
  if (holding.grid) {
    const g = holding.grid;
    lines.push(`网格：${g.lower}～${g.upper}，间距 ${g.step.type === "pct" ? `${g.step.value * 100}%` : g.step.value}，每格 ${g.size}`);
  }
  if (ev.signals.length) {
    lines.push("规则引擎给出的操作：");
    for (const s of ev.signals) {
      lines.push(`- ${s.action === "buy" ? "买入" : "卖出"} ${s.quantity} @ ${s.price}，约 ${s.amount}（${s.layer === "tier" ? "分档" : "网格"}：${s.reason}）`);
    }
    lines.push(`执行后预计持仓 ${ev.positionAfter}`);
  } else {
    lines.push("规则引擎给出的操作：不操作");
  }
  const next = [
    ev.nextTiers.down && `加仓档 ${ev.nextTiers.down.price}`,
    ev.nextTiers.up && `止盈档 ${ev.nextTiers.up.price}`,
    ev.grid?.nextBuy !== undefined && `网格买 ${ev.grid.nextBuy}`,
    ev.grid?.nextSell !== undefined && `网格卖 ${ev.grid.nextSell}`,
  ].filter(Boolean);
  if (next.length) lines.push(`下一触发价：${next.join("、")}`);
  for (const n of ev.notes) lines.push(`${n.level === "warn" ? "注意" : "说明"}：${n.text}`);
  return lines.join("\n");
}

export async function analyzeSystemPrompt(): Promise<string> {
  return `你是一位严格遵循既定规则的网格交易助手。下面是《网格交易规则》：

<grid_rules>
${await loadRulesText()}
</grid_rules>

用户的持仓数据已经由规则引擎（确定性代码）计算过，结果会放在 <engine_result> 中。要求：
1. 买卖方向、数量、价格一律以 <engine_result> 为准，不要自行重新计算或改动数量。
2. 你的工作是：用通俗的语言解释为什么这样操作；对照规则的"适用条件"判断这个标的和当前行情是否适合做网格（如能从截图看出单边上涨/下跌趋势，要明确指出）；指出风险和需要用户确认的地方。
3. 如果没有 <engine_result>（关键信息缺失），简要列出需要补充的信息；如需举例，只用一两句明确标注"假设"的话说明与用户最相关的规则，不要展开完整推演，不得编造用户的真实数据。
4. 截图识别出的数据可能有误，提醒用户核对 <extracted> 中的数字。

输出使用简洁的 Markdown（中文），总长度尽量控制在 500 字以内，依次包含：
## 结论
## 为什么
## 适用性与风险
## 下一步

计算式用普通文本书写，不要使用 LaTeX 公式或 $ 符号。结尾固定附一句：以上内容基于预设规则机械推演，仅供学习参考，不构成投资建议。`;
}

export interface AnalysisContext {
  holding?: Holding;
  quote?: Quote;
  evaluation?: Evaluation;
  extraction?: Extraction;
  problems: string[];
  /** holding 来源：配置文件中的 watchlist，或从截图/文字中提取 */
  source: "config" | "extracted" | "none";
}

export function analyzePrompt(userText: string | undefined, ctx: AnalysisContext, imageCount: number): string {
  const parts: string[] = [];
  if (userText?.trim()) parts.push(`用户描述：\n${userText.trim()}`);
  if (imageCount) parts.push(`（用户上传了 ${imageCount} 张截图）`);
  if (ctx.extraction) parts.push(`<extracted>\n${JSON.stringify(ctx.extraction, null, 2)}\n</extracted>`);
  if (ctx.holding && ctx.evaluation) {
    parts.push(
      `<engine_result source="${ctx.source === "config" ? "用户配置文件中的持仓" : "从截图/文字提取的持仓"}">\n` +
        describeEvaluation(ctx.holding, ctx.quote, ctx.evaluation) +
        "\n</engine_result>",
    );
  }
  if (ctx.problems.length) parts.push(`无法完整计算的原因：${ctx.problems.join("；")}`);
  return parts.join("\n\n");
}

// ---------------- 邮件中的 AI 点评 ----------------

const COMMENT_SYSTEM = `你是网格交易助手。规则引擎已经根据预设规则给出了交易信号，请为每个标的写一段不超过 100 字的中文点评：
说明这次操作的含义、需要留意的风险（例如是否可能是单边行情、资金是否充足）。不要改动数量和价格，不要使用 Markdown 标题。
格式：每个标的一段，以"【名称】"开头。`;

export async function emailComment(client: AIClient, items: CheckItem[], signal?: AbortSignal): Promise<string> {
  const prompt = items
    .filter((i) => i.evaluation && i.quote)
    .map((i) => describeEvaluation({ ...i.holding, name: i.quote!.name }, i.quote, i.evaluation!))
    .join("\n\n");
  const text = await complete(client, { system: COMMENT_SYSTEM, prompt, effort: "low", signal });
  return text.trim();
}
