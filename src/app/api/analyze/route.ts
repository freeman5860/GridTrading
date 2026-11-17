import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "@/lib/rules";

export const maxDuration = 300;

const client = new Anthropic();

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const MAX_IMAGES = 6;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof ALLOWED_TYPES)[number];

interface AnalyzeBody {
  text?: string;
  images?: { mediaType: string; data: string }[];
  params?: Record<string, string>;
}

const PARAM_LABELS: Record<string, string> = {
  symbol: "标的名称/代码",
  basePrice: "基准价 P0",
  currentPrice: "当前价",
  position: "当前持仓数量",
  cash: "可用资金",
  range: "预期震荡区间",
  triggered: "已触发过的档位",
};

export async function POST(req: Request) {
  let body: AnalyzeBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  const images = body.images ?? [];
  const params = Object.entries(body.params ?? {}).filter(([, v]) => v?.trim());

  if (!text && images.length === 0 && params.length === 0) {
    return Response.json({ error: "请输入文字或上传图片" }, { status: 400 });
  }
  if (images.length > MAX_IMAGES) {
    return Response.json({ error: `最多上传 ${MAX_IMAGES} 张图片` }, { status: 400 });
  }
  for (const img of images) {
    if (!ALLOWED_TYPES.includes(img.mediaType as ImageType) || !img.data) {
      return Response.json({ error: "仅支持 JPG / PNG / WebP / GIF 图片" }, { status: 400 });
    }
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType as ImageType, data: img.data },
  }));

  let prompt = "";
  if (params.length) {
    prompt +=
      "用户填写的结构化信息：\n" +
      params.map(([k, v]) => `- ${PARAM_LABELS[k] ?? k}：${v.trim()}`).join("\n") +
      "\n\n";
  }
  prompt += text ? `用户描述：\n${text}` : "请根据上面的信息/截图给出网格交易建议。";
  if (images.length) prompt += `\n\n（用户上传了 ${images.length} 张截图，请先识别其中的行情与持仓信息。）`;
  content.push({ type: "text", text: prompt });

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, obj: object) =>
    controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const msgStream = client.beta.messages.stream(
          {
            model: MODEL,
            max_tokens: 32000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "high" },
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content }],
          },
          { signal: req.signal },
        );

        for await (const event of msgStream) {
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") send(controller, { t: "text", v: event.delta.text });
            else if (event.delta.type === "thinking_delta")
              send(controller, { t: "thinking", v: event.delta.thinking });
          }
        }

        const final = await msgStream.finalMessage();
        if (final.stop_reason === "refusal") {
          send(controller, { t: "error", v: "模型拒绝了该请求，请调整描述后重试。" });
        } else if (final.stop_reason === "max_tokens") {
          send(controller, { t: "error", v: "回答过长被截断，可以缩小问题范围后重试。" });
        }
        send(controller, { t: "done" });
      } catch (err) {
        let msg = "AI 服务调用失败，请稍后再试。";
        if (err instanceof Anthropic.AuthenticationError) msg = "服务端未正确配置 ANTHROPIC_API_KEY。";
        else if (err instanceof Anthropic.RateLimitError) msg = "请求过于频繁，请稍后再试。";
        else if (err instanceof Anthropic.BadRequestError) msg = `请求无效：${err.message}`;
        else if (err instanceof Anthropic.APIError) msg = `AI 服务错误 (${err.status})`;
        if (!req.signal.aborted) {
          console.error(err);
          send(controller, { t: "error", v: msg });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
