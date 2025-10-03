export interface RunnerLike {
  start: (arg?: any) => Promise<void> | void;
  stop: () => void;
  getStatus: () => any;
}

export class RunnerRegistry<R extends RunnerLike> {
  private runners: Map<string, R> = new Map();

  upsert(key: string, factory: () => R): R {
    let r = this.runners.get(key);
    if (!r) {
      r = factory();
      this.runners.set(key, r);
    }
    return r as R;
  }

  get(key: string): R | undefined {
    return this.runners.get(key);
  }

  list(): Array<{ key: string; status: any }> {
    return Array.from(this.runners.entries()).map(([key, r]) => ({ key, status: r.getStatus() }));
  }

  async start(key: string, arg?: any): Promise<boolean> {
    const r = this.runners.get(key);
    if (!r) return false;
    await r.start(arg);
    return true;
  }

  stop(key: string): boolean {
    const r = this.runners.get(key);
    if (!r) return false;
    r.stop();
    return true;
  }

  remove(key: string): boolean {
    const r = this.runners.get(key);
    if (!r) return false;
    try { r.stop(); } catch {}
    return this.runners.delete(key);
  }
}


