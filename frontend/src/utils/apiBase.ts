// Compute API base consistently across the app
// Prefer VITE_API_BASE when provided, otherwise default to '/api'
export const apiBase: string = (typeof window !== 'undefined' && (import.meta as any)?.env?.VITE_API_BASE) || '/api';


