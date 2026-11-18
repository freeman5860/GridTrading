# 用 GitHub Actions 定时监控

不需要自己的服务器：GitHub 按计划运行 `gridbot run --once`，有交易信号时发邮件。

## 设置步骤

1. **Fork 本仓库**到自己的账号。

2. **准备配置**：在本地运行 `gridbot init`，按自己的持仓修改 `gridbot.yaml`。密钥一律写成环境变量：

   ```yaml
   notify:
     email:
       host: smtp.qq.com
       user: you@qq.com
       pass: ${SMTP_PASS}
       to: you@qq.com
   ai:                      # 可选
     provider: claude
     apiKey: ${ANTHROPIC_API_KEY}
     emailComment: true
   watchlist:
     - { symbol: sh510300, basePrice: 4.0, position: 10000 }
   ```

   建议先在本地运行 `gridbot check` 和 `gridbot notify-test`，确认配置无误。

3. **添加 Secrets**：打开 fork 后的仓库，进入 Settings → Secrets and variables → Actions → Secrets：

   | 名称 | 内容 |
   |---|---|
   | `GRIDBOT_CONFIG` | 整份 `gridbot.yaml` 的内容（直接粘贴） |
   | `SMTP_PASS` | 邮箱的 SMTP 授权码 |
   | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | 用到哪个 AI 就填哪个（可选） |

4. **启用**：同一页面切到 Variables，添加 `GRIDBOT_ENABLED`，值为 `true`。

5. **打开 Actions**：进入仓库的 Actions 页面。fork 的仓库需要先点击确认启用 workflow。然后选择 gridbot → Run workflow 手动运行一次，查看日志是否正常。

## 为什么持仓放在 Secret 里

Fork 出来的仓库默认是公开的。把 `gridbot.yaml` 提交到仓库，等于公开自己的持仓和资金。Secret 的内容不会出现在代码和日志里。

## 运行时间

workflow 在工作日按 UTC 时间每 15 分钟触发一次，覆盖北京时间 09:00–16:59（A 股、港股）和 21:00–05:59（美股）。
`gridbot run --once` 会再按各市场真实的交易时段过滤，所以休市时段的触发会直接结束，不请求行情。

## 修改持仓

成交后需要更新持仓：编辑 Secret `GRIDBOT_CONFIG`，改掉对应的 `position`，或者修改 `basePrice` 开始新一轮。下次运行即生效。

## 注意事项

- **GitHub 的定时任务会延迟。** 高峰时可能晚几分钟到几十分钟，偶尔还会跳过。需要准时提醒的话，请在自己的电脑或服务器上运行 `gridbot run`。
- **状态保存在 Actions 缓存里。** 已触发档位、网格位置就存在这里，每次运行恢复上一次的状态。缓存 7 天没有被使用会被 GitHub 清除，例如春节这类超过 7 天的长假。清除后，本轮已经提醒过的档位可能会再提醒一次。也可以在 Actions → Caches 页面手动删除缓存来重置状态。
- **私有仓库会消耗额度。** 公开仓库的 Actions 免费。私有仓库每月有免费分钟数，按这个频率大约每月用掉 1500–2500 分钟，可能超出免费额度。
- **关闭**：把变量 `GRIDBOT_ENABLED` 改成其他值，或在 Actions 页面禁用 workflow。
