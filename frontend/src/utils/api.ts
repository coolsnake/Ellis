// Lightweight API fetch interceptor: injects Basic Auth for /api requests and handles 401s

// Compute API base (same logic as elsewhere)
const apiBase: string = (typeof window !== 'undefined' && (import.meta as any)?.env?.VITE_API_BASE) || '/api';

type Credentials = { user: string; pass: string } | null;
type StoredCreds = { user: string; pass: string; expiresAt?: number } | null;

function getStoredCreds(): Credentials {
    try {
        const s = typeof window !== 'undefined' ? window.localStorage.getItem('authCreds') : null;
        const obj = s ? JSON.parse(s) as any : null;
        if (!obj || typeof obj.user !== 'string' || typeof obj.pass !== 'string') return null;
        const exp = Number(obj?.expiresAt ?? NaN);
        if (!Number.isFinite(exp) || exp <= Date.now()) {
            try { window.localStorage.removeItem('authCreds'); } catch {}
            return null;
        }
        return { user: obj.user, pass: obj.pass };
    } catch {
        return null;
    }
}

function buildAuthHeader(creds: Credentials): Record<string, string> {
	if (!creds) return {};
	try {
		const token = btoa(`${creds.user}:${creds.pass}`);
		return { Authorization: `Basic ${token}` };
	} catch {
		return {};
	}
}

function isApiUrl(url: string): boolean {
	try {
		// Normalize relative vs absolute
		const baseIsAbsolute = /^(https?:)?\/\//i.test(apiBase);
		if (baseIsAbsolute) {
			return url.startsWith(apiBase);
		}
		// Relative apiBase like '/api'
		if (/^(https?:)?\/\//i.test(url)) {
			// Absolute url: compare path segment
			const u = new URL(url);
			return u.pathname.startsWith(apiBase);
		}
		// Relative url
		return url.startsWith(apiBase);
	} catch {
		return false;
	}
}

// Install interceptor once (safe if imported multiple times)
(() => {
	if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
	const w = window as any;
	if (w.__lockstone_api_fetch_installed) return;
	w.__lockstone_api_fetch_installed = true;

	const originalFetch: typeof window.fetch = window.fetch.bind(window);

	window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		try {
			const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
			let nextInit: RequestInit = { ...(init || {}) };
			// Merge headers and inject Authorization for API urls if not already present
			if (isApiUrl(url)) {
				const creds = getStoredCreds();
				const auth = buildAuthHeader(creds);
				const existing = (nextInit.headers || {}) as Record<string, string>;
				const hasAuth = typeof existing === 'object' && Object.keys(existing).some(k => k.toLowerCase() === 'authorization');
				nextInit.headers = hasAuth ? existing : { ...existing, ...auth };
			}
			const res = await originalFetch(input as any, nextInit);
			if (res.status === 401 && isApiUrl(typeof input === 'string' ? input : (input as any).url || '')) {
				try { window.localStorage.removeItem('authCreds'); } catch {}
				// Redirect to login if not already there
				try {
					if (!window.location.pathname.startsWith('/login')) {
						window.location.replace('/login');
					}
				} catch {}
			}
			return res;
		} catch {
			return originalFetch(input as any, init);
		}
	};
})();

export {};


