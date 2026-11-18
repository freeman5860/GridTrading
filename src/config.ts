import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { normalizeSymbol, SymbolError } from "./core/symbol.js";
import type { GridStep, Holding, Market } from "./core/types.js";
import { emailConfigSchema } from "./notify/email.js";
import { webhookSchema } from "./notify/webhook.js";

z.config(z.locales.zhCN()); // 校验错误信息使用中文

export const DEFAULT_CONFIG = "gridbot.yaml";

const positive = z.number().positive();

const stepSchema = z.union([positive, z.string()]).transform((v, ctx): GridStep => {
  if (typeof v === "number") return { type: "abs", value: v };
  const s = v.trim();
  const pct = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return { type: "pct", value: Number(pct[1]) / 100 };
  if (/^\d+(\.\d+)?$/.test(s)) return { type: "abs", value: Number(s) };
  ctx.addIssue({ code: "custom", message: `网格间距格式错误："${v}"，应为金额（如 0.1）或百分比（如 "2%"）` });
  return z.NEVER;
});

const holdingSchema = z
  .object({
    symbol: z.string(),
    name: z.string().optional(),
    basePrice: positive,
    position: z.number().min(0),
    cash: z.number().min(0).optional(),
    /** 港股通：cash 和手续费为人民币 */
    connect: z.boolean().optional(),
    tiers: z.boolean().optional(),
    grid: z
      .object({
        lower: positive,
        upper: positive,
        step: stepSchema,
        size: z.number().int().positive(),
        initialLots: z.number().int().min(0).optional(),
      })
      .refine((g) => g.upper > g.lower, { message: "网格上限必须大于下限" })
      .optional(),
    fee: z.object({ rate: z.number().min(0), min: z.number().min(0) }).optional(),
  })
  .transform((h, ctx): Holding => {
    try {
      const { symbol, market } = normalizeSymbol(h.symbol);
      if (h.connect && market !== "hk") {
        ctx.addIssue({ code: "custom", path: ["connect"], message: `${h.symbol} 不是港股，不能设置 connect（港股通）` });
        return z.NEVER;
      }
      return { ...h, symbol };
    } catch (e) {
      ctx.addIssue({ code: "custom", path: ["symbol"], message: (e as SymbolError).message });
      return z.NEVER;
    }
  });

/** 解析时间间隔："30s" / "15m" / "1h"，纯数字按分钟；最少 1 分钟（避免频繁请求公开行情接口） */
export function parseInterval(v: string | number): number {
  if (typeof v === "number") return v * 60_000;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!m) throw new Error(`时间间隔格式错误："${v}"，示例：30s、15m、1h`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m").toLowerCase() as "s" | "m" | "h"];
  return Number(m[1]) * unit;
}

const intervalSchema = z.union([z.number().positive(), z.string()]).transform((v, ctx) => {
  try {
    const ms = parseInterval(v);
    if (ms < 60_000) ctx.addIssue({ code: "custom", message: "检查间隔不能小于 1 分钟" });
    return ms;
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

/** ${ENV} 替换后可能是空字符串，视为未填写 */
const optionalString = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional());

const configSchema = z.object({
  market: z.object({ source: z.string().default("tencent") }).default({ source: "tencent" }),
  state: z.string().optional(),
  watchlist: z.array(holdingSchema).min(1, "watchlist 至少需要一个标的"),
  notify: z
    .object({
      email: emailConfigSchema.optional(),
      /** 即时通讯推送：企业微信 / 钉钉 / 飞书 / Telegram / Bark / Server酱 / 通用 Webhook */
      webhooks: z.array(webhookSchema).default([]),
      /** 没有交易信号时也发邮件（默认只在有信号时发送） */
      always: z.boolean().default(false),
    })
    .optional(),
  schedule: z
    .object({
      /** 交易时段内的检查间隔 */
      interval: intervalSchema.default(15 * 60_000),
      /** 只监控这些市场，默认全部 */
      markets: z.array(z.enum(["cn", "hk", "us"] satisfies Market[])).optional(),
    })
    .default({ interval: 15 * 60_000 }),
  ai: z
    .object({
      provider: z.enum(["claude", "openai", "gemini", "local"]),
      apiKey: optionalString,
      /** 仅 Claude：代理网关的 Bearer Token，可代替 apiKey */
      authToken: optionalString,
      model: optionalString,
      /** 自定义 API 地址：代理，或 OpenAI 兼容服务（DeepSeek、通义千问、Kimi 等） */
      baseURL: optionalString,
      /** 信号邮件中附带 AI 点评 */
      emailComment: z.boolean().default(false),
    })
    .optional(),
});

export type Config = z.infer<typeof configSchema> & { path: string; statePath: string };

export class ConfigError extends Error {}

/** 递归替换字符串中的 ${ENV_VAR}，用于把密钥放在环境变量 / GitHub Secrets 里 */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => env[name] ?? "") as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)])) as T;
  }
  return value;
}

