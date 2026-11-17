"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GRID_RULES } from "@/lib/rules";

type Img = { id: string; url: string; mediaType: string; data: string };

const FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: "symbol", label: "标的", placeholder: "如 沪深300ETF 510300" },
  { key: "basePrice", label: "基准价 P0", placeholder: "如 4.00" },
  { key: "currentPrice", label: "当前价", placeholder: "如 3.40" },
  { key: "position", label: "持仓数量", placeholder: "如 10000 份" },
  { key: "cash", label: "可用资金", placeholder: "如 20000 元" },
  { key: "range", label: "震荡区间", placeholder: "如 3.2 ~ 4.4" },
  { key: "triggered", label: "已触发档位", placeholder: "如 −15% 已加仓" },
];

const EXAMPLES = [
  "我持有沪深300ETF 10000份，成本4.00元，现价3.38元，账户还有2万元现金，该怎么操作？",
  "某只宽基ETF基准价2元，判断在1.6~2.4元之间震荡，我有5万元，帮我设计一套网格挂单计划。",
  "我买的一只股票从10元涨到了13.6元，持仓2000股，之前+25%时已经卖过10%了，现在要不要卖？",
];

const MAX_IMAGES = 6;

async function compressImage(file: File): Promise<Img> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return {
    id: crypto.randomUUID(),
    url,
    mediaType: "image/jpeg",
    data: url.split(",")[1],
  };
}

