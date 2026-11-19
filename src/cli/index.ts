#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { prepareCheck } from "../check.js";
import { ConfigError, DEFAULT_CONFIG, EXAMPLE_CONFIG, loadConfig, parseInterval } from "../config.js";
import { MARKETS, normalizeSymbol } from "../core/symbol.js";
import { describeSessions, isMarketOpen, localTime, nextOpen as nextOpenSafe } from "../market/hours.js";
import { getQuoteSource } from "../market/source.js";
import { renderTestEmail } from "../notify/render.js";
import { describeChannels, type SendReport } from "../notify/index.js";
import { ALL_MARKETS, buildSignalEmail, describeNextOpen, notifierFor, runLoop, tick, type TickOutcome } from "../scheduler.js";
import { analyzePrompt, analyzeSystemPrompt, MAX_IMAGES, readImage } from "../ai/analyze.js";
import { createAIClient, errorMessage, PROVIDER_INFO } from "../ai/providers.js";
import { prepareAnalysis } from "../ai/run.js";
import { styleText } from "node:util";
import { loadState, saveState } from "../state.js";
import { formatCheck, formatItem, formatQuote } from "./format.js";
import { startServer } from "../server/index.js";
import { startMonitor } from "../server/monitor.js";

const program = new Command()
  .name("gridbot")
  .description("网格交易监控助手：A 股 / 港股 / 美股，分档仓位管理 + 区间小网格")
  .version("0.1.0")
  .option("-c, --config <path>", "配置文件路径", process.env.GRIDBOT_CONFIG ?? DEFAULT_CONFIG);

program
  .command("init")
  .description("在当前目录生成示例配置文件")
  .option("-f, --force", "覆盖已存在的配置文件")
  .action(async (opts: { force?: boolean }) => {
    const file = program.opts<{ config: string }>().config;
    const exists = await access(file).then(() => true, () => false);
    if (exists && !opts.force) fail(`${file} 已存在，如需覆盖请加 --force`);
    await writeFile(file, EXAMPLE_CONFIG, "utf8");
    console.log(`已生成 ${file}，按你的持仓修改后运行：gridbot check`);
  });

program
  .command("check")
  .description("获取最新行情，按规则检查每个标的并输出交易信号")
  .option("-n, --dry-run", "只输出结果，不保存已触发档位等状态")
  .option("--json", "以 JSON 输出（便于脚本处理）")
  .option("--exit-code", "有交易信号时以退出码 10 结束（便于 cron / CI 判断）")
  .option("--notify", "有交易信号时发送提醒（需要配置 notify.email 或 notify.webhooks）")
  .action(async (opts: { dryRun?: boolean; json?: boolean; exitCode?: boolean; notify?: boolean }) => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    const { result, commit } = await prepareCheck(config);
    console.log(opts.json ? JSON.stringify(result, null, 2) : formatCheck(result, Boolean(opts.dryRun)));
    if (opts.dryRun) return finish(result.signalCount, result.items.some((i) => i.error), opts.exitCode);

    if (opts.notify && (result.signalCount > 0 || config.notify?.always)) {
      const notifier = notifierFor(config);
      if (!notifier) fail("未配置提醒渠道（notify.email 或 notify.webhooks）");
      // 全部渠道失败时不保存状态，下次检查会重新提醒
      const report = await notifier.send(await buildSignalEmail(config, result));
      printReport(report);
    }
    await commit();
    finish(result.signalCount, result.items.some((i) => i.error), opts.exitCode);
  });

function finish(signals: number, hasError: boolean, exitCode?: boolean) {
  if (exitCode && signals > 0) process.exitCode = 10;
  else if (hasError) process.exitCode = 2;
}

