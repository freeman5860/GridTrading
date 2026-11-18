// 多模型适配：Claude / ChatGPT（含任意 OpenAI 兼容服务）/ Gemini 统一成同一种流式接口。
// 所有连接参数都显式传入，不让 SDK 自行读取环境变量，行为只由配置文件决定。

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { setTimeout as sleep } from "node:timers/promises";

export type ProviderId = "claude" | "openai" | "gemini";

export interface AIConfig {
  provider: ProviderId;
  apiKey?: string;
  /** 仅 Claude：Bearer Token 认证（代理网关常用），可代替 apiKey */
  authToken?: string;
  model?: string;
  baseURL?: string;
}

export interface ImageInput {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** base64 */
  data: string;
}

export interface ChatRequest {
  system: string;
  prompt: string;
  images?: ImageInput[];
  /** 思考深度：提取信息用 low，分析用 high（仅支持的模型生效） */
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export type StreamEvent = { t: "thinking" | "text"; v: string };

export interface AIClient {
  provider: ProviderId;
  model: string;
  stream(req: ChatRequest): AsyncGenerator<StreamEvent>;
}

export class AIError extends Error {}

export const PROVIDER_INFO: Record<
  ProviderId,
  { name: string; defaultModel: string; baseURL: string }
> = {
  claude: {
    name: "Claude",
    defaultModel: "claude-opus-5-5",
    baseURL: "https://api.anthropic.com",
  },
  openai: {
    name: "ChatGPT",
    defaultModel: "gpt-5.5",
    baseURL: "https://api.openai.com/v1",
  },
  gemini: {
    name: "Gemini",
    defaultModel: "gemini-3.8-flash",
    baseURL: "https://generativelanguage.googleapis.com",
  },
};

export function createAIClient(cfg: AIConfig): AIClient {
  const info = PROVIDER_INFO[cfg.provider];
  const model = cfg.model || info.defaultModel;
  const baseURL = cfg.baseURL || info.baseURL;
  if (!cfg.apiKey && !(cfg.provider === "claude" && cfg.authToken)) {
    throw new AIError(`未配置 ${info.name} 的 API Key（配置文件 ai.apiKey）`);
  }
  const stream =
    cfg.provider === "claude"
      ? claudeStream(cfg, model, baseURL)
      : cfg.provider === "openai"
        ? openaiStream(cfg, model, baseURL)
        : geminiStream(cfg, model, baseURL);
  return { provider: cfg.provider, model, stream };
}

/** 收集完整文本（不需要逐字输出时使用） */
export async function complete(
  client: AIClient,
  req: ChatRequest,
): Promise<string> {
  let text = "";
  for await (const ev of client.stream(req)) if (ev.t === "text") text += ev.v;
  return text;
}

/** 是否为 AI 服务相关的错误（API 错误、网络、超时）；其他错误（如代码格式不对）直接显示原信息 */
export function isAIServiceError(e: unknown): boolean {
  const err = e as { status?: unknown; name?: string; message?: string };
  return (
    e instanceof AIError ||
    err?.status !== undefined ||
    err?.name === "AbortError" ||
    err?.name === "TimeoutError" ||
    /connection|timeout|fetch failed/i.test(err?.message ?? "")
  );
}

/** 用户可读的错误信息 */
export function errorMessage(e: unknown): string {
  return isAIServiceError(e) ? describeAIError(e) : ((e as Error)?.message ?? String(e));
}

/** 把各家 SDK 的异常统一成中文提示 */
export function describeAIError(err: unknown): string {
  if (err instanceof AIError) return err.message;
  const raw = (err as Error)?.message ?? String(err);
  const status =
    (err as { status?: number })?.status ?? (err as { code?: number })?.code;
  // Gemini 的错误信息是多层嵌套的 JSON 字符串，取最内层的 message
  const inner = [
    ...raw.replace(/\\+"/g, '"').matchAll(/"message"\s*:\s*"([^"]+)"/g),
  ]
    .map((m) => m[1])
    .at(-1);
  const msg = (inner ?? raw).replace(/\\n/g, " ").trim().slice(0, 300);
  const name = (err as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError" || /operation was aborted|timed? ?out/i.test(raw))
    return "AI 服务长时间没有响应，已超时（服务可能繁忙），请稍后重试或换一个模型";
  if (
    /API[_ ]KEY[_ ]INVALID|api key not valid|invalid api key|incorrect api key|invalid x-api-key/i.test(
      raw,
    )
  )
    return "AI 服务的 API Key 无效，请检查配置 ai.apiKey";
  if (status === 401 || status === 403)
    return "AI 服务认证失败（401/403），请检查 API Key 是否正确、是否有权限";
  if (status === 404) return `模型不存在或当前 Key 无权使用：${msg}`;
  if (status === 429) return "AI 服务请求过于频繁或额度不足（429），请稍后再试";
  if (status === 503) return "AI 服务当前繁忙（503），请稍后重试或换一个模型";
  if (typeof status === "number" && status >= 500)
    return `AI 服务暂时不可用（${status}）`;
  if (status === 400) return `AI 请求无效：${msg}`;
  return `AI 调用失败：${msg}`;
}

// ---------------- Claude ----------------

// 支持服务端拒答回退（fallbacks: "default"）+ 自适应思考 + effort 的模型
const CLAUDE_MODERN = [
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
];

function claudeStream(cfg: AIConfig, model: string, baseURL: string) {
  const client = new Anthropic({
    apiKey: cfg.apiKey || null,
    authToken: cfg.authToken || null,
    baseURL,
  });
  // 兼容代理网关的模型名写法，如 "vendor/claude-opus-5.5"
  const normalized = model.toLowerCase().replace(/\./g, "-");
  const modern = CLAUDE_MODERN.some((m) => normalized.endsWith(m));

  return async function* (req: ChatRequest): AsyncGenerator<StreamEvent> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = (
      req.images ?? []
    ).map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    }));
    content.push({ type: "text", text: req.prompt });

    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 32000,
        ...(modern
          ? {
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default" as const,
              thinking: {
                type: "adaptive" as const,
                display: "summarized" as const,
              },
              output_config: { effort: req.effort ?? "high" },
            }
          : {}),
        system: [
          {
            type: "text",
            text: req.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content }],
      },
      { signal: req.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta")
          yield { t: "text", v: event.delta.text };
        else if (event.delta.type === "thinking_delta")
          yield { t: "thinking", v: event.delta.thinking };
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal")
      throw new AIError("模型拒绝了该请求，请调整描述后重试");
    if (final.stop_reason === "max_tokens")
      throw new AIError("回答过长被截断，请缩小问题范围后重试");
  };
}

