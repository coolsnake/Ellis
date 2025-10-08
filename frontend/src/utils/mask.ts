// Utility to mask sensitive tokens/keys that may appear in RPC URLs
export const maskRpcUrl = (url?: string): any => {
  if (!url || typeof url !== 'string') return url as any;
  const maskValue = (v: string) => (v.length <= 4 ? '****' : `${v.slice(0, 2)}***${v.slice(-2)}`);
  try {
    const u = new URL(url);
    const sensitiveParams = ['api-key', 'api_key', 'apikey', 'key', 'x-api-key', 'token', 'auth', 'access_token', 'apiKey'];
    for (const p of sensitiveParams) {
      if (u.searchParams.has(p)) {
        const v = u.searchParams.get(p);
        if (v) u.searchParams.set(p, maskValue(v));
      }
    }
    // Mask path segments that look like inline API keys (e.g., /v2/<key>)
    const segs = u.pathname.split('/').map((seg) => {
      if (seg.length >= 16 && /^[A-Za-z0-9._-]+$/.test(seg)) return maskValue(seg);
      return seg;
    });
    u.pathname = segs.join('/');
    return u.toString();
  } catch {
    // Fallback: mask common query param patterns in raw strings
    return (url as string).replace(/(api[-_]?key|x-api-key|token|auth|access_token|apiKey)=([^&]+)/gi, '$1=****');
  }
};


