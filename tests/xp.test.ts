import { describe, expect, it } from 'vitest';
import {
  LEVEL1_NEED,
  LEVEL_MAX,
  XP_CAP,
  XP_CUM,
  XP_NEED,
  XP_SLOPE,
  XP_TOTAL_AT_MAX,
  addXp,
  displayXp,
  levelOf,
  needFor,
  progressInLevel,
  totalXpForLevel,
} from '../src/core/xp';

/** 到达满级所需的累计经验（逐级取整后会与 1,000,000 锚点差几点）。 */
const FULL = XP_TOTAL_AT_MAX;

describe('xp · 100 级曲线', () => {
  it('Lv.1 → Lv.2 恰好 500', () => {
    expect(LEVEL1_NEED).toBe(500);
    expect(needFor(1)).toBe(500);
    expect(totalXpForLevel(2)).toBe(500);
  });

  it('累计到 100 级 ≈ 1,000,000（误差 < 5）', () => {
    // 斜率由锚点反解，累计裸值正好 1,000,000，逐级四舍五入后再偏几点
    expect(Math.abs(XP_CUM[LEVEL_MAX]! - 1_000_000)).toBeLessThan(5);
  });

  it('XP_TOTAL_AT_MAX 必须等于表里的真值（不是手打的 1,000,000）', () => {
    // 这条是防回归：常量和表一旦脱钩，用户打到"官方宣称的 100 万"会卡在 99 级
    expect(XP_TOTAL_AT_MAX).toBe(XP_CUM[LEVEL_MAX]);
    expect(totalXpForLevel(LEVEL_MAX)).toBe(XP_TOTAL_AT_MAX);

    expect(levelOf(XP_TOTAL_AT_MAX)).toBe(100);
    expect(levelOf(XP_TOTAL_AT_MAX - 1)).toBe(99);
    expect(progressInLevel(XP_TOTAL_AT_MAX).level).toBe(100);
    expect(progressInLevel(XP_TOTAL_AT_MAX - 1).toNext).toBe(1);
  });

  it('斜率是从两个锚点反解的，不是拍出来的整数', () => {
    const steps = LEVEL_MAX - 1; // 99 次升级
    const sumIdx = (steps * (steps - 1)) / 2; // 0+1+…+98 = 4851
    // 裸值（不取整）累计：Lv.1→2 的 500 × 99 + 斜率 × 4851 = 1,000,000
    expect(LEVEL1_NEED * steps + XP_SLOPE * sumIdx).toBeCloseTo(1_000_000, 6);
    // 斜率现在约 195.939；随手写整数 196 会累计多出 296 点，
    // 正是「容差不能卡 5」的原因
    expect(LEVEL1_NEED * steps + 196 * sumIdx).toBeCloseTo(1_000_296, 6);
  });

  it('每一级都在同一条等差线上（不单独修补最后一级）', () => {
    const tail = XP_NEED[XP_NEED.length - 1]!;
    const prev = XP_NEED[XP_NEED.length - 2]!;
    const step = XP_NEED[1]! - XP_NEED[0]!;
    // 最后两级之差仍是约一个斜率（允许取整带来的 ±1）
    expect(Math.abs(tail - prev - step)).toBeLessThanOrEqual(2);
  });

  it('升级需求单调递增，且满级没有下一级', () => {
    expect(XP_NEED).toHaveLength(LEVEL_MAX - 1);
    for (let i = 1; i < XP_NEED.length; i++) {
      expect(XP_NEED[i]!).toBeGreaterThan(XP_NEED[i - 1]!);
    }
    expect(needFor(LEVEL_MAX)).toBe(0);
  });

  it('levelOf：边界值归属下一级', () => {
    expect(levelOf(0)).toBe(1);
    expect(levelOf(499)).toBe(1);
    expect(levelOf(500)).toBe(2);
    // 边界用 needFor 算，不写死数字 —— 曲线换过一次（500 万 → 100 万），
    // 写死 1521 的断言当场就红了，而它测的其实是「归属下一级」这条规则
    const n2 = needFor(2);
    expect(levelOf(500 + n2 - 1)).toBe(2);
    expect(levelOf(500 + n2)).toBe(3);
    expect(levelOf(FULL)).toBe(100);
    expect(levelOf(FULL - 1)).toBe(99);
    expect(levelOf(99_999_999)).toBe(100);
  });

  it('progressInLevel 给出本级进度', () => {
    const p = progressInLevel(700);
    expect(p.level).toBe(2);
    expect(p.into).toBe(200);
    expect(p.need).toBe(needFor(2));
    expect(p.toNext).toBe(needFor(2) - 200);
    expect(p.ratio).toBeCloseTo(200 / needFor(2), 6);
    expect(p.isMax).toBe(false);

    const max = progressInLevel(FULL);
    expect(max.level).toBe(100);
    expect(max.isMax).toBe(true);
    expect(max.ratio).toBe(1);
    expect(max.toNext).toBe(0);
  });

  it('1 个正确字 = 1 点经验；升级只报一次', () => {
    const r = addXp(499, 1);
    expect(r).toMatchObject({ total: 500, gained: 1, levelBefore: 1, levelAfter: 2, levelUp: true });
    expect(addXp(0, 1).levelUp).toBe(false);
    expect(addXp(0, -50).total).toBe(0); // 经验只涨不跌
  });
});

describe('xp · 上限与 ∞', () => {
  it('到达 1 亿后展示 ∞，内部不再增长', () => {
    const near = addXp(XP_CAP - 10, 100);
    expect(near.total).toBe(XP_CAP);
    expect(near.gained).toBe(10);
    expect(near.capped).toBe(true);

    const again = addXp(near.total, 5000);
    expect(again.total).toBe(XP_CAP);
    expect(again.gained).toBe(0);

    expect(displayXp(XP_CAP)).toEqual({ capped: true, value: 100_000_000, text: '∞' });
    expect(displayXp(XP_CAP - 1).text).toBe('99999999');
    expect(displayXp(XP_CAP - 1).capped).toBe(false);
  });

  it('满级后等级不再变化，但经验继续累积', () => {
    expect(levelOf(FULL)).toBe(100);
    expect(levelOf(60_000_000)).toBe(100);
    expect(addXp(FULL, 1000).levelAfter).toBe(100);
    expect(addXp(FULL, 1000).levelUp).toBe(false);
    expect(addXp(FULL, 1000).total).toBe(FULL + 1000);
  });

  it('超大经验值不会被 32 位截断成负数（不许用 |0）', () => {
    expect(addXp(3_000_000_000, 1).total).toBe(XP_CAP);
    expect(levelOf(3_000_000_000)).toBe(100);
    expect(progressInLevel(2 ** 40).level).toBe(100);
    expect(addXp(Number.NaN, 10).total).toBe(10);
  });
});
