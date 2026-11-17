# gridbot · 网格交易监控助手

开源的网格交易监控工具，支持 **A 股 / 港股 / 美股**。按预设规则（分档仓位管理 + 区间小网格）检查持仓，给出买卖信号。

- 规则判断用确定性代码完成，免费、可测试、不依赖大模型。
- 行情默认来自腾讯公开接口，不需要注册或 Key。
- 规则说明：[docs/rules.md](docs/rules.md)

> 当前进度：第 1 步（规则引擎 + 行情 + `check` 命令）已完成。
> 后续：定时运行与邮件提醒 → 多模型 AI 截图分析 → 本地网页控制台与 GitHub Actions 模板。

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

状态（已触发档位、网格位置）保存在配置文件同目录的 `.gridbot/state.json`，已加入 `.gitignore`。

## 开发

```bash
npm test          # 运行测试
npm run typecheck
```

```
src/core/      规则引擎（纯函数）、类型、代码规范化
src/market/    行情来源（腾讯接口），可扩展其他来源
src/config.ts  配置加载与校验
src/state.ts   状态持久化
src/check.ts   一次完整检查：配置 → 行情 → 引擎 → 状态
src/cli/       命令行
web/           AI 截图分析网页（Next.js，后续整合进 gridbot serve）
```

## 免责声明

本项目输出的信号由预设规则机械计算，仅供学习参考，不构成投资建议。行情数据来自第三方公开接口，可能延迟或出错。市场有风险，投资需谨慎。