export function parseConfig(text: string, configPath: string): Config {
  let raw: unknown;
  try {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) throw doc.errors[0];
    // 代码不加引号时 YAML 会解析成数字（000001 → 1），这里改回原始文本
    YAML.visit(doc, {
      Pair(_, pair) {
        if (YAML.isScalar(pair.key) && pair.key.value === "symbol" && YAML.isScalar(pair.value)) {
          if (typeof pair.value.value === "number") pair.value.value = pair.value.source ?? String(pair.value.value);
        }
      },
    });
    raw = doc.toJS();
  } catch (e) {
    throw new ConfigError(`配置文件 YAML 格式错误：${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(interpolateEnv(raw));
  if (!parsed.success) {
    throw new ConfigError(`配置文件校验失败（${configPath}）：\n${z.prettifyError(parsed.error)}`);
  }
  const dir = path.dirname(path.resolve(configPath));
  const symbols = parsed.data.watchlist.map((h) => h.symbol);
  const dup = symbols.find((s, i) => symbols.indexOf(s) !== i);
  if (dup) throw new ConfigError(`watchlist 中 ${dup} 重复出现`);
  return {
    ...parsed.data,
    path: path.resolve(configPath),
    statePath: path.resolve(dir, parsed.data.state ?? ".gridbot/state.json"),
  };
}

export interface HoldingPatch {
  position?: number;
  basePrice?: number;
  /** null 表示删除该字段（不限制资金） */
  cash?: number | null;
}

/**
 * 修改配置文件中某个标的的字段，保留文件里的注释和格式。
 * 写入前会用新内容完整校验一遍，校验不通过则不写入。
 */
export async function updateHoldingInFile(configPath: string, symbol: string, patch: HoldingPatch): Promise<Config> {
  const text = await readFile(configPath, "utf8");
  const doc = YAML.parseDocument(text);
  const list = doc.get("watchlist");
  if (!YAML.isSeq(list)) throw new ConfigError("配置文件中没有 watchlist 列表");

  const index = list.items.findIndex((item) => {
    if (!YAML.isMap(item)) return false;
    const node = item.get("symbol", true);
    const raw = YAML.isScalar(node) ? (node.source ?? String(node.value)) : undefined;
    try {
      return raw !== undefined && normalizeSymbol(String(raw)).symbol === symbol;
    } catch {
      return false;
    }
  });
  if (index < 0) throw new ConfigError(`配置的 watchlist 中没有 ${symbol}`);

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) doc.deleteIn(["watchlist", index, key]);
    else doc.setIn(["watchlist", index, key], value);
  }
  const next = doc.toString();
  const config = parseConfig(next, configPath); // 校验失败会抛出 ConfigError，原文件不变

  const tmp = `${configPath}.${process.pid}.tmp`;
  await writeFile(tmp, next, "utf8");
  await rename(tmp, configPath);
  return config;
}

export async function loadConfig(configPath = process.env.GRIDBOT_CONFIG ?? DEFAULT_CONFIG): Promise<Config> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigError(`找不到配置文件 ${configPath}，可以先运行 gridbot init 生成`);
  }
  return parseConfig(text, configPath);
}

export const EXAMPLE_CONFIG = `# gridbot 配置文件
# 密钥类配置建议写成 \${ENV_VAR}，从环境变量读取（GitHub Actions 中对应 Secrets）。

market:
  source: tencent          # 行情来源：腾讯公开接口，支持 A 股 / 港股 / 美股

# 状态文件：记录每个标的已触发的档位和网格位置，默认与本文件同目录的 .gridbot/state.json
# state: .gridbot/state.json

# 定时运行（gridbot run）：只在各市场交易时段内检查
schedule:
  interval: 15m            # 检查间隔：30s / 15m / 1h，最少 1 分钟
  # markets: [cn, hk, us]  # 只监控部分市场

# 提醒：有交易信号时通过邮件和/或手机推送发送（gridbot run / gridbot check --notify）
# notify:
#   email:
#     host: smtp.qq.com    # QQ 邮箱；163 为 smtp.163.com，Gmail 为 smtp.gmail.com
#     port: 465            # 465 为 SSL；587 为 STARTTLS
#     user: you@qq.com
#     pass: \${SMTP_PASS}   # QQ/163 邮箱填"授权码"，不是登录密码；Gmail 填应用专用密码
#     to: you@qq.com       # 可以是列表：[a@x.com, b@y.com]
#   webhooks:              # 手机推送（可多个，与邮件同时发送）
#     - type: wecom        # 企业微信群机器人
#       url: \${WECOM_WEBHOOK}
#     # - { type: dingtalk, url: \${DINGTALK_WEBHOOK}, secret: \${DINGTALK_SECRET} }   # 钉钉（加签可选）
#     # - { type: feishu, url: \${FEISHU_WEBHOOK}, secret: \${FEISHU_SECRET} }         # 飞书（签名校验可选）
#     # - { type: telegram, botToken: \${TG_BOT_TOKEN}, chatId: "123456" }
#     # - { type: bark, url: \${BARK_URL} }            # iOS Bark，如 https://api.day.app/你的Key
#     # - { type: serverchan, sendKey: \${SCKEY} }     # Server酱，推送到微信
#     # - { type: webhook, url: https://example.com/hook }   # 通用：POST JSON {title, text, html}
#   always: false          # true 时没有信号也发送（不建议）

# AI 分析（gridbot analyze）与邮件点评，可选
# ai:
#   provider: claude       # claude | openai | gemini | local（本地模型，如 Ollama 部署的 Qwen）
#   apiKey: \${ANTHROPIC_API_KEY}   # openai 用 \${OPENAI_API_KEY}，gemini 用 \${GEMINI_API_KEY}
#   model: claude-opus-5-5 # 不填使用默认模型（openai: gpt-5.5，gemini: gemini-3.8-flash）
#   # baseURL: https://api.deepseek.com   # provider: openai 时可指向任意 OpenAI 兼容服务
#   # 本地模型示例（不需要 apiKey）：
#   # provider: local
#   # model: qwen3          # 识别截图需要视觉模型，如 qwen2.5vl
#   # baseURL: http://127.0.0.1:11434/v1   # 默认 Ollama；LM Studio 为 :1234/v1，vLLM 为 :8000/v1
#   emailComment: false    # true 时信号邮件附带 AI 点评

watchlist:
  # A 股场内 ETF：只用第一层分档仓位管理
  - symbol: sh510300       # 也可写 510300 / 510300.SH
    basePrice: 4.00        # 基准价 P0（首次买入均价或自定义）
    position: 10000        # 当前持仓（股/份），每次交易后请更新
    cash: 20000            # 该标的可用资金（人民币），不填视为不限制
    fee: { rate: 0.0001, min: 5 }   # 可选：佣金费率与每笔最低收费，用于检查网格是否划算

  # 港股：每手股数自动从行情读取（盈富基金一手 500 股）
  - symbol: hk02800        # 也可写 2800 / 02800.HK
    basePrice: 24.5
    position: 2000
    cash: 30000            # 港币
    # connect: true        # 通过港股通买入时打开：cash 和手续费改为人民币，按实时汇率折算；价格仍为港元

  # 美股：同时启用第二层区间小网格
  - symbol: usQQQ          # 也可写 QQQ
    basePrice: 600
    position: 50
    cash: 10000            # 美元
    grid:
      lower: 560           # 区间下限
      upper: 680           # 区间上限
      step: "2%"           # 间距：固定金额（如 5）或百分比（如 "2%"）
      size: 5              # 每格买卖数量
      initialLots: 0       # 启用时已持有的网格仓格数（不含底仓）
`;
