// Simple soak harness: runs periodic status checks and logs strategy metrics
// Usage: tsx src/tests/soak.drift.ts (ensure backend running)

const API_BASE = (process.env.API_BASE as string) || 'http://localhost:3001/api';

async function main() {
  const start = Date.now();
  const durationMs = Number(process.env.SOAK_DURATION_MS || 10 * 60 * 1000);
  const pollMs = Number(process.env.SOAK_POLL_MS || 2000);
  console.log('Starting Drift soak test', { durationMs, pollMs, API_BASE });
  while (Date.now() - start < durationMs) {
    try {
      const res = await fetch(`${API_BASE}/strategies/leveraged-grid/status`);
      const data = await res.json();
      const list = (data?.strategies || []) as Array<{ key: string; status: any }>;
      const summary = list.map((s) => ({ key: s.key, running: s.status?.running, openOrders: s.status?.openOrders, effLev: s.status?.effectiveLeverage, liqBuf: s.status?.liquidationBuffer }));
      console.log(new Date().toISOString(), 'runner', summary);
    } catch (e) {
      console.warn('soak: poll failed', String(e));
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  console.log('Soak completed');
}

main().catch((e) => { console.error('soak error', e); process.exit(1); });


