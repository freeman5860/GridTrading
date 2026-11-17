// 前后端共用的 AI 服务商元信息（不含任何密钥）

export type ProviderId = "anthropic" | "openai" | "gemini";

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  defaultModel: string;
  modelHint: string;
  keyHint: string;
  keyUrl: string;
  baseURLHint: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    name: "Claude",
    defaultModel: "claude-opus-5-5",
    modelHint: "如 claude-opus-5-5、claude-sonnet-5-5",
    keyHint: "sk-ant-...",
    keyUrl: "https://platform.claude.com/settings/keys",
    baseURLHint: "默认 https://api.anthropic.com",
  },
  openai: {
    id: "openai",
    name: "ChatGPT",
    defaultModel: "gpt-5.5",
    modelHint: "如 gpt-5.5；用兼容服务时填对应模型名",
    keyHint: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
    baseURLHint: "默认 https://api.openai.com/v1，可填任意 OpenAI 兼容地址",
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    defaultModel: "gemini-3.8-flash",
    modelHint: "如 gemini-3.8-flash",
    keyHint: "AIza...",
    keyUrl: "https://aistudio.google.com/apikey",
    baseURLHint: "默认 https://generativelanguage.googleapis.com",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && v in PROVIDERS;
}
