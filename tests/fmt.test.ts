import { describe, expect, it } from 'vitest';
import { abbr } from '../src/app/fmt';

/**
 * `abbr` 的七条边界（从原 tests/money.test.ts 搬来，钱删了但这条规则没变）。
 *
 * 判据是「缩写不能撒谎」：`abbr(10,300)` 曾经返回「1万」，
 * 10,300 被报成 10,000 —— `1.3万` 不是谎，`1.0万` 是。
 */
describe('abbr · 大数缩写', () => {
  it('一万以下原样，带千分位', () => expect(abbr(8600)).toBe('8,600'));
  it('1.03 万落在 .0 例外上 → 精确值', () => expect(abbr(10300)).toBe('10,300'));
  it('1.08 万 → 一位小数', () => expect(abbr(10800)).toBe('1.1万'));
  it('9.995 万 toFixed 成 10.0 → 精确值', () => expect(abbr(99950)).toBe('99,950'));
  it('十万级：10.0 被 strip 掉', () => expect(abbr(100000)).toBe('10万'));
  it('百万级取整', () => expect(abbr(1234567)).toBe('123万'));
  it('负数与 NaN 归零', () => {
    expect(abbr(-5)).toBe('0');
    expect(abbr(Number.NaN)).toBe('0');
  });
});