program
  .command("run")
  .description("定时运行：交易时段内按间隔检查，有交易信号时发邮件（Ctrl+C 退出）")
  .option("-i, --interval <time>", "检查间隔，如 5m / 1h（默认读取配置 schedule.interval）")
  .option("--once", "只执行一次：仅检查当前开盘的市场，适合 cron / GitHub Actions 定时调用")
  .action(async (opts: { interval?: string; once?: boolean }) => {
    const configPath = program.opts<{ config: string }>().config;
    const config = await loadConfig(configPath);
    const interval = opts.interval ? parseInterval(opts.interval) : undefined;
    if (interval !== undefined && interval < 60_000) fail("检查间隔不能小于 1 分钟");
    const notifier = notifierFor(config);

    if (opts.once) {
      const outcome = await tick(config);
      if (outcome.status === "closed") {
        log(`当前没有开盘的市场，未检查。下次开盘：${describeNextOpen(outcome.nextOpen)}`);
        return;
      }
      printTick(outcome);
      if (outcome.status === "notify-failed") process.exitCode = 3;
      return;
    }

    const every = Math.round((interval ?? config.schedule.interval) / 60_000);
    log(`gridbot 开始运行：每 ${every} 分钟检查一次，${notifier ? `信号发送到 ${describeChannels(notifier.channels)}` : "未配置提醒渠道（只在终端输出）"}`);
    const ac = new AbortController();
    const stop = () => {
      log("收到退出信号，停止运行");
      ac.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runLoop({ configPath, signal: ac.signal, interval, log, onTick: printTick });
  });

function log(line: string) {
  const t = new Date().toLocaleString("zh-CN", { hour12: false });
  console.log(`[${t}] ${line}`);
}

function printTick(outcome: TickOutcome) {
  if (outcome.status === "closed") return;
  const { result } = outcome;
  const names = outcome.markets.map((m) => MARKETS[m].name).join("、");
  const checked = result.items.filter((i) => i.evaluation).length;
  const skipped = result.items.filter((i) => i.skipped).length;
  log(
    `检查 ${names}：${checked} 个标的` +
      (skipped ? `，${skipped} 个休市跳过` : "") +
      `，${result.signalCount ? `${result.signalCount} 个交易信号` : "无交易信号"}` +
      (outcome.status === "checked" && outcome.notified ? `，已发送到 ${outcome.report?.sent.join("、") ?? "提醒渠道"}` : ""),
  );
  if (outcome.status === "checked") for (const f of outcome.report?.failed ?? []) log(`⚠ ${f.error}`);
  for (const item of result.items) {
    if (item.error || (item.evaluation?.signals.length ?? 0) > 0) console.log(formatItem(item));
  }
  if (outcome.status === "notify-failed") log(`⚠ 所有提醒渠道都发送失败：${outcome.error}。状态未保存，下次检查会再次尝试发送`);
}

program
  .command("analyze")
  .description("AI 分析：识别截图 / 文字中的持仓，按规则计算后由 AI 解读")
  .argument("[images...]", `截图文件（最多 ${MAX_IMAGES} 张，JPG / PNG / WebP / GIF）`)
  .option("-t, --text <text>", "文字描述，如：我持有 510300 一万份，成本 4 元")
  .option("-s, --symbol <code>", "分析配置 watchlist 中的标的（使用配置里的持仓和已触发档位）")
  .option("--thinking", "显示模型的思考过程")
  .action(async (files: string[], opts: { text?: string; symbol?: string; thinking?: boolean }) => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    if (!config.ai) fail("未配置 ai，请在配置文件中添加 ai 段（provider、apiKey）");
    if (files.length > MAX_IMAGES) fail(`最多 ${MAX_IMAGES} 张图片`);
    const gray = (t: string) => (process.stdout.isTTY ? styleText("gray", t) : t);

    const ac = new AbortController();
    process.once("SIGINT", () => ac.abort());
    try {
      const client = createAIClient(config.ai);
      const images = await Promise.all(files.map(readImage));
      console.log(gray(`使用 ${PROVIDER_INFO[client.provider].name} · ${client.model}`));

      if (!opts.symbol || images.length || opts.text) console.log(gray("正在识别持仓信息并计算…"));
      const ctx = await prepareAnalysis(config, client, { symbol: opts.symbol, text: opts.text, images, signal: ac.signal });

      if (ctx.extraction) {
        const x = ctx.extraction;
        const shown = [
          x.name || x.symbol ? `标的 ${[x.name, x.symbol].filter(Boolean).join(" ")}` : undefined,
          x.price ? `现价 ${x.price}` : undefined,
          x.basePrice ? `基准/成本 ${x.basePrice}` : undefined,
          x.position ? `持仓 ${x.position}` : undefined,
          x.cash ? `资金 ${x.cash}` : undefined,
          x.grid?.lower && x.grid.upper ? `网格 ${x.grid.lower}～${x.grid.upper}` : undefined,
        ].filter(Boolean);
        console.log(gray(`识别结果（请核对）：${shown.join("，") || "未识别到持仓信息"}`));
      }
      if (ctx.evaluation) {
        const sigs = ctx.evaluation.signals;
        console.log(gray(`规则引擎：${sigs.length ? sigs.map((s) => `${s.action === "buy" ? "买入" : "卖出"} ${s.quantity} @ ${s.price}`).join("，") : "不操作"}`));
      }
      if (ctx.portfolio) {
        console.log(gray(`没有指定标的，分析配置中的全部 ${ctx.portfolio.length} 个持仓：`));
        for (const i of ctx.portfolio) {
          const sigs = i.evaluation?.signals ?? [];
          const what = i.evaluation
            ? sigs.length
              ? sigs.map((s) => `${s.action === "buy" ? "买入" : "卖出"} ${s.quantity} @ ${s.price}`).join("，")
              : "不操作"
            : (i.error ?? i.skipped);
          console.log(gray(`  ${i.quote?.name ?? i.holding.symbol}：${what}`));
        }
      }
      for (const p of ctx.problems) console.log(gray(`说明：${p}`));
      console.log("");

      let inThinking = false;
      for await (const ev of client.stream({
        system: await analyzeSystemPrompt(),
        prompt: analyzePrompt(opts.text, ctx, images.length),
        images,
        effort: "high",
        signal: ac.signal,
      })) {
        if (ev.t === "thinking") {
          if (!opts.thinking) continue;
          if (!inThinking) process.stdout.write(gray("[思考] "));
          inThinking = true;
          process.stdout.write(gray(ev.v));
        } else {
          if (inThinking) process.stdout.write("\n\n");
          inThinking = false;
          process.stdout.write(ev.v);
        }
      }
      process.stdout.write("\n");
    } catch (e) {
      if (ac.signal.aborted) return;
      fail(errorMessage(e));
    }
  });

