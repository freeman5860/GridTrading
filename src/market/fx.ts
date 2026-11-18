// 港元兑人民币汇率（港股通用）：腾讯行情公开接口的外汇报价 whHKDCNY。
// 返回格式：v_whHKDCNY="310~港元人民币~HKDCNY~0.8495~0~20261119004601~..."，第 4 个字段为现价。

import type { FxRate } from "../core/types.js";

const URL_HKDCNY = "https://qt.gtimg.cn/q=whHKDCNY";

export function parseFx(body: string): FxRate | undefined {
  const m = body.match(/v_whHKDCNY="([^"]*)"/);
  if (!m) return undefined;
  const f = m[1]!.split("~");
  const rate = Number(f[3]);
  // 合理范围检查，防止接口格式变化时用错数字
  if (!(rate > 0.5 && rate < 1.5)) return undefined;
  const t = f[5]?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return { rate, time: t ? `${t[1]}-${t[2]}-${t[3]} ${t[4]}:${t[5]}:${t[6]}` : undefined };
}

export async function fetchHkdCny(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<FxRate> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const res = await fetch(URL_HKDCNY, {
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; gridbot)" },
  });
  if (!res.ok) throw new Error(`汇率接口返回 HTTP ${res.status}`);
  const fx = parseFx(new TextDecoder("gbk").decode(await res.arrayBuffer()));
  if (!fx) throw new Error("汇率接口返回格式无法识别");
  return fx;
}

/** 便于测试替换 */
export const fxSource = { fetchHkdCny };
