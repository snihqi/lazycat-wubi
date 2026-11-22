/**
 * num.ts — 整数安全读取（全项目唯一一份）。
 *
 * 负责：把"来自存档 / 来自界面的任何东西"安全地变成一个夹在范围内、可参与运算的整数。
 * 不负责：显示格式、单位换算、业务上限（业务上限由调用方作为参数传入）。
 * 调用方：store.ts（读档）、currency.ts（钱）、xp.ts（经验）、daily.ts（计数）、queue.ts。
 *
 * 为什么要有这个文件：参考实现里有一处 `Number.isFinite` + 夹取，但写在自己的 load() 里，
 * 后面每个新模块都各抄一遍就会漂。**不要用 `|0`**：它是 32 位截断，21.5 亿以上会翻负，
 * 而经验/铜钱都已经在亿这个量级。
 */

/** 是不是一个真正的有限数值（排除 NaN / Infinity / '12' / null）。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 任意值 → 整数。
 * - 非有限数值 → `fallback`（默认 0）
 * - 向下取整（与参考实现一致：经验/铜钱只增不减，向下取整对用户更保守）
 * - 再按 `min` / `max` 夹取
 */
export function safeInt(value: unknown, fallback = 0, min?: number, max?: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) {
    const f = Math.floor(Number(fallback));
    const base = Number.isFinite(f) ? f : 0;
    return applyBounds(base, min, max);
  }
  return applyBounds(n, min, max);
}

function applyBounds(n: number, min?: number, max?: number): number {
  let r = n;
  if (min !== undefined && r < min) r = min;
  if (max !== undefined && r > max) r = max;
  return r;
}


