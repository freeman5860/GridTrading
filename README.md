# 网格交易助手

上传行情/持仓截图或输入文字，AI（Claude）严格按照预设的《网格交易规则》给出交易建议。

- 规则正文：`src/lib/rules.ts`（页面"交易规则"页和 AI system prompt 共用同一份，改这里即可）
- AI 接口：`src/app/api/analyze/route.ts`（流式返回 NDJSON：thinking / text / error / done）
- 页面：`src/app/page.tsx`（支持文字、点击/拖拽/粘贴上传图片、可选结构化字段）

## 运行

```bash
cp .env.example .env.local   # 填入 ANTHROPIC_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

默认模型 `claude-opus-5-5`（自适应思考 + effort high，开启服务端拒答回退），可用 `ANTHROPIC_MODEL` 覆盖。
图片在浏览器端压缩为 ≤1600px 的 JPEG，最多 6 张。

> 输出仅供学习参考，不构成投资建议。
