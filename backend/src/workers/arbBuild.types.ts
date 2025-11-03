import type { ExecutionPlan } from '../execution/types.js';

export type SerializedInstructionKey = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type SerializedInstruction = {
  programId: string;
  keys: SerializedInstructionKey[];
  data: string;
};

export interface ArbBuildRequest {
  plan: ExecutionPlan;
  extraSetupIxs?: SerializedInstruction[];
  computeBudget?: { computeUnitLimit?: number; computeUnitPriceMicroLamports?: number };
}

export interface ArbBuildResult {
  instructions: SerializedInstruction[];
  ixCount: number;
  sizeBytes: number;
}


