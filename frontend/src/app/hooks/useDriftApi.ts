import { apiGet, apiPost } from '../../utils/api';
import { ROUTES } from '../../utils/routes';

export function useDriftApi() {
  return {
    status: async () => apiGet<any>(ROUTES.drift.status),
    subaccounts: async () => apiGet<any>(ROUTES.drift.subaccounts),
    spotMarkets: async () => apiGet<any>(ROUTES.drift.spotMarkets),
    balances: async (subId: number) => apiGet<any>(`${ROUTES.drift.subaccountBalances}?subaccountId=${Number(subId)}`),
    createSubaccount: async (name?: string) => apiPost<any>(ROUTES.drift.subaccountCreate, name ? { name } : undefined),
    switchSubaccount: async (id: number) => apiPost<any>(ROUTES.drift.subaccountSwitch, { id }),
    // If backend supports rename selected, wire here; else no-op
    renameSelected: async (_name: string) => ({ ok: false }),
    deposit: async (amount: number, spotMarketIndex: number) => apiPost<any>(ROUTES.drift.subaccountDeposit, { amount, spotMarketIndex }),
    withdraw: async (amount: number, spotMarketIndex: number) => apiPost<any>(ROUTES.drift.subaccountWithdraw, { amount, spotMarketIndex }),
  };
}


