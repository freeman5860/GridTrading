import { SYSTEM_PROMPT } from "@/lib/rules";
import { PROVIDERS, isProviderId } from "@/lib/provider-meta";
import { describeError, run, type ImageInput } from "@/lib/providers";

export const maxDuration = 300;

const MAX_IMAGES = 6;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

interface AnalyzeBody {
  text?: string;
  images?: { mediaType: string; data: string }[];
  params?: Record<string, string>;
  ai?: { provider?: string; apiKey?: string; model?: string; baseURL?: string };
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
    return Response.json(
      { error: `最多上传 ${MAX_IMAGES} 张图片` },
      { status: 400 },
    );
  }
  if (
    images.some((img) => !ALLOWED_TYPES.includes(img.mediaType) || !img.data)
  ) {
    return Response.json(
      { error: "仅支持 JPG / PNG / WebP / GIF 图片" },
      { status: 400 },
    );
  }

  // AI 配置完全由用户在页面上填写，服务端不内置任何 Key
  const provider = isProviderId(body.ai?.provider)
    ? body.ai.provider
    : "anthropic";
  const apiKey = body.ai?.apiKey?.trim() ?? "";
  const model = body.ai?.model?.trim() || PROVIDERS[provider].defaultModel;
  const baseURL = body.ai?.baseURL?.trim() || undefined;
  if (baseURL && !/^https?:\/\//i.test(baseURL)) {
    return Response.json(
      { error: "API 地址需以 http:// 或 https:// 开头" },
      { status: 400 },
    );
  }
  if (!apiKey) {
    return Response.json(
      { error: "未配置 API Key：请点击右上角「AI 设置」填写。" },
      { status: 400 },
    );
  }

  let prompt = "";
  if (params.length) {
    prompt +=
      "用户填写的结构化信息：\n" +
      params
        .map(([k, v]) => `- ${PARAM_LABELS[k] ?? k}：${v.trim()}`)
        .join("\n") +
      "\n\n";
  }
  prompt += text
    ? `用户描述：\n${text}`
    : "请根据上面的信息/截图给出网格交易建议。";
  if (images.length)
    prompt += `\n\n（用户上传了 ${images.length} 张截图，请先识别其中的行情与持仓信息。）`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        send({ t: "meta", v: `${provider} · ${model}` });
        for await (const ev of run({
          provider,
          apiKey,
          model,
          baseURL,
          system: SYSTEM_PROMPT,
          prompt,
          images: images as ImageInput[],
          signal: req.signal,
        })) {
          send(ev);
        }
        send({ t: "done" });
      } catch (err) {
        if (!req.signal.aborted) {
          // 只记录错误信息，不记录请求体（其中可能含用户的 API Key）
          console.error(
            `[analyze] ${provider}/${model}:`,
            (err as Error)?.message,
          );
          send({ t: "error", v: describeError(err) });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
