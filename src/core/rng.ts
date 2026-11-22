/**
 * rng.ts — 可复现随机（seeded）。
 *
 * 负责：给出一个**同 seed 同序列**的随机源，让出题顺序可重放、可写进单测、可存档恢复。
 * 不负责：洗牌策略、出题规则（在 queue.ts）；也不碰 `Math.random`。
 * 调用方：queue.ts（尾窗落位、抖动），以及将来任何需要"同一份存档开出同一套题"的地方。
 *
 * 算法：mulberry32（32 位状态，周期 2^32，质量足够做间隔重复的落位抖动）。
 * 这里的 `| 0` / `>>> 0` 是 PRNG 本身要求的 32 位算术，不是"拿 32 位去截断业务整数"，
 * 与 num.ts 里禁止 `|0` 的理由无关。
 */

/** 随机源。`state` 可直接存档，`rngFromState()` 能原样恢复。 */
export interface Rng {
  /** [0, 1) 均匀分布。 */
  next(): number;
  /** [0, maxExclusive) 的整数。`maxExclusive <= 0` 时返回 0。 */
  int(maxExclusive: number): number;
  /** 从数组里取一个；空数组返回 `undefined`。 */
  pick<T>(list: readonly T[]): T | undefined;
  /** 派生一个子随机源（互相独立、且父流不受影响）。 */
  fork(label?: string | number): Rng;
  /** 当前 32 位状态（存档用）。 */
  readonly state: number;
}

/**
 * 字符串 → 32 位种子（cyrb53 的 32 位变体，FNV 风格混合）。
 * 目的只是"把任意字符串/数字摊成一个雪崩良好的整数"，不用于安全用途。
 */
export function hashSeed(seed: string | number): number {
  const text = String(seed);
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** mulberry32：状态显式保存在闭包外，方便读出来存档。 */
export function rngFromState(state: number): Rng {
  let a = state >>> 0;

  const api: Rng = {
    get state(): number {
      return a;
    },
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(maxExclusive: number): number {
      if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
      return Math.floor(api.next() * Math.floor(maxExclusive));
    },
    pick<T>(list: readonly T[]): T | undefined {
      if (list.length === 0) return undefined;
      return list[api.int(list.length)];
    },
    fork(label: string | number = ''): Rng {
      return rngFromState(hashSeed(`${api.state}:${label}`));
    },
  };

  return api;
}

/** 由 seed 建随机源。数字 seed 与字符串 seed 都行，同样输入永远同样输出。 */
export function createRng(seed: string | number = 'lazycat-wubi'): Rng {
  return rngFromState(hashSeed(seed));
}
