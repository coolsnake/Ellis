import React, { useEffect, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useModalConfig } from '../app/hooks/useModalConfig';

type Props = {
  apiBase: string;
  initial?: any;
  onClose: () => void;
};

export const DataFetchConfig: React.FC<Props> = ({ apiBase, initial, onClose }) => {
  // Persist ALL configuration values to localStorage
  const [uiPrefs, updateUiPrefs] = useModalConfig('dataFetchConfig', {
    lastValues: null as any,
  });
  
  const [cfg, setCfg] = useState<any>(uiPrefs.lastValues || {
		// System
		enablePoolWs: true,
    poolSubscriptionMode: 'wss',  // 'wss' | 'grpc' | 'disabled'
    grpc_endpoint: '',
    grpc_xToken: '',
    grpc_commitment: 'processed',  // 'processed' | 'confirmed' | 'finalized'
    poolsRefreshMs: 60000,
    poolRefreshMinGapMs: 3000,
    tokenUniverseMode: 'union',
    jupiterTopTokens_category: 'toptraded',
    jupiterTopTokens_interval: '24h',
    jupiterTopTokens_limit: 100,
    jupiterTopTokens_cacheTtlMs: 300000,
    scopePoolsMode: 'none',
    anchorMints: 'So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    includeAnchorsInUniverse: true,
    enableAnchorBridging: true,
    routeLevelScoping: false,
    canonicalizePairs: 'lex',
    minAmmLiqBase: 100000,
    minClmmLiquidity: 100000,
    minPoolsPerPair: 2,
    enableActivityFilter: false,
    maxInactivePoolMs: 12 * 60 * 60 * 1000, // 12 hours default
    universePrefilterOrca: false,
    // WS Attach rate (pools per second)
    wsAttachPerSec: 10,
    // DEX Source Control
    enabledDexSources_raydium: true,
    enabledDexSources_raydium_amm: true,
    enabledDexSources_raydium_clmm: true,
    enabledDexSources_raydium_cpmm: false,
    enabledDexSources_orca: true,
    enabledDexSources_orca_amm: true,
    enabledDexSources_orca_clmm: true,
    enabledDexSources_meteora: true,
    enabledDexSources_meteora_balanced: true,
    enabledDexSources_meteora_balanced_v1: true,
    enabledDexSources_meteora_balanced_v2: true,
    enabledDexSources_pumpswap: true,
		// RPC Rate Limiter
		rpcMaxRps: 50,
		rpcBurst: 12,
		rpcMinGapMs: 20,
		// Raydium (HTTP)
		ray_cacheTtlMs: 300000,
		ray_httpConcurrency: 2,
		ray_httpPageSize: 50,
		ray_httpMaxPagesPerMint: 2,
		ray_minAmmLiqBase: 0,
		ray_minClmmLiquidity: 0,
    // Sanity
    sanity_enabled: true,
    sanity_maxPriceDeviation: 50,
    sanity_feeMin: 0,
    sanity_feeMax: 10000,
    sanity_writeSamples: false,
    sanity_sampleRate: 0.005,
    sanity_applyRaydiumAmm: true,
    sanity_applyRaydiumClmm: true,
    sanity_applyOrcaClmm: true,
    // Orca
    orca_cacheTtlMs: 300000,
    orca_maxHttpRetries: 2,
    orca_httpBackoffMs: 500,
    orca_pageSize: 200,
    orca_maxPages: 3,
    orca_minAmmLiqBase: 0,
    orca_minClmmLiquidity: 0,
    // Meteora (DLMM)
    meteora_apiUrl: 'https://dlmm-api.meteora.ag/pair/all_with_pagination',
    meteora_pageSize: 1000,
    meteora_maxPages: 50,
    // Meteora Balanced (mAMM)
    meteoraBalanced_apiUrl: 'https://damm-api.meteora.ag/pools',
    meteoraBalanced_apiUrlV2: 'https://dammv2-api.meteora.ag/pools',
    meteoraBalanced_hideLowTvl: false,
    meteoraBalanced_hideLowApr: false,
    meteoraBalanced_tokensVerified: false,
    meteoraBalanced_minLiqBase: 50,
    meteoraBalanced_anchorTokensOnly: true,
    meteoraBalanced_enableRpcEnrichment: true,
    meteoraBalanced_rpcBatchSize: 100,
    meteoraBalanced_cacheTtlMs: 300000,
    meteoraBalanced_maxHttpRetries: 2,
    meteoraBalanced_httpBackoffMs: 500,
    meteoraBalanced_pageSize: 200,
    meteoraBalanced_maxPages: 3,
    meteora_cacheTtlMs: 300000,
    meteora_maxHttpRetries: 2,
    meteora_httpBackoffMs: 500,
    // (Note: overridden by values above; keep fields here for backend sync)
    // meteora_pageSize
    // meteora_maxPages
    meteora_minClmmLiquidity: 0,
    meteora_universePrefilter: false,
    // Pumpswap (Shyft GraphQL)
    pumpswap_shyftApiKey: '',
    pumpswap_cacheTtlMs: 60000,
    pumpswap_maxHttpRetries: 2,
    pumpswap_httpBackoffMs: 500,
    pumpswap_defaultFeeBps: 30,
    pumpswap_minLiqBase: 0,
    pumpswap_pageSize: 1000,
    pumpswap_maxPages: 10,
    pumpswap_pageDelayMs: 200,
    pumpswap_enableRpcEnrichment: true,
    pumpswap_rpcBatchSize: 100,
    pumpswap_validatePrices: true,
    pumpswap_validationSamples: 10,
    // Shyft GraphQL (Global)
    shyft_apiKey: '',
    // Raydium GraphQL
    raydium_useGraphQL: false,
    raydium_shyftApiKey: '',
    raydium_pageDelayMs: 200,
    raydium_mintBatchSize: 10,
    raydium_graphqlPageSize: 1000,
    raydium_graphqlMaxPages: 50,
    raydium_detailBatchSize: 50,
    // Raydium CLMM GraphQL (separate from AMM)
    raydiumClmm_graphqlPageSize: 1000,
    raydiumClmm_graphqlMaxPages: 50,
    raydiumClmm_pageDelayMs: 200,
    raydiumClmm_mintBatchSize: 10,
    raydiumClmm_detailBatchSize: 50,
    // Raydium CPMM GraphQL
    raydiumCpmm_enabled: false,
    raydiumCpmm_pageDelayMs: 200,
    raydiumCpmm_mintBatchSize: 10,
    raydiumCpmm_graphqlPageSize: 1000,
    raydiumCpmm_graphqlMaxPages: 50,
    raydiumCpmm_detailBatchSize: 50,
    // Orca GraphQL
    orca_useGraphQL: false,
    orca_shyftApiKey: '',
    orca_pageDelayMs: 200,
    orca_mintBatchSize: 10,
    orca_graphqlPageSize: 1000,
    orca_graphqlMaxPages: 50,
    orca_detailBatchSize: 20,
    // Meteora GraphQL
    meteora_useGraphQL: false,
    meteora_shyftApiKey: '',
    meteora_pageDelayMs: 200,
    meteora_mintBatchSize: 10,
    meteora_graphqlPageSize: 1000,
    meteora_graphqlMaxPages: 50,
    meteora_detailBatchSize: 10,
    // Pumpswap GraphQL batch settings
    pumpswap_mintBatchSize: 10,
    pumpswap_graphqlPageSize: 1000,
    pumpswap_graphqlMaxPages: 50,
    // Jupiter
    jupiterApiUrl: '',
    jupiterPauseApi: false,
    jupiterLimiterTargetMs: 2000,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Save ALL configuration values to localStorage when they change (excluding API keys)
  useEffect(() => {
    const sanitized = {
      ...cfg,
      pumpswap_shyftApiKey: '', // Don't persist API keys
      shyft_apiKey: '',
      raydium_shyftApiKey: '',
      orca_shyftApiKey: '',
      meteora_shyftApiKey: '',
      grpc_xToken: '', // Don't persist gRPC x-token
    };
    updateUiPrefs({ lastValues: sanitized });
  }, [cfg]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase}${ROUTES.system.config}`);
        if (r.ok) {
          const j = await r.json();
				setCfg((prev: any) => ({
            ...prev,
					enablePoolWs: j?.system?.enablePoolWs !== false,
            poolSubscriptionMode: j?.system?.poolSubscriptionMode || prev.poolSubscriptionMode || 'wss',
            grpc_endpoint: j?.system?.grpc?.endpoint || prev.grpc_endpoint || '',
            grpc_xToken: j?.system?.grpc?.xToken || prev.grpc_xToken || '',
            grpc_commitment: j?.system?.grpc?.commitment || prev.grpc_commitment || 'processed',
            poolsRefreshMs: Number(j?.system?.poolsRefreshMs ?? prev.poolsRefreshMs),
            poolRefreshMinGapMs: Number(j?.system?.poolRefreshMinGapMs ?? prev.poolRefreshMinGapMs),
            tokenUniverseMode: j?.system?.tokenUniverseMode || prev.tokenUniverseMode,
            jupiterTopTokens_category: j?.system?.jupiterTopTokens?.category || prev.jupiterTopTokens_category || 'toptraded',
            jupiterTopTokens_interval: j?.system?.jupiterTopTokens?.interval || prev.jupiterTopTokens_interval || '24h',
            jupiterTopTokens_limit: Number(j?.system?.jupiterTopTokens?.limit ?? prev.jupiterTopTokens_limit ?? 100),
            jupiterTopTokens_cacheTtlMs: Number(j?.system?.jupiterTopTokens?.cacheTtlMs ?? prev.jupiterTopTokens_cacheTtlMs ?? 300000),
            scopePoolsMode: j?.system?.scopePoolsMode || prev.scopePoolsMode,
            anchorMints: Array.isArray(j?.system?.anchorMints) ? j.system.anchorMints.join(',') : (prev.anchorMints || ''),
            includeAnchorsInUniverse: (j?.system?.includeAnchorsInUniverse ?? true) !== false,
            enableAnchorBridging: !!j?.system?.enableAnchorBridging,
            routeLevelScoping: !!j?.system?.routeLevelScoping,
            canonicalizePairs: j?.system?.canonicalizePairs || prev.canonicalizePairs,
            minAmmLiqBase: Number(j?.system?.minAmmLiqBase ?? prev.minAmmLiqBase),
            minClmmLiquidity: Number(j?.system?.minClmmLiquidity ?? prev.minClmmLiquidity),
            minPoolsPerPair: Number(j?.system?.minPoolsPerPair ?? prev.minPoolsPerPair),
            enableActivityFilter: j?.system?.enableActivityFilter !== false,
            maxInactivePoolMs: Number(j?.system?.maxInactivePoolMs ?? prev.maxInactivePoolMs ?? (12 * 60 * 60 * 1000)),
            universePrefilterOrca: !!j?.system?.universePrefilterOrca,
            jupiterApiUrl: j?.system?.jupiterApiUrl || prev.jupiterApiUrl,
            // WS attach rate
            wsAttachPerSec: Number(j?.system?.wsAttachPerSec ?? prev.wsAttachPerSec ?? 10),
            // RPC Rate Limiter
            rpcMaxRps: Number(j?.system?.rpcMaxRps ?? prev.rpcMaxRps ?? 50),
            rpcBurst: Number(j?.system?.rpcBurst ?? prev.rpcBurst ?? 12),
            rpcMinGapMs: Number(j?.system?.rpcMinGapMs ?? prev.rpcMinGapMs ?? 20),
            // DEX Source Control
            enabledDexSources_raydium: j?.system?.enabledDexSources?.raydium ?? prev.enabledDexSources_raydium ?? true,
            enabledDexSources_raydium_amm: (typeof j?.system?.enabledDexSources?.raydium === 'object' ? (j.system.enabledDexSources.raydium.amm ?? true) : prev.enabledDexSources_raydium_amm ?? true),
            enabledDexSources_raydium_clmm: (typeof j?.system?.enabledDexSources?.raydium === 'object' ? (j.system.enabledDexSources.raydium.clmm ?? true) : prev.enabledDexSources_raydium_clmm ?? true),
            enabledDexSources_raydium_cpmm: (typeof j?.system?.enabledDexSources?.raydium === 'object' ? (j.system.enabledDexSources.raydium.cpmm ?? false) : prev.enabledDexSources_raydium_cpmm ?? false),
            enabledDexSources_orca: j?.system?.enabledDexSources?.orca ?? prev.enabledDexSources_orca ?? true,
            enabledDexSources_orca_amm: (typeof j?.system?.enabledDexSources?.orca === 'object' ? (j.system.enabledDexSources.orca.amm ?? true) : prev.enabledDexSources_orca_amm ?? true),
            enabledDexSources_orca_clmm: (typeof j?.system?.enabledDexSources?.orca === 'object' ? (j.system.enabledDexSources.orca.clmm ?? true) : prev.enabledDexSources_orca_clmm ?? true),
            enabledDexSources_meteora: j?.system?.enabledDexSources?.meteora ?? prev.enabledDexSources_meteora ?? true,
            enabledDexSources_meteora_balanced: j?.system?.enabledDexSources?.meteora_balanced ?? prev.enabledDexSources_meteora_balanced ?? true,
            enabledDexSources_meteora_balanced_v1: (typeof j?.system?.enabledDexSources?.meteora_balanced === 'object' ? (j.system.enabledDexSources.meteora_balanced.v1 ?? true) : prev.enabledDexSources_meteora_balanced_v1 ?? true),
            enabledDexSources_meteora_balanced_v2: (typeof j?.system?.enabledDexSources?.meteora_balanced === 'object' ? (j.system.enabledDexSources.meteora_balanced.v2 ?? true) : prev.enabledDexSources_meteora_balanced_v2 ?? true),
            enabledDexSources_pumpswap: j?.system?.enabledDexSources?.pumpswap ?? prev.enabledDexSources_pumpswap ?? true,
			ray_cacheTtlMs: Number(j?.raydium?.cacheTtlMs ?? prev.ray_cacheTtlMs),
			ray_httpConcurrency: Number((j?.raydium?.concurrency ?? j?.raydium?.sdkConcurrency) ?? prev.ray_httpConcurrency),
			ray_pageSize: Number((j?.raydium?.pageSize ?? j?.raydium?.httpPageSize) ?? (prev.ray_pageSize ?? prev.ray_httpPageSize)),
			ray_maxPages: Number((j?.raydium?.maxPages ?? j?.raydium?.httpMaxPagesPerMint) ?? (prev.ray_maxPages ?? 0)),
            ray_maxHttpRetries: Number(j?.raydium?.maxHttpRetries ?? 2),
            ray_httpBackoffMs: Number(j?.raydium?.httpBackoffMs ?? 300),
            ray_minAmmLiqBase: Number(j?.raydium?.minAmmLiqBase ?? prev.ray_minAmmLiqBase),
            ray_minClmmLiquidity: Number(j?.raydium?.minClmmLiquidity ?? prev.ray_minClmmLiquidity),
            // mode removed from UI
            orca_cacheTtlMs: Number(j?.orca?.cacheTtlMs ?? prev.orca_cacheTtlMs),
            orca_maxHttpRetries: Number(j?.orca?.maxHttpRetries ?? prev.orca_maxHttpRetries),
            orca_httpBackoffMs: Number(j?.orca?.httpBackoffMs ?? prev.orca_httpBackoffMs),
            orca_pageSize: Number(j?.orca?.pageSize ?? prev.orca_pageSize),
            orca_maxPages: Number(j?.orca?.maxPages ?? prev.orca_maxPages),
            orca_minAmmLiqBase: Number(j?.orca?.minAmmLiqBase ?? prev.orca_minAmmLiqBase),
            orca_minClmmLiquidity: Number(j?.orca?.minClmmLiquidity ?? prev.orca_minClmmLiquidity),
            // Meteora
            // mode removed from UI
            meteora_apiUrl: j?.meteora?.apiUrl || prev.meteora_apiUrl,
            meteora_cacheTtlMs: Number(j?.meteora?.cacheTtlMs ?? prev.meteora_cacheTtlMs),
            meteora_maxHttpRetries: Number(j?.meteora?.maxHttpRetries ?? prev.meteora_maxHttpRetries),
            meteora_httpBackoffMs: Number(j?.meteora?.httpBackoffMs ?? prev.meteora_httpBackoffMs),
            meteora_pageSize: Number(j?.meteora?.pageSize ?? prev.meteora_pageSize),
            meteora_maxPages: Number(j?.meteora?.maxPages ?? prev.meteora_maxPages),
            meteora_minClmmLiquidity: Number(j?.meteora?.minClmmLiquidity ?? prev.meteora_minClmmLiquidity),
            meteora_universePrefilter: !!j?.meteora?.universePrefilter,
            // Meteora Balanced
            meteoraBalanced_apiUrl: j?.meteoraBalanced?.apiUrl || prev.meteoraBalanced_apiUrl,
            meteoraBalanced_apiUrlV2: j?.meteoraBalanced?.apiUrlV2 || prev.meteoraBalanced_apiUrlV2,
            meteoraBalanced_hideLowTvl: j?.meteoraBalanced?.hideLowTvl === true,
            meteoraBalanced_hideLowApr: j?.meteoraBalanced?.hideLowApr === true,
            meteoraBalanced_tokensVerified: j?.meteoraBalanced?.tokensVerified === true,
            meteoraBalanced_minLiqBase: Number(j?.meteoraBalanced?.minLiqBase ?? prev.meteoraBalanced_minLiqBase ?? 50),
            meteoraBalanced_anchorTokensOnly: j?.meteoraBalanced?.anchorTokensOnly !== false,
            meteoraBalanced_enableRpcEnrichment: j?.meteoraBalanced?.enableRpcEnrichment !== false,
            meteoraBalanced_rpcBatchSize: Number(j?.meteoraBalanced?.rpcBatchSize ?? prev.meteoraBalanced_rpcBatchSize ?? 100),
            meteoraBalanced_cacheTtlMs: Number(j?.meteoraBalanced?.cacheTtlMs ?? prev.meteoraBalanced_cacheTtlMs),
            meteoraBalanced_maxHttpRetries: Number(j?.meteoraBalanced?.maxHttpRetries ?? prev.meteoraBalanced_maxHttpRetries),
            meteoraBalanced_httpBackoffMs: Number(j?.meteoraBalanced?.httpBackoffMs ?? prev.meteoraBalanced_httpBackoffMs),
            meteoraBalanced_pageSize: Number(j?.meteoraBalanced?.pageSize ?? prev.meteoraBalanced_pageSize),
            meteoraBalanced_maxPages: Number(j?.meteoraBalanced?.maxPages ?? prev.meteoraBalanced_maxPages),
            // Pumpswap
            pumpswap_shyftApiKey: j?.pumpswap?.shyftApiKey || prev.pumpswap_shyftApiKey || '',
            pumpswap_cacheTtlMs: Number(j?.pumpswap?.cacheTtlMs ?? prev.pumpswap_cacheTtlMs ?? 60000),
            pumpswap_maxHttpRetries: Number(j?.pumpswap?.maxHttpRetries ?? prev.pumpswap_maxHttpRetries ?? 2),
            pumpswap_httpBackoffMs: Number(j?.pumpswap?.httpBackoffMs ?? prev.pumpswap_httpBackoffMs ?? 500),
            pumpswap_defaultFeeBps: Number(j?.pumpswap?.defaultFeeBps ?? prev.pumpswap_defaultFeeBps ?? 30),
            pumpswap_minLiqBase: Number(j?.pumpswap?.minLiqBase ?? prev.pumpswap_minLiqBase ?? 0),
            pumpswap_pageSize: Number(j?.pumpswap?.pageSize ?? prev.pumpswap_pageSize ?? 1000),
            pumpswap_maxPages: Number(j?.pumpswap?.maxPages ?? prev.pumpswap_maxPages ?? 10),
            pumpswap_pageDelayMs: Number(j?.pumpswap?.pageDelayMs ?? prev.pumpswap_pageDelayMs ?? 200),
            pumpswap_enableRpcEnrichment: (j?.pumpswap?.enableRpcEnrichment !== false),
            pumpswap_rpcBatchSize: Number(j?.pumpswap?.rpcBatchSize ?? prev.pumpswap_rpcBatchSize ?? 100),
            pumpswap_validatePrices: (j?.pumpswap?.validatePrices !== false),
            pumpswap_validationSamples: Number(j?.pumpswap?.validationSamples ?? prev.pumpswap_validationSamples ?? 10),
            // Shyft GraphQL
            shyft_apiKey: j?.shyft?.apiKey || prev.shyft_apiKey || '',
            // Raydium GraphQL
            raydium_useGraphQL: !!j?.raydium?.useGraphQL,
            raydium_shyftApiKey: j?.raydium?.shyftApiKey || prev.raydium_shyftApiKey || '',
            raydium_pageDelayMs: Number(j?.raydium?.pageDelayMs ?? prev.raydium_pageDelayMs ?? 200),
            raydium_mintBatchSize: Number(j?.raydium?.mintBatchSize ?? prev.raydium_mintBatchSize ?? 10),
            raydium_graphqlPageSize: Number(j?.raydium?.graphqlPageSize ?? prev.raydium_graphqlPageSize ?? 1000),
            raydium_graphqlMaxPages: Number(j?.raydium?.graphqlMaxPages ?? prev.raydium_graphqlMaxPages ?? 50),
            raydium_detailBatchSize: Number(j?.raydium?.detailBatchSize ?? prev.raydium_detailBatchSize ?? 50),
            // Raydium CLMM GraphQL
            raydiumClmm_graphqlPageSize: Number(j?.raydiumClmm?.graphqlPageSize ?? prev.raydiumClmm_graphqlPageSize ?? 1000),
            raydiumClmm_graphqlMaxPages: Number(j?.raydiumClmm?.graphqlMaxPages ?? prev.raydiumClmm_graphqlMaxPages ?? 50),
            raydiumClmm_pageDelayMs: Number(j?.raydiumClmm?.pageDelayMs ?? prev.raydiumClmm_pageDelayMs ?? 200),
            raydiumClmm_mintBatchSize: Number(j?.raydiumClmm?.mintBatchSize ?? prev.raydiumClmm_mintBatchSize ?? 10),
            raydiumClmm_detailBatchSize: Number(j?.raydiumClmm?.detailBatchSize ?? prev.raydiumClmm_detailBatchSize ?? 50),
            // Raydium CPMM GraphQL
            raydiumCpmm_enabled: !!j?.raydiumCpmm?.enabled,
            raydiumCpmm_pageDelayMs: Number(j?.raydiumCpmm?.pageDelayMs ?? prev.raydiumCpmm_pageDelayMs ?? 200),
            raydiumCpmm_mintBatchSize: Number(j?.raydiumCpmm?.mintBatchSize ?? prev.raydiumCpmm_mintBatchSize ?? 10),
            raydiumCpmm_graphqlPageSize: Number(j?.raydiumCpmm?.graphqlPageSize ?? prev.raydiumCpmm_graphqlPageSize ?? 1000),
            raydiumCpmm_graphqlMaxPages: Number(j?.raydiumCpmm?.graphqlMaxPages ?? prev.raydiumCpmm_graphqlMaxPages ?? 50),
            raydiumCpmm_detailBatchSize: Number(j?.raydiumCpmm?.detailBatchSize ?? prev.raydiumCpmm_detailBatchSize ?? 50),
            // Orca GraphQL
            orca_useGraphQL: !!j?.orca?.useGraphQL,
            orca_shyftApiKey: j?.orca?.shyftApiKey || prev.orca_shyftApiKey || '',
            orca_pageDelayMs: Number(j?.orca?.pageDelayMs ?? prev.orca_pageDelayMs ?? 200),
            orca_mintBatchSize: Number(j?.orca?.mintBatchSize ?? prev.orca_mintBatchSize ?? 10),
            orca_graphqlPageSize: Number(j?.orca?.graphqlPageSize ?? prev.orca_graphqlPageSize ?? 1000),
            orca_graphqlMaxPages: Number(j?.orca?.graphqlMaxPages ?? prev.orca_graphqlMaxPages ?? 50),
            orca_detailBatchSize: Number(j?.orca?.detailBatchSize ?? prev.orca_detailBatchSize ?? 20),
            // Meteora GraphQL
            meteora_useGraphQL: !!j?.meteora?.useGraphQL,
            meteora_shyftApiKey: j?.meteora?.shyftApiKey || prev.meteora_shyftApiKey || '',
            meteora_pageDelayMs: Number(j?.meteora?.pageDelayMs ?? prev.meteora_pageDelayMs ?? 200),
            meteora_mintBatchSize: Number(j?.meteora?.mintBatchSize ?? prev.meteora_mintBatchSize ?? 10),
            meteora_graphqlPageSize: Number(j?.meteora?.graphqlPageSize ?? prev.meteora_graphqlPageSize ?? 1000),
            meteora_graphqlMaxPages: Number(j?.meteora?.graphqlMaxPages ?? prev.meteora_graphqlMaxPages ?? 50),
            meteora_detailBatchSize: Number(j?.meteora?.detailBatchSize ?? prev.meteora_detailBatchSize ?? 10),
            // Pumpswap GraphQL batch settings
            pumpswap_mintBatchSize: Number(j?.pumpswap?.mintBatchSize ?? prev.pumpswap_mintBatchSize ?? 10),
            pumpswap_graphqlPageSize: Number(j?.pumpswap?.graphqlPageSize ?? prev.pumpswap_graphqlPageSize ?? 1000),
            pumpswap_graphqlMaxPages: Number(j?.pumpswap?.graphqlMaxPages ?? prev.pumpswap_graphqlMaxPages ?? 50),
            // Sanity
            sanity_enabled: (j?.sanity?.enabled ?? true) !== false,
            sanity_maxPriceDeviation: Number(j?.sanity?.maxPriceDeviation ?? prev.sanity_maxPriceDeviation),
            sanity_feeMin: Number(j?.sanity?.feeMin ?? prev.sanity_feeMin),
            sanity_feeMax: Number(j?.sanity?.feeMax ?? prev.sanity_feeMax),
            sanity_writeSamples: !!j?.sanity?.writeSamples,
            sanity_sampleRate: Number(j?.sanity?.sampleRate ?? prev.sanity_sampleRate),
            sanity_applyRaydiumAmm: (j?.sanity?.sanity_applyRaydiumAmm ?? true) !== false,
            sanity_applyRaydiumClmm: (j?.sanity?.sanity_applyRaydiumClmm ?? true) !== false,
            sanity_applyOrcaClmm: (j?.sanity?.sanity_applyOrcaClmm ?? true) !== false,
          }));
        }
      } catch {}
    })();
  }, [apiBase]);

  const set = (k: string, v: any) => setCfg((p: any) => ({ ...p, [k]: v }));
  
  const [stoppingWs, setStoppingWs] = useState(false);
  
  const handleStopWs = async () => {
    if (stoppingWs) return;
    setStoppingWs(true);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) {
            headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
          }
        }
      } catch {}
      
      const response = await fetch(`${apiBase}/arb/pools/unsubscribe`, {
        method: 'POST',
        headers
      });
      
      if (!response.ok) {
        throw new Error(`Failed to stop WebSocket: ${response.statusText}`);
      }
      
      const result = await response.json();
      if (result.ok) {
        setError(null);
        // Optionally show a success message
        try {
          const tempSuccess = document.createElement('div');
          tempSuccess.className = 'text-green-400 text-sm mb-2';
          tempSuccess.textContent = '✅ WebSocket subscriptions stopped successfully';
          document.querySelector('.space-y-6')?.prepend(tempSuccess);
          setTimeout(() => tempSuccess.remove(), 3000);
        } catch {}
      }
    } catch (err: any) {
      setError(`Failed to stop WebSocket: ${err.message || err}`);
    } finally {
      setStoppingWs(false);
    }
  };

  const onSave = async () => {
    if (saving) return; setSaving(true); setError(null);
		const body: any = {
      system: {
        enablePoolWs: !!cfg.enablePoolWs,
        poolSubscriptionMode: cfg.poolSubscriptionMode || 'wss',
        grpc: {
          endpoint: String(cfg.grpc_endpoint || ''),
          xToken: String(cfg.grpc_xToken || ''),
          commitment: cfg.grpc_commitment || 'processed',
        },
        poolsRefreshMs: Number(cfg.poolsRefreshMs),
        poolRefreshMinGapMs: Number(cfg.poolRefreshMinGapMs),
        wsAttachPerSec: Number(cfg.wsAttachPerSec),
        tokenUniverseMode: cfg.tokenUniverseMode,
        jupiterTopTokens: {
          category: String(cfg.jupiterTopTokens_category || 'toptraded'),
          interval: String(cfg.jupiterTopTokens_interval || '24h'),
          limit: Math.max(1, Math.min(100, Number(cfg.jupiterTopTokens_limit) || 1)),
          cacheTtlMs: Math.max(30000, Number(cfg.jupiterTopTokens_cacheTtlMs) || 300000),
        },
        scopePoolsMode: cfg.scopePoolsMode,
        anchorMints: String(cfg.anchorMints || '').split(',').map(s => s.trim()).filter(Boolean),
        includeAnchorsInUniverse: !!cfg.includeAnchorsInUniverse,
        enableAnchorBridging: !!cfg.enableAnchorBridging,
        routeLevelScoping: !!cfg.routeLevelScoping,
        canonicalizePairs: cfg.canonicalizePairs,
        minAmmLiqBase: Number(cfg.minAmmLiqBase),
        minClmmLiquidity: Number(cfg.minClmmLiquidity),
        minPoolsPerPair: Number(cfg.minPoolsPerPair),
        enableActivityFilter: !!cfg.enableActivityFilter,
        maxInactivePoolMs: Number(cfg.maxInactivePoolMs),
        universePrefilterOrca: !!cfg.universePrefilterOrca,
        jupiterApiUrl: cfg.jupiterApiUrl,
        rpcMaxRps: Number(cfg.rpcMaxRps),
        rpcBurst: Number(cfg.rpcBurst),
        rpcMinGapMs: Number(cfg.rpcMinGapMs),
        enabledDexSources: {
          raydium: cfg.enabledDexSources_raydium ? 
            (cfg.enabledDexSources_raydium_amm && cfg.enabledDexSources_raydium_clmm && !cfg.enabledDexSources_raydium_cpmm ? true : 
              { amm: !!cfg.enabledDexSources_raydium_amm, clmm: !!cfg.enabledDexSources_raydium_clmm, cpmm: !!cfg.enabledDexSources_raydium_cpmm }) : false,
          orca: cfg.enabledDexSources_orca ? 
            (cfg.enabledDexSources_orca_amm && cfg.enabledDexSources_orca_clmm ? true : 
              { amm: !!cfg.enabledDexSources_orca_amm, clmm: !!cfg.enabledDexSources_orca_clmm }) : false,
          meteora: !!cfg.enabledDexSources_meteora,
          meteora_balanced: cfg.enabledDexSources_meteora_balanced ? 
            (cfg.enabledDexSources_meteora_balanced_v1 && cfg.enabledDexSources_meteora_balanced_v2 ? true : 
              { v1: !!cfg.enabledDexSources_meteora_balanced_v1, v2: !!cfg.enabledDexSources_meteora_balanced_v2 }) : false,
          pumpswap: !!cfg.enabledDexSources_pumpswap,
        },
      },
			raydium: {
			cacheTtlMs: Number(cfg.ray_cacheTtlMs),
			concurrency: Number(cfg.ray_httpConcurrency),
			pageSize: Number(cfg.ray_pageSize ?? cfg.ray_httpPageSize),
			maxPages: Number(cfg.ray_maxPages ?? 0),
			maxHttpRetries: Number(cfg.ray_maxHttpRetries ?? 2),
			httpBackoffMs: Number(cfg.ray_httpBackoffMs ?? 300),
			minAmmLiqBase: Number(cfg.ray_minAmmLiqBase),
			minClmmLiquidity: Number(cfg.ray_minClmmLiquidity),
      useGraphQL: !!cfg.raydium_useGraphQL,
      shyftApiKey: String(cfg.raydium_shyftApiKey || ''),
      pageDelayMs: Number(cfg.raydium_pageDelayMs || 200),
      mintBatchSize: Number(cfg.raydium_mintBatchSize || 10),
      graphqlPageSize: Number(cfg.raydium_graphqlPageSize || 1000),
      graphqlMaxPages: Number(cfg.raydium_graphqlMaxPages || 50),
      detailBatchSize: Number(cfg.raydium_detailBatchSize || 50),
		},
      raydiumClmm: {
        graphqlPageSize: Number(cfg.raydiumClmm_graphqlPageSize || 1000),
        graphqlMaxPages: Number(cfg.raydiumClmm_graphqlMaxPages || 50),
        pageDelayMs: Number(cfg.raydiumClmm_pageDelayMs || 200),
        mintBatchSize: Number(cfg.raydiumClmm_mintBatchSize || 10),
        detailBatchSize: Number(cfg.raydiumClmm_detailBatchSize || 50),
      },
      raydiumCpmm: {
        enabled: !!cfg.raydiumCpmm_enabled,
        pageDelayMs: Number(cfg.raydiumCpmm_pageDelayMs || 200),
        mintBatchSize: Number(cfg.raydiumCpmm_mintBatchSize || 10),
        graphqlPageSize: Number(cfg.raydiumCpmm_graphqlPageSize || 1000),
        graphqlMaxPages: Number(cfg.raydiumCpmm_graphqlMaxPages || 50),
        detailBatchSize: Number(cfg.raydiumCpmm_detailBatchSize || 50),
      },
      orca: {
        cacheTtlMs: Number(cfg.orca_cacheTtlMs),
        maxHttpRetries: Number(cfg.orca_maxHttpRetries),
        httpBackoffMs: Number(cfg.orca_httpBackoffMs),
        pageSize: Number(cfg.orca_pageSize),
        maxPages: Number(cfg.orca_maxPages),
        minAmmLiqBase: Number(cfg.orca_minAmmLiqBase),
        minClmmLiquidity: Number(cfg.orca_minClmmLiquidity),
        useGraphQL: !!cfg.orca_useGraphQL,
        shyftApiKey: String(cfg.orca_shyftApiKey || ''),
        pageDelayMs: Number(cfg.orca_pageDelayMs || 200),
        mintBatchSize: Number(cfg.orca_mintBatchSize || 10),
        graphqlPageSize: Number(cfg.orca_graphqlPageSize || 1000),
        graphqlMaxPages: Number(cfg.orca_graphqlMaxPages || 50),
        detailBatchSize: Number(cfg.orca_detailBatchSize || 20),
      },
      meteora: {
        apiUrl: cfg.meteora_apiUrl,
        cacheTtlMs: Number(cfg.meteora_cacheTtlMs),
        maxHttpRetries: Number(cfg.meteora_maxHttpRetries),
        httpBackoffMs: Number(cfg.meteora_httpBackoffMs),
        pageSize: Number(cfg.meteora_pageSize),
        maxPages: Number(cfg.meteora_maxPages),
        minClmmLiquidity: Number(cfg.meteora_minClmmLiquidity),
        universePrefilter: !!cfg.meteora_universePrefilter,
        useGraphQL: !!cfg.meteora_useGraphQL,
        shyftApiKey: String(cfg.meteora_shyftApiKey || ''),
        pageDelayMs: Number(cfg.meteora_pageDelayMs || 200),
        mintBatchSize: Number(cfg.meteora_mintBatchSize || 10),
        graphqlPageSize: Number(cfg.meteora_graphqlPageSize || 1000),
        graphqlMaxPages: Number(cfg.meteora_graphqlMaxPages || 50),
        detailBatchSize: Number(cfg.meteora_detailBatchSize || 10),
      },
      meteoraBalanced: {
        apiUrl: cfg.meteoraBalanced_apiUrl,
        apiUrlV2: cfg.meteoraBalanced_apiUrlV2,
        hideLowTvl: !!cfg.meteoraBalanced_hideLowTvl,
        hideLowApr: !!cfg.meteoraBalanced_hideLowApr,
        tokensVerified: !!cfg.meteoraBalanced_tokensVerified,
        minLiqBase: Number(cfg.meteoraBalanced_minLiqBase ?? 50),
        anchorTokensOnly: cfg.meteoraBalanced_anchorTokensOnly !== false,
        enableRpcEnrichment: cfg.meteoraBalanced_enableRpcEnrichment !== false,
        rpcBatchSize: Number(cfg.meteoraBalanced_rpcBatchSize ?? 100),
        cacheTtlMs: Number(cfg.meteoraBalanced_cacheTtlMs),
        maxHttpRetries: Number(cfg.meteoraBalanced_maxHttpRetries),
        httpBackoffMs: Number(cfg.meteoraBalanced_httpBackoffMs),
        pageSize: Number(cfg.meteoraBalanced_pageSize),
        maxPages: Number(cfg.meteoraBalanced_maxPages),
      },
      pumpswap: {
        shyftApiKey: String(cfg.pumpswap_shyftApiKey || ''),
        cacheTtlMs: Number(cfg.pumpswap_cacheTtlMs || 60000),
        maxHttpRetries: Number(cfg.pumpswap_maxHttpRetries || 2),
        httpBackoffMs: Number(cfg.pumpswap_httpBackoffMs || 500),
        defaultFeeBps: Number(cfg.pumpswap_defaultFeeBps || 30),
        minLiqBase: Number(cfg.pumpswap_minLiqBase || 0),
        pageSize: Number(cfg.pumpswap_pageSize || 1000),
        maxPages: Number(cfg.pumpswap_maxPages || 10),
        pageDelayMs: Number(cfg.pumpswap_pageDelayMs || 200),
        enableRpcEnrichment: !!cfg.pumpswap_enableRpcEnrichment,
        rpcBatchSize: Number(cfg.pumpswap_rpcBatchSize || 100),
        validatePrices: !!cfg.pumpswap_validatePrices,
        validationSamples: Number(cfg.pumpswap_validationSamples || 10),
        mintBatchSize: Number(cfg.pumpswap_mintBatchSize || 10),
        graphqlPageSize: Number(cfg.pumpswap_graphqlPageSize || 1000),
        graphqlMaxPages: Number(cfg.pumpswap_graphqlMaxPages || 50),
      },
      shyft: {
        apiKey: String(cfg.shyft_apiKey || ''),
      },
      sanity: {
        enabled: !!cfg.sanity_enabled,
        maxPriceDeviation: Number(cfg.sanity_maxPriceDeviation),
        feeMin: Number(cfg.sanity_feeMin),
        feeMax: Number(cfg.sanity_feeMax),
        writeSamples: !!cfg.sanity_writeSamples,
        sampleRate: Number(cfg.sanity_sampleRate),
        sanity_applyRaydiumAmm: !!cfg.sanity_applyRaydiumAmm,
        sanity_applyRaydiumClmm: !!cfg.sanity_applyRaydiumClmm,
        sanity_applyOrcaClmm: !!cfg.sanity_applyOrcaClmm,
      },
    };
    try {
      const r = await fetch(`${apiBase}${ROUTES.system.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('Failed to save');
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Data Fetchers & Normalizers</h2>
          <button className="text-gray-300 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {error ? <div className="text-red-400 text-sm mb-2">{error}</div> : null}

        <div className="space-y-6">
          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">System Refresh</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.enablePoolWs} onChange={(e)=>set('enablePoolWs', e.target.checked)} />Enable Pool Websocket</label>
              <div className="flex items-center gap-2">
                <button 
                  onClick={handleStopWs}
                  disabled={stoppingWs}
                  className="px-3 py-1 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded text-sm font-medium text-white transition-colors"
                  title="Immediately unsubscribe all pool and vault WebSocket subscriptions"
                >
                  {stoppingWs ? 'Stopping...' : '🛑 Stop WS'}
                </button>
                <span className="text-xs text-gray-400">Unsubscribe all pools & vaults</span>
              </div>
            <div>
              <label className="block text-sm mb-1">Unified Refresh Period (ms)</label>
              <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.poolsRefreshMs} onChange={(e)=>set('poolsRefreshMs', Number(e.target.value)||0)} />
            </div>
              <div>
                <label className="block text-sm mb-1">Min Gap Between Refreshes (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.poolRefreshMinGapMs} onChange={(e)=>set('poolRefreshMinGapMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">WS Attach Rate (pools/sec)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.wsAttachPerSec} onChange={(e)=>set('wsAttachPerSec', Number(e.target.value)||0)} />
              </div>
            </div>
          </div>

          {/* Pool Subscription Mode */}
          <div className="bg-gray-700 rounded p-4 border-2 border-amber-500">
            <h3 className="text-lg font-semibold mb-3">Pool Subscription Mode</h3>
            <div className="mb-4 text-sm text-gray-300 bg-amber-900/30 border border-amber-500/50 rounded p-3">
              <strong>gRPC Streaming:</strong> Low-latency pool updates via Yellowstone gRPC. 
              Uses 'processed' commitment for fastest updates (unconfirmed transactions).
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm mb-1">Subscription Mode</label>
                <select 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={cfg.poolSubscriptionMode} 
                  onChange={(e) => set('poolSubscriptionMode', e.target.value)}
                >
                  <option value="wss">WebSocket (RPC)</option>
                  <option value="grpc">gRPC (Yellowstone)</option>
                  <option value="disabled">Disabled</option>
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  {cfg.poolSubscriptionMode === 'wss' && 'Standard RPC WebSocket subscriptions (onAccountChange)'}
                  {cfg.poolSubscriptionMode === 'grpc' && 'Low-latency gRPC streaming via Shyft Yellowstone'}
                  {cfg.poolSubscriptionMode === 'disabled' && 'No real-time updates (HTTP polling only)'}
                </p>
              </div>
              
              <div>
                <label className="block text-sm mb-1">Commitment Level</label>
                <select 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={cfg.grpc_commitment} 
                  onChange={(e) => set('grpc_commitment', e.target.value)}
                  disabled={cfg.poolSubscriptionMode !== 'grpc'}
                >
                  <option value="processed">Processed (fastest, unconfirmed)</option>
                  <option value="confirmed">Confirmed (~400ms delay)</option>
                  <option value="finalized">Finalized (~2s delay)</option>
                </select>
              </div>
            </div>

            {cfg.poolSubscriptionMode === 'grpc' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-800/50 rounded p-3 border border-gray-600">
                <div className="md:col-span-2">
                  <label className="block text-sm mb-1">gRPC Endpoint</label>
                  <input 
                    type="text" 
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 font-mono text-sm" 
                    value={cfg.grpc_endpoint} 
                    onChange={(e) => set('grpc_endpoint', e.target.value)} 
                    placeholder="grpc.ams.shyft.to:443" 
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Shyft gRPC endpoint. Choose region closest to your server (ams, ny, etc.)
                  </p>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm mb-1">X-Token (Shyft API Key)</label>
                  <input 
                    type="password" 
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 font-mono text-sm" 
                    value={cfg.grpc_xToken} 
                    onChange={(e) => set('grpc_xToken', e.target.value)} 
                    placeholder="Your Shyft gRPC x-token" 
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Found in your Shyft dashboard under gRPC section
                  </p>
                </div>
              </div>
            )}

            <div className="mt-3 text-xs text-gray-300 bg-gray-600 rounded p-2">
              <strong>💡 gRPC Benefits:</strong> Single multiplexed stream, no per-subscription limits, 
              ~40% less bandwidth (Protobuf), slot-based delivery guarantees.
              <br />
              <strong>⚠️ Requires:</strong> Shyft gRPC subscription ($199+/mo) or dedicated node.
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">RPC Rate Limiter</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Max RPS (requests/sec)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.rpcMaxRps} onChange={(e)=>set('rpcMaxRps', Number(e.target.value)||0)} />
                <p className="text-xs text-gray-400 mt-1">Maximum RPC calls per second (default: 50)</p>
              </div>
              <div>
                <label className="block text-sm mb-1">Burst Capacity (tokens)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.rpcBurst} onChange={(e)=>set('rpcBurst', Number(e.target.value)||0)} />
                <p className="text-xs text-gray-400 mt-1">Token bucket capacity (default: 12). Lower = smoother RPS</p>
              </div>
              <div>
                <label className="block text-sm mb-1">Min Gap (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.rpcMinGapMs} onChange={(e)=>set('rpcMinGapMs', Number(e.target.value)||0)} />
                <p className="text-xs text-gray-400 mt-1">Minimum gap between calls (default: 20ms)</p>
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-300 bg-gray-600 rounded p-2">
              <strong>💡 To reduce RPS spikes:</strong> Lower burst capacity to 4-5 tokens. This limits initial burst while maintaining sustained rate.
              <br /><strong>⚠️ Note:</strong> Changes require backend restart to take effect (these are read from environment at startup).
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">DEX Source Control</h3>
            <p className="text-xs text-gray-300 mb-3">
              Control which DEX fetchers run during pool refresh. Disable sources to reduce API load or focus on specific DEXes during testing.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Raydium */}
              <div className="border border-gray-600 rounded p-3 bg-gray-800/30">
                <div className="flex items-center gap-2 mb-2">
                  <input 
                    type="checkbox" 
                    checked={!!cfg.enabledDexSources_raydium} 
                    onChange={(e)=>{
                      set('enabledDexSources_raydium', e.target.checked);
                      if (!e.target.checked) {
                        set('enabledDexSources_raydium_amm', false);
                        set('enabledDexSources_raydium_clmm', false);
                        set('enabledDexSources_raydium_cpmm', false);
                      }
                    }} 
                  />
                  <span className="font-semibold">Raydium</span>
                </div>
                {cfg.enabledDexSources_raydium && (
                  <div className="ml-6 space-y-1">
                    <label className="flex items-center gap-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!cfg.enabledDexSources_raydium_amm} 
                        onChange={(e)=>set('enabledDexSources_raydium_amm', e.target.checked)} 
                      />
                      AMM Pools
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!cfg.enabledDexSources_raydium_clmm} 
                        onChange={(e)=>set('enabledDexSources_raydium_clmm', e.target.checked)} 
                      />
                      CLMM Pools
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!cfg.enabledDexSources_raydium_cpmm} 
                        onChange={(e)=>set('enabledDexSources_raydium_cpmm', e.target.checked)} 
                      />
                      CPMM Pools
                    </label>
                  </div>
                )}
              </div>

              {/* Orca */}
              <div className="border border-gray-600 rounded p-3 bg-gray-800/30">
                <div className="flex items-center gap-2 mb-2">
                  <input 
                    type="checkbox" 
                    checked={!!cfg.enabledDexSources_orca} 
                    onChange={(e)=>{
                      set('enabledDexSources_orca', e.target.checked);
                      if (!e.target.checked) {
                        set('enabledDexSources_orca_amm', false);
                        set('enabledDexSources_orca_clmm', false);
                      }
                    }} 
                  />
                  <span className="font-semibold">Orca</span>
                </div>
                {cfg.enabledDexSources_orca && (
                  <div className="ml-6 space-y-1">
                    <label className="flex items-center gap-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!cfg.enabledDexSources_orca_amm} 
                        onChange={(e)=>set('enabledDexSources_orca_amm', e.target.checked)} 
                      />
                      AMM Pools
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!cfg.enabledDexSources_orca_clmm} 
                        onChange={(e)=>set('enabledDexSources_orca_clmm', e.target.checked)} 
                      />
                      CLMM Pools (Whirlpool)
                    </label>
                  </div>
                )}
              </div>

              {/* Meteora */}
              <div className="border border-gray-600 rounded p-3 bg-gray-800/30">
                <label className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    checked={!!cfg.enabledDexSources_meteora} 
                    onChange={(e)=>set('enabledDexSources_meteora', e.target.checked)} 
                  />
                  <span className="font-semibold">Meteora DLMM</span>
                </label>
                <p className="text-xs text-gray-400 ml-6 mt-1">Dynamic Liquidity Market Maker (CLMM)</p>
              </div>

              {/* Meteora Balanced */}
              <div className="border border-gray-600 rounded p-3 bg-gray-800/30">
                <label className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    checked={!!cfg.enabledDexSources_meteora_balanced} 
                    onChange={(e)=>{
                      set('enabledDexSources_meteora_balanced', e.target.checked);
                      if (!e.target.checked) {
                        set('enabledDexSources_meteora_balanced_v1', false);
                        set('enabledDexSources_meteora_balanced_v2', false);
                      }
                    }} 
                  />
                  <span className="font-semibold">Meteora Balanced</span>
                </label>
                <p className="text-xs text-gray-400 ml-6 mt-1">Dynamic AMM (DAMM) - includes V1 and V2</p>
                
                {/* V1/V2 Sub-toggles */}
                {cfg.enabledDexSources_meteora_balanced && (
                  <div className="ml-6 mt-2 flex gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!cfg.enabledDexSources_meteora_balanced_v1} 
                        onChange={(e)=>set('enabledDexSources_meteora_balanced_v1', e.target.checked)} 
                      />
                      <span>DAMM V1</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!cfg.enabledDexSources_meteora_balanced_v2} 
                        onChange={(e)=>set('enabledDexSources_meteora_balanced_v2', e.target.checked)} 
                      />
                      <span>DAMM V2</span>
                    </label>
                  </div>
                )}
              </div>

              {/* Pumpswap */}
              <div className="border border-gray-600 rounded p-3 bg-gray-800/30">
                <label className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    checked={!!cfg.enabledDexSources_pumpswap} 
                    onChange={(e)=>set('enabledDexSources_pumpswap', e.target.checked)} 
                  />
                  <span className="font-semibold">Pumpswap</span>
                </label>
                <p className="text-xs text-gray-400 ml-6 mt-1">pump.fun AMM pools</p>
              </div>
            </div>
            <div className="mt-3 text-xs text-gray-300 bg-gray-600 rounded p-2">
              <strong>💡 Tip:</strong> Disable unused DEXes during development to reduce API load and speed up refresh cycles. Changes take effect on the next pool refresh.
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Token Universe & Scoping</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Token Universe Mode</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.tokenUniverseMode} onChange={(e)=>set('tokenUniverseMode', e.target.value)}>
                  <option value="jupiter">jupiter</option>
                  <option value="watchlist">watchlist</option>
                  <option value="intersection">intersection</option>
                  <option value="union">union</option>
                  <option value="minpools">minpools</option>
                  <option value="jupiterTop">jupiterTop</option>
                  <option value="mergedTokens">mergedTokens</option>
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">Scope Pools Mode</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.scopePoolsMode} onChange={(e)=>set('scopePoolsMode', e.target.value)}>
                  <option value="none">none</option>
                  <option value="watchlist">watchlist</option>
                  <option value="jupiter">jupiter</option>
                  <option value="intersection">intersection</option>
                  <option value="union">union</option>
                  <option value="jupiterTop">jupiterTop</option>
                  <option value="mergedTokens">mergedTokens</option>
                </select>
              </div>
              <div className="md:col-span-1">
                <label className="block text-sm mb-1">Anchor Mints (CSV)</label>
                <input type="text" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.anchorMints} onChange={(e)=>set('anchorMints', e.target.value)} placeholder="So111...,EPjF..." />
              </div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.includeAnchorsInUniverse} onChange={(e)=>set('includeAnchorsInUniverse', e.target.checked)} />Include anchors in token universe</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.enableAnchorBridging} onChange={(e)=>set('enableAnchorBridging', e.target.checked)} />Enable anchor bridging during scoping</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.routeLevelScoping} onChange={(e)=>set('routeLevelScoping', e.target.checked)} />Apply scoping again in API routes</label>
              <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-4 gap-4 bg-gray-800/40 border border-gray-600 rounded p-3">
                <div>
                  <label className="block text-sm mb-1">Jupiter Top Category</label>
                  <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.jupiterTopTokens_category} onChange={(e)=>set('jupiterTopTokens_category', e.target.value)}>
                    <option value="toptraded">toptraded</option>
                    <option value="toporganicscore">toporganicscore</option>
                    <option value="toptrending">toptrending</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm mb-1">Interval</label>
                  <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.jupiterTopTokens_interval} onChange={(e)=>set('jupiterTopTokens_interval', e.target.value)}>
                    <option value="5m">5m</option>
                    <option value="1h">1h</option>
                    <option value="6h">6h</option>
                    <option value="24h">24h</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm mb-1">Limit (1-100)</label>
                  <input type="number" min={1} max={100} className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.jupiterTopTokens_limit} onChange={(e)=>set('jupiterTopTokens_limit', Number(e.target.value)||1)} />
                </div>
                <div>
                  <label className="block text-sm mb-1">Cache TTL (ms)</label>
                  <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.jupiterTopTokens_cacheTtlMs} onChange={(e)=>set('jupiterTopTokens_cacheTtlMs', Number(e.target.value)||0)} />
                  <p className="text-xs text-gray-400 mt-1">Used when token universe/scoping = jupiterTop</p>
                </div>
              </div>
              <div>
                <label className="block text-sm mb-1">Canonicalize Pairs</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.canonicalizePairs} onChange={(e)=>set('canonicalizePairs', e.target.value)}>
                  <option value="none">none</option>
                  <option value="lex">lex</option>
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">Global Min AMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.minAmmLiqBase} onChange={(e)=>set('minAmmLiqBase', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Global Min CLMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.minClmmLiquidity} onChange={(e)=>set('minClmmLiquidity', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Minimum Pools per Pair (1-3)</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.minPoolsPerPair} onChange={(e)=>set('minPoolsPerPair', Number(e.target.value)||1)}>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </div>
              <div className="md:col-span-3 bg-gray-800/40 border border-gray-600 rounded p-3">
                <h4 className="text-sm font-semibold mb-2">Pool Activity Filter</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      checked={!!cfg.enableActivityFilter} 
                      onChange={(e)=>set('enableActivityFilter', e.target.checked)} 
                    />
                    <span>Enable Activity Filter</span>
                  </label>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Max Inactive Time (hours)
                    </label>
                    <input 
                      type="number" 
                      min={0.1}
                      max={168}
                      step={0.5}
                      className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                      value={cfg.maxInactivePoolMs ? (cfg.maxInactivePoolMs / (60 * 60 * 1000)).toFixed(1) : 12} 
                      onChange={(e)=>set('maxInactivePoolMs', Math.max(0, Number(e.target.value) || 0) * 60 * 60 * 1000)}
                      disabled={!cfg.enableActivityFilter}
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      Filters pools with no on-chain activity in this time window
                    </p>
                  </div>
                </div>
                {cfg.enableActivityFilter && (
                  <div className="mt-2 text-xs text-gray-300 bg-blue-900/30 border border-blue-500/50 rounded p-2">
                    <strong>ℹ️ Note:</strong> This checks the most recent transaction for each pool via RPC. 
                    May take 1-3 minutes for large pool sets. Pools without recent activity will be filtered out.
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 md:col-span-3"><input type="checkbox" checked={!!cfg.universePrefilterOrca} onChange={(e)=>set('universePrefilterOrca', e.target.checked)} />Prefilter Orca HTTP by universe (conservative)</label>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4 border-2 border-blue-500">
            <h3 className="text-lg font-semibold mb-3">🚀 Shyft GraphQL (Token-Centric Fetching)</h3>
            <div className="mb-4 text-sm text-gray-300 bg-blue-900/30 border border-blue-500/50 rounded p-3">
              <strong>📊 New:</strong> Enable GraphQL fetching per DEX. Queries pools by token universe instead of pagination. HTTP fetching is used as automatic fallback on errors.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div className="md:col-span-2">
                <label className="block text-sm mb-1">Global Shyft API Key (Optional Fallback)</label>
                <input 
                  type="password" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 font-mono text-sm" 
                  value={cfg.shyft_apiKey} 
                  onChange={(e)=>set('shyft_apiKey', e.target.value)} 
                  placeholder="Uses Pumpswap key if empty" 
                />
                <p className="text-xs text-gray-400 mt-1">Shared across all DEXs. DEX-specific keys override this.</p>
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-gray-800/50 rounded p-3 border border-gray-600">
                <label className="flex items-center gap-2 mb-3">
                  <input type="checkbox" checked={!!cfg.raydium_useGraphQL} onChange={(e)=>set('raydium_useGraphQL', e.target.checked)} />
                  <span className="font-semibold">Enable Raydium GraphQL</span>
                </label>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">API Key (optional)</label>
                    <input 
                      type="password" 
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm font-mono" 
                      value={cfg.raydium_shyftApiKey} 
                      onChange={(e)=>set('raydium_shyftApiKey', e.target.value)}
                      disabled={!cfg.raydium_useGraphQL}
                      placeholder="Uses global/Pumpswap" 
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Page Delay (ms)</label>
                    <input 
                      type="number" 
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                      value={cfg.raydium_pageDelayMs} 
                      onChange={(e)=>set('raydium_pageDelayMs', Number(e.target.value)||0)}
                      disabled={!cfg.raydium_useGraphQL}
                    />
                  </div>
                  <div className="grid grid-cols-4 gap-1 pt-1 border-t border-gray-600">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Mint Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydium_mintBatchSize} 
                        onChange={(e)=>set('raydium_mintBatchSize', Number(e.target.value)||10)}
                        disabled={!cfg.raydium_useGraphQL}
                        min={1} max={50}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Page Size</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydium_graphqlPageSize} 
                        onChange={(e)=>set('raydium_graphqlPageSize', Number(e.target.value)||1000)}
                        disabled={!cfg.raydium_useGraphQL}
                        min={100} max={1000}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Max Pages</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydium_graphqlMaxPages} 
                        onChange={(e)=>set('raydium_graphqlMaxPages', Number(e.target.value)||50)}
                        disabled={!cfg.raydium_useGraphQL}
                        min={1} max={200}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Detail Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydium_detailBatchSize} 
                        onChange={(e)=>set('raydium_detailBatchSize', Number(e.target.value)||50)}
                        disabled={!cfg.raydium_useGraphQL}
                        min={1} max={100}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Total pools = Page Size × Max Pages (e.g., 1000 × 50 = 50k pools)</p>
                </div>
              </div>

              <div className="bg-gray-800/50 rounded p-3 border border-blue-600">
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-semibold text-blue-400">Raydium CLMM GraphQL Settings</span>
                  <span className="text-xs text-gray-400">(uses same GraphQL toggle as AMM)</span>
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Page Delay (ms)</label>
                    <input 
                      type="number" 
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                      value={cfg.raydiumClmm_pageDelayMs} 
                      onChange={(e)=>set('raydiumClmm_pageDelayMs', Number(e.target.value)||0)}
                      disabled={!cfg.raydium_useGraphQL}
                    />
                  </div>
                  <div className="grid grid-cols-4 gap-1 pt-1 border-t border-gray-600">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Mint Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydiumClmm_mintBatchSize} 
                        onChange={(e)=>set('raydiumClmm_mintBatchSize', Number(e.target.value)||10)}
                        disabled={!cfg.raydium_useGraphQL}
                        min={1} max={50}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Page Size</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydiumClmm_graphqlPageSize} 
                        onChange={(e)=>set('raydiumClmm_graphqlPageSize', Number(e.target.value)||1000)}
                        disabled={!cfg.raydium_useGraphQL}
                        min={100} max={1000}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Max Pages</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydiumClmm_graphqlMaxPages} 
                        onChange={(e)=>set('raydiumClmm_graphqlMaxPages', Number(e.target.value)||50)}
                        disabled={!cfg.raydium_useGraphQL}
                        min={1} max={200}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Detail Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydiumClmm_detailBatchSize} 
                        onChange={(e)=>set('raydiumClmm_detailBatchSize', Number(e.target.value)||50)}
                        disabled={!cfg.raydium_useGraphQL}
                        min={1} max={100}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Total pools = Page Size × Max Pages</p>
                </div>
              </div>

              <div className="bg-gray-800/50 rounded p-3 border border-orange-600">
                <label className="flex items-center gap-2 mb-3">
                  <input type="checkbox" checked={!!cfg.raydiumCpmm_enabled} onChange={(e)=>set('raydiumCpmm_enabled', e.target.checked)} />
                  <span className="font-semibold text-orange-400">Enable Raydium CPMM GraphQL</span>
                </label>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Page Delay (ms)</label>
                    <input 
                      type="number" 
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                      value={cfg.raydiumCpmm_pageDelayMs} 
                      onChange={(e)=>set('raydiumCpmm_pageDelayMs', Number(e.target.value)||0)}
                      disabled={!cfg.raydiumCpmm_enabled}
                    />
                  </div>
                  <div className="grid grid-cols-4 gap-1 pt-1 border-t border-gray-600">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Mint Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydiumCpmm_mintBatchSize} 
                        onChange={(e)=>set('raydiumCpmm_mintBatchSize', Number(e.target.value)||10)}
                        disabled={!cfg.raydiumCpmm_enabled}
                        min={1} max={50}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Page Size</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydiumCpmm_graphqlPageSize} 
                        onChange={(e)=>set('raydiumCpmm_graphqlPageSize', Number(e.target.value)||1000)}
                        disabled={!cfg.raydiumCpmm_enabled}
                        min={100} max={1000}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Max Pages</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydiumCpmm_graphqlMaxPages} 
                        onChange={(e)=>set('raydiumCpmm_graphqlMaxPages', Number(e.target.value)||50)}
                        disabled={!cfg.raydiumCpmm_enabled}
                        min={1} max={200}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Detail Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.raydiumCpmm_detailBatchSize} 
                        onChange={(e)=>set('raydiumCpmm_detailBatchSize', Number(e.target.value)||50)}
                        disabled={!cfg.raydiumCpmm_enabled}
                        min={1} max={100}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Total pools = Page Size × Max Pages</p>
                </div>
              </div>

              <div className="bg-gray-800/50 rounded p-3 border border-gray-600">
                <label className="flex items-center gap-2 mb-3">
                  <input type="checkbox" checked={!!cfg.orca_useGraphQL} onChange={(e)=>set('orca_useGraphQL', e.target.checked)} />
                  <span className="font-semibold">Enable Orca GraphQL</span>
                </label>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">API Key (optional)</label>
                    <input 
                      type="password" 
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm font-mono" 
                      value={cfg.orca_shyftApiKey} 
                      onChange={(e)=>set('orca_shyftApiKey', e.target.value)}
                      disabled={!cfg.orca_useGraphQL}
                      placeholder="Uses global/Pumpswap" 
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Page Delay (ms)</label>
                    <input 
                      type="number" 
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                      value={cfg.orca_pageDelayMs} 
                      onChange={(e)=>set('orca_pageDelayMs', Number(e.target.value)||0)}
                      disabled={!cfg.orca_useGraphQL}
                    />
                  </div>
                  <div className="grid grid-cols-4 gap-1 pt-1 border-t border-gray-600">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Mint Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.orca_mintBatchSize} 
                        onChange={(e)=>set('orca_mintBatchSize', Number(e.target.value)||10)}
                        disabled={!cfg.orca_useGraphQL}
                        min={1} max={50}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Page Size</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.orca_graphqlPageSize} 
                        onChange={(e)=>set('orca_graphqlPageSize', Number(e.target.value)||1000)}
                        disabled={!cfg.orca_useGraphQL}
                        min={100} max={1000}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Max Pages</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.orca_graphqlMaxPages} 
                        onChange={(e)=>set('orca_graphqlMaxPages', Number(e.target.value)||50)}
                        disabled={!cfg.orca_useGraphQL}
                        min={1} max={200}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Detail Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.orca_detailBatchSize} 
                        onChange={(e)=>set('orca_detailBatchSize', Number(e.target.value)||20)}
                        disabled={!cfg.orca_useGraphQL}
                        min={1} max={50}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Total pools = Page Size × Max Pages</p>
                </div>
              </div>

              <div className="bg-gray-800/50 rounded p-3 border border-gray-600">
                <label className="flex items-center gap-2 mb-3">
                  <input type="checkbox" checked={!!cfg.meteora_useGraphQL} onChange={(e)=>set('meteora_useGraphQL', e.target.checked)} />
                  <span className="font-semibold">Enable Meteora GraphQL</span>
                </label>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">API Key (optional)</label>
                    <input 
                      type="password" 
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm font-mono" 
                      value={cfg.meteora_shyftApiKey} 
                      onChange={(e)=>set('meteora_shyftApiKey', e.target.value)}
                      disabled={!cfg.meteora_useGraphQL}
                      placeholder="Uses global/Pumpswap" 
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Page Delay (ms)</label>
                    <input 
                      type="number" 
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                      value={cfg.meteora_pageDelayMs} 
                      onChange={(e)=>set('meteora_pageDelayMs', Number(e.target.value)||0)}
                      disabled={!cfg.meteora_useGraphQL}
                    />
                  </div>
                  <div className="grid grid-cols-4 gap-1 pt-1 border-t border-gray-600">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Mint Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.meteora_mintBatchSize} 
                        onChange={(e)=>set('meteora_mintBatchSize', Number(e.target.value)||10)}
                        disabled={!cfg.meteora_useGraphQL}
                        min={1} max={50}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Page Size</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.meteora_graphqlPageSize} 
                        onChange={(e)=>set('meteora_graphqlPageSize', Number(e.target.value)||1000)}
                        disabled={!cfg.meteora_useGraphQL}
                        min={100} max={1000}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Max Pages</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.meteora_graphqlMaxPages} 
                        onChange={(e)=>set('meteora_graphqlMaxPages', Number(e.target.value)||50)}
                        disabled={!cfg.meteora_useGraphQL}
                        min={1} max={200}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Detail Batch</label>
                      <input 
                        type="number" 
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                        value={cfg.meteora_detailBatchSize} 
                        onChange={(e)=>set('meteora_detailBatchSize', Number(e.target.value)||10)}
                        disabled={!cfg.meteora_useGraphQL}
                        min={1} max={50}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Total pools = Page Size × Max Pages</p>
                </div>
              </div>
            </div>

            {/* Pumpswap GraphQL Batch Settings */}
            <div className="mt-4 p-3 bg-gray-800/50 rounded border border-amber-600">
              <h4 className="text-sm font-semibold mb-2 text-amber-400">📦 Pumpswap GraphQL Batch Settings</h4>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Mint Batch Size</label>
                  <input 
                    type="number" 
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                    value={cfg.pumpswap_mintBatchSize} 
                    onChange={(e)=>set('pumpswap_mintBatchSize', Number(e.target.value)||10)}
                    min={1} max={50}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Page Size</label>
                  <input 
                    type="number" 
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                    value={cfg.pumpswap_graphqlPageSize} 
                    onChange={(e)=>set('pumpswap_graphqlPageSize', Number(e.target.value)||1000)}
                    min={100} max={1000}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Max Pages</label>
                  <input 
                    type="number" 
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm" 
                    value={cfg.pumpswap_graphqlMaxPages} 
                    onChange={(e)=>set('pumpswap_graphqlMaxPages', Number(e.target.value)||50)}
                    min={1} max={200}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-1">Total pools = Page Size × Max Pages</p>
            </div>

            <div className="mt-3 text-xs text-gray-300 bg-gray-600 rounded p-2">
              <strong>💡 Batch Settings:</strong><br/>
              • <strong>Mint Batch:</strong> How many token mints to include in each _in clause query. Lower = more queries but smaller responses.<br/>
              • <strong>Page Size:</strong> Pools per page returned by GraphQL (default: 1000). Max allowed by Shyft is typically 1000.<br/>
              • <strong>Max Pages:</strong> Maximum pagination pages per mint batch. Total pools = Page Size × Max Pages.<br/>
              • <strong>Detail Batch:</strong> Pools per detail query (fetches full pool data). Lower = safer for large pool sets.
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Raydium (HTTP)</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Cache TTL (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_cacheTtlMs} onChange={(e)=>set('ray_cacheTtlMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Concurrency</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_httpConcurrency} onChange={(e)=>set('ray_httpConcurrency', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Page Size</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_pageSize ?? cfg.ray_httpPageSize} onChange={(e)=>set('ray_pageSize', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max Pages (Global)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_maxPages ?? 0} onChange={(e)=>set('ray_maxPages', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max HTTP Retries</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_maxHttpRetries ?? 2} onChange={(e)=>set('ray_maxHttpRetries', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Backoff (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_httpBackoffMs ?? 300} onChange={(e)=>set('ray_httpBackoffMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min AMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_minAmmLiqBase} onChange={(e)=>set('ray_minAmmLiqBase', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min CLMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_minClmmLiquidity} onChange={(e)=>set('ray_minClmmLiquidity', Number(e.target.value)||0)} />
              </div>
            </div>
          </div>

        <div className="bg-gray-700 rounded p-4">
          <h3 className="text-lg font-semibold mb-3">Sanity Checks</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_enabled} onChange={(e)=>set('sanity_enabled', e.target.checked)} />Enable Sanity Filters</label>
              <div>
                <label className="block text-sm mb-1">Max Price Deviation (x)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_maxPriceDeviation} onChange={(e)=>set('sanity_maxPriceDeviation', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Fee Min (bps)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_feeMin} onChange={(e)=>set('sanity_feeMin', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Fee Max (bps)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_feeMax} onChange={(e)=>set('sanity_feeMax', Number(e.target.value)||0)} />
              </div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_writeSamples} onChange={(e)=>set('sanity_writeSamples', e.target.checked)} />Write Suspect Samples</label>
              <div>
                <label className="block text-sm mb-1">Sample Rate</label>
                <input type="number" step="0.001" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_sampleRate} onChange={(e)=>set('sanity_sampleRate', Number(e.target.value)||0)} />
              </div>
              <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyRaydiumAmm} onChange={(e)=>set('sanity_applyRaydiumAmm', e.target.checked)} />Apply to Raydium AMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyRaydiumClmm} onChange={(e)=>set('sanity_applyRaydiumClmm', e.target.checked)} />Apply to Raydium CLMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyOrcaClmm} onChange={(e)=>set('sanity_applyOrcaClmm', e.target.checked)} />Apply to Orca CLMM</label>
              </div>
            </div>
        </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Orca</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Cache TTL (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_cacheTtlMs} onChange={(e)=>set('orca_cacheTtlMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max HTTP Retries</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_maxHttpRetries} onChange={(e)=>set('orca_maxHttpRetries', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Backoff (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_httpBackoffMs} onChange={(e)=>set('orca_httpBackoffMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Page Size</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_pageSize} onChange={(e)=>set('orca_pageSize', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max Pages</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_maxPages} onChange={(e)=>set('orca_maxPages', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min AMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_minAmmLiqBase} onChange={(e)=>set('orca_minAmmLiqBase', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min CLMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_minClmmLiquidity} onChange={(e)=>set('orca_minClmmLiquidity', Number(e.target.value)||0)} />
              </div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Meteora (DLMM)</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm mb-1">API URL</label>
                <input type="url" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteora_apiUrl} onChange={(e)=>set('meteora_apiUrl', e.target.value)} placeholder="https://dlmm-api.meteora.ag/v1/pairs" />
              </div>
              <div>
                <label className="block text-sm mb-1">Cache TTL (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteora_cacheTtlMs} onChange={(e)=>set('meteora_cacheTtlMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max HTTP Retries</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteora_maxHttpRetries} onChange={(e)=>set('meteora_maxHttpRetries', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Backoff (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteora_httpBackoffMs} onChange={(e)=>set('meteora_httpBackoffMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Page Size</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteora_pageSize} onChange={(e)=>set('meteora_pageSize', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max Pages</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteora_maxPages} onChange={(e)=>set('meteora_maxPages', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min CLMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteora_minClmmLiquidity} onChange={(e)=>set('meteora_minClmmLiquidity', Number(e.target.value)||0)} />
              </div>
              <label className="flex items-center gap-2 md:col-span-3"><input type="checkbox" checked={!!cfg.meteora_universePrefilter} onChange={(e)=>set('meteora_universePrefilter', e.target.checked)} />Prefilter Meteora HTTP by universe (conservative)</label>
            </div>
          </div>

          {/* Meteora Balanced V1 Fetcher */}
          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Meteora Balanced V1 (DAMM API)</h3>
            
            {/* V1 Quality Filters */}
            <div className="mb-4 p-3 bg-gray-800/50 rounded border border-gray-600">
              <h4 className="text-sm font-semibold mb-2 text-blue-400">🎯 V1 Quality Filters</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input 
                    type="checkbox" 
                    checked={!!cfg.meteoraBalanced_anchorTokensOnly} 
                    onChange={(e)=>set('meteoraBalanced_anchorTokensOnly', e.target.checked)} 
                  />
                  <span>Anchor Tokens Only (SOL/USDC)</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input 
                    type="checkbox" 
                    checked={!!cfg.meteoraBalanced_hideLowApr} 
                    onChange={(e)=>set('meteoraBalanced_hideLowApr', e.target.checked)} 
                  />
                  <span>Hide Low APR Pools</span>
                </label>
              </div>
              <div className="mt-2 text-xs text-gray-400">
                💡 <strong>Anchor Tokens Only</strong> (recommended) fetches only SOL/USDC pairs for best quality and ~95% fewer API calls
              </div>
            </div>

            {/* V1 API URL */}
            <div className="mb-4">
              <label className="block text-sm mb-1">API URL (V1)</label>
              <input type="url" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm" value={cfg.meteoraBalanced_apiUrl} onChange={(e)=>set('meteoraBalanced_apiUrl', e.target.value)} placeholder="https://damm-api.meteora.ag/pools" />
            </div>

            {/* V1 Min Liquidity */}
            <div className="mb-4">
              <label className="block text-sm mb-1">Min Liquidity (USD)</label>
              <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteoraBalanced_minLiqBase} onChange={(e)=>set('meteoraBalanced_minLiqBase', Number(e.target.value)||0)} />
              <span className="text-xs text-gray-400">Minimum TVL threshold for API filtering (default: 50)</span>
            </div>

            {/* V1 HTTP Configuration */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm mb-1">Max HTTP Retries</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteoraBalanced_maxHttpRetries} onChange={(e)=>set('meteoraBalanced_maxHttpRetries', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Backoff (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteoraBalanced_httpBackoffMs} onChange={(e)=>set('meteoraBalanced_httpBackoffMs', Number(e.target.value)||0)} />
              </div>
            </div>
          </div>

          {/* Meteora Balanced V2 Fetcher */}
          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Meteora Balanced V2 (DAMM V2 API)</h3>
            
            {/* V2 Quality Filters */}
            <div className="mb-4 p-3 bg-gray-800/50 rounded border border-gray-600">
              <h4 className="text-sm font-semibold mb-2 text-purple-400">🎯 V2 Quality Filters</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input 
                    type="checkbox" 
                    checked={!!cfg.meteoraBalanced_tokensVerified} 
                    onChange={(e)=>set('meteoraBalanced_tokensVerified', e.target.checked)} 
                  />
                  <span>Verified Tokens Only</span>
                </label>
              </div>
              <div className="mt-2 text-xs text-gray-400">
                ℹ️ V2 API uses paginated fetching with optional token verification filter
              </div>
            </div>

            {/* V2 API URL */}
            <div className="mb-4">
              <label className="block text-sm mb-1">API URL (V2)</label>
              <input type="url" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm" value={cfg.meteoraBalanced_apiUrlV2} onChange={(e)=>set('meteoraBalanced_apiUrlV2', e.target.value)} placeholder="https://dammv2-api.meteora.ag/pools" />
            </div>

            {/* V2 RPC Enrichment */}
            <div className="mb-4 p-3 bg-gray-800/50 rounded border border-gray-600">
              <h4 className="text-sm font-semibold mb-2 text-green-400">⚙️ RPC Enrichment</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="flex items-center gap-2 mb-1">
                    <input 
                      type="checkbox" 
                      checked={!!cfg.meteoraBalanced_enableRpcEnrichment} 
                      onChange={(e)=>set('meteoraBalanced_enableRpcEnrichment', e.target.checked)} 
                    />
                    <span className="text-sm">Enable RPC Enrichment</span>
                  </label>
                  <p className="text-xs text-gray-400 mt-1">Fetch vault balances for precise reserves</p>
                </div>
                <div>
                  <label className="block text-sm mb-1">RPC Batch Size</label>
                  <input 
                    type="number" 
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                    value={cfg.meteoraBalanced_rpcBatchSize} 
                    onChange={(e)=>set('meteoraBalanced_rpcBatchSize', Number(e.target.value)||100)} 
                    disabled={!cfg.meteoraBalanced_enableRpcEnrichment}
                  />
                </div>
              </div>
            </div>

            {/* V2 HTTP Configuration */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Cache TTL (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteoraBalanced_cacheTtlMs} onChange={(e)=>set('meteoraBalanced_cacheTtlMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Page Size</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteoraBalanced_pageSize} onChange={(e)=>set('meteoraBalanced_pageSize', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max Pages</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.meteoraBalanced_maxPages} onChange={(e)=>set('meteoraBalanced_maxPages', Number(e.target.value)||0)} />
              </div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Pumpswap (Shyft GraphQL)</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-3">
                <label className="block text-sm mb-1">Shyft API Key</label>
                <input 
                  type="text" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={cfg.pumpswap_shyftApiKey || ''} 
                  onChange={(e)=>set('pumpswap_shyftApiKey', e.target.value)} 
                  placeholder="YOUR_SHYFT_API_KEY" 
                />
              </div>
              <div>
                <label className="block text-sm mb-1">Cache TTL (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_cacheTtlMs || 60000} onChange={(e)=>set('pumpswap_cacheTtlMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max HTTP Retries</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_maxHttpRetries || 2} onChange={(e)=>set('pumpswap_maxHttpRetries', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Backoff (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_httpBackoffMs || 500} onChange={(e)=>set('pumpswap_httpBackoffMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Page Size</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_pageSize || 1000} onChange={(e)=>set('pumpswap_pageSize', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max Pages</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_maxPages || 10} onChange={(e)=>set('pumpswap_maxPages', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Default Fee (bps)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_defaultFeeBps || 30} onChange={(e)=>set('pumpswap_defaultFeeBps', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min Liquidity (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_minLiqBase || 0} onChange={(e)=>set('pumpswap_minLiqBase', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Page Delay (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_pageDelayMs || 200} onChange={(e)=>set('pumpswap_pageDelayMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">RPC Batch Size</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_rpcBatchSize || 100} onChange={(e)=>set('pumpswap_rpcBatchSize', Number(e.target.value)||0)} />
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!cfg.pumpswap_enableRpcEnrichment} onChange={(e)=>set('pumpswap_enableRpcEnrichment', e.target.checked)} />
                Enable RPC Enrichment (fetches token balances for price/liquidity)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!cfg.pumpswap_validatePrices} onChange={(e)=>set('pumpswap_validatePrices', e.target.checked)} />
                Validate Prices (compare against other DEXes)
              </label>
              <div>
                <label className="block text-sm mb-1">Validation Samples (log count)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.pumpswap_validationSamples || 10} onChange={(e)=>set('pumpswap_validationSamples', Number(e.target.value)||0)} />
              </div>
              <div className="md:col-span-3 text-xs text-gray-300">
                Fetches pools involving SOL + USDC via Shyft's GraphQL API for pump.fun/Pumpswap coverage. RPC enrichment fetches token account balances to calculate accurate prices and liquidity. Price validation compares Pumpswap prices against other DEXes and logs deviations &gt;5%. Page Delay helps avoid rate limits.
              </div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Jupiter</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">API URL</label>
                <input type="url" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.jupiterApiUrl} onChange={(e)=>set('jupiterApiUrl', e.target.value)} placeholder="https://quote-api.jup.ag/v6" />
              </div>
              <div className="col-span-2 text-xs text-gray-300">Limiting is controlled by the backend rate limiter; API pause is exposed via terminal commands today.</div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button className="px-4 py-2 bg-gray-600 rounded text-white" onClick={onClose} disabled={saving}>Cancel</button>
            <button className={`px-4 py-2 ${saving?'bg-blue-500/60':'bg-blue-600 hover:bg-blue-700'} rounded text-white`} onClick={onSave} disabled={saving}>{saving?'Saving…':'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};


