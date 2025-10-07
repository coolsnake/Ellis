export type SimDiagnostics = {
  failingIx?: number;
  logs?: string[];
  programId?: string;
};

export function parseSimLogs(_raw: any): SimDiagnostics {
  // Placeholder: returns empty diagnostics
  return {};
}


