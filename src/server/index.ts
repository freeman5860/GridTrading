// gridbot serve：本地网页控制台。
// 只依赖 Node 内置 http 模块；前端是 web/ 下的静态文件，无需构建。
//
// 安全：默认只监听 127.0.0.1；校验 Host（防 DNS 重绑定）和 Origin（防 CSRF）；接口从不返回密钥。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { analyzePrompt, analyzeSystemPrompt, loadRulesText, MAX_IMAGES } from "../ai/analyze.js";
import { createAIClient, errorMessage, PROVIDER_INFO, type ImageInput } from "../ai/providers.js";
import { prepareAnalysis } from "../ai/run.js";
import { prepareCheck } from "../check.js";
import { ConfigError, loadConfig, updateHoldingInFile, type Config, type HoldingPatch } from "../config.js";
import { MARKETS, normalizeSymbol } from "../core/symbol.js";
import { describeSessions, isMarketOpen, localTime, nextOpen } from "../market/hours.js";
import { ALL_MARKETS, describeNextOpen } from "../scheduler.js";
import { channelName } from "../notify/webhook.js";
import { loadState, saveState } from "../state.js";

export interface ServeOptions {
  configPath: string;
  host: string;
  port: number;
}

const WEB_DIR = new URL("../../web/", import.meta.url);
const STATIC: Record<string, { file: URL | string; type: string }> = {
  "/": { file: new URL("index.html", WEB_DIR), type: "text/html; charset=utf-8" },
  "/app.js": { file: new URL("app.js", WEB_DIR), type: "text/javascript; charset=utf-8" },
  "/lib.js": { file: new URL("lib.js", WEB_DIR), type: "text/javascript; charset=utf-8" },
  "/watch.js": { file: new URL("watch.js", WEB_DIR), type: "text/javascript; charset=utf-8" },
  "/ai.js": { file: new URL("ai.js", WEB_DIR), type: "text/javascript; charset=utf-8" },
  "/style.css": { file: new URL("style.css", WEB_DIR), type: "text/css; charset=utf-8" },
  "/vendor/marked.js": {
    file: createRequire(import.meta.url).resolve("marked"),
    type: "text/javascript; charset=utf-8",
  },
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

// 6 张图片 × 约 5MB × base64 膨胀 4/3，留出余量
const MAX_BODY = 45 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function allowedHosts(bindHost: string): Set<string> {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (bindHost !== "0.0.0.0" && bindHost !== "::") hosts.add(bindHost.includes(":") ? `[${bindHost}]` : bindHost);
  return hosts;
}

/** 取出 Host 头中的主机名部分（去掉端口） */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const m = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/);
  return m?.[1]?.toLowerCase();
}

export function startServer(opts: ServeOptions): Promise<Server> {
  const hosts = allowedHosts(opts.host);
  // 监听 0.0.0.0 时允许任何 Host（用户明确选择了局域网访问）
  const anyHost = opts.host === "0.0.0.0" || opts.host === "::";

  const server = createServer((req, res) => {
    handle(req, res, opts, hosts, anyHost).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof ConfigError ? 400 : 500;
      if (status === 500) console.error("[serve]", e);
      if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: ServeOptions, hosts: Set<string>, anyHost: boolean) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  const hostname = hostnameOf(req.headers.host);
  if (!anyHost && (!hostname || !hosts.has(hostname))) throw new HttpError(403, "不允许的 Host");

  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (method === "POST") {
    // 浏览器跨站请求会带 Origin，必须与本站一致
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, "不允许的来源");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      throw new HttpError(415, "只接受 application/json");
    }
  }

  if (method === "GET" && STATIC[url.pathname]) {
    const { file, type } = STATIC[url.pathname]!;
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-cache",
      ...(type.startsWith("text/html") ? { "Content-Security-Policy": CSP } : {}),
    });
    res.end(body);
    return;
  }

  const route = `${method} ${url.pathname}`;
  if (route === "GET /api/status") return sendJson(res, 200, await status(opts.configPath));
  if (route === "GET /api/rules") return sendJson(res, 200, { markdown: await loadRulesText() });
  if (route === "POST /api/analyze") return analyze(req, res, opts.configPath);

  const m = url.pathname.match(/^\/api\/holdings\/([^/]+)(\/execute|\/reset)?$/);
  if (m && method === "POST") {
    const symbol = normalizeSymbol(decodeURIComponent(m[1]!)).symbol;
    const body = await readJson(req, 64 * 1024);
    if (m[2] === "/execute") return sendJson(res, 200, await execute(opts.configPath, symbol, body));
    if (m[2] === "/reset") return sendJson(res, 200, await reset(opts.configPath, symbol));
    return sendJson(res, 200, await updateHolding(opts.configPath, symbol, body));
  }

  throw new HttpError(404, "未找到");
}

// ---------------- 接口实现 ----------------

/** 控制台首页数据：各市场状态 + 每个标的的行情与规则计算（试运行，不保存状态） */
async function status(configPath: string) {
  const config = await loadConfig(configPath);
  const now = new Date();
  const markets = ALL_MARKETS.map((m) => {
    const open = isMarketOpen(m, now);
    return {
      market: m,
      name: MARKETS[m].name,
      open,
      localTime: localTime(m, now).hhmm,
      sessions: describeSessions(m),
      nextOpen: open ? undefined : describeNextOpen([{ market: m, at: nextOpen(m, now) }]),
    };
  });

  let check: Awaited<ReturnType<typeof prepareCheck>>["result"] | undefined;
  let checkError: string | undefined;
  try {
    check = (await prepareCheck(config)).result;
  } catch (e) {
    checkError = `获取行情失败：${(e as Error).message}`;
  }
  const state = await loadState(config.statePath);

  return {
    now: now.toISOString(),
    configPath: config.path,
    markets,
    settings: publicSettings(config),
    check,
    checkError,
    state: state.symbols,
  };
}

