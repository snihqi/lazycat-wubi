import { describe, expect, it } from 'vitest';
import { createMatcher } from '../src/core/matcher';

describe('matcher · 回删（跟打器要能退格重打）', () => {
  it('跟打模式：打错后退一格，字回到待打状态且统计还原', () => {
    const m = createMatcher('我们今天', 'follow');
    m.commit('我');
    m.commit('他');           // 错
    const bad = m.stats();
    expect(bad.wrongChars).toBe(1);
    expect(m.index).toBe(2);

    expect(m.undo()).toBe(true);
    expect(m.index).toBe(1);          // 回到「们」之前
    expect(m.stats().wrongChars).toBe(0);
    expect(m.stats().correctChars).toBe(1);

    expect(m.commit('们').correct).toBe(true);
    expect(m.expecting()).toBe('今');
  });

  it('跟打模式：连退三次回到开头', () => {
    const m = createMatcher('abc', 'follow');
    m.commit('a'); m.commit('b'); m.commit('c');
    expect(m.done).toBe(true);
    expect(m.undo()).toBe(true);
    expect(m.undo()).toBe(true);
    expect(m.undo()).toBe(true);
    expect(m.undo()).toBe(false);     // 没有可退的了
    expect(m.index).toBe(0);
    expect(m.stats().correctChars).toBe(0);
  });

  it('严格模式：打错不前进，退一次把错误标记撤掉', () => {
    const m = createMatcher('我', 'strict');
    m.commit('你');
    expect(m.stats().wrongChars).toBe(1);
    expect(m.failuresAt(0)).toBe(1);
    expect(m.undo()).toBe(true);
    expect(m.stats().wrongChars).toBe(0);
    expect(m.failuresAt(0)).toBe(0);
    expect(m.strikes()).toBe(0);
  });

  it('长文本：退格后仍能重新打完，统计对得上', () => {
    // 用一段合成长文本守着「长目标串上退格仍能重打」这条约束
    const text = '在工作或学习中遇到不认识的字，我们往往会去查它的编码。五笔的答案是一张拆解图。';
    const m = createMatcher(text, 'follow');
    for (const ch of text.slice(0, 20)) m.commit(ch);
    m.undo(); m.undo();
    for (const ch of text.slice(18)) if (!m.done) m.commit(ch);
    expect(m.done).toBe(true);
    expect(m.stats().wrongChars).toBe(0);
    expect(m.stats().correctChars).toBe(m.progress().total);
  });
});
