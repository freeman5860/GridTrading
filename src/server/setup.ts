// 控制台"设置向导"：在网页上配置持仓、提醒渠道和 AI，写回配置文件。
//
// - 读取时返回原始配置（未替换 ${ENV}），密钥字段只返回"是否已设置 / 引用的环境变量名"，从不返回密钥本身。
// - 写入时保留文件中的注释和格式；密钥字段留空表示保持原值。
// - 写入前用完整的配置校验一遍，校验不通过则不写入。

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML, { YAMLMap, YAMLSeq, type Document } from "yaml";
import { ConfigError, EXAMPLE_CONFIG, parseConfig } from "../config.js";
import { normalizeSymbol } from "../core/symbol.js";
import { PROVIDER_INFO, type ProviderId } from "../ai/providers.js";
import { CHANNEL_NAMES } from "../notify/webhook.js";

/** 各类推送渠道中属于密钥的字段（机器人地址本身就包含 Key） */
export const SECRET_FIELDS: Record<string, string[]> = {
  wecom: ["url"],
  dingtalk: ["url", "secret"],
  feishu: ["url", "secret"],
  telegram: ["botToken"],
  bark: ["url"],
  serverchan: ["sendKey"],
  webhook: ["url"],
};

const PROVIDERS = Object.keys(PROVIDER_INFO) as ProviderId[];

const NEW_CONFIG = `# gridbot 配置文件（由控制台设置向导生成，也可以直接编辑）
# 密钥建议写成 \${ENV_VAR}，从环境变量读取；完整示例见 gridbot init。

schedule:
  interval: 15m            # 交易时段内的检查间隔
`;

export interface SecretView {
  set: boolean;
  /** 写成 ${NAME} 时的环境变量名 */
  env?: string;
  /** 该环境变量当前是否有值 */
  envSet?: boolean;
}

