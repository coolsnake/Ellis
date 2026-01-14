import React, { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../utils/api';

// Types matching backend
interface ProgramStatus {
  deployed: boolean;
  programId: string | null;
  dataSize: number | null;
  executable: boolean;
  upgradeAuthority: string | null;
  lastDeploySlot: number | null;
  cluster: string;
}

interface RouterConfig {
  programId: string | null;
  deployedAt: string | null;
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  executionMode: 'direct' | 'flash_loan' | 'auto';
  vaultOwner: string | null;
  flashLoanFeeBps: number;
  enabled: boolean;
}

interface CliStatus {
  solana: boolean;
  anchor: boolean;
  cluster: string;
}

interface RouterStatusResponse {
  success: boolean;
  status: ProgramStatus;
  config: RouterConfig;
  cli: CliStatus;
  ready: boolean;
  flashLoanAvailable: boolean;
}

// Types for pool data
interface PoolSummary {
  id: string;
  mintA: string;
  mintB: string;
  nativeMintA?: string;
  nativeMintB?: string;
  feeBps?: number;
  tickSpacing?: number;
  binStep?: number;
  liquidity?: number;
  sqrtPriceX64?: number;
  priceAPerB?: number;
  liquidityBase?: number;
}

interface PoolsByDex {
  raydium: { 
    clmm: PoolSummary[]; 
    amm: PoolSummary[]; 
    cpmm: PoolSummary[];
    clmmCount: number; 
    ammCount: number;
    cpmmCount: number;
  };
  orca: { clmm: PoolSummary[]; clmmCount: number };
  meteora: { dlmm: PoolSummary[]; dlmmCount: number };
  meteoraBalanced: { 
    amm: PoolSummary[]; 
    ammCount: number;
    dammV1: PoolSummary[];
    dammV2: PoolSummary[];
    dammV1Count: number;
    dammV2Count: number;
  };
  pumpswap: { amm: PoolSummary[]; ammCount: number };
}

interface ExecuteHop {
  dex: 'raydium' | 'raydium-amm' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora-damm' | 'meteora-damm-v2' | 'pumpswap';
  variant?: 'clmm' | 'amm' | 'cpmm' | 'dlmm' | 'damm_v1' | 'damm_v2';
  poolId: string;
  inputMint: string;
  outputMint: string;
}

interface TestExecuteResult {
  success: boolean;
  simulated?: boolean;
  signature?: string;
  error?: string | null;
  logs?: string[];
  unitsConsumed?: number;
  plan?: {
    hops: number;
    inputRaw: string;
    expectedOutputRaw: string;
  };
}

type RouterPanelProps = {
  apiBase: string;
  onClose: () => void;
};

export const RouterPanel: React.FC<RouterPanelProps> = ({ apiBase, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ProgramStatus | null>(null);
  const [config, setConfig] = useState<RouterConfig | null>(null);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [flashLoanAvailable, setFlashLoanAvailable] = useState(false);
  
  const [building, setBuilding] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [closing, setClosing] = useState(false);
  const [selectedCluster, setSelectedCluster] = useState<'devnet' | 'mainnet-beta' | 'localnet'>('devnet');
  const [forceNewProgramId, setForceNewProgramId] = useState(false);
  const [actionLogs, setActionLogs] = useState<string[]>([]);

  const [hops, setHops] = useState<number>(1);
  const [testDex, setTestDex] = useState<'raydium' | 'meteora' | 'orca'>('raydium');
  const [testVariant, setTestVariant] = useState<'clmm' | 'dlmm' | 'whirlpool'>('clmm');
  const [testPoolId, setTestPoolId] = useState('');
  const [testSecondPoolId, setTestSecondPoolId] = useState('');
  const [testSecondDex, setTestSecondDex] = useState<'raydium' | 'meteora' | 'orca'>('raydium');
  const [testSecondVariant, setTestSecondVariant] = useState<'clmm' | 'dlmm' | 'whirlpool'>('clmm');
  const [testInputMint, setTestInputMint] = useState('So11111111111111111111111111111111111111112');
  const [testOutputMint, setTestOutputMint] = useState('USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT');
  const [testAmountIn, setTestAmountIn] = useState('10000000');
  const [testMinAmountOut, setTestMinAmountOut] = useState('1');
  const [testSimulate, setTestSimulate] = useState(true);
  const [testingSwap, setTestingSwap] = useState(false);
  const [testSwapResult, setTestSwapResult] = useState<{success: boolean; signature?: string; error?: string} | null>(null);

  // Multi-hop Execute Testing State
  const [poolsByDex, setPoolsByDex] = useState<PoolsByDex | null>(null);
  const [loadingPools, setLoadingPools] = useState(false);
  const [executeHops, setExecuteHops] = useState<ExecuteHop[]>([
    { dex: 'raydium', variant: 'clmm', poolId: '', inputMint: '', outputMint: '' }
  ]);
  const [executeAmountIn, setExecuteAmountIn] = useState('10000000');
  const [executeMinProfit, setExecuteMinProfit] = useState('-10000000'); // Allow loss for testing
  const [executeSimulate, setExecuteSimulate] = useState(true);
  const [testingExecute, setTestingExecute] = useState(false);
  const [executeResult, setExecuteResult] = useState<TestExecuteResult | null>(null);

  // MarginFi Flashloan Testing State
  const [flashloanToken, setFlashloanToken] = useState<'SOL' | 'USDC'>('SOL');
  const [flashloanAmount, setFlashloanAmount] = useState('0.001'); // In token units (e.g., 0.001 SOL)
  const [flashloanSimulate, setFlashloanSimulate] = useState(true);
  const [testingFlashloan, setTestingFlashloan] = useState(false);
  const [flashloanResult, setFlashloanResult] = useState<{
    success: boolean;
    simulated?: boolean;
    signature?: string;
    error?: string;
    logs?: string[];
    unitsConsumed?: number;
    marginfiAccount?: string;
    formattedAmount?: string;
  } | null>(null);
  const [flashloanPrerequisites, setFlashloanPrerequisites] = useState<{
    ready?: boolean;
    hasMarginfiAccount?: boolean;
    willCreateAccount?: boolean;
    hasTokenBalance?: boolean;
    marginfiAccount?: string;
    tokenBalance?: string;
    error?: string;
    recommendedAmount?: string;
  } | null>(null);
  const [checkingPrerequisites, setCheckingPrerequisites] = useState(false);

  // Update variant when DEX changes
  const handleDexChange = (dex: 'raydium' | 'meteora' | 'orca') => {
    setTestDex(dex);
    if (dex === 'raydium') setTestVariant('clmm');
    else if (dex === 'meteora') setTestVariant('dlmm');
    else if (dex === 'orca') setTestVariant('whirlpool');
  };
  
  const handleSecondDexChange = (dex: 'raydium' | 'meteora' | 'orca') => {
    setTestSecondDex(dex);
    if (dex === 'raydium') setTestSecondVariant('clmm');
    else if (dex === 'meteora') setTestSecondVariant('dlmm');
    else if (dex === 'orca') setTestSecondVariant('whirlpool');
  };

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiGet<RouterStatusResponse>('/router/status');
      if (data.success) {
        setStatus(data.status);
        setConfig(data.config);
        setCli(data.cli);
        setReady(data.ready);
        setFlashLoanAvailable(data.flashLoanAvailable);
        if (data.config?.cluster) {
          setSelectedCluster(data.config.cluster);
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Fetch pools for multi-hop execute testing
  const fetchPools = useCallback(async () => {
    try {
      setLoadingPools(true);
      const data = await apiGet<{ success: boolean; pools: PoolsByDex }>('/router/pools?limit=200');
      if (data.success) {
        setPoolsByDex(data.pools);
      }
    } catch (err: any) {
      console.error('Failed to fetch pools:', err);
    } finally {
      setLoadingPools(false);
    }
  }, []);

  // Fetch pools when panel opens if program is deployed
  useEffect(() => {
    if (status?.deployed && !poolsByDex) {
      fetchPools();
    }
  }, [status?.deployed, poolsByDex, fetchPools]);

  // Helper to get pools for a DEX (used by updateExecuteHop before getPoolsForDex is defined)
  const getPoolsForDexInternal = (dex: ExecuteHop['dex']): PoolSummary[] => {
    if (!poolsByDex) return [];
    switch (dex) {
      case 'raydium': return poolsByDex.raydium?.clmm || [];
      case 'raydium-amm': return poolsByDex.raydium?.amm || [];
      case 'raydium-cpmm': return poolsByDex.raydium?.cpmm || [];
      case 'orca': return poolsByDex.orca?.clmm || [];
      case 'meteora': return poolsByDex.meteora?.dlmm || [];
      case 'meteora-damm': return poolsByDex.meteoraBalanced?.dammV1 || [];
      case 'meteora-damm-v2': return poolsByDex.meteoraBalanced?.dammV2 || [];
      case 'pumpswap': return poolsByDex.pumpswap?.amm || [];
      default: return [];
    }
  };

  // Handler for execute hop changes
  const updateExecuteHop = (index: number, field: keyof ExecuteHop, value: string) => {
    setExecuteHops(prevHops => {
      const newHops = [...prevHops];
      newHops[index] = { ...newHops[index], [field]: value };
      
      // Auto-populate mints when pool is selected
      if (field === 'poolId' && value && poolsByDex) {
        const dex = newHops[index].dex;
        const pools = getPoolsForDexInternal(dex);
        
        const pool = pools.find(p => p.id === value);
        if (pool) {
          newHops[index].inputMint = pool.mintA || pool.nativeMintA || '';
          newHops[index].outputMint = pool.mintB || pool.nativeMintB || '';
        }
      }
      
      return newHops;
    });
  };
  
  // Handler for DEX changes in execute hops - clears pool and mints when DEX changes
  const handleExecuteDexChange = (index: number, newDex: string) => {
    setExecuteHops(prevHops => {
      const newHops = [...prevHops];
      // Determine variant based on DEX selection
      let variant: ExecuteHop['variant'];
      switch (newDex) {
        case 'raydium': variant = 'clmm'; break;
        case 'raydium-amm': variant = 'amm'; break;
        case 'raydium-cpmm': variant = 'cpmm'; break;
        case 'orca': variant = 'clmm'; break;
        case 'meteora': variant = 'dlmm'; break;
        case 'meteora-damm': variant = 'damm_v1'; break;
        case 'meteora-damm-v2': variant = 'damm_v2'; break;
        case 'pumpswap': variant = 'amm'; break;
        default: variant = undefined;
      }
      
      newHops[index] = {
        ...newHops[index],
        dex: newDex as ExecuteHop['dex'],
        variant,
        poolId: '',
        inputMint: '',
        outputMint: '',
      };
      return newHops;
    });
  };

  const addExecuteHop = () => {
    const lastHop = executeHops[executeHops.length - 1];
    setExecuteHops([...executeHops, {
      dex: 'raydium',
      variant: 'clmm',
      poolId: '',
      inputMint: lastHop?.outputMint || '', // Chain output to next input
      outputMint: ''
    }]);
  };

  const removeExecuteHop = (index: number) => {
    if (executeHops.length > 1) {
      setExecuteHops(executeHops.filter((_, i) => i !== index));
    }
  };

  const handleTestExecute = async () => {
    if (executeHops.some(h => !h.poolId || !h.inputMint || !h.outputMint)) {
      setExecuteResult({ success: false, error: 'All hop fields required' });
      return;
    }

    setTestingExecute(true);
    setExecuteResult(null);

    try {
      const result = await apiPost<TestExecuteResult>('/router/test-execute', {
        hops: executeHops.map(h => ({
          poolId: h.poolId,
          dex: h.dex,
          variant: h.variant,
          inputMint: h.inputMint,
          outputMint: h.outputMint,
        })),
        amountIn: executeAmountIn,
        minProfit: executeMinProfit,
        simulate: executeSimulate,
      });
      setExecuteResult(result);
    } catch (err: any) {
      setExecuteResult({ success: false, error: err.message });
    } finally {
      setTestingExecute(false);
    }
  };

  // Get pools for a specific DEX
  const getPoolsForDex = (dex: ExecuteHop['dex']): PoolSummary[] => {
    if (!poolsByDex) return [];
    switch (dex) {
      case 'raydium':
        return poolsByDex.raydium?.clmm || [];
      case 'raydium-amm':
        return poolsByDex.raydium?.amm || [];
      case 'raydium-cpmm':
        return poolsByDex.raydium?.cpmm || [];
      case 'orca':
        return poolsByDex.orca?.clmm || [];
      case 'meteora':
        return poolsByDex.meteora?.dlmm || [];
      case 'meteora-damm':
        return poolsByDex.meteoraBalanced?.dammV1 || [];
      case 'meteora-damm-v2':
        return poolsByDex.meteoraBalanced?.dammV2 || [];
      case 'pumpswap':
        return poolsByDex.pumpswap?.amm || [];
      default:
        return [];
    }
  };

  const handleBuild = async () => {
    if (building) return;
    setBuilding(true);
    setActionLogs(['Starting build...']);
    setError(null);
    
    try {
      const result = await apiPost<{ success: boolean; binaryPath?: string; error?: string; logs?: string[] }>('/router/build');
      if (result.logs) {
        setActionLogs(prev => [...prev, ...result.logs!]);
      }
      if (result.success) {
        setActionLogs(prev => [...prev, `Build successful: ${result.binaryPath}`]);
      } else {
        setActionLogs(prev => [...prev, `Build failed: ${result.error}`]);
        setError(result.error || 'Build failed');
      }
    } catch (err: any) {
      setError(err.message);
      setActionLogs(prev => [...prev, `Error: ${err.message}`]);
    } finally {
      setBuilding(false);
    }
  };

  const handleDeploy = async () => {
    if (deploying) return;
    
    // Confirm if forcing new program ID
    if (forceNewProgramId) {
      const confirmed = window.confirm(
        'Generate New Program ID?\n\n' +
        'This will:\n' +
        '• Generate a new program keypair\n' +
        '• Update source files (lib.rs, Anchor.toml)\n' +
        '• Rebuild the program\n' +
        '• Deploy with the new ID\n\n' +
        'Use this after closing a program or if the previous ID is unusable.'
      );
      if (!confirmed) return;
    }
    
    setDeploying(true);
    setActionLogs(forceNewProgramId 
      ? ['Starting deployment with new program ID...'] 
      : ['Starting deployment...']
    );
    setError(null);
    
    try {
      const result = await apiPost<{ success: boolean; programId?: string; error?: string; logs?: string[] }>(
        '/router/deploy',
        { cluster: selectedCluster, forceNewProgramId }
      );
      if (result.logs) {
        setActionLogs(prev => [...prev, ...result.logs!]);
      }
      if (result.success) {
        setActionLogs(prev => [...prev, `Deployed successfully: ${result.programId}`]);
        setForceNewProgramId(false); // Reset checkbox after successful deploy
        await fetchStatus();
      } else {
        setActionLogs(prev => [...prev, `Deploy failed: ${result.error}`]);
        setError(result.error || 'Deploy failed');
      }
    } catch (err: any) {
      setError(err.message);
      setActionLogs(prev => [...prev, `Error: ${err.message}`]);
    } finally {
      setDeploying(false);
    }
  };

  const handleUpgrade = async () => {
    if (deploying || !config?.programId) return;
    setDeploying(true);
    setActionLogs(['Starting upgrade...']);
    setError(null);
    
    try {
      const result = await apiPost<{ success: boolean; error?: string; logs?: string[] }>('/router/upgrade');
      if (result.logs) {
        setActionLogs(prev => [...prev, ...result.logs!]);
      }
      if (result.success) {
        setActionLogs(prev => [...prev, 'Upgrade successful']);
        await fetchStatus();
      } else {
        setActionLogs(prev => [...prev, `Upgrade failed: ${result.error}`]);
        setError(result.error || 'Upgrade failed');
      }
    } catch (err: any) {
      setError(err.message);
      setActionLogs(prev => [...prev, `Error: ${err.message}`]);
    } finally {
      setDeploying(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!config) return;
    try {
      await apiPost('/router/config/enabled', { enabled: !config.enabled });
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleModeChange = async (mode: string) => {
    try {
      await apiPost('/router/config/mode', { mode });
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleAirdrop = async () => {
    try {
      setActionLogs(prev => [...prev, 'Requesting airdrop...']);
      const result = await apiPost<{ success: boolean; balance?: number; error?: string }>('/router/airdrop', { amount: 2 });
      if (result.success) {
        setActionLogs(prev => [...prev, `Airdrop successful. New balance: ${result.balance?.toFixed(4)} SOL`]);
      } else {
        setActionLogs(prev => [...prev, `Airdrop failed: ${result.error}`]);
      }
    } catch (err: any) {
      setActionLogs(prev => [...prev, `Airdrop error: ${err.message}`]);
    }
  };

  const handleCloseProgram = async () => {
    if (closing || !config?.programId) return;
    
    // Confirmation dialog
    const confirmed = window.confirm(
      `Are you sure you want to close the program?\n\n` +
      `Program ID: ${config.programId}\n` +
      `Cluster: ${status?.cluster || 'unknown'}\n\n` +
      `This will:\n` +
      `- Stop the program from being executable\n` +
      `- Recover the rent (~2-3 SOL) to your wallet\n\n` +
      `This action cannot be undone. You would need to redeploy.`
    );
    
    if (!confirmed) return;
    
    setClosing(true);
    setActionLogs(['Starting program closure...']);
    setError(null);
    
    try {
      const result = await apiPost<{ 
        success: boolean; 
        rentRecovered?: number; 
        error?: string; 
        logs?: string[] 
      }>('/router/close');
      
      if (result.logs) {
        setActionLogs(prev => [...prev, ...result.logs!]);
      }
      
      if (result.success) {
        const rentSol = result.rentRecovered 
          ? (result.rentRecovered / 1e9).toFixed(6) 
          : 'unknown';
        setActionLogs(prev => [
          ...prev, 
          `Program closed successfully`,
          `Rent recovered: ${rentSol} SOL`
        ]);
        await fetchStatus();
      } else {
        setActionLogs(prev => [...prev, `Close failed: ${result.error}`]);
        setError(result.error || 'Close failed');
      }
    } catch (err: any) {
      setError(err.message);
      setActionLogs(prev => [...prev, `Error: ${err.message}`]);
    } finally {
      setClosing(false);
    }
  };

  const getSolscanUrl = (programId: string, cluster: string) => {
    const base = cluster === 'mainnet-beta' ? 'https://solscan.io' : 'https://solscan.io';
    const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
    return `${base}/account/${programId}${clusterParam}`;
  };

  const handleTestSwap = async () => {
    if (!testPoolId) {
      setTestSwapResult({ success: false, error: 'Pool ID required' });
      return;
    }
    if (hops === 2 && !testSecondPoolId) {
      setTestSwapResult({ success: false, error: 'Second Pool ID required for 2-hop swap' });
      return;
    }

    setTestingSwap(true);
    setTestSwapResult(null);
    
    try {
      const result = await apiPost('/router/test/swap', {
        poolId: testPoolId,
        dex: testDex,
        variant: testVariant,
        inputMint: testInputMint || undefined,
        outputMint: testOutputMint || undefined,
        amountIn: testAmountIn,
        minAmountOut: testMinAmountOut,
        simulate: testSimulate,
        useRouter: true,
        hops,
        secondPoolId: hops === 2 ? testSecondPoolId : undefined,
        secondDex: hops === 2 ? testSecondDex : undefined,
        secondVariant: hops === 2 ? testSecondVariant : undefined,
      });
      
      setTestSwapResult({
        success: result.success,
        signature: result.signature,
        error: result.error,
      });
    } catch (err: any) {
      setTestSwapResult({ success: false, error: err.message });
    } finally {
      setTestingSwap(false);
    }
  };

  // MarginFi Flashloan handlers
  const checkFlashloanPrerequisites = async () => {
    setCheckingPrerequisites(true);
    setFlashloanPrerequisites(null);
    
    try {
      const result = await apiGet<{
        success: boolean;
        ready?: boolean;
        hasMarginfiAccount?: boolean;
        willCreateAccount?: boolean;
        hasTokenBalance?: boolean;
        marginfiAccount?: string;
        tokenBalance?: string;
        error?: string;
        recommendedAmount?: string;
      }>(`/router/flashloan/prerequisites?token=${flashloanToken}&amount=${flashloanAmount}`);
      
      setFlashloanPrerequisites(result);
      if (result.recommendedAmount && !flashloanAmount) {
        setFlashloanAmount(result.recommendedAmount);
      }
    } catch (err: any) {
      setFlashloanPrerequisites({ error: err.message });
    } finally {
      setCheckingPrerequisites(false);
    }
  };

  const handleTestFlashloan = async () => {
    setTestingFlashloan(true);
    setFlashloanResult(null);
    
    try {
      const result = await apiPost<{
        success: boolean;
        simulated?: boolean;
        signature?: string;
        error?: string;
        logs?: string[];
        unitsConsumed?: number;
        marginfiAccount?: string;
        formattedAmount?: string;
      }>('/router/flashloan/test', {
        token: flashloanToken,
        amount: flashloanAmount,
        simulate: flashloanSimulate,
      });
      
      setFlashloanResult(result);
    } catch (err: any) {
      setFlashloanResult({ success: false, error: err.message });
    } finally {
      setTestingFlashloan(false);
    }
  };

  // Update recommended amount when token changes
  const handleFlashloanTokenChange = (token: 'SOL' | 'USDC') => {
    setFlashloanToken(token);
    // Set default amounts based on token
    if (token === 'SOL') {
      setFlashloanAmount('1000000'); // 0.001 SOL
    } else {
      setFlashloanAmount('1000'); // 0.001 USDC
    }
    setFlashloanPrerequisites(null);
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-gray-800 rounded-lg p-6 w-full max-w-2xl">
          <div className="text-white text-center">Loading router status...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Arb Router Program</h2>
          <button className="text-gray-300 hover:text-white text-xl" onClick={onClose}>✕</button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-600 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* CLI Status */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <h3 className="text-lg font-semibold text-white mb-3">CLI Status</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${cli?.solana ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-gray-300">Solana CLI</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${cli?.anchor ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-gray-300">Anchor CLI</span>
            </div>
            <div className="text-gray-300">
              Cluster: <span className="text-white font-mono">{cli?.cluster || 'unknown'}</span>
            </div>
          </div>
        </div>

        {/* Program Status */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <h3 className="text-lg font-semibold text-white mb-3">Program Status</h3>
          
          {/* Manual Program ID Entry */}
          {!config?.programId && (
            <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-600 rounded text-sm">
              <div className="font-medium text-yellow-300 mb-2">Program ID Not Set</div>
              <div className="text-yellow-400 text-xs mb-3">
                If you deployed the program manually, enter the program ID below to track it.
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter program ID (e.g., ArbRtr1111111111111111111111111111111111111)"
                  className="flex-1 bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm font-mono"
                  id="manual-program-id"
                />
                <button
                  onClick={async () => {
                    const input = document.getElementById('manual-program-id') as HTMLInputElement;
                    const programId = input?.value.trim();
                    if (!programId) {
                      setError('Please enter a program ID');
                      return;
                    }
                    try {
                      await apiPost('/router/config', { programId });
                      setActionLogs(prev => [...prev, `Program ID set: ${programId}`]);
                      await fetchStatus();
                      input.value = '';
                    } catch (err: any) {
                      setError(err.message || 'Failed to set program ID');
                    }
                  }}
                  className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded text-sm font-medium"
                >
                  Set Program ID
                </button>
              </div>
            </div>
          )}
          
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <span className="text-gray-400 text-sm">Status:</span>
              <div className="flex items-center gap-2 mt-1">
                <span className={`w-2 h-2 rounded-full ${status?.deployed ? 'bg-green-500' : 'bg-yellow-500'}`} />
                <span className="text-white">{status?.deployed ? 'Deployed' : 'Not Deployed'}</span>
              </div>
            </div>
            <div>
              <span className="text-gray-400 text-sm">Router Enabled:</span>
              <div className="mt-1">
                <button
                  onClick={handleToggleEnabled}
                  className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                    config?.enabled
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                  }`}
                >
                  {config?.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            </div>
          </div>

          {status?.deployed && config?.programId && (
            <div className="space-y-2">
              <div>
                <span className="text-gray-400 text-sm">Program ID:</span>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-green-400 text-sm font-mono bg-gray-900/50 px-2 py-1 rounded">
                    {config.programId}
                  </code>
                  <a
                    href={getSolscanUrl(config.programId, status.cluster)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 text-sm"
                  >
                    View on Solscan ↗
                  </a>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-400">Data Size:</span>
                  <span className="text-white ml-2">{status.dataSize?.toLocaleString()} bytes</span>
                </div>
                <div>
                  <span className="text-gray-400">Executable:</span>
                  <span className={`ml-2 ${status.executable ? 'text-green-400' : 'text-red-400'}`}>
                    {status.executable ? 'Yes' : 'No'}
                  </span>
                </div>
              </div>
              
              <div className="mt-3 pt-3 border-t border-gray-600">
                <span className="text-gray-400 text-sm">Upgrade Authority:</span>
                <div className="mt-1">
                  {status.upgradeAuthority ? (
                    <div className="flex items-center gap-2">
                      <code className="text-green-400 text-xs font-mono bg-gray-900/50 px-2 py-1 rounded">
                        {status.upgradeAuthority.slice(0, 8)}...{status.upgradeAuthority.slice(-8)}
                      </code>
                      <span className="text-green-400 text-xs">Closeable</span>
                    </div>
                  ) : (
                    <span className="text-yellow-400 text-sm">
                      No upgrade authority (immutable) - rent not recoverable
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Execution Mode */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <h3 className="text-lg font-semibold text-white mb-3">Execution Mode</h3>
          <div className="flex gap-2">
            {(['direct', 'flash_loan', 'auto'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => handleModeChange(mode)}
                className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
                  config?.executionMode === mode
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                }`}
              >
                {mode === 'flash_loan' ? 'Flash Loan' : mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
          <p className="mt-2 text-gray-400 text-sm">
            {config?.executionMode === 'direct' && 'Execute swaps with your own tokens'}
            {config?.executionMode === 'flash_loan' && 'Borrow from vault, execute arb, repay with profit'}
            {config?.executionMode === 'auto' && 'Use flash loan if vault has funds, otherwise direct'}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${flashLoanAvailable ? 'bg-green-500' : 'bg-gray-500'}`} />
            <span className="text-gray-400 text-sm">
              Flash Loan: {flashLoanAvailable ? 'Available' : 'Not Available'}
            </span>
          </div>
        </div>

        {/* Test Swap Section - Debug Mode (fetches on-chain) */}
        {status?.deployed && (
          <div className="mb-6 p-4 bg-gray-700/50 rounded-lg border border-yellow-600/30">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-yellow-400 text-xs font-medium px-2 py-0.5 bg-yellow-900/40 rounded">DEBUG MODE</span>
              <h3 className="text-lg font-semibold text-white">Pool Swap Test</h3>
            </div>
            <p className="text-gray-400 text-xs mb-3">
              Fetches pool data fresh from on-chain. Use for debugging new pools or verifying account ordering.
            </p>
            
            <div className="space-y-4">
              <div>
                <label className="block text-gray-400 text-sm mb-2">Number of Hops</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setHops(1)}
                    className={`px-4 py-2 rounded text-sm ${
                      hops === 1 ? 'bg-blue-600 text-white' : 'bg-gray-600 text-gray-300'
                    }`}
                  >
                    Single Hop
                  </button>
                  <button
                    onClick={() => setHops(2)}
                    className={`px-4 py-2 rounded text-sm ${
                      hops === 2 ? 'bg-blue-600 text-white' : 'bg-gray-600 text-gray-300'
                    }`}
                  >
                    Double Hop
                  </button>
                </div>
              </div>

              {/* First Pool DEX Selector */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">DEX {hops === 2 ? '(Hop 1)' : ''}</label>
                  <select
                    value={testDex}
                    onChange={(e) => handleDexChange(e.target.value as 'raydium' | 'meteora' | 'orca')}
                    className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm"
                  >
                    <option value="raydium">Raydium CLMM</option>
                    <option value="meteora">Meteora DLMM</option>
                    <option value="orca">Orca Whirlpool</option>
                  </select>
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Pool ID {hops === 2 ? '(Hop 1)' : ''}</label>
                  <input
                    type="text"
                    value={testPoolId}
                    onChange={(e) => setTestPoolId(e.target.value)}
                    placeholder={testDex === 'raydium' 
                      ? "FXAXqgjNK6JVzVV2frumKTEuxC8hTEUhVTJTRhMMwLmM" 
                      : testDex === 'meteora'
                      ? "24fA4td938Lt9PcZXBWQeST5KCNucHw9GimbKSVKFutq"
                      : "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm"}
                    className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm font-mono"
                  />
                </div>
              </div>

              {/* Second Pool DEX Selector (for 2-hop) */}
              {hops === 2 && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-400 text-sm mb-1">DEX (Hop 2)</label>
                    <select
                      value={testSecondDex}
                      onChange={(e) => handleSecondDexChange(e.target.value as 'raydium' | 'meteora' | 'orca')}
                      className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm"
                    >
                      <option value="raydium">Raydium CLMM</option>
                      <option value="meteora">Meteora DLMM</option>
                      <option value="orca">Orca Whirlpool</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-gray-400 text-sm mb-1">Pool ID (Hop 2)</label>
                    <input
                      type="text"
                      value={testSecondPoolId}
                      onChange={(e) => setTestSecondPoolId(e.target.value)}
                      placeholder="Same pool for round trip"
                      className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm font-mono"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Input Mint</label>
                  <input
                    type="text"
                    value={testInputMint}
                    onChange={(e) => setTestInputMint(e.target.value)}
                    placeholder="So11111111111111111111111111111111111111112"
                    className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Output Mint</label>
                  <input
                    type="text"
                    value={testOutputMint}
                    onChange={(e) => setTestOutputMint(e.target.value)}
                    placeholder="USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"
                    className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Amount In</label>
                  <input
                    type="text"
                    value={testAmountIn}
                    onChange={(e) => setTestAmountIn(e.target.value)}
                    placeholder="10000000"
                    className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Min Amount Out</label>
                  <input
                    type="text"
                    value={testMinAmountOut}
                    onChange={(e) => setTestMinAmountOut(e.target.value)}
                    placeholder="1"
                    className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={testSimulate}
                  onChange={(e) => setTestSimulate(e.target.checked)}
                  className="w-4 h-4"
                />
                <label className="text-gray-300 text-sm">Simulate Only</label>
              </div>

              <button
                onClick={handleTestSwap}
                disabled={testingSwap}
                className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white rounded font-medium"
              >
                {testingSwap ? 'Testing...' : `Test ${hops === 1 ? 'Single' : 'Double'} Hop Swap`}
              </button>

              {testSwapResult && (
                <div className={`p-3 rounded text-sm ${
                  testSwapResult.success ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'
                }`}>
                  {testSwapResult.success ? (
                    <div>
                      <div className="font-medium">✓ Swap Successful</div>
                      {testSwapResult.signature && (
                        <div className="text-xs mt-1 font-mono">{testSwapResult.signature}</div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <div className="font-medium">✗ Swap Failed</div>
                      <div className="text-xs mt-1">{testSwapResult.error}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Multi-Hop Execute Testing Section - Production-like Mode (uses caches) */}
        {status?.deployed && (
          <div className="mb-6 p-4 bg-gray-700/50 rounded-lg border border-purple-600/30">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-purple-400 text-xs font-medium px-2 py-0.5 bg-purple-900/40 rounded">PRODUCTION MODE</span>
                <h3 className="text-lg font-semibold text-white">Execute Pipeline Test</h3>
              </div>
              <button
                onClick={fetchPools}
                disabled={loadingPools}
                className="px-3 py-1 bg-gray-600 hover:bg-gray-500 text-gray-200 rounded text-sm"
              >
                {loadingPools ? 'Loading...' : 'Refresh Pools'}
              </button>
            </div>
            
            <p className="text-gray-400 text-xs mb-4">
              Tests the real execution pipeline using pool/execution caches. Supports N-hop multi-DEX routes.
            </p>

            {/* Pool Stats */}
            {poolsByDex && (
              <div className="mb-4 p-2 bg-gray-800/50 rounded text-xs text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
                <span>Raydium CLMM: {poolsByDex.raydium?.clmmCount || 0}</span>
                <span>Raydium AMM: {poolsByDex.raydium?.ammCount || 0}</span>
                <span>Raydium CPMM: {poolsByDex.raydium?.cpmmCount || 0}</span>
                <span>Orca: {poolsByDex.orca?.clmmCount || 0}</span>
                <span>Meteora DLMM: {poolsByDex.meteora?.dlmmCount || 0}</span>
                <span>Meteora DAMM: {poolsByDex.meteoraBalanced?.ammCount || 0}</span>
                <span>PumpSwap: {poolsByDex.pumpswap?.ammCount || 0}</span>
              </div>
            )}

            {/* Hops Builder */}
            <div className="space-y-4">
              {executeHops.map((hop, index) => (
                <div key={index} className="p-3 bg-gray-800/50 rounded-lg border border-gray-600">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white font-medium text-sm">Hop {index + 1}</span>
                    {executeHops.length > 1 && (
                      <button
                        onClick={() => removeExecuteHop(index)}
                        className="text-red-400 hover:text-red-300 text-sm"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3 mb-2">
                    {/* DEX Selector */}
                    <div>
                      <label className="block text-gray-400 text-xs mb-1">DEX</label>
                      <select
                        value={hop.dex}
                        onChange={(e) => handleExecuteDexChange(index, e.target.value)}
                        className="w-full bg-gray-700 text-white px-2 py-1.5 rounded border border-gray-600 text-sm"
                      >
                        <option value="raydium">Raydium CLMM</option>
                        <option value="raydium-amm">Raydium AMM</option>
                        <option value="raydium-cpmm">Raydium CPMM</option>
                        <option value="orca">Orca Whirlpool</option>
                        <option value="meteora">Meteora DLMM</option>
                        <option value="meteora-damm">Meteora DAMM v1</option>
                        <option value="meteora-damm-v2">Meteora DAMM v2</option>
                        <option value="pumpswap">PumpSwap AMM</option>
                      </select>
                    </div>
                    
                    {/* Pool Selector */}
                    <div>
                      <label className="block text-gray-400 text-xs mb-1">Pool</label>
                      {poolsByDex ? (
                        <select
                          key={`pool-select-${hop.dex}-${index}`}
                          value={hop.poolId}
                          onChange={(e) => updateExecuteHop(index, 'poolId', e.target.value)}
                          className="w-full bg-gray-700 text-white px-2 py-1.5 rounded border border-gray-600 text-sm font-mono"
                        >
                          <option value="">Select Pool...</option>
                          {getPoolsForDex(hop.dex).slice(0, 100).map(p => (
                            <option key={p.id} value={p.id}>
                              {p.id.slice(0, 8)}... ({p.mintA?.slice(0, 4) || '?'}→{p.mintB?.slice(0, 4) || '?'})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={hop.poolId}
                          onChange={(e) => updateExecuteHop(index, 'poolId', e.target.value)}
                          placeholder="Pool ID"
                          className="w-full bg-gray-700 text-white px-2 py-1.5 rounded border border-gray-600 text-sm font-mono"
                        />
                      )}
                    </div>
                  </div>
                  
                  {/* Mints */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-gray-400 text-xs mb-1">Input Mint</label>
                      <input
                        type="text"
                        value={hop.inputMint}
                        onChange={(e) => updateExecuteHop(index, 'inputMint', e.target.value)}
                        placeholder="Input token mint"
                        className="w-full bg-gray-700 text-white px-2 py-1.5 rounded border border-gray-600 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-400 text-xs mb-1">Output Mint</label>
                      <input
                        type="text"
                        value={hop.outputMint}
                        onChange={(e) => updateExecuteHop(index, 'outputMint', e.target.value)}
                        placeholder="Output token mint"
                        className="w-full bg-gray-700 text-white px-2 py-1.5 rounded border border-gray-600 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>
              ))}
              
              {/* Add Hop Button */}
              <button
                onClick={addExecuteHop}
                className="w-full px-4 py-2 bg-gray-600 hover:bg-gray-500 text-gray-200 rounded text-sm border border-dashed border-gray-500"
              >
                + Add Hop
              </button>
            </div>

            {/* Amount & Settings */}
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div>
                <label className="block text-gray-400 text-sm mb-1">Amount In (raw)</label>
                <input
                  type="text"
                  value={executeAmountIn}
                  onChange={(e) => setExecuteAmountIn(e.target.value)}
                  placeholder="10000000"
                  className="w-full bg-gray-700 text-white px-3 py-2 rounded border border-gray-600 text-sm"
                />
              </div>
              <div>
                <label className="block text-gray-400 text-sm mb-1">Min Profit (raw, can be negative)</label>
                <input
                  type="text"
                  value={executeMinProfit}
                  onChange={(e) => setExecuteMinProfit(e.target.value)}
                  placeholder="-10000000"
                  className="w-full bg-gray-700 text-white px-3 py-2 rounded border border-gray-600 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center gap-4 mt-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={executeSimulate}
                  onChange={(e) => setExecuteSimulate(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-gray-300 text-sm">Simulate Only</span>
              </label>
              
              <button
                onClick={handleTestExecute}
                disabled={testingExecute}
                className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded font-medium"
              >
                {testingExecute ? 'Testing Execute...' : `Execute ${executeHops.length}-Hop Route`}
              </button>
            </div>

            {/* Execute Result */}
            {executeResult && (
              <div className={`mt-4 p-3 rounded text-sm ${
                executeResult.success ? 'bg-green-900/30 text-green-300 border border-green-700' : 'bg-red-900/30 text-red-300 border border-red-700'
              }`}>
                {executeResult.success ? (
                  <div>
                    <div className="font-medium">✓ Execute {executeResult.simulated ? 'Simulation' : 'Transaction'} Successful</div>
                    {executeResult.signature && (
                      <div className="text-xs mt-1 font-mono break-all">{executeResult.signature}</div>
                    )}
                    {executeResult.plan && (
                      <div className="text-xs mt-2 text-green-400">
                        Hops: {executeResult.plan.hops} | 
                        Input: {executeResult.plan.inputRaw} | 
                        Expected Output: {executeResult.plan.expectedOutputRaw}
                      </div>
                    )}
                    {executeResult.unitsConsumed && (
                      <div className="text-xs mt-1 text-green-400">
                        Compute Units: {executeResult.unitsConsumed.toLocaleString()}
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div className="font-medium">✗ Execute Failed</div>
                    <div className="text-xs mt-1 break-all">{executeResult.error}</div>
                  </div>
                )}
                
                {/* Show logs if available */}
                {executeResult.logs && executeResult.logs.length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs text-gray-400 mb-1">Logs:</div>
                    <div className="bg-gray-900/50 p-2 rounded text-xs font-mono max-h-32 overflow-y-auto">
                      {executeResult.logs.slice(-15).map((log, i) => (
                        <div key={i} className="text-gray-300 break-all">{log}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* MarginFi Flashloan Testing Section */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg border border-orange-600/30">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-orange-400 text-xs font-medium px-2 py-0.5 bg-orange-900/40 rounded">MARGINFI</span>
            <h3 className="text-lg font-semibold text-white">Flashloan Test</h3>
          </div>
          <p className="text-gray-400 text-xs mb-4">
            Test MarginFi flashloan integration. Borrows and immediately repays a small amount.
            Requires a MarginFi account (create at <a href="https://app.marginfi.com" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">app.marginfi.com</a>).
          </p>

          {/* Token Selection */}
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1">Token</label>
              <select
                value={flashloanToken}
                onChange={(e) => handleFlashloanTokenChange(e.target.value as 'SOL' | 'USDC')}
                className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm"
              >
                <option value="SOL">SOL</option>
                <option value="USDC">USDC</option>
              </select>
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1">Amount ({flashloanToken})</label>
              <input
                type="text"
                value={flashloanAmount}
                onChange={(e) => setFlashloanAmount(e.target.value)}
                placeholder={flashloanToken === 'SOL' ? '0.001' : '0.001'}
                className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-600 text-sm font-mono"
              />
            </div>
          </div>

          {/* Prerequisites Check */}
          <div className="mb-4">
            <button
              onClick={checkFlashloanPrerequisites}
              disabled={checkingPrerequisites}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 text-white rounded text-sm"
            >
              {checkingPrerequisites ? 'Checking...' : 'Check Prerequisites'}
            </button>
            
            {flashloanPrerequisites && (
              <div className={`mt-2 p-3 rounded text-sm ${
                flashloanPrerequisites.ready 
                  ? 'bg-green-900/30 text-green-300 border border-green-700' 
                  : 'bg-yellow-900/30 text-yellow-300 border border-yellow-700'
              }`}>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${
                      flashloanPrerequisites.hasMarginfiAccount 
                        ? 'bg-green-500' 
                        : flashloanPrerequisites.willCreateAccount 
                          ? 'bg-blue-500' 
                          : 'bg-red-500'
                    }`} />
                    <span>MarginFi Account: {
                      flashloanPrerequisites.hasMarginfiAccount 
                        ? 'Found' 
                        : flashloanPrerequisites.willCreateAccount 
                          ? 'Will be created automatically' 
                          : 'Not Found'
                    }</span>
                  </div>
                  {flashloanPrerequisites.marginfiAccount && (
                    <div className="text-xs text-gray-400 font-mono ml-4">
                      {flashloanPrerequisites.marginfiAccount}
                      {flashloanPrerequisites.willCreateAccount && <span className="text-blue-400 ml-2">(PDA)</span>}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${flashloanPrerequisites.hasTokenBalance ? 'bg-green-500' : 'bg-yellow-500'}`} />
                    <span>Token Balance: {flashloanPrerequisites.tokenBalance || 'N/A'}</span>
                  </div>
                  {flashloanPrerequisites.error && (
                    <div className="text-xs text-red-400 mt-1">{flashloanPrerequisites.error}</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Simulate Checkbox */}
          <div className="flex items-center gap-2 mb-4">
            <input
              type="checkbox"
              checked={flashloanSimulate}
              onChange={(e) => setFlashloanSimulate(e.target.checked)}
              className="w-4 h-4"
            />
            <label className="text-gray-300 text-sm">Simulate Only</label>
          </div>

          {/* Test Button */}
          <button
            onClick={handleTestFlashloan}
            disabled={testingFlashloan}
            className="w-full px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 text-white rounded font-medium"
          >
            {testingFlashloan ? 'Testing Flashloan...' : `Test ${flashloanToken} Flashloan`}
          </button>

          {/* Result */}
          {flashloanResult && (
            <div className={`mt-4 p-3 rounded text-sm ${
              flashloanResult.success 
                ? 'bg-green-900/30 text-green-300 border border-green-700' 
                : 'bg-red-900/30 text-red-300 border border-red-700'
            }`}>
              {flashloanResult.success ? (
                <div>
                  <div className="font-medium">
                    ✓ Flashloan {flashloanResult.simulated ? 'Simulation' : 'Transaction'} Successful
                  </div>
                  {flashloanResult.formattedAmount && (
                    <div className="text-xs mt-1">Amount: {flashloanResult.formattedAmount}</div>
                  )}
                  {flashloanResult.signature && (
                    <div className="text-xs mt-1 font-mono break-all">{flashloanResult.signature}</div>
                  )}
                  {flashloanResult.unitsConsumed && (
                    <div className="text-xs mt-1">Compute Units: {flashloanResult.unitsConsumed.toLocaleString()}</div>
                  )}
                  {flashloanResult.marginfiAccount && (
                    <div className="text-xs mt-1 text-gray-400">
                      MarginFi Account: {flashloanResult.marginfiAccount.slice(0, 8)}...
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="font-medium">✗ Flashloan Failed</div>
                  <div className="text-xs mt-1 break-all">{flashloanResult.error}</div>
                </div>
              )}
              
              {/* Show logs if available */}
              {flashloanResult.logs && flashloanResult.logs.length > 0 && (
                <div className="mt-2">
                  <div className="text-xs text-gray-400 mb-1">Logs:</div>
                  <div className="bg-gray-900/50 p-2 rounded text-xs font-mono max-h-32 overflow-y-auto">
                    {flashloanResult.logs.slice(-15).map((log, i) => (
                      <div key={i} className="text-gray-300 break-all">{log}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Deploy Actions */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <h3 className="text-lg font-semibold text-white mb-3">Deployment</h3>
          
          <div className="flex items-center gap-4 mb-4">
            <label className="text-gray-400 text-sm">Target Cluster:</label>
            <select
              value={selectedCluster}
              onChange={(e) => setSelectedCluster(e.target.value as 'devnet' | 'mainnet-beta' | 'localnet')}
              className="bg-gray-700 text-white px-3 py-1 rounded border border-gray-600"
            >
              <option value="localnet">Localnet (Free)</option>
              <option value="devnet">Devnet</option>
              <option value="mainnet-beta">Mainnet-Beta</option>
            </select>
            {(selectedCluster === 'devnet' || selectedCluster === 'localnet') && (
              <button
                onClick={handleAirdrop}
                className="px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm"
              >
                Request Airdrop
              </button>
            )}
          </div>
          
          {selectedCluster === 'localnet' && (
            <div className="mb-4 p-3 bg-blue-900/30 border border-blue-600 rounded text-sm text-blue-300">
              <div className="font-medium mb-1">Localnet Testing Mode</div>
              <div className="text-xs text-blue-400">
                Free testing - no real SOL required. Make sure you have a local validator running:
                <code className="ml-1 bg-gray-800 px-1.5 py-0.5 rounded">solana-test-validator</code>
              </div>
            </div>
          )}

          {/* Force New Program ID Option */}
          <div className="mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={forceNewProgramId}
                onChange={(e) => setForceNewProgramId(e.target.checked)}
                className="w-4 h-4 rounded border-gray-500 bg-gray-700 text-orange-500 focus:ring-orange-500"
              />
              <span className="text-gray-300 text-sm">Force New Program ID</span>
            </label>
            {forceNewProgramId && (
              <div className="mt-2 p-3 bg-orange-900/30 border border-orange-600 rounded text-sm text-orange-300">
                <div className="font-medium mb-1">⚠️ New Program ID Mode</div>
                <div className="text-xs text-orange-400">
                  This will generate a new keypair, update source files (lib.rs, Anchor.toml), 
                  rebuild, and deploy with a fresh program ID. Use this after closing a program 
                  or if deployment fails with "program has been closed" error.
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleBuild}
              disabled={building || deploying || !cli?.anchor}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-medium"
            >
              {building ? 'Building...' : 'Build Program'}
            </button>
            <button
              onClick={handleDeploy}
              disabled={building || deploying || !cli?.solana}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-medium"
            >
              {deploying ? 'Deploying...' : 'Deploy'}
            </button>
            {(status?.deployed || config?.programId) && (
              <button
                onClick={handleUpgrade}
                disabled={building || deploying || closing || !cli?.solana}
                className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-medium"
              >
                {deploying ? 'Upgrading...' : 'Upgrade'}
              </button>
            )}
            {(status?.deployed || config?.programId) && (
              <button
                onClick={handleCloseProgram}
                disabled={building || deploying || closing || !cli?.solana}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-medium"
                title={
                  !status?.upgradeAuthority && status?.executable
                    ? 'Warning: Program may be immutable (no upgrade authority). Click to attempt close - backend will verify.'
                    : !status?.executable && status !== null
                    ? 'Program is not executable or already closed'
                    : 'Close program and recover rent (~2-3 SOL)'
                }
              >
                {closing ? 'Closing...' : 'Close & Recover Rent'}
              </button>
            )}
          </div>
        </div>

        {/* Action Logs */}
        {actionLogs.length > 0 && (
          <div className="mb-6 p-4 bg-gray-900/50 rounded-lg">
            <h3 className="text-lg font-semibold text-white mb-2">Logs</h3>
            <div className="font-mono text-xs text-gray-300 max-h-40 overflow-y-auto space-y-1">
              {actionLogs.map((log, i) => (
                <div key={i} className="break-all">{log}</div>
              ))}
            </div>
            <button
              onClick={() => setActionLogs([])}
              className="mt-2 text-gray-400 hover:text-gray-300 text-xs"
            >
              Clear logs
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-3 pt-4 border-t border-gray-700">
          <button
            onClick={fetchStatus}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
          >
            Refresh
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};