program
  .command("serve")
  .description("启动本地网页控制台：查看持仓与信号、成交后更新持仓、AI 截图分析")
  .option("-p, --port <port>", "端口", "8686")
  .option("--host <host>", "监听地址；默认只允许本机访问，局域网访问用 0.0.0.0（注意安全）", "127.0.0.1")
  .option("--no-monitor", "不在控制台中定时检查和发送提醒（已用 gridbot run 或 GitHub Actions 时使用）")
  .action(async (opts: { port: string; host: string; monitor: boolean }) => {
    const configPath = program.opts<{ config: string }>().config;
    // 先校验配置，有错误直接提示；还没有配置文件时可以在网页上按向导创建
    const exists = await access(configPath).then(() => true, () => false);
    if (exists) await loadConfig(configPath);
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`端口无效：${opts.port}`);
    const monitor = opts.monitor ? startMonitor({ configPath, log: (line) => log(`[监控] ${line}`) }) : undefined;
    try {
      await startServer({ configPath, host: opts.host, port, monitor });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      fail(code === "EADDRINUSE" ? `端口 ${port} 已被占用，可以用 --port 换一个` : `启动失败：${(e as Error).message}`);
    }
    const shown = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host.includes(":") ? `[${opts.host}]` : opts.host;
    console.log(`控制台已启动：http://${shown}:${port}  （Ctrl+C 退出）`);
    console.log(
      opts.monitor
        ? "定时监控已开启：交易时段内按配置的间隔检查，有信号时发送提醒（已在用 gridbot run / GitHub Actions 时，可加 --no-monitor 避免重复检查）"
        : "定时监控未开启（--no-monitor）：控制台只用于查看，提醒由 gridbot run 或 GitHub Actions 发送",
    );
    if (!exists) console.log(`还没有配置文件 ${configPath}：在浏览器中打开控制台，按向导设置持仓、提醒渠道和 AI。`);
    if (!["127.0.0.1", "localhost", "::1"].includes(opts.host)) {
      console.log("⚠ 当前允许其他设备访问。控制台可以修改配置文件并调用 AI（产生费用），请只在可信的网络中使用。");
    }
  });

