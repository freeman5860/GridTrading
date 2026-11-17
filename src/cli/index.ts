#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { runCheck } from "../check.js";
import { ConfigError, DEFAULT_CONFIG, EXAMPLE_CONFIG, loadConfig } from "../config.js";
import { normalizeSymbol } from "../core/symbol.js";
import { getQuoteSource } from "../market/source.js";
import { loadState, saveState } from "../state.js";
import { formatCheck, formatQuote } from "./format.js";

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
  .action(async (opts: { dryRun?: boolean; json?: boolean; exitCode?: boolean }) => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    const result = await runCheck(config, { dryRun: opts.dryRun });
    console.log(opts.json ? JSON.stringify(result, null, 2) : formatCheck(result, Boolean(opts.dryRun)));
    if (opts.exitCode && result.signalCount > 0) process.exitCode = 10;
    if (result.items.some((i) => i.error)) process.exitCode ??= 2;
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
