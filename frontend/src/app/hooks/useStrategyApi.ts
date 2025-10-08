import { apiGet, apiPost } from '../../utils/api';
import { ROUTES } from '../../utils/routes';

export function useStrategyApi() {
  return {
    async fetchBaseStrategies(): Promise<any[]> {
      const resp = await apiGet<any>(ROUTES.legacy.strategy);
      return Array.isArray((resp as any)?.strategies) ? (resp as any).strategies : [];
    },
    async fetchLeveragedGridStatus(): Promise<any> {
      return await apiGet<any>(ROUTES.strategies.leveragedGrid.status).catch(() => ({}));
    },
    async saveGridStrategy(body: any): Promise<any> {
      return await apiPost<any>(ROUTES.legacy.strategy, body);
    },
    async removeStrategy(name: string): Promise<any> {
      return await apiPost<any>(`${ROUTES.legacy.strategy}/remove`, { name });
    },
  };
}