export function secretView(v: unknown, env: NodeJS.ProcessEnv = process.env): SecretView {
  if (typeof v !== "string" || !v.trim()) return { set: false };
  const m = v.trim().match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (m) return { set: true, env: m[1], envSet: Boolean(env[m[1]!]) };
  return { set: true };
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function readText(configPath: string): Promise<string | null> {
  try {
    return await readFile(configPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function parseDoc(text: string): Document {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new ConfigError(`配置文件 YAML 格式错误：${doc.errors[0]!.message}`);
  if (doc.contents === null) doc.contents = new YAMLMap() as never;
  if (!YAML.isMap(doc.contents)) throw new ConfigError("配置文件格式错误：顶层应为键值对");
  return doc;
}

/** 代码不加引号时 YAML 会解析成数字，取原始文本 */
function symbolText(node: unknown): string | undefined {
  if (!YAML.isMap(node)) return undefined;
  const s = node.get("symbol", true);
  return YAML.isScalar(s) ? (s.source ?? String(s.value)) : undefined;
}

function symbolKey(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    return normalizeSymbol(text).symbol;
  } catch {
    return text.trim().toLowerCase();
  }
}

// ---------------- 读取 ----------------

export async function readSetup(configPath: string, env: NodeJS.ProcessEnv = process.env) {
  const text = await readText(configPath);
  const providers = Object.fromEntries(PROVIDERS.map((p) => [p, PROVIDER_INFO[p]]));
  const base = { configPath: path.resolve(configPath), providers, channelNames: CHANNEL_NAMES };
  if (text === null) {
    return { ...base, exists: false, isExample: false, error: undefined, watchlist: [], notify: { email: null, webhooks: [], always: false }, ai: null, schedule: { interval: "15m" } };
  }

  const doc = parseDoc(text);
  const raw = (doc.toJS() ?? {}) as Raw;
  let error: string | undefined;
  try {
    parseConfig(text, configPath);
  } catch (e) {
    error = (e as Error).message;
  }

  const seq = doc.get("watchlist", true);
  const watchlist = (Array.isArray(raw.watchlist) ? raw.watchlist : []).filter(isObj).map((h, i) => {
    const grid = isObj(h.grid) ? h.grid : undefined;
    const fee = isObj(h.fee) ? h.fee : undefined;
    return {
      symbol: (YAML.isSeq(seq) ? symbolText(seq.items[i]) : undefined) ?? String(h.symbol ?? ""),
      name: h.name,
      basePrice: h.basePrice,
      position: h.position,
      cash: h.cash,
      connect: h.connect === true,
      tiers: h.tiers !== false,
      grid: grid ? { lower: grid.lower, upper: grid.upper, step: grid.step === undefined ? undefined : String(grid.step), size: grid.size, initialLots: grid.initialLots } : null,
      fee: fee ? { rate: fee.rate, min: fee.min } : null,
    };
  });

  const notify = isObj(raw.notify) ? raw.notify : {};
  const email = isObj(notify.email) ? notify.email : undefined;
  const webhooks = (Array.isArray(notify.webhooks) ? notify.webhooks : []).filter(isObj).map((w, index) => ({
    index,
    type: String(w.type ?? ""),
    name: str(w.name),
    chatId: w.chatId === undefined ? undefined : String(w.chatId),
    secrets: Object.fromEntries((SECRET_FIELDS[String(w.type)] ?? []).map((f) => [f, secretView(w[f], env)])),
  }));

  const ai = isObj(raw.ai) ? raw.ai : undefined;
  const schedule = isObj(raw.schedule) ? raw.schedule : {};

  return {
    ...base,
    exists: true,
    // 还是 gridbot init 生成的示例配置，没有改过
    isExample: text.trim() === EXAMPLE_CONFIG.trim(),
    error,
    watchlist,
    notify: {
      email: email
        ? {
            host: str(email.host),
            port: email.port,
            user: str(email.user),
            from: str(email.from),
            to: Array.isArray(email.to) ? email.to.join(", ") : str(email.to),
            pass: secretView(email.pass, env),
          }
        : null,
      webhooks,
      always: notify.always === true,
    },
    ai: ai
      ? {
          provider: String(ai.provider ?? ""),
          model: str(ai.model),
          baseURL: str(ai.baseURL),
          emailComment: ai.emailComment === true,
          review: ai.review ?? ai.reviewBuys ?? true,
          apiKey: secretView(ai.apiKey, env),
          authToken: secretView(ai.authToken, env),
        }
      : null,
    schedule: { interval: schedule.interval === undefined ? "15m" : String(schedule.interval) },
  };
}

// ---------------- 写入 ----------------

class InputError extends ConfigError {}

/** 修改文档并写回；文件不存在时从模板新建 */
async function mutate(configPath: string, fn: (doc: Document, raw: Raw) => void) {
  const text = (await readText(configPath)) ?? NEW_CONFIG;
  const doc = parseDoc(text);
  fn(doc, (doc.toJS() ?? {}) as Raw);
  const next = doc.toString();
  parseConfig(next, configPath); // 校验失败抛出 ConfigError，原文件不变
  const tmp = `${configPath}.${process.pid}.tmp`;
  await writeFile(tmp, next, "utf8");
  await rename(tmp, configPath);
}

/** 设置字段并尽量保留原节点（注释）；undefined / null 删除该字段；对象逐个字段合并 */
function setValue(doc: Document, map: YAMLMap, key: string, v: unknown) {
  const cur = map.get(key, true);
  if (v === undefined || v === null) {
    map.delete(key);
    return;
  }
  if (isObj(v)) {
    if (YAML.isMap(cur)) {
      const keys = new Set([...cur.items.map((p) => String(YAML.isScalar(p.key) ? p.key.value : p.key)), ...Object.keys(v)]);
      for (const k of keys) setValue(doc, cur, k, v[k]);
      return;
    }
    map.set(key, doc.createNode(v));
    return;
  }
  if (YAML.isScalar(cur) && !Array.isArray(v)) {
    cur.value = v;
    return;
  }
  map.set(key, doc.createNode(v));
}

function ensureMap(doc: Document, key: string): YAMLMap {
  const cur = doc.get(key, true);
  if (YAML.isMap(cur)) return cur;
  const map = new YAMLMap();
  doc.set(key, map);
  return map;
}

const optNum = (v: unknown, label: string): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new InputError(`${label}必须是数字`);
  return n;
};
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * 密钥字段：undefined 或空字符串表示保持原值，null 表示删除，其他字符串为新值（可以是 ${ENV}）。
 */
function resolveSecret(input: unknown, old: unknown): string | undefined {
  if (input === null) return undefined;
  if (typeof input === "string" && input.trim()) return input.trim();
  return typeof old === "string" && old ? old : undefined;
}

export async function saveWatchlist(configPath: string, body: Raw) {
  if (!Array.isArray(body.items) || !body.items.length) throw new InputError("请至少添加一个标的");
  const items = body.items.map((it: unknown, i: number) => {
    if (!isObj(it)) throw new InputError("持仓格式错误");
    const n = `第 ${i + 1} 个标的的`;
    const symbol = optStr(it.symbol);
    if (!symbol) throw new InputError(`${n}代码不能为空`);
    if (it.basePrice === undefined || it.basePrice === null || it.basePrice === "") throw new InputError(`${n}基准价不能为空`);
    const grid = isObj(it.grid) ? it.grid : undefined;
    const fee = isObj(it.fee) ? it.fee : undefined;
    const step = optStr(typeof grid?.step === "number" ? String(grid.step) : grid?.step);
    return {
      symbol,
      name: optStr(it.name),
      basePrice: optNum(it.basePrice, `${n}基准价`),
      position: optNum(it.position, `${n}持仓`) ?? 0,
      cash: optNum(it.cash, `${n}可用资金`),
      connect: it.connect === true ? true : undefined,
      // 分档默认开启，只在关闭时写入
      tiers: it.tiers === false ? false : undefined,
      grid: grid
        ? {
            lower: optNum(grid.lower, `${n}网格下限`),
            upper: optNum(grid.upper, `${n}网格上限`),
            step: step && /^\d+(\.\d+)?$/.test(step) ? Number(step) : step,
            size: optNum(grid.size, `${n}每格数量`),
            initialLots: optNum(grid.initialLots, `${n}已持网格仓`),
          }
        : undefined,
      fee: fee && (optNum(fee.rate, `${n}费率`) !== undefined || optNum(fee.min, `${n}最低收费`) !== undefined)
        ? { rate: optNum(fee.rate, `${n}费率`) ?? 0, min: optNum(fee.min, `${n}最低收费`) ?? 0 }
        : undefined,
    };
  });

  await mutate(configPath, (doc) => {
    const old = doc.get("watchlist", true);
    const pool = new Map<string, YAMLMap>();
    if (YAML.isSeq(old)) {
      for (const node of old.items) {
        const k = symbolKey(symbolText(node));
        if (k && YAML.isMap(node) && !pool.has(k)) pool.set(k, node);
      }
    }
    const seq = new YAMLSeq();
    for (const item of items) {
      const k = symbolKey(item.symbol)!;
      const node = pool.get(k);
      pool.delete(k);
      if (!node) {
        seq.items.push(doc.createNode(Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined))));
        continue;
      }
      const { symbol, ...rest } = item;
      // 代码写法不同但指向同一标的时，保留用户原来的写法
      if (symbolKey(symbolText(node)) !== symbolKey(symbol)) setValue(doc, node, "symbol", symbol);
      for (const [key, v] of Object.entries(rest)) setValue(doc, node, key, v);
      seq.items.push(node);
    }
    if (YAML.isSeq(old)) {
      seq.commentBefore = old.commentBefore;
      seq.comment = old.comment;
    }
    doc.set("watchlist", seq);
  });
}

