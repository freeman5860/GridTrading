# gridbot · 网格交易监控助手

开源的网格交易监控工具，支持 **A 股 / 港股 / 美股**。按预设规则（分档仓位管理 + 区间小网格）检查持仓，给出买卖信号。

- 规则判断用确定性代码完成，免费、可测试、不依赖大模型。
- 行情默认来自腾讯公开接口，不需要注册或 Key。
- 规则说明：[docs/rules.md](docs/rules.md)

功能：

- **监控**：`gridbot run` 在各市场交易时段内定时检查，有信号时发邮件。
- **控制台**：`gridbot serve` 启动本地网页，查看持仓和信号，成交后一键更新持仓，上传截图让 AI 分析。
- **免服务器**：用 GitHub Actions 定时运行，见 [docs/github-actions.md](docs/github-actions.md)。
- **AI**：支持 Claude / ChatGPT（含 OpenAI 兼容服务）/ Gemini / 本地部署的模型（如 Ollama 上的 Qwen），负责识别截图和解读信号，不参与计算。

## 快速开始

需要 Node.js 22 或更高版本。

```bash
npm install
npm run build
npm link                    # 可选：把 gridbot 命令装到全局
gridbot init                # 生成 gridbot.yaml 示例配置
# 按你的持仓修改 gridbot.yaml
gridbot check               # 拉取行情并检查
```

不想全局安装时，用 `node dist/cli/index.js check`；开发时可以不编译，直接用 `npm run dev -- check`。

## 命令

| 命令 | 说明 |
|---|---|
| `gridbot init [-f]` | 生成示例配置文件 |
| `gridbot check` | 获取行情，按规则输出交易信号，并记录已触发的档位 |
| `gridbot check -n` | 试运行：只看结果，不保存状态 |
| `gridbot check --json` | JSON 输出，便于脚本处理 |
| `gridbot check --exit-code` | 有交易信号时退出码为 10，便于 cron / CI 判断 |
| `gridbot check --notify` | 有交易信号时发送邮件 |
| `gridbot run` | 常驻运行：交易时段内按间隔检查，有信号时发邮件 |
| `gridbot run --once` | 只检查当前开盘的市场一次，适合 cron / GitHub Actions |
| `gridbot analyze 截图.png -t "说明"` | AI 识别截图 / 文字中的持仓，规则引擎计算后由 AI 解读 |
| `gridbot analyze -s 510300` | AI 解读配置中某个标的的当前状态 |
| `gridbot notify-test` | 发送测试邮件，检查 SMTP 配置 |
| `gridbot markets` | 查看各市场是否开盘、交易时段和下次开盘时间 |
| `gridbot serve` | 启动本地网页控制台（默认 http://127.0.0.1:8686） |
| `gridbot quote 510300 700 AAPL` | 查询实时行情 |
| `gridbot reset <代码…>` / `--all` | 清除状态，开始新一轮 |

全局参数 `-c, --config <path>` 指定配置文件，也可以用环境变量 `GRIDBOT_CONFIG`。

## 配置

```yaml
watchlist:
  - symbol: sh510300       # A 股：也可写 510300 / 510300.SH
    basePrice: 4.00        # 基准价 P0
    position: 10000        # 当前持仓，交易后请更新
    cash: 20000            # 可用资金（标的币种），不填不限制
    fee: { rate: 0.0001, min: 5 }   # 可选，用于检查网格是否划算

  - symbol: hk02800        # 港股：每手股数自动读取
    basePrice: 24.5
    position: 2000

  - symbol: usQQQ          # 美股
    basePrice: 600
    position: 50
    tiers: true            # 第一层分档，默认开启
    grid:                  # 第二层网格，可选
      lower: 560
      upper: 680
      step: "2%"           # 或固定金额，如 5
      size: 5
```

配置中的字符串支持 `${ENV_VAR}`，方便把密钥放在环境变量里。

### 定时运行与邮件提醒

```yaml
schedule:
  interval: 15m            # 交易时段内的检查间隔，最少 1 分钟
  # markets: [cn, hk]      # 只监控部分市场，默认全部

notify:
  email:
    host: smtp.qq.com      # 163：smtp.163.com；Gmail：smtp.gmail.com
    port: 465              # 465 为 SSL，587 为 STARTTLS
    user: you@qq.com
    pass: ${SMTP_PASS}     # QQ / 163 填"授权码"（邮箱设置里开启 SMTP 后获取），Gmail 填应用专用密码
    to: you@qq.com         # 也可以是列表
```

```bash
export SMTP_PASS=你的授权码
gridbot notify-test        # 先确认能收到测试邮件
gridbot run                # 开始监控（Ctrl+C 退出）
```

说明：

- 只在各市场交易时段检查：A 股 09:30–11:30、13:00–15:00（北京时间），港股 09:30–12:00、13:00–16:00（香港时间），美股 09:30–16:00（纽约时间，自动处理夏令时）。
- 不内置节假日日历：交易时段内如果行情日期不是当地今天，会判定为休市并跳过。
- 每次检查前重新读取配置，成交后修改 `position` 不需要重启。
- 只在有交易信号时发邮件；每档每轮只提醒一次。邮件发送失败时不保存状态，下次检查会重新提醒，不会漏发。
- 想在后台长期运行，可以用 `nohup gridbot run > gridbot.log 2>&1 &`、pm2 或 systemd。

