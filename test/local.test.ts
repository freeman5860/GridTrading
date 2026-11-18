import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complete, createAIClient, describeAIError, ThinkSplitter, type StreamEvent } from "../src/ai/providers.js";
import { parseConfig } from "../src/config.js";

const join = (evs: StreamEvent[]) => {
  const out = { thinking: "", text: "" };
  for (const e of evs) out[e.t] += e.v;
  return out;
};

describe("<think> 标签拆分", () => {
  it("拆出思考过程和正文", () => {
    const s = new ThinkSplitter();
    expect(join([...s.push("<think>先算涨跌幅</think>\n\n结论：买入"), ...s.flush()])).toEqual({
      thinking: "先算涨跌幅",
      text: "\n\n结论：买入",
    });
  });

  it("标签被拆在多个流式片段之间", () => {
    const s = new ThinkSplitter();
    const parts = ["<thi", "nk>想", "一想</th", "ink>答", "案 <", "b>不是标签</b>"];
    const evs = parts.flatMap((p) => s.push(p)).concat(s.flush());
    expect(join(evs)).toEqual({ thinking: "想一想", text: "答案 <b>不是标签</b>" });
  });

  it("没有标签时原样输出", () => {
    const s = new ThinkSplitter();
    expect(join([...s.push("a < b，"), ...s.push("c"), ...s.flush()])).toEqual({ thinking: "", text: "a < b，c" });
  });
});

describe("本地模型", () => {
  it("不需要 API Key，默认连接 Ollama 和 qwen3", () => {
    const c = createAIClient({ provider: "local" });
    expect(c.model).toBe("qwen3");
    expect(() => createAIClient({ provider: "openai" })).toThrow(/API Key/);
  });

  it("配置文件支持 provider: local", () => {
    const c = parseConfig(
      "ai: { provider: local, model: qwen2.5vl, baseURL: 'http://127.0.0.1:1234/v1' }\nwatchlist: [{ symbol: sh510300, basePrice: 4, position: 1 }]",
      "/tmp/x/gridbot.yaml",
    );
    expect(c.ai).toMatchObject({ provider: "local", model: "qwen2.5vl" });
  });

  it("连不上本地服务时给出提示", async () => {
    const c = createAIClient({ provider: "local", baseURL: "http://127.0.0.1:9/v1" });
    const err = await complete(c, { system: "s", prompt: "p" }).catch((e) => e);
    expect(describeAIError(err)).toContain("无法连接 AI 服务");
  });

  it("非视觉模型收到图片时给出中文提示", () => {
    const e = Object.assign(new Error("400 Multimodal data provided, but model does not support multimodal requests."), { status: 400 });
    expect(describeAIError(e)).toContain("不支持识别图片");
  });

  it("模型未下载时提示 ollama pull", () => {
    const e = Object.assign(new Error('404 model "qwen3" not found, try pulling it first'), { status: 404 });
    expect(describeAIError(e)).toContain("ollama pull");
  });

  describe("与 OpenAI 兼容服务的实际交互", () => {
    let server: Server;
    let baseURL: string;
    const requests: { auth?: string; body: Record<string, unknown> }[] = [];

    beforeAll(async () => {
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const chunks = ["<think>基准价 4，现价 3.4", "，跌 15%</th", "ink>", "买入 1000 份。"];
          for (const [i, c] of chunks.entries()) {
            const payload = { id: "x", object: "chat.completion.chunk", created: 0, model: "qwen3", choices: [{ index: 0, delta: { content: c }, finish_reason: i === chunks.length - 1 ? "stop" : null }] };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
          res.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("发送模型名、JSON 模式，并拆分流式输出中的思考过程", async () => {
      const c = createAIClient({ provider: "local", baseURL, model: "qwen3:8b" });
      const evs: StreamEvent[] = [];
      for await (const e of c.stream({ system: "规则", prompt: "分析", json: true })) evs.push(e);

      expect(join(evs)).toEqual({ thinking: "基准价 4，现价 3.4，跌 15%", text: "买入 1000 份。" });
      const req = requests.at(-1)!;
      expect(req.body).toMatchObject({ model: "qwen3:8b", stream: true, response_format: { type: "json_object" } });
      expect(req.body.messages).toEqual([
        { role: "system", content: "规则" },
        { role: "user", content: "分析" },
      ]);
    });
  });
});