export async function saveNotify(configPath: string, body: Raw) {
  await mutate(configPath, (doc, raw) => {
    const oldNotify = isObj(raw.notify) ? raw.notify : {};
    const oldEmail = isObj(oldNotify.email) ? oldNotify.email : {};
    const oldHooks = Array.isArray(oldNotify.webhooks) ? oldNotify.webhooks : [];

    let email: Raw | undefined;
    if (isObj(body.email)) {
      const e = body.email;
      const to = String(e.to ?? "")
        .split(/[,，;；\s]+/)
        .filter(Boolean);
      email = {
        host: optStr(e.host),
        port: optNum(e.port, "SMTP 端口"),
        user: optStr(e.user),
        pass: resolveSecret(e.pass, oldEmail.pass),
        from: optStr(e.from),
        to: to.length > 1 ? to : to[0],
      };
    }

    const webhooks = (Array.isArray(body.webhooks) ? body.webhooks : []).map((w: unknown) => {
      if (!isObj(w) || typeof w.type !== "string" || !SECRET_FIELDS[w.type]) throw new InputError("不支持的推送渠道");
      const prev = typeof w.index === "number" && isObj(oldHooks[w.index]) && oldHooks[w.index].type === w.type ? (oldHooks[w.index] as Raw) : undefined;
      const out: Raw = { ...prev, type: w.type, name: optStr(w.name) };
      for (const f of SECRET_FIELDS[w.type]!) out[f] = resolveSecret((w as Raw)[f], prev?.[f]);
      if (w.type === "telegram") out.chatId = optStr(typeof w.chatId === "number" ? String(w.chatId) : w.chatId);
      return { prev: typeof w.index === "number" && prev ? w.index : undefined, out };
    });

    const interval = optStr(body.interval);
    if (interval) setValue(doc, ensureMap(doc, "schedule"), "interval", interval);

    if (!email && !webhooks.length && body.always !== true) {
      doc.delete("notify");
      return;
    }
    const notify = ensureMap(doc, "notify");
    setValue(doc, notify, "email", email);

    const oldSeq = notify.get("webhooks", true);
    const seq = new YAMLSeq();
    for (const { prev, out } of webhooks) {
      const node = prev !== undefined && YAML.isSeq(oldSeq) ? oldSeq.items[prev] : undefined;
      if (YAML.isMap(node)) {
        const keys = new Set([...Object.keys(out), ...node.items.map((p) => String(YAML.isScalar(p.key) ? p.key.value : p.key))]);
        for (const k of keys) setValue(doc, node, k, out[k]);
        seq.items.push(node);
      } else {
        seq.items.push(doc.createNode(Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))));
      }
    }
    if (seq.items.length) notify.set("webhooks", seq);
    else notify.delete("webhooks");
    setValue(doc, notify, "always", body.always === true ? true : undefined);
  });
}

export async function saveAI(configPath: string, body: Raw) {
  await mutate(configPath, (doc, raw) => {
    if (!isObj(body.ai)) {
      doc.delete("ai");
      return;
    }
    const a = body.ai;
    const provider = a.provider as ProviderId;
    if (!PROVIDERS.includes(provider)) throw new InputError("请选择 AI 服务");
    const old = isObj(raw.ai) ? raw.ai : {};
    // 换了服务商时，旧的 Key 不再适用
    const same = old.provider === provider;
    const ai = {
      provider,
      apiKey: resolveSecret(a.apiKey, same ? old.apiKey : undefined),
      authToken: provider === "claude" ? resolveSecret(a.authToken, same ? old.authToken : undefined) : undefined,
      model: optStr(a.model),
      baseURL: optStr(a.baseURL),
      emailComment: a.emailComment === true ? true : undefined,
      // 默认开启，只在关闭时写入（旧名称 reviewBuys 会被删除）
      review: a.review === false ? false : undefined,
      reviewBuys: undefined,
    };
    setValue(doc, doc.contents as YAMLMap, "ai", ai);
  });
}
