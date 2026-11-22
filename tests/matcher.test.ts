import { describe, expect, it } from 'vitest';
import { accuracyOf, createMatcher } from '../src/core/matcher';

describe('matcher · 严格模式（单字 / 词组卡）', () => {
  it('打错不前进，expecting 不变', () => {
    const m = createMatcher('我', 'strict');
    const r = m.commit('你');

    expect(r.advanced).toBe(false);
    expect(r.correct).toBe(false);
    expect(r.expecting).toBe('我');
    expect(r.index).toBe(0);
    expect(r.consumed).toBe(1);
    expect(r.rest).toBe('');
    expect(r.done).toBe(false);
    expect(r.stats.wrongChars).toBe(1);
    expect(m.expecting()).toBe('我');
  });

  it('连续打错累计失败次数（界面用它在第 3 次展开图解条）', () => {
    const m = createMatcher('我', 'strict');
    m.commit('你');
    m.commit('他');
    m.commit('她');
    expect(m.strikes()).toBe(3);
    expect(m.failuresAt(0)).toBe(3);
    expect(m.expecting()).toBe('我');
  });

  it('打对后前进并清空连错计数', () => {
    const m = createMatcher('我们', 'strict');
    m.commit('你');
    const r = m.commit('我');
    expect(r.advanced).toBe(true);
    expect(r.correct).toBe(true);
    expect(m.strikes()).toBe(0);
    expect(r.expecting).toBe('们');
    expect(r.done).toBe(false);
  });

  it('词组卡两个字都打对才算打完', () => {
    const m = createMatcher('我们', 'strict');
    expect(m.commit('我').done).toBe(false);
    expect(m.commit('们').done).toBe(true);
    expect(m.expecting()).toBeNull();
  });
});

describe('matcher · 跟打模式（文章 / 考试）', () => {
  it('打错也前进，errors +1', () => {
    const m = createMatcher('我们的', 'follow');
    const r = m.commit('我你');

    expect(r.advanced).toBe(true);
    expect(r.correct).toBe(false);
    expect(r.index).toBe(2);
    expect(r.expecting).toBe('的');
    expect(r.wrong).toBe('你');
    expect(r.stats.wrongChars).toBe(1);
    expect(r.stats.correctChars).toBe(1);
    expect(accuracyOf(r.stats)).toBeCloseTo(0.5, 6);
  });

  it('标点：一致算对、不一致算错，都不计字数', () => {
    const ok = createMatcher('你好，世界', 'follow');
    const r1 = ok.commit('你好，世界');
    expect(r1.done).toBe(true);
    expect(r1.stats.correctChars).toBe(4);
    expect(r1.stats.correctPunct).toBe(1);
    expect(r1.stats.wrongPunct).toBe(0);

    const bad = createMatcher('你好，世界', 'follow');
    const r2 = bad.commit('你好,世界');
    expect(r2.done).toBe(true);
    expect(r2.stats.correctChars).toBe(4);
    expect(r2.stats.wrongPunct).toBe(1);
    expect(r2.stats.wrongChars).toBe(0); // 标点错不污染"字数准确率"
  });

  it('打完的判据：剩余只有标点也算打完（ux-spec 5.7）', () => {
    const m = createMatcher('走吧。', 'follow');
    const r = m.commit('走吧');
    expect(r.done).toBe(true);
    expect(r.index).toBe(2);
  });
});

