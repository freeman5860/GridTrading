import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { normalizeSymbol, SymbolError } from "./core/symbol.js";
import type { GridStep, Holding } from "./core/types.js";

z.config(z.locales.zhCN());

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
      return { ...h, symbol: normalizeSymbol(h.symbol).symbol };
    } catch (e) {
      ctx.addIssue({ code: "custom", path: ["symbol"], message: (e as SymbolError).message });
      return z.NEVER;
    }
  });

const configSchema = z.object({
  market: z.object({ source: z.string().default("tencent") }).default({ source: "tencent" }),
  state: z.string().optional(),
  watchlist: z.array(holdingSchema).min(1, "watchlist 至少需要一个标的"),
  // 后续步骤使用，这里先放行
  ai: z.unknown().optional(),
  notify: z.unknown().optional(),
  schedule: z.unknown().optional(),
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
