import { describe, expect, it } from 'vitest';
import { accuracyOf, createMatcher } from '../src/core/matcher';
import { countEffective } from '../src/core/wordcount';

/**
 * 长文本回归：空白处理。
 *
 * 背景：`commit()` 曾经不区分"用户打的字"和"输入侧混进来的空白"，
 * 目标字会被一个 '\n' 当成错字吃掉，且从该处起整篇错位。
 *
 * 词组卡的目标串也可能带空白，所以用合成文本守着这条约束。
 */
const LINES = [
  '在工作或学习中遇到不认识的字，',
  '我们往往会去查它的编码。',
  '五笔的答案是一张拆解图。',
];
const text = LINES.join('\n');

describe('长文本 · 空白不参与判定', () => {
  const EXPECTED_CHARS = countEffective(text);

  it('按 expecting() 驱动：748 个有效字全对', () => {
    const m = createMatcher(text, 'follow');
    let guard = 0;
    while (!m.done && guard++ < 5000) {
      const e = m.expecting();
      if (e === null) break;
      m.commit(e);
    }
    expect(m.done).toBe(true);
    expect(m.stats().correctChars).toBe(EXPECTED_CHARS);
    expect(m.stats().wrongChars).toBe(0);
    expect(accuracyOf(m.stats())).toBe(1);
  });

  it('按目标串逐字驱动（含换行）也必须全对', () => {
    const m = createMatcher(text, 'follow');
    for (const ch of text) {
      if (m.done) break;
      m.commit(ch);
    }
    expect(m.stats().correctChars).toBe(EXPECTED_CHARS);
    expect(m.stats().wrongChars).toBe(0);
    expect(m.stats().wrongPunct).toBe(0);
  });

  it('末尾夹带空格/换行不会推进、不会吃字', () => {
    const m = createMatcher(text, 'follow');
    m.commit('在 工作或学习中\n');
    expect(m.stats().correctChars).toBe(7);
    expect(m.stats().wrongChars).toBe(0);
    expect(m.stats().wrongPunct).toBe(0);
    expect(m.expecting()).toBe('遇');
  });
});