// ---------------- ChatGPT / OpenAI 兼容服务 ----------------

function openaiStream(cfg: AIConfig, model: string, baseURL: string) {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL,
    organization: null,
    project: null,
  });

  return async function* (req: ChatRequest): AsyncGenerator<StreamEvent> {
    const images = req.images ?? [];
    const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
      ...images.map((img): OpenAI.Chat.ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url: `data:${img.mediaType};base64,${img.data}` },
      })),
      { type: "text", text: req.prompt },
    ];
    const stream = await client.chat.completions.create(
      {
        model,
        stream: true,
        messages: [
          { role: "system", content: req.system },
          // 纯文字时用字符串，兼容不支持多模态数组的 OpenAI 兼容服务
          { role: "user", content: images.length ? userContent : req.prompt },
        ],
      },
      { signal: req.signal },
    );
    let finish: string | null = null;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      // 部分兼容服务（如 DeepSeek）用 reasoning_content 返回思考过程
      const reasoning = (choice.delta as { reasoning_content?: string })
        .reasoning_content;
      if (reasoning) yield { t: "thinking", v: reasoning };
      if (choice.delta?.content) yield { t: "text", v: choice.delta.content };
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (finish === "length")
      throw new AIError("回答过长被截断，请缩小问题范围后重试");
    if (finish === "content_filter")
      throw new AIError("模型拒绝了该请求，请调整描述后重试");
  };
}

// ---------------- Gemini ----------------

const GEMINI_TIMEOUT_MS = 5 * 60_000;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export async function withRetry<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
  delays = [2_000, 5_000],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (
        attempt >= delays.length ||
        signal.aborted ||
        !status ||
        !RETRYABLE.has(status)
      )
        throw e;
      await sleep(delays[attempt]!, undefined, { signal });
    }
  }
}

function geminiStream(cfg: AIConfig, model: string, baseURL: string) {
  const ai = new GoogleGenAI({
    apiKey: cfg.apiKey,
    vertexai: false,
    httpOptions: { baseUrl: baseURL },
  });

  return async function* (req: ChatRequest): AsyncGenerator<StreamEvent> {
    // Gemini SDK 默认不重试，而它自带的 retryOptions 在流式请求上会长时间挂起（实测），
    // 所以在这里自行重试：只在开始输出之前、遇到 408 / 429 / 5xx 时重试 2 次。另加 5 分钟总超时。
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(GEMINI_TIMEOUT_MS)])
      : AbortSignal.timeout(GEMINI_TIMEOUT_MS);
    const stream = await withRetry(signal, () =>
      ai.models.generateContentStream({
        model,
        contents: [
          {
            role: "user",
            parts: [
              ...(req.images ?? []).map((img) => ({
                inlineData: { mimeType: img.mediaType, data: img.data },
              })),
              { text: req.prompt },
            ],
          },
        ],
        config: { systemInstruction: req.system, abortSignal: signal },
      }),
    );
    let finish: string | undefined;
    for await (const chunk of stream) {
      const cand = chunk.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (part.text)
          yield { t: part.thought ? "thinking" : "text", v: part.text };
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (chunk.promptFeedback?.blockReason) finish = "SAFETY";
    }
    if (finish === "MAX_TOKENS")
      throw new AIError("回答过长被截断，请缩小问题范围后重试");
    if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT")
      throw new AIError("模型拒绝了该请求，请调整描述后重试");
  };
}