program
  .command("notify-test")
  .description("向所有提醒渠道（邮件、手机推送）发送一条测试消息")
  .action(async () => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    const notifier = notifierFor(config);
    if (!notifier) fail("未配置提醒渠道（notify.email 或 notify.webhooks）");
    const results = await Promise.allSettled(notifier.channels.map((c) => c.notifier.send(renderTestEmail())));
    results.forEach((r, i) => {
      const name = notifier.channels[i]!.name;
      console.log(r.status === "fulfilled" ? `✓ ${name}：已发送，请查收` : `✗ ${(r.reason as Error).message}`);
    });
    if (results.some((r) => r.status === "rejected")) process.exitCode = 1;
  });

function printReport(report: SendReport | void) {
  if (!report) return;
  console.log(`已发送到 ${report.sent.join("、")}`);
  for (const f of report.failed) console.log(`⚠ ${f.error}`);
}

program
  .command("markets")
  .description("查看各市场当前是否开盘及交易时段")
  .action(() => {
    const now = new Date();
    for (const m of ALL_MARKETS) {
      const t = localTime(m, now);
      const open = isMarketOpen(m, now);
      const next = open ? "" : `，下次开盘 ${describeNextOpen([{ market: m, at: nextOpenSafe(m, now) }])}`;
      console.log(`${MARKETS[m].name}：${open ? "交易中" : "休市"}（当地 ${t.date} ${t.hhmm}，交易时段 ${describeSessions(m)}${next}）`);
    }
    console.log("注：未内置节假日日历，节假日会显示为交易时段；定时检查时会根据行情日期自动跳过休市日。");
  });

program
  .command("quote")
  .description("查询实时行情，如：gridbot quote 510300 hk00700 AAPL")
  .argument("<symbols...>", "代码，支持 sh510300 / 510300 / hk00700 / 700 / usAAPL / AAPL 等写法")
  .action(async (inputs: string[]) => {
    const symbols = inputs.map((i) => normalizeSymbol(i).symbol);
    const quotes = await getQuoteSource().fetchQuotes(symbols);
    for (const sym of symbols) {
      const q = quotes.get(sym);
      console.log(q ? formatQuote(q) : `${sym}  未查到行情，请检查代码`);
    }
  });

program
  .command("reset")
  .description("清除标的的状态（已触发档位、网格位置），开始新一轮")
  .argument("[symbols...]", "要重置的代码，不填则需配合 --all")
  .option("--all", "重置全部标的")
  .action(async (inputs: string[], opts: { all?: boolean }) => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    if (!inputs.length && !opts.all) fail("请指定要重置的代码，或使用 --all");
    const state = await loadState(config.statePath);
    const targets = opts.all ? Object.keys(state.symbols) : inputs.map((i) => normalizeSymbol(i).symbol);
    for (const t of targets) delete state.symbols[t];
    await saveState(config.statePath, state);
    console.log(`已重置：${targets.join("、") || "（无状态）"}`);
  });

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof ConfigError ? e.message : `出错了：${(e as Error).message ?? e}`);
  process.exit(1);
});