状态（已触发档位、网格位置）保存在配置文件同目录的 `.gridbot/state.json`，已加入 `.gitignore`。

### AI 分析（可选）

支持 Claude、ChatGPT（以及任意 OpenAI 兼容服务，如 DeepSeek、通义千问、Kimi）、Gemini：

```yaml
ai:
  provider: claude         # claude | openai | gemini | local
  apiKey: ${ANTHROPIC_API_KEY}
  # model: claude-opus-5-5 # 默认：claude-opus-5-5 / gpt-5.5 / gemini-3.8-flash
  # baseURL: https://api.deepseek.com   # 代理或 OpenAI 兼容服务
  emailComment: true       # 信号邮件附带 AI 点评
```

```bash
gridbot analyze 持仓截图.png
gridbot analyze 行情.png 持仓.png -t "成本 4 元，还有 2 万现金"
gridbot analyze -t "我持有沪深300ETF 10000 份，成本 4.8 元"
gridbot analyze -s hk00700 --thinking     # 显示思考过程
```

#### 本地模型（Qwen 等）

用 Ollama、LM Studio、vLLM、llama.cpp 等在本机或内网部署的模型，数据不出本地，也不产生 API 费用：

```bash
ollama pull qwen3:8b          # 文字分析
ollama pull qwen2.5vl:7b      # 需要识别截图时用视觉模型
```

```yaml
ai:
  provider: local
  model: qwen3:8b
  # baseURL: http://127.0.0.1:11434/v1   # 默认 Ollama；LM Studio 为 :1234/v1，vLLM 为 :8000/v1
  # apiKey: ...                          # 服务需要认证时才填
```

- 不需要 API Key；Qwen3、DeepSeek-R1 输出的 `<think>` 思考过程会单独显示。
- 识别截图需要视觉模型（如 `qwen2.5vl`、`gemma3`），纯文字模型收到图片会提示更换。
- 建议使用 7B/8B 及以上的模型。实测 1.7B 能跑通流程，但识别代码不稳定、解读质量一般；用户文字里写明的代码会优先于模型识别的结果。

分工：AI 负责**识别**截图和文字里的持仓数据，**规则引擎**负责计算买卖方向和数量，AI 再负责**解读**，包括为什么这样做、是否适合做网格、有哪些风险。AI 不会改动引擎算出的数量。

- 识别出的数据会先显示出来，请核对。
- 截图中没有代码时，会按名称匹配配置里的标的；匹配到多个时不猜测。
- 现价优先使用实时行情，获取失败时才用截图里识别的价格。
- 没开 `emailComment` 时，定时监控完全不调用 AI；开启后点评失败也不影响邮件发送。

### 本地网页控制台

```bash
gridbot serve                 # 打开 http://127.0.0.1:8686
gridbot serve --port 9000
```

- **监控**：各市场开盘状态，每个标的的现价、相对基准价、档位刻度、当前信号、下一触发价、网格位置，每分钟自动刷新。
- **已按信号成交**：记录已触发的档位（之后不再提醒），并把配置里的持仓更新为成交后的数量；部分成交时可以手动填写。
- **修改持仓 / 重置档位**：直接写回 `gridbot.yaml`，保留文件中的注释。
- **AI 分析**：上传、拖拽或粘贴截图，流式显示识别结果、引擎计算和 AI 解读。
- **规则**：查看完整的交易规则。

控制台默认只允许本机访问，并会拒绝来自其他网站的请求；接口不会返回 API Key、邮箱密码等密钥。
`--host 0.0.0.0` 可以让局域网内的手机访问，但控制台能修改配置、调用 AI（产生费用），请只在可信网络中使用。

### GitHub Actions（无需服务器）

Fork 本仓库，把配置放进 Secret `GRIDBOT_CONFIG`，设置变量 `GRIDBOT_ENABLED=true`，GitHub 就会在交易日定时检查并发邮件。详细步骤和注意事项见 [docs/github-actions.md](docs/github-actions.md)。

## 开发

```bash
npm test          # 运行测试
npm run typecheck
```

```
src/core/      规则引擎（纯函数）、类型、代码规范化
src/market/    行情来源（腾讯接口，可扩展）、交易时段
src/config.ts  配置加载与校验
src/state.ts   状态持久化
src/check.ts   一次完整检查：配置 → 行情 → 引擎 → 状态
src/scheduler.ts  定时运行：交易时段判断 → 检查 → 发邮件 → 保存状态
src/notify/    邮件渲染与发送（SMTP）
src/ai/        多模型适配、截图识别、分析与邮件点评
src/cli/       命令行
src/server/    本地控制台服务器（gridbot serve）
web/           控制台前端（纯 HTML / JS，无需构建）
.github/workflows/gridbot.yml   GitHub Actions 定时监控模板
```

## 免责声明

本项目输出的信号由预设规则机械计算，仅供学习参考，不构成投资建议。行情数据来自第三方公开接口，可能延迟或出错。市场有风险，投资需谨慎。
