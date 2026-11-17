"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from "@/lib/provider-meta";

export interface ProviderSettings {
  apiKey: string;
  model: string;
  baseURL: string;
}

export interface AISettings {
  provider: ProviderId;
  byProvider: Record<ProviderId, ProviderSettings>;
}

const STORAGE_KEY = "grid-trading.ai-settings.v1";

const empty = (): ProviderSettings => ({ apiKey: "", model: "", baseURL: "" });

export function defaultSettings(
  provider: ProviderId = "anthropic",
): AISettings {
  return {
    provider,
    byProvider: { anthropic: empty(), openai: empty(), gemini: empty() },
  };
}

export function loadSettings(): AISettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AISettings;
    const base = defaultSettings(
      parsed.provider in PROVIDERS ? parsed.provider : "anthropic",
    );
    for (const id of PROVIDER_IDS)
      base.byProvider[id] = { ...empty(), ...parsed.byProvider?.[id] };
    return base;
  } catch {
    return null;
  }
}

// ---- 本地配置的小型 store（配合 useSyncExternalStore，避免 SSR 水合不一致） ----
let cache: AISettings | undefined;
const listeners = new Set<() => void>();
const SERVER_SNAPSHOT = defaultSettings();

function setCache(s: AISettings) {
  cache = s;
  listeners.forEach((l) => l());
}

export function saveSettings(s: AISettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式等情况下无法保存，仅在本次会话内生效 */
  }
  setCache(s);
}

export function clearSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  setCache(defaultSettings());
}

export function useAISettings(): AISettings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (cache ??= loadSettings() ?? defaultSettings()),
    () => SERVER_SNAPSHOT,
  );
}

export function AISettingsDialog({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: AISettings;
  onClose: () => void;
  onSave: (s: AISettings) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const p = draft.provider;
  const meta = PROVIDERS[p];
  const cur = draft.byProvider[p];
  const update = (patch: Partial<ProviderSettings>) =>
    setDraft((d) => ({
      ...d,
      byProvider: { ...d.byProvider, [p]: { ...d.byProvider[p], ...patch } },
    }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI 设置"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl bg-panel border border-line p-5 sm:p-6 space-y-5 max-h-[90vh] overflow-auto"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">AI 设置</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-fg text-xl leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div>
          <div className="text-sm text-muted mb-2">选择 AI 服务</div>
          <div className="grid grid-cols-3 gap-2">
            {PROVIDER_IDS.map((id) => (
              <button
                key={id}
                onClick={() => setDraft((d) => ({ ...d, provider: id }))}
                className={`h-10 rounded-lg border text-sm font-medium transition ${
                  p === id
                    ? "border-accent bg-accent text-white"
                    : "border-line hover:bg-soft"
                }`}
              >
                {PROVIDERS[id].name}
              </button>
            ))}
          </div>
        </div>

        <label className="block text-sm">
          <div className="flex justify-between mb-1">
            <span className="text-muted">API Key</span>
            <a
              href={meta.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              获取 Key ↗
            </a>
          </div>
          <div className="flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={cur.apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder={meta.keyHint}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 min-w-0 rounded-md border border-line bg-bg px-3 py-2 font-mono outline-none focus:border-accent"
            />
            <button
              onClick={() => setShowKey((s) => !s)}
              className="px-3 rounded-md border border-line text-muted hover:bg-soft shrink-0"
            >
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
        </label>

        <label className="block text-sm">
          <span className="text-muted">模型</span>
          <input
            value={cur.model}
            onChange={(e) => update({ model: e.target.value })}
            placeholder={`默认 ${meta.defaultModel}（${meta.modelHint}）`}
            spellCheck={false}
            className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 font-mono outline-none focus:border-accent"
          />
        </label>

        <div>
          <button
            onClick={() => setShowAdvanced((s) => !s)}
            className="text-sm text-muted hover:text-fg"
          >
            {showAdvanced ? "▾" : "▸"} 高级：自定义 API 地址（代理 / 兼容服务）
          </button>
          {showAdvanced && (
            <input
              value={cur.baseURL}
              onChange={(e) => update({ baseURL: e.target.value })}
              placeholder={meta.baseURLHint}
              spellCheck={false}
              className="mt-2 w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            />
          )}
        </div>

        <p className="text-xs text-muted leading-relaxed rounded-lg bg-soft p-3">
          🔒 Key
          只保存在你当前浏览器的本地存储中，每次分析时随请求发送给本站服务端转发给
          AI
          服务商，服务端不会存储或记录。在公共电脑上使用后请点击「清除本地配置」。
        </p>

        <div className="flex gap-2 justify-between">
          <button
            onClick={() => {
              clearSettings();
              setDraft(defaultSettings(draft.provider));
            }}
            className="h-10 px-4 rounded-lg text-sm text-muted hover:bg-soft"
          >
            清除本地配置
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="h-10 px-4 rounded-lg border border-line text-sm hover:bg-soft"
            >
              取消
            </button>
            <button
              onClick={() => onSave(draft)}
              className="h-10 px-5 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
