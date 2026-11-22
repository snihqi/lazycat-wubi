import { describe, expect, it } from 'vitest';
import { CHARS } from '../src/data';
import { codeRows, mainCode } from '../src/app/data';
import type { CharRecord } from '../src/core/types';

function rec(ch: string): CharRecord {
  const hit = CHARS.find((c) => c.ch === ch);
  if (!hit) throw new Error(`3000 字表里没有「${ch}」`);
  return hit;
}

/** 断言用的简写：[码, 级别] 列表。 */
function levels(ch: string): Array<[string, string]> {
  return codeRows(rec(ch)).map((r) => [r.code, r.level]);
}

describe('codeRows · 全码 = 最长的那一条，不按位数硬套', () => {
  it('「一」= 一级 / 三级 / 全码（g / ggl / ggll）', () => {
    expect(levels('一')).toEqual([
      ['g', '一级简码'],
      ['ggl', '三级简码'],
      ['ggll', '全码'],
    ]);
  });

  it('「好」= 二级 / 全码（vb / vbg）—— vbg 三位但它是全码', () => {
    expect(levels('好')).toEqual([
      ['vb', '二级简码'],
      ['vbg', '全码'],
    ]);
    // 按位数硬套会把 vbg 说成三级简码，把字教错；判据只能是「是不是全码的前缀」。
    const vbg = codeRows(rec('好')).find((r) => r.code === 'vbg');
    expect(vbg?.level).toBe('全码');
    expect(vbg?.level).not.toBe('三级简码');
    expect(codeRows(rec('好')).some((r) => r.level === '三级简码')).toBe(false);
  });

  it('「想」= 三级 / 全码（shn / shnu）', () => {
    expect(levels('想')).toEqual([
      ['shn', '三级简码'],
      ['shnu', '全码'],
    ]);
  });

  it('「的」= 一级 / 三级 / 全码（r / rqy / rqyy）', () => {
    expect(levels('的')).toEqual([
      ['r', '一级简码'],
      ['rqy', '三级简码'],
      ['rqyy', '全码'],
    ]);
  });

  it('只有全码一个字：不留空表（场 fnrt 没有简码）', () => {
    const rows = codeRows(rec('场'));
    expect(rows).toEqual([{ code: 'fnrt', level: '全码', how: '敲完 4 位，按空格上屏', isFull: true }]);
  });
});

describe('codeRows · 边界', () => {
  it('同长的两版都算全码；不是全码前缀的短码写「另一写法」', () => {
    // 扭 = rnh / rnhf / rnfg。mainCode 取最后一条（rnfg），于是：
    //   rnhf 与全码等长 → 「全码 · 另一写法」；rnh 不是 rnfg 的前缀 → 「另一写法」
    // （写「取全码前 3 位」就是假话 —— 参考项目的注释记的也是这个坑）
    const rows = codeRows(rec('扭'));
    expect(rows.map((r) => [r.code, r.level])).toEqual([
      ['rnh', '另一写法'],
      ['rnhf', '全码 · 另一写法'],
      ['rnfg', '全码'],
    ]);
    const LEVELS = ['全码', '全码 · 另一写法', '另一写法', '一级简码', '二级简码', '三级简码'];
    expect(rows.every((r) => LEVELS.includes(r.level))).toBe(true);
  });

  it('isFull 恰好一行，且就是 mainCode()', () => {
    for (const ch of ['一', '好', '想', '的', '王', '工', '五', '我', '场']) {
      const rows = codeRows(rec(ch));
      const fulls = rows.filter((r) => r.isFull);
      expect(fulls).toHaveLength(1);
      expect(fulls[0]!.code).toBe(mainCode(rec(ch)));
    }
  });

  it('按码长升序，且「怎么打」与级别自洽', () => {
    for (const ch of ['一', '好', '想', '的', '王', '工', '五', '我']) {
      const rows = codeRows(rec(ch));
      const lens = rows.map((r) => r.code.length);
      expect(lens).toEqual([...lens].sort((a, b) => a - b));
      for (const r of rows) {
        if (r.isFull) expect(r.how).toBe(`敲完 ${r.code.length} 位，按空格上屏`);
        else if (r.level === '另一写法' || r.level === '全码 · 另一写法') {
          expect(r.how).toBe('另一种取法，同样能上屏');
        } else if (r.level === '一级简码') {
          expect(r.how).toBe('只打这一个字母，按空格上屏');
        } else {
          expect(r.how).toBe(`取全码前 ${r.code.length} 位，按空格上屏`);
        }
        // 简码一定是全码的前缀（这是「取前 N 位」这句话成立的前提）
        if (r.level.endsWith('简码')) expect(mainCode(rec(ch)).startsWith(r.code)).toBe(true);
      }
    }
  });

  it('「工」是键名字，但它也有简码 a / aaa —— 级别照全码口径算', () => {
    expect(levels('工')).toEqual([
      ['a', '一级简码'],
      ['aaa', '三级简码'],
      ['aaaa', '全码'],
    ]);
  });
});
