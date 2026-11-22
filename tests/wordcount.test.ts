import { describe, expect, it } from 'vitest';
import { breakdown, countEffective, countEffectiveFrom, hasEffectiveFrom, isEffectiveChar, isHanzi, normalizeTarget } from '../src/core/wordcount';

describe('wordcount · 有效字数口径', () => {
  it('只数汉字、英文、数字，不数标点与空白', () => {
    expect(countEffective('你好，世界！')).toBe(4);
    expect(countEffective('hello world')).toBe(10);
    expect(countEffective('五笔 86 版')).toBe(5); // 五 笔 8 6 版
    expect(countEffective('　全角空格\t和\n换行')).toBe(7); // 全角空格 和 换行
    expect(countEffective('')).toBe(0);
  });

  it('汉字三个区段都算', () => {
    expect(isHanzi('一')).toBe(true); // 基本区
    expect(isHanzi('㐀')).toBe(true); // 扩展 A
    expect(isHanzi('豈')).toBe(true); // 兼容区
    expect(isHanzi('a')).toBe(false);
    expect(isHanzi('，')).toBe(false);
  });

  it('breakdown 把各类分别数出来', () => {
    const b = breakdown('ab12中文，。 x');
    expect(b).toEqual({ han: 2, latin: 3, digit: 2, other: 2, space: 1, total: 7 });
  });

  it('isEffectiveChar：标点/空白/emoji 都不算字数', () => {
    expect(isEffectiveChar('中')).toBe(true);
    expect(isEffectiveChar('z')).toBe(true);
    expect(isEffectiveChar('7')).toBe(true);
    expect(isEffectiveChar('７')).toBe(true); // 全角数字
    expect(isEffectiveChar('，')).toBe(false);
    expect(isEffectiveChar(' ')).toBe(false);
    expect(isEffectiveChar('😀')).toBe(false);
  });

  it('normalizeTarget 去掉段落缩进与空行，保留标点', () => {
    expect(normalizeTarget('　　第一段，带标点。\n\n  第二段\n')).toBe('第一段，带标点。\n第二段');
    expect(normalizeTarget('a\r\nb')).toBe('a\nb');
  });

  it('hasEffectiveFrom / countEffectiveFrom 只看剩余部分', () => {
    const t = '我们，走了';
    expect(countEffectiveFrom(t, 0)).toBe(4); // 我们走了
    expect(countEffectiveFrom(t, 2)).toBe(2); // 走了
    expect(hasEffectiveFrom('我们。', 2)).toBe(false); // 只剩标点 = 打完
    expect(hasEffectiveFrom('我们。啊', 2)).toBe(true);
  });
});
