export type SimDiagnostics = {
  failingIx?: number;
  logs?: string[];
  programId?: string;
  err?: string;
};

export function parseSimLogs(raw: any): SimDiagnostics {
  try {
    const out: SimDiagnostics = {};
    const logs: string[] = Array.isArray(raw?.value?.logs) ? raw.value.logs : (Array.isArray(raw?.logs) ? raw.logs : []);
    out.logs = logs;
    for (const line of (logs || [])) {
      const m = /Program (\w+) failed: (.+)$/.exec(line) || /program (\w+) failed: (.+)$/i.exec(line);
      if (m) { out.programId = m[1]; out.err = m[2]; }
      const ix = /Program log: Instruction: (\d+)/.exec(line);
      if (ix) { const n = Number(ix[1]); if (Number.isFinite(n)) out.failingIx = n; }
    }
    return out;
  } catch {
    return {};
  }
}