export default function Home() {
  const [tab, setTab] = useState<"ask" | "rules">("ask");
  const [text, setText] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [showParams, setShowParams] = useState(false);
  const [images, setImages] = useState<Img[]>([]);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    try {
      const imgs = await Promise.all(list.map(compressImage));
      setImages((prev) => [...prev, ...imgs].slice(0, MAX_IMAGES));
    } catch {
      setError("图片读取失败，请换一张试试");
    }
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.some((f) => f.type.startsWith("image/"))) {
        e.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  const canSubmit =
    !loading && (text.trim() || images.length || Object.values(params).some((v) => v.trim()));

  async function submit() {
    if (!canSubmit) return;
    setLoading(true);
    setAnswer("");
    setThinking("");
    setError("");
    const ac = new AbortController();
    abortRef.current = ac;
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          params,
          images: images.map(({ mediaType, data }) => ({ mediaType, data })),
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `请求失败 (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { t: string; v?: string };
          if (ev.t === "text") setAnswer((a) => a + ev.v);
          else if (ev.t === "thinking") setThinking((a) => a + ev.v);
          else if (ev.t === "error") setError(ev.v ?? "未知错误");
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="min-h-full bg-bg text-fg">
      <header className="border-b border-line bg-panel/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-4xl px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <GridIcon />
            <span>网格交易助手</span>
          </div>
          <nav className="flex gap-1 text-sm">
            {(["ask", "rules"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-md transition ${
                  tab === t ? "bg-accent text-white" : "text-muted hover:bg-soft"
                }`}
              >
                {t === "ask" ? "交易建议" : "交易规则"}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 space-y-6">
        {tab === "rules" ? (
          <article className="md rounded-xl border border-line bg-panel p-5 sm:p-8">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{GRID_RULES}</ReactMarkdown>
          </article>
        ) : (
          <>
            <section className="rounded-xl border border-line bg-panel p-4 sm:p-6 space-y-4">
              <div>
                <h1 className="text-lg font-semibold">描述你的持仓或行情</h1>
                <p className="text-sm text-muted mt-1">
                  可以输入文字、上传/粘贴截图（行情、持仓、K 线均可），AI 会按
                  <button onClick={() => setTab("rules")} className="text-accent underline mx-1">
                    网格交易规则
                  </button>
                  给出操作建议。
                </p>
              </div>

              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                }}
                rows={5}
                placeholder="例如：我持有某宽基 ETF 10000 份，成本 4.00 元，现价 3.38 元，还有 2 万现金……（⌘/Ctrl + Enter 提交）"
                className="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-accent"
              />

              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setText(ex)}
                    className="text-xs text-muted border border-line rounded-full px-3 py-1 hover:bg-soft text-left"
                  >
                    {ex.length > 26 ? ex.slice(0, 26) + "…" : ex}
                  </button>
                ))}
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  addFiles(e.dataTransfer.files);
                }}
                className={`rounded-lg border-2 border-dashed p-3 transition ${
                  dragging ? "border-accent bg-soft" : "border-line"
                }`}
              >
                <div className="flex flex-wrap gap-3 items-center">
                  {images.map((img) => (
                    <div key={img.id} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt="上传的截图"
                        className="h-20 w-20 object-cover rounded-md border border-line"
                      />
                      <button
                        onClick={() => setImages((p) => p.filter((i) => i.id !== img.id))}
                        className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-fg text-bg text-xs leading-5"
                        aria-label="删除图片"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {images.length < MAX_IMAGES && (
                    <button
                      onClick={() => fileRef.current?.click()}
                      className="h-20 px-4 rounded-md text-sm text-muted hover:bg-soft flex flex-col items-center justify-center gap-1"
                    >
                      <span className="text-2xl leading-none">＋</span>
                      <span>上传 / 拖拽 / 粘贴截图</span>
                    </button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>

              <div>
                <button
                  onClick={() => setShowParams((s) => !s)}
                  className="text-sm text-muted hover:text-fg"
                >
                  {showParams ? "▾" : "▸"} 补充结构化信息（可选，越完整建议越准确）
                </button>
                {showParams && (
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {FIELDS.map((f) => (
                      <label key={f.key} className="text-sm">
                        <span className="text-muted">{f.label}</span>
                        <input
                          value={params[f.key] ?? ""}
                          onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={submit}
                  disabled={!canSubmit}
                  className="flex-1 sm:flex-none sm:px-8 h-11 rounded-lg bg-accent text-white font-medium disabled:opacity-40 hover:opacity-90"
                >
                  {loading ? "分析中…" : "生成交易建议"}
                </button>
                {loading && (
                  <button
                    onClick={() => abortRef.current?.abort()}
                    className="h-11 px-5 rounded-lg border border-line hover:bg-soft"
                  >
                    停止
                  </button>
                )}
              </div>
            </section>

            <div ref={resultRef} className="scroll-mt-20">
              {(loading || answer || error || thinking) && (
                <section className="rounded-xl border border-line bg-panel p-4 sm:p-6 space-y-4">
                  {thinking && (
                    <details className="rounded-lg bg-soft px-3 py-2 text-sm" open={loading && !answer}>
                      <summary className="cursor-pointer text-muted select-none">
                        {loading && !answer ? "AI 正在思考…" : "查看思考过程"}
                      </summary>
                      <div className="mt-2 whitespace-pre-wrap text-muted leading-relaxed max-h-64 overflow-auto">
                        {thinking}
                      </div>
                    </details>
                  )}
                  {loading && !thinking && !answer && (
                    <div className="flex items-center gap-2 text-muted text-sm">
                      <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
                      正在识别信息并对照规则计算…
                    </div>
                  )}
                  {answer && (
                    <article className="md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
                    </article>
                  )}
                  {error && (
                    <div className="rounded-lg border border-down/40 bg-down/10 text-down px-3 py-2 text-sm">
                      {error}
                    </div>
                  )}
                </section>
              )}
            </div>
          </>
        )}

        <footer className="text-center text-xs text-muted pb-8">
          规则整理自网络公开分享，AI 输出仅供学习参考，不构成投资建议。市场有风险，投资需谨慎。
        </footer>
      </main>
    </div>
  );
}

function GridIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="5" className="fill-accent" />
      <path d="M5 9h14M5 13h14M5 17h14" stroke="white" strokeOpacity=".45" strokeWidth="1.2" />
      <path d="M5 15.5 9 10l3.5 4L19 7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
