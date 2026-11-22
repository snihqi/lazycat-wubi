import { describe, expect, it } from 'vitest';
import { createRng, hashSeed, rngFromState } from '../src/core/rng';

describe('rng · 可复现', () => {
  it('同 seed 同序列', () => {
    const a = Array.from({ length: 50 }, () => createRng('seed').next());
    expect(new Set(a).size).toBe(1); // 每次新建都从头开始

    const r1 = createRng('seed');
    const r2 = createRng('seed');
    for (let i = 0; i < 200; i++) expect(r1.next()).toBe(r2.next());
  });

  it('数字 seed 与字符串 seed 都能用，且各自稳定', () => {
    expect(hashSeed(42)).toBe(hashSeed(42));
    // 数字 seed 会先 String() 化，所以 42 与 '42' 是同一个种子（刻意的：切 seed 不该有惊喜）
    expect(hashSeed('42')).toBe(hashSeed(42));
    expect(createRng(7).int(1000)).toBe(createRng(7).int(1000));
  });

  it('输出在 [0,1) 且分布大致均匀', () => {
    const r = createRng('dist');
    let sum = 0;
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
      buckets[Math.min(9, Math.floor(v * 10))] += 1;
    }
    expect(sum / 10000).toBeCloseTo(0.5, 1);
    for (const b of buckets) expect(b).toBeGreaterThan(700);
  });

  it('int(n) 落在 [0, n)，n<=0 时返回 0', () => {
    const r = createRng('int');
    for (let i = 0; i < 500; i++) {
      const v = r.int(7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(r.int(0)).toBe(0);
    expect(r.int(-3)).toBe(0);
    expect(r.int(Number.NaN)).toBe(0);
  });

  it('状态可存档恢复', () => {
    const r = createRng('state');
    for (let i = 0; i < 10; i++) r.next();
    const snapshot = r.state;
    const next5 = Array.from({ length: 5 }, () => r.next());

    const restored = rngFromState(snapshot);
    expect(Array.from({ length: 5 }, () => restored.next())).toEqual(next5);
  });

  it('fork 出的子流互相独立，且不影响父流', () => {
    const parent = createRng('fork');
    const a = parent.fork('a');
    const b = parent.fork('b');
    expect(a.next()).not.toBe(b.next());

    const p2 = createRng('fork');
    const c = p2.fork('a');
    expect(Array.from({ length: 5 }, () => c.next())).toEqual(
      (() => {
        const x = createRng('fork').fork('a');
        return Array.from({ length: 5 }, () => x.next());
      })(),
    );
    expect(p2.next()).toBe(createRng('fork').next());
  });

  it('pick 空数组返回 undefined', () => {
    expect(createRng('pick').pick([])).toBeUndefined();
    expect(['a', 'b']).toContain(createRng('pick').pick(['a', 'b']));
  });
});
