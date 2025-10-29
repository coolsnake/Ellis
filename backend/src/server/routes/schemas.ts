import { z } from 'zod';

const DirectArraysSchema = z.object({
  path: z.array(z.string()).min(2),
  hopPoolIds: z.array(z.string()),
  dexes: z.array(z.string()),
  size: z.number().optional(),
  sizeUsd: z.number().optional(),
  slippageBps: z.number().optional(),
}).superRefine((o, ctx) => {
  const expected = o.path.length - 1;
  if (o.hopPoolIds.length !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hopPoolIds'], message: `expected ${expected}, got ${o.hopPoolIds.length}` });
  }
  if (o.dexes.length !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dexes'], message: `expected ${expected}, got ${o.dexes.length}` });
  }
});

const HopOverrideSchema = z.object({
  dex: z.string(),
  poolId: z.string(),
  inputMint: z.string().optional(),
  outputMint: z.string().optional(),
  amountInRaw: z.union([z.string(), z.number()]).optional(),
  minOutRaw: z.union([z.string(), z.number()]).optional(),
});

const PlanSchema = z.object({
  plan: z.object({
    path: z.array(z.string()).min(2),
    hops: z.array(HopOverrideSchema),
  }),
  size: z.number().optional(),
  sizeUsd: z.number().optional(),
  slippageBps: z.number().optional(),
});

export const ResolveDirectSchema = z.union([DirectArraysSchema, PlanSchema]);

