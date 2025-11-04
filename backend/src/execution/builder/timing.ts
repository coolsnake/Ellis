

export interface TimingMetrics {
  [stepName: string]: number;
}

export class TransactionTiming {
  private startTime: number;
  private timings: TimingMetrics;
  private currentStep: string | null = null;
  private currentStepStart: number = 0;

  constructor() {
    this.startTime = Date.now();
    this.timings = {};
  }

  /**
   * Start timing a step
   */
  startStep(stepName: string): void {
    // If there's a current step, end it first
    if (this.currentStep) {
      this.endCurrentStep();
    }
    this.currentStep = stepName;
    this.currentStepStart = Date.now();
  }

  /**
   * End the current step
   */
  endStep(): void {
    if (this.currentStep) {
      const duration = Date.now() - this.currentStepStart;
      const existing = this.timings[this.currentStep] || 0;
      this.timings[this.currentStep] = existing + duration;
      this.currentStep = null;
    }
  }

  /**
   * End current step if one is active
   */
  private endCurrentStep(): void {
    if (this.currentStep) {
      const duration = Date.now() - this.currentStepStart;
      const existing = this.timings[this.currentStep] || 0;
      this.timings[this.currentStep] = existing + duration;
    }
  }

  /**
   * Record a completed step (for steps that don't need start/end)
   */
  recordStep(stepName: string, duration: number): void {
    const existing = this.timings[stepName] || 0;
    this.timings[stepName] = existing + duration;
  }

  /**
   * Get timing for a specific step
   */
  getStepTiming(stepName: string): number {
    return this.timings[stepName] || 0;
  }

  /**
   * Get all timings
   */
  getTimings(): TimingMetrics {
    // End current step if active
    this.endCurrentStep();
    return { ...this.timings };
  }

  /**
   * Get total elapsed time
   */
  getTotalTime(): number {
    this.endCurrentStep();
    return Date.now() - this.startTime;
  }

  /**
   * Get timing breakdown as a formatted object for logging
   */
  getBreakdown(): Record<string, number> {
    const timings = this.getTimings();
    const total = this.getTotalTime();
    
    const breakdown: Record<string, number> = {
      ms_total: total,
    };

    // Add individual step timings
    for (const [step, duration] of Object.entries(timings)) {
      breakdown[`ms_${step}`] = duration;
    }

    // Calculate unaccounted time (overhead/gaps between steps)
    const accounted = Object.values(timings).reduce((sum, val) => sum + val, 0);
    const unaccounted = Math.max(0, total - accounted);
    if (unaccounted > 0) {
      breakdown.ms_overhead = unaccounted;
    }

    return breakdown;
  }

  /**
   * Reset all timings (useful for reuse)
   */
  reset(): void {
    this.endCurrentStep();
    this.startTime = Date.now();
    this.timings = {};
  }
}