/** 只返回不含密钥的配置摘要 */
export function publicSettings(config: Config) {
  const ai = config.ai;
  const email = config.notify?.email;
  return {
    interval: config.schedule.interval,
    ai: ai ? { provider: ai.provider, name: PROVIDER_INFO[ai.provider].name, model: ai.model || PROVIDER_INFO[ai.provider].defaultModel, emailComment: ai.emailComment } : null,
    email: email ? { host: email.host, to: email.to } : null,
    // 只返回渠道名称：机器人地址、Key 都是密钥
    channels: [
      ...(email ? [`邮件（${email.to.join("、")}）`] : []),
      ...(config.notify?.webhooks ?? []).map(channelName),
    ],
  };
}

function numberField(body: Record<string, unknown>, key: string, opts: { positive?: boolean } = {}): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (opts.positive && v === 0)) {
    throw new HttpError(400, `${key} 必须是${opts.positive ? "正数" : "非负数"}`);
  }
  return v;
}

async function updateHolding(configPath: string, symbol: string, body: Record<string, unknown>) {
  const patch: HoldingPatch = {
    position: numberField(body, "position"),
    basePrice: numberField(body, "basePrice", { positive: true }),
    // cash 传 null 表示删除该字段（不限制资金）
    cash: body.cash === null ? null : numberField(body, "cash"),
  };
  await updateHoldingInFile(configPath, symbol, patch);
  return { ok: true };
}

/**
 * "已按信号成交"：重新计算一次，保存该标的的状态（标记档位已触发、网格前进），并把持仓更新为成交后的数量。
 * 用户可以传入实际成交后的持仓（部分成交等情况）。
 */
async function execute(configPath: string, symbol: string, body: Record<string, unknown>) {
  const config = await loadConfig(configPath);
  if (!config.watchlist.some((h) => h.symbol === symbol)) throw new HttpError(404, `配置中没有 ${symbol}`);
  const { result } = await prepareCheck(config);
  const item = result.items.find((i) => i.holding.symbol === symbol);
  if (!item?.evaluation) throw new HttpError(409, item?.error ?? item?.skipped ?? "无法计算该标的");
  if (!item.evaluation.signals.length) throw new HttpError(409, "当前没有交易信号，无需确认成交");

  const position = numberField(body, "position") ?? item.evaluation.positionAfter;
  const state = await loadState(config.statePath);
  state.symbols[symbol] = { ...item.evaluation.nextState, updatedAt: new Date().toISOString() };
  await saveState(config.statePath, state);
  await updateHoldingInFile(configPath, symbol, { position });
  return { ok: true, position };
}

async function reset(configPath: string, symbol: string) {
  const config = await loadConfig(configPath);
  const state = await loadState(config.statePath);
  delete state.symbols[symbol];
  await saveState(config.statePath, state);
  return { ok: true };
}

/** AI 分析，以 NDJSON 流式返回：meta → extracted → engine → thinking / text → done | error */
async function analyze(req: IncomingMessage, res: ServerResponse, configPath: string) {
  const body = await readJson(req, MAX_BODY);
  const config = await loadConfig(configPath);
  if (!config.ai) throw new HttpError(400, "配置文件中没有 ai 段，无法使用 AI 分析");

  const text = typeof body.text === "string" ? body.text : undefined;
  const symbol = typeof body.symbol === "string" && body.symbol.trim() ? body.symbol.trim() : undefined;
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES) throw new HttpError(400, `最多 ${MAX_IMAGES} 张图片`);
  const images: ImageInput[] = rawImages.map((img) => {
    const { mediaType, data } = (img ?? {}) as { mediaType?: unknown; data?: unknown };
    if (typeof mediaType !== "string" || !ALLOWED_IMAGE_TYPES.includes(mediaType) || typeof data !== "string" || !data) {
      throw new HttpError(400, "仅支持 JPG / PNG / WebP / GIF 图片");
    }
    return { mediaType: mediaType as ImageInput["mediaType"], data };
  });

  const ac = new AbortController();
  res.on("close", () => ac.abort()); // 浏览器点"停止"或关闭页面时中止 AI 请求
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const send = (obj: object) => res.write(JSON.stringify(obj) + "\n");

  try {
    const client = createAIClient(config.ai);
    send({ t: "meta", v: `${PROVIDER_INFO[client.provider].name} · ${client.model}` });
    const ctx = await prepareAnalysis(config, client, { symbol, text, images, signal: ac.signal });
    if (ctx.extraction) send({ t: "extracted", v: ctx.extraction });
    send({ t: "engine", v: { holding: ctx.holding, quote: ctx.quote, evaluation: ctx.evaluation, problems: ctx.problems, source: ctx.source } });
    for await (const ev of client.stream({
      system: await analyzeSystemPrompt(),
      prompt: analyzePrompt(text, ctx, images.length),
      images,
      effort: "high",
      signal: ac.signal,
    })) {
      send(ev);
    }
    send({ t: "done" });
  } catch (e) {
    if (!ac.signal.aborted) {
      send({ t: "error", v: errorMessage(e) });
    }
  } finally {
    res.end();
  }
}

// ---------------- 工具 ----------------

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "请求内容过大");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "请求格式错误（需要 JSON 对象）");
  }
}
