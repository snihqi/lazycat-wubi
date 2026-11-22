import { describe, expect, it } from 'vitest';
import { CARDS, CHARS, ROOTS, WORDS, cardById, isItemCard } from '../src/data';
import { createQueue } from '../src/core/queue';

describe('data · 字根（328 题）', () => {
  it('303 字根 + 25 一级简码 = 328，id 唯一', () => {
    expect(ROOTS).toHaveLength(328);
    expect(ROOTS.filter((r) => r.kind === 'root')).toHaveLength(303);
    expect(ROOTS.filter((r) => r.kind === 'shortcode')).toHaveLength(25);
    expect(new Set(ROOTS.map((r) => r.id)).size).toBe(328);
  });

  it('每个字根都有键位与 SVG 路径；变体字根没有名字（glyph 为空是合法的）', () => {
    let named = 0;
    for (const r of ROOTS) {
      expect(r.key).toHaveLength(1);
      expect(r.zone).toBeGreaterThanOrEqual(1);
      expect(r.zone).toBeLessThanOrEqual(5);
      expect(r.id).toMatch(/^(root|shortcode):/);
      if (r.kind === 'root') {
        expect(r.path.length).toBeGreaterThan(0);
        if (r.glyph.length > 0) named += 1;
      } else {
        expect(r.glyph.length).toBeGreaterThan(0);
        expect(r.path).toBe('');
      }
    }
    // 参考数据里变体字根没有名字，界面按"键位 + 序位"回退显示；主字根必须都有名字
    // 实测 217/303 有名字，其余 86 个是变体（参考数据本来就不给名字）
    expect(named).toBeGreaterThan(200);
  });

  it('池序不连着同一个键（按区交错铺开）', () => {
    let adjacent = 0;
    for (let i = 1; i < ROOTS.length; i++) if (ROOTS[i]!.key === ROOTS[i - 1]!.key) adjacent += 1;
    expect(adjacent).toBe(0);
  });

  it('25 个一级简码就是标准那 25 个字', () => {
    const got = new Set(ROOTS.filter((r) => r.kind === 'shortcode').map((r) => r.glyph));
    const expected = '一地在要工上是中国同和的有人我主产不为这民了发以经';
    expect(got.size).toBe(25);
    for (const ch of expected) expect(got.has(ch)).toBe(true);
  });
});

describe('data · 3000 字', () => {
  it('3000 条，按字频序，freqRank 递增', () => {
    expect(CHARS).toHaveLength(3000);
    expect(CHARS[0]!.ch).toBe('的');
    for (let i = 1; i < CHARS.length; i++) {
      expect(CHARS[i]!.freqRank).toBeGreaterThan(CHARS[i - 1]!.freqRank);
    }
  });

  it('每条都有编码与拼音', () => {
    for (const c of CHARS.slice(0, 100)) {
      expect(c.codes.length).toBeGreaterThan(0);
      expect(c.codes[0]!.length).toBeGreaterThanOrEqual(1);
      expect(c.py.length).toBeGreaterThan(0);
    }
  });
});

describe('data · 词组', () => {
  it('三类各 1000 条，长度正确', () => {
    expect(WORDS[2]).toHaveLength(1000);
    expect(WORDS[3]).toHaveLength(1000);
    expect(WORDS[4]).toHaveLength(1000);
    for (const w of WORDS[2].slice(0, 50)) expect([...w]).toHaveLength(2);
    for (const w of WORDS[3].slice(0, 50)) expect([...w]).toHaveLength(3);
    for (const w of WORDS[4].slice(0, 50)) expect([...w]).toHaveLength(4);
  });

  it('组内没有重复词', () => {
    expect(new Set(WORDS[2]).size).toBe(WORDS[2].length);
    expect(new Set(WORDS[3]).size).toBe(WORDS[3].length);
    expect(new Set(WORDS[4]).size).toBe(WORDS[4].length);
  });
});

describe('data · 卡片索引', () => {
  it('10 张卡：字根 1 + 单字 6 + 词组 3', () => {
    expect(CARDS).toHaveLength(10);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(10);
    expect(CARDS.map((c) => c.kind)).toEqual(['roots', 'chars', 'chars', 'chars', 'chars', 'chars', 'chars', 'word2', 'word3', 'idiom']);
  });

  it('id 是稳定字符串，不是下标', () => {
    for (const c of CARDS) expect(c.id).toMatch(/^[a-z]+[:0-9a-z-]*$/);
    expect(cardById('chars:1-500')?.title).toBe('单字 · 1–500');
    expect(cardById('nope')).toBeUndefined();
  });

  it('逐条卡的 items 数量与 charCount 自洽', () => {
    for (const c of CARDS) {
      expect(isItemCard(c)).toBe(true);
      if (!isItemCard(c)) continue;
      expect(c.items).toHaveLength(c.count);
      expect(c.charCount).toBeGreaterThan(0);
    }
  });

  it('字根卡的 items 与字根池一一对应，能直接建队列', () => {
    const card = cardById('roots')!;
    expect(isItemCard(card)).toBe(true);
    if (!isItemCard(card)) return;
    expect(card.items).toEqual(ROOTS.map((r) => r.id));

    const q = createQueue(card.items, { seed: 'roots' });
    expect(q.size).toBe(328);
    expect(q.progress().mastered).toBe(0);
  });
});
