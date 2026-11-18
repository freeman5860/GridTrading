import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import type { RenderedEmail } from "./render.js";
import type { SendReport } from "./index.js";

export const emailConfigSchema = z
  .object({
    host: z.string().min(1, "缺少 SMTP 服务器地址 host"),
    port: z.number().int().positive().default(465),
    /** 465 端口默认 SSL；587 等端口用 STARTTLS */
    secure: z.boolean().optional(),
    user: z.string().min(1, "缺少 SMTP 用户名 user"),
    pass: z.string().min(1, "SMTP 密码 pass 为空（如果用了 ${ENV_VAR}，请检查环境变量是否已设置）"),
    from: z.string().optional(),
    to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  })
  .transform((c) => ({ ...c, secure: c.secure ?? c.port === 465, to: Array.isArray(c.to) ? c.to : [c.to] }));

export type EmailConfig = z.output<typeof emailConfigSchema>;

export interface Notifier {
  /** 多渠道组合时返回各渠道的发送结果 */
  send(mail: RenderedEmail): Promise<void | SendReport>;
}

export function createEmailNotifier(cfg: EmailConfig, transport?: Transporter): Notifier {
  const t =
    transport ??
    nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  return {
    async send(mail) {
      try {
        await t.sendMail({
          from: cfg.from ?? `gridbot <${cfg.user}>`,
          to: cfg.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
      } catch (e) {
        throw new Error(`邮件发送失败：${(e as Error).message}`, { cause: e });
      }
    },
  };
}
