type TriggerPriorityInputs = {
  baseCfg: number;
  subPriority: number;
  suggestedMul: number;
  multiplier: number;
  floor: number;
};

export function computeTriggerPriorityFee(inputs: TriggerPriorityInputs): number {
  const baseCfg = Number(inputs.baseCfg || 0);
  const subPriority = Number(inputs.subPriority || 0);
  const suggestedMul = Number(inputs.suggestedMul || 1);
  const multiplier = Number(inputs.multiplier || 1);
  const floor = Math.max(0, Number(inputs.floor || 0));
  const dyn = Math.max(baseCfg, subPriority * suggestedMul);
  return Math.max(floor, Math.floor(dyn * multiplier));
}
