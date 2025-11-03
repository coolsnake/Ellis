import { isArbStreamEnabled } from './realtime.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export type PushDecision = {
  shouldPush: boolean;
  reason: string;
  gateType?: 'disabled' | 'detect_mode' | 'incremental_mode';
};

/**
 * Unified decision point for whether graph updates should be pushed to arb-rs.
 * All code paths should use this function instead of duplicating logic.
 * 
 * @param opts - Options for push decision
 * @param opts.force - Force push even if modes would normally block (for explicit pushes like /arb/start)
 * @param opts.source - Source of the update (for logging and mode-specific logic)
 * @returns Decision object with shouldPush flag and reason
 */
export function shouldPushGraphUpdate(opts?: {
  force?: boolean;
  source?: string;
}): PushDecision {
  // Gate 1: Stream must be enabled
  if (!isArbStreamEnabled()) {
    return {
      shouldPush: false,
      reason: 'arb_stream_disabled',
      gateType: 'disabled',
    };
  }

  // Gate 2: Force override (for explicit pushes like /arb/start)
  if (opts?.force) {
    return {
      shouldPush: true,
      reason: 'force_enabled',
    };
  }

  // Gate 3: Mode-based gating
  const detectMode = !!((CONFIG.system as any)?.detectDrivenGraphPush);
  const incrementalMode = !!((CONFIG.system as any)?.graphIncrementalMode);

  if (detectMode) {
    return {
      shouldPush: false,
      reason: 'detect_driven_mode_active',
      gateType: 'detect_mode',
    };
  }

  if (incrementalMode && opts?.source !== 'incremental') {
    // Incremental mode should only push from applyPoolUpdates
    return {
      shouldPush: false,
      reason: 'incremental_mode_requires_incremental_path',
      gateType: 'incremental_mode',
    };
  }

  return {
    shouldPush: true,
    reason: 'allowed',
  };
}

/**
 * Log push decision for observability (INFO level if blocked, DEBUG if allowed)
 */
export function logPushDecision(decision: PushDecision, context: {
  version?: number;
  kind: 'snapshot' | 'diff';
  source?: string;
}): void {
  if (!decision.shouldPush) {
    logger.info('graph.push.blocked', {
      reason: decision.reason,
      gateType: decision.gateType,
      version: context.version,
      kind: context.kind,
      source: context.source,
      cat: 'graph',
    });
  } else {
    logger.debug('graph.push.allowed', {
      reason: decision.reason,
      version: context.version,
      kind: context.kind,
      source: context.source,
      cat: 'graph',
    });
  }
}

