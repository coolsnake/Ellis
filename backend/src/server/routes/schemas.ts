import { z } from 'zod';

export const ResolveDirectSchema = z.object({
  path: z.array(z.string()).min(2),
  hopPoolIds: z.array(z.string()),
  dexes: z.array(z.string()),
  size: z.number().optional(),
  sizeUsd: z.number().optional(),
  slippageBps: z.number().optional(),
}).refine((o) => o.hopPoolIds.length === o.path.length - 1 && o.dexes.length === o.path.length - 1, { message: 'path/hops length mismatch' });


