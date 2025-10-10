export type ArbOpportunityLike = {
  profit_bps?: number;
  net_bps?: number;
  est_profit_usd?: number;
  path?: string[];
  hop_dexes?: string[];
  dexes?: string[];
  hop_rates?: number[];
  hop_outs?: number[];
  hop_fee_bps?: number[];
  hop_pool_ids?: string[];
  hop_liquidity_display?: number[];
  est_capacity?: number;
  bottleneck?: { from?: string; to?: string; dex?: string; rate?: number; liquidity?: number; fee_bps?: number };
  is_near_miss?: boolean;
};

export function formatOpportunityLog(o: ArbOpportunityLike, index: number): string {
  const bps = Math.round(Number(o.profit_bps ?? o.net_bps ?? 0) || 0);
  const path = (o.path || []).join('->');
  const dexes = (o.hop_dexes || o.dexes || []).join('>');
  const rates = (o.hop_rates || []).map(v => Number.isFinite(v) ? Number(v).toFixed(8) : String(v)).join(',');
  const outs = (o.hop_outs || []).map(v => Number.isFinite(v) ? Number(v).toFixed(6) : String(v)).join(',');
  const fees = (o.hop_fee_bps || []).join(',');
  const pools = (o.hop_pool_ids || []).join(',');
  const liqs = (o.hop_liquidity_display || []).map(v => Number.isFinite(v) ? Number(v).toFixed(2) : String(v)).join(',');
  const cap = (o.est_capacity ?? undefined);
  const hops = (o.hop_rates?.length) || (o.hop_pool_ids?.length) || Math.max(0, (o.path||[]).length);
  const bn = o.bottleneck ? ` from=${o.bottleneck.from} to=${o.bottleneck.to} dex=${o.bottleneck.dex} rate=${o.bottleneck.rate} liq=${o.bottleneck.liquidity} fee_bps=${o.bottleneck.fee_bps}` : '';
  const edges = (() => {
    try {
      const p: string[] = Array.isArray(o.path) ? (o.path as string[]) : [];
      const ids: string[] = Array.isArray(o.hop_pool_ids) ? (o.hop_pool_ids as string[]) : [];
      const n = p.length;
      const out: string[] = [];
      for (let k = 0; k < n; k += 1) {
        const a = p[k];
        const b = p[(k + 1) % n];
        const id = ids[k] || '';
        const short = (m: string) => (typeof m === 'string' && m.length > 8) ? `${m.slice(0,4)}…${m.slice(-4)}` : m;
        out.push(`${short(a)}->${short(b)}:${id}`);
      }
      return out.join(',');
    } catch { return ''; }
  })();
  return `opportunity:detected #${index+1} bps=${bps} usd=${o.est_profit_usd ?? '-'} hops=${hops} path=${path} dexes=${dexes} rates=[${rates}] outs=[${outs}] fees=[${fees}] pools=[${pools}] edges=[${edges}] liq=[${liqs}] est_capacity=${cap ?? '-'} bottleneck{${bn.trim()}}`;
}


