// 多渠道通知：邮件 + 各种即时通讯推送，同时发送。
// 全部失败时抛出错误（调用方不保存状态，下次重新提醒）；部分失败时返回报告（避免成功的渠道重复收到提醒）。

import type { Config } from "../config.js";
import { createEmailNotifier, type Notifier } from "./email.js";
import type { RenderedEmail } from "./render.js";
import { channelName, createWebhookNotifier } from "./webhook.js";

export interface Channel {
  name: string;
  notifier: Notifier;
}

export interface SendReport {
  sent: string[];
  failed: { channel: string; error: string }[];
}

export class NotifyError extends Error {
  constructor(public report: SendReport) {
    super(report.failed.map((f) => f.error).join("；"));
  }
}

export function channelsFor(config: Config): Channel[] {
  const n = config.notify;
  if (!n) return [];
  const list: Channel[] = [];
  if (n.email) list.push({ name: `邮件（${n.email.to.join("、")}）`, notifier: createEmailNotifier(n.email) });
  for (const w of n.webhooks) list.push({ name: channelName(w), notifier: createWebhookNotifier(w) });
  return list;
}

export function describeChannels(channels: Channel[]): string {
  return channels.map((c) => c.name).join("、");
}

/** 组合成一个 Notifier；没有配置任何渠道时返回 null */
export function combine(channels: Channel[]): (Notifier & { channels: Channel[] }) | null {
  if (!channels.length) return null;
  return {
    channels,
    async send(msg: RenderedEmail): Promise<SendReport> {
      const results = await Promise.allSettled(channels.map((c) => c.notifier.send(msg)));
      const report: SendReport = { sent: [], failed: [] };
      results.forEach((r, i) => {
        const name = channels[i]!.name;
        if (r.status === "fulfilled") report.sent.push(name);
        else report.failed.push({ channel: name, error: (r.reason as Error)?.message ?? String(r.reason) });
      });
      if (!report.sent.length) throw new NotifyError(report);
      return report;
    },
  };
}
