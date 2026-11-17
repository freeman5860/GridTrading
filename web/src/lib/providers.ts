import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { ProviderId } from "@/lib/provider-meta";

export type ImageInput = {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: string;
};

export type StreamEvent = { t: "thinking" | "text" | "error"; v: string };

export interface RunOptions {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseURL?: string;
  system: string;
  prompt: string;
  images: ImageInput[];
  signal: AbortSignal;
}

// 官方默认地址。显式传入，避免 SDK 读取服务器上的 *_BASE_URL 环境变量，把用户的 Key 发到别处
const DEFAULT_BASE_URL = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com",
} as const;

export function run(opts: RunOptions): AsyncGenerator<StreamEvent> {
  switch (opts.provider) {
    case "anthropic":
      return runAnthropic(opts);
    case "openai":
      return runOpenAI(opts);
    case "gemini":
      return runGemini(opts);
  }
}

/** 把各家 SDK 的异常统一转成中文提示 */
function innerMessage(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err);
  // Gemini 的错误信息是多层嵌套的 JSON 字符串，取最内层的 message
  const all = [
    ...raw.replace(/\\+"/g, '"').matchAll(/"message"\s*:\s*"([^"]+)"/g),
  ].map((m) => m[1]);
  return (all.at(-1) ?? raw).replace(/\\n/g, " ").trim().slice(0, 300);
}

export function describeError(err: unknown): string {
  const status =
    (err as { status?: number; code?: number })?.status ??
    (err as { code?: number })?.code;
  const msg = innerMessage(err);
  if (
    /API[_ ]KEY[_ ]INVALID|api key not valid|invalid api key|incorrect api key/i.test(
      (err as Error)?.message ?? "",
    )
  )
    return "API Key 无效，请检查设置中的 API Key。";
  if (status === 401 || status === 403)
    return "API Key 无效或没有权限，请检查设置中的 API Key。";
  if (status === 404) return "模型不存在或当前 Key 无权使用，请检查模型名称。";
  if (status === 429) return "请求过于频繁或额度不足，请稍后再试。";
  if (status === 400) return `请求无效：${msg}`;
  if (status === 503) return "AI 服务当前繁忙（503），请稍后重试或切换模型。";
  if (typeof status === "number" && status >= 500)
    return `AI 服务暂时不可用 (${status})，请稍后再试。`;
  return `AI 服务调用失败：${msg}`;
}

// ---------- Claude ----------

// 支持服务端拒答回退（fallbacks: "default"）+ 自适应思考 + effort 的模型
const CLAUDE_MODERN = [
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
];

async function* runAnthropic(o: RunOptions): AsyncGenerator<StreamEvent> {
  // 显式传 authToken: null，避免 SDK 读取服务器上的 ANTHROPIC_AUTH_TOKEN 等环境变量
  const client = new Anthropic({
    apiKey: o.apiKey,
    authToken: null,
    baseURL: o.baseURL ?? DEFAULT_BASE_URL.anthropic,
  });
  // 兼容代理网关的模型名写法，如 "vendor/claude-opus-5.5"
  const normalized = o.model.toLowerCase().replace(/\./g, "-");
  const modern = CLAUDE_MODERN.some((m) => normalized.endsWith(m));

  const content: Anthropic.Beta.BetaContentBlockParam[] = o.images.map(
    (img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    }),
  );
  content.push({ type: "text", text: o.prompt });

  const stream = client.beta.messages.stream(
    {
      model: o.model,
      max_tokens: 32000,
      ...(modern
        ? {
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default" as const,
            thinking: {
              type: "adaptive" as const,
              display: "summarized" as const,
            },
            output_config: { effort: "high" as const },
          }
        : {}),
      system: [
        { type: "text", text: o.system, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content }],
    },
    { signal: o.signal },
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
    yield { t: "error", v: "模型拒绝了该请求，请调整描述后重试。" };
  else if (final.stop_reason === "max_tokens")
    yield { t: "error", v: "回答过长被截断，可以缩小问题范围后重试。" };
}

// ---------- ChatGPT（也兼容任何 OpenAI 协议的服务，如 DeepSeek、通义、Kimi 等） ----------

async function* runOpenAI(o: RunOptions): AsyncGenerator<StreamEvent> {
  const client = new OpenAI({
    apiKey: o.apiKey,
    baseURL: o.baseURL ?? DEFAULT_BASE_URL.openai,
    organization: null,
    project: null,
  });

  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
    ...o.images.map((img): OpenAI.Chat.ChatCompletionContentPart => ({
      type: "image_url",
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    })),
    { type: "text", text: o.prompt },
  ];

  const stream = await client.chat.completions.create(
    {
      model: o.model,
      stream: true,
      messages: [
        { role: "system", content: o.system },
        // 纯文字时用字符串，兼容不支持多模态数组的 OpenAI 协议服务
        { role: "user", content: o.images.length ? userContent : o.prompt },
      ],
    },
    { signal: o.signal },
  );

  let finish: string | null = null;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    // 部分兼容服务（如 DeepSeek）会返回 reasoning_content 作为思考过程
    const reasoning = (choice.delta as { reasoning_content?: string })
      .reasoning_content;
    if (reasoning) yield { t: "thinking", v: reasoning };
    if (choice.delta?.content) yield { t: "text", v: choice.delta.content };
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (finish === "length")
    yield { t: "error", v: "回答过长被截断，可以缩小问题范围后重试。" };
  else if (finish === "content_filter")
    yield { t: "error", v: "模型拒绝了该请求，请调整描述后重试。" };
}

// ---------- Gemini ----------

async function* runGemini(o: RunOptions): AsyncGenerator<StreamEvent> {
  const ai = new GoogleGenAI({
    apiKey: o.apiKey,
    vertexai: false,
    httpOptions: { baseUrl: o.baseURL ?? DEFAULT_BASE_URL.gemini },
  });

  const stream = await ai.models.generateContentStream({
    model: o.model,
    contents: [
      {
        role: "user",
        parts: [
          ...o.images.map((img) => ({
            inlineData: { mimeType: img.mediaType, data: img.data },
          })),
          { text: o.prompt },
        ],
      },
    ],
    config: { systemInstruction: o.system, abortSignal: o.signal },
  });

  let finish: string | undefined;
  for await (const chunk of stream) {
    const cand = chunk.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (!part.text) continue;
      yield { t: part.thought ? "thinking" : "text", v: part.text };
    }
    if (cand?.finishReason) finish = cand.finishReason;
    if (chunk.promptFeedback?.blockReason) finish = "SAFETY";
  }
  if (finish === "MAX_TOKENS")
    yield { t: "error", v: "回答过长被截断，可以缩小问题范围后重试。" };
  else if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT")
    yield { t: "error", v: "模型拒绝了该请求，请调整描述后重试。" };
}