describe('matcher · 一次上屏多个字', () => {
  it('目标 3 字，一次上屏 4 字：消费 3 个，剩 1 个留给下一次', () => {
    const m = createMatcher('我们仨', 'strict');
    const r = m.commit('我们仨啊');

    expect(r.consumed).toBe(3);
    expect(r.rest).toBe('啊');
    expect(r.advanced).toBe(true);
    expect(r.correct).toBe(true);
    expect(r.done).toBe(true);
    expect(r.stats.correctChars).toBe(3);
  });

  it('严格模式打错时只消费到错字为止（剩下的下次再提交）', () => {
    const m = createMatcher('我们', 'strict');
    const r = m.commit('你我们');
    expect(r.consumed).toBe(1); // 只吃掉了错的那个"你"
    expect(r.rest).toBe('我们');
    expect(r.index).toBe(0);
    expect(r.advanced).toBe(false);
  });

  it('一次上屏 3 字、第 3 字打错：前 2 字推进了，但这次提交算"被挡住"', () => {
    const m = createMatcher('我们今天', 'strict');
    const r = m.commit('我们他');

    // 状态：确实走到了第 3 个字
    expect(r.index).toBe(2);
    expect(r.expecting).toBe('今');
    expect(r.stats.correctChars).toBe(2);
    expect(r.stats.wrongChars).toBe(1);

    // 语义：这次上屏被错字挡住了（advanced 与 blocked 互为反面），要看推进到哪读 index
    expect(r.advanced).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.correct).toBe(false);

    // 重打当前字就继续
    const r2 = m.commit('今');
    expect(r2.advanced).toBe(true);
    expect(r2.blocked).toBe(false);
    expect(m.expecting()).toBe('天');
  });

  it('跟打模式一次吃完整串', () => {
    const m = createMatcher('春眠不觉晓', 'follow');
    const r = m.commit('春眠不觉晓');
    expect(r.consumed).toBe(5);
    expect(r.done).toBe(true);
    expect(r.rest).toBe('');
  });
});

describe('matcher · skip 与空白', () => {
  it('skip 记为错误并前进，不扣经验（经验在 xp.ts 只加不减）', () => {
    const m = createMatcher('我们', 'strict');
    const r = m.skip();
    expect(r.advanced).toBe(true);
    expect(r.correct).toBe(false);
    expect(r.index).toBe(1);
    expect(r.stats.skipped).toBe(1);
    expect(r.stats.wrongChars).toBe(1);
    expect(r.expecting).toBe('们');
  });

  it('目标串里的换行 / 空格不要求输入', () => {
    const m = createMatcher('第一段\n第二段', 'follow');
    const r = m.commit('第一段第二段');
    expect(r.done).toBe(true);
    expect(r.stats.correctChars).toBe(6);
    expect(r.stats.wrongChars).toBe(0);
  });

  it('空输入什么也不做', () => {
    const m = createMatcher('我', 'strict');
    const r = m.commit('');
    expect(r.consumed).toBe(0);
    expect(r.advanced).toBe(false);
    expect(m.index).toBe(0);
  });

  it('没有数据时准确率返回 null，不返回 NaN', () => {
    expect(accuracyOf({ correctChars: 0, wrongChars: 0, correctPunct: 0, wrongPunct: 0, skipped: 0 })).toBeNull();
  });
});

describe('matcher · 空白自动跳过（界面必须按 index 驱动）', () => {
  const text = '今天\n\n很好';

  it('换行不要求用户输入，推进时自动越过', () => {
    const m = createMatcher(text, 'follow');
    m.commit('今天');
    expect(m.expecting()).toBe('很');
    expect(m.index).toBeGreaterThan(2);
  });

  it('按 expecting() 驱动可以打完，且全部记对', () => {
    const m = createMatcher(text, 'follow');
    let guard = 0;
    while (!m.done && guard++ < 100) {
      const exp = m.expecting();
      if (exp === null) break;
      m.commit(exp);
    }
    expect(m.done).toBe(true);
    expect(m.stats().correctChars).toBe(4);
    expect(m.stats().wrongChars).toBe(0);
    expect(accuracyOf(m.stats())).toBe(1);
  });

  it('输入里混入空白必须被忽略，不能吃掉目标字（当前失败，待修）', () => {
    // 场景：输入法/textarea 偶尔会带出一个空格或换行。
    // 空白不是用户"打"出来的东西，目标里的空白也是自动跳过的，
    // 所以输入侧的空白必须无条件丢弃，不比较、不推进、不记错。
    const m = createMatcher('今天 很好', 'follow');
    const r = m.commit('今天\n');
    expect(r.correct).toBe(true);
    expect(r.wrong).toBeNull();          // 现在会失败：'\n' 被拿去比 '很'，记成错字
    expect(m.stats().wrongPunct).toBe(0); // 现在会失败：wrongPunct +1
    expect(m.expecting()).toBe('很');
  });
});
