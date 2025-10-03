import { describe, it, expect } from 'vitest';

class MinHeap<T> {
  private data: T[] = [];
  constructor(private compare: (a: T, b: T) => number) {}
  size(): number { return this.data.length; }
  push(item: T): void { this.data.push(item); this.bu(this.data.length - 1); }
  pop(): T | undefined { if (!this.data.length) return undefined; const t=this.data[0]; const l=this.data.pop() as T; if (this.data.length) { this.data[0]=l; this.bd(0);} return t; }
  private bu(i: number) { while (i>0){ const p=(i-1)>>1; if (this.compare(this.data[i], this.data[p])>=0) break; [this.data[i], this.data[p]]=[this.data[p], this.data[i]]; i=p; } }
  private bd(i: number) { const n=this.data.length; while (true){ let s=i; const l=2*i+1, r=2*i+2; if (l<n && this.compare(this.data[l], this.data[s])<0) s=l; if (r<n && this.compare(this.data[r], this.data[s])<0) s=r; if (s===i) break; [this.data[i], this.data[s]]=[this.data[s], this.data[i]]; i=s; } }
}

describe('liquidator - heap behavior', () => {
  it('orders by health ascending', () => {
    const heap = new MinHeap<{ u: string; h: number }>((a,b)=>a.h-b.h);
    heap.push({ u:'a', h: 0.5 });
    heap.push({ u:'b', h: -0.2 });
    heap.push({ u:'c', h: 0.1 });
    expect(heap.size()).toBe(3);
    expect(heap.pop()?.u).toBe('b');
    expect(heap.pop()?.u).toBe('c');
    expect(heap.pop()?.u).toBe('a');
  });
});


