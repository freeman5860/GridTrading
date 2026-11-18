// 即时通讯推送：企业微信 / 钉钉 / 飞书群机器人、Telegram、Bark（iOS）、Server酱（微信），以及通用 Webhook。
// 注意：机器人地址和 Key 本身就是密钥，日志和错误信息中不能出现。

import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Notifier } from "./email.js";
import type { RenderedEmail } from "./render.js";

const url = z.url({ protocol: /^https?$/, message: "需要以 http:// 或 https:// 开头的地址" });

export const webhookSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wecom"), url, name: z.string().optional() }),
  z.object({ type: z.literal("dingtalk"), url, secret: z.string().optional(), name: z.string().optional() }),
  z.object({ type: z.literal("feishu"), url, secret: z.string().optional(), name: z.string().optional() }),
  z.object({
    type: z.literal("telegram"),
    botToken: z.string().min(1, "缺少 botToken"),
    chatId: z.union([z.string().min(1), z.number()]),
    apiBase: url.default("https://api.telegram.org"),
    name: z.string().optional(),
  }),
  z.object({ type: z.literal("bark"), url, name: z.string().optional() }),
  z.object({ type: z.literal("serverchan"), sendKey: z.string().min(1, "缺少 sendKey"), name: z.string().optional() }),
  z.object({ type: z.literal("webhook"), url, headers: z.record(z.string(), z.string()).optional(), name: z.string().optional() }),
]);

export type WebhookConfig = z.output<typeof webhookSchema>;

export const CHANNEL_NAMES: Record<WebhookConfig["type"], string> = {
  wecom: "企业微信",
  dingtalk: "钉钉",
  feishu: "飞书",
  telegram: "Telegram",
  bark: "Bark",
  serverchan: "Server酱",
  webhook: "Webhook",
};

export const channelName = (c: WebhookConfig) => c.name ?? CHANNEL_NAMES[c.type];

/** 按 UTF-8 字节数截断（企业微信等按字节限制长度） */
export function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const suffix = "\n…（内容过长已截断）";
  let cut = buf.subarray(0, maxBytes - Buffer.byteLength(suffix)).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1); // 去掉被截断的半个汉字
  return cut + suffix;
}

const truncateChars = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 12) + "\n…（已截断）");

/** 钉钉加签：HmacSHA256(secret, timestamp + "\n" + secret)，Base64 后 URL 编码 */
export function dingtalkSign(secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
}

/** 飞书加签：以 timestamp + "\n" + secret 为密钥，对空字符串做 HmacSHA256，再 Base64 */
export function feishuSign(secret: string, timestamp: number): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

interface Request {
  url: string;
  body: string;
  contentType: string;
  headers?: Record<string, string>;
  /** 检查返回内容，失败时返回错误描述 */
  check(json: unknown): string | undefined;
}

const codeIs =
  (field: string, ok: number, msgField = "errmsg") =>
  (json: unknown) => {
    const j = json as Record<string, unknown> | undefined;
    return j?.[field] === ok ? undefined : `${String(j?.[msgField] ?? j?.msg ?? "返回异常")}（${field}=${String(j?.[field])}）`;
  };

export function buildRequest(c: WebhookConfig, msg: RenderedEmail, now = Date.now()): Request {
  const text = `${msg.subject}\n\n${msg.text}`;
  const json = (body: unknown, check: Request["check"], target = "url" in c ? c.url : ""): Request => ({
    url: target,
    body: JSON.stringify(body),
    contentType: "application/json",
    check,
  });

  switch (c.type) {
    case "wecom":
      // 文本消息最长 2048 字节
      return json({ msgtype: "text", text: { content: truncateBytes(text, 2048) } }, codeIs("errcode", 0));
    case "dingtalk": {
      let target = c.url;
      if (c.secret) {
        const sep = target.includes("?") ? "&" : "?";
        target += `${sep}timestamp=${now}&sign=${encodeURIComponent(dingtalkSign(c.secret, now))}`;
      }
      return json({ msgtype: "text", text: { content: truncateChars(text, 18000) } }, codeIs("errcode", 0), target);
    }
    case "feishu": {
      const ts = Math.floor(now / 1000);
      return json(
        { ...(c.secret ? { timestamp: String(ts), sign: feishuSign(c.secret, ts) } : {}), msg_type: "text", content: { text: truncateChars(text, 18000) } },
        (j) => {
          const r = j as { code?: number; StatusCode?: number; msg?: string };
          return (r?.code ?? r?.StatusCode) === 0 ? undefined : `${r?.msg ?? "返回异常"}（code=${String(r?.code ?? r?.StatusCode)}）`;
        },
      );
    }
    case "telegram":
      return json(
        { chat_id: c.chatId, text: truncateChars(text, 4096), disable_web_page_preview: true },
        (j) => ((j as { ok?: boolean })?.ok ? undefined : String((j as { description?: string })?.description ?? "返回异常")),
        `${c.apiBase.replace(/\/$/, "")}/bot${c.botToken}/sendMessage`,
      );
    case "bark":
      return json(
        { title: msg.subject, body: truncateChars(msg.text, 3000), group: "gridbot" },
        (j) => ((j as { code?: number })?.code === 200 ? undefined : String((j as { message?: string })?.message ?? "返回异常")),
      );
    case "serverchan": {
      // Server酱³ 的 SendKey 以 sctp<数字>t 开头，使用单独的域名
      const m = c.sendKey.match(/^sctp(\d+)t/i);
      const target = m ? `https://${m[1]}.push.ft07.com/send/${c.sendKey}.send` : `https://sctapi.ftqq.com/${c.sendKey}.send`;
      return {
        url: target,
        body: new URLSearchParams({ title: msg.subject.slice(0, 32), desp: truncateChars(msg.text, 30000) }).toString(),
        contentType: "application/x-www-form-urlencoded",
        check: codeIs("code", 0, "message"),
      };
    }
    case "webhook":
      return {
        url: c.url,
        body: JSON.stringify({ title: msg.subject, text: msg.text, html: msg.html }),
        contentType: "application/json",
        headers: c.headers,
        check: () => undefined, // 通用 Webhook 只看 HTTP 状态码
      };
  }
}

export function createWebhookNotifier(c: WebhookConfig): Notifier {
  const name = channelName(c);
  return {
    async send(msg) {
      const req = buildRequest(c, msg);
      let res: Response;
      try {
        res = await fetch(req.url, {
          method: "POST",
          headers: { "Content-Type": req.contentType, ...req.headers },
          body: req.body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        // 不输出地址：地址中包含机器人 Key
        const reason = (e as Error).name === "TimeoutError" ? "请求超时" : "网络请求失败";
        throw new Error(`${name}推送失败：${reason}`);
      }
      const raw = await res.text();
      if (!res.ok) throw new Error(`${name}推送失败：HTTP ${res.status}`);
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }
      const err = req.check(parsed);
      if (err) throw new Error(`${name}推送失败：${err}`);
    },
  };
}
