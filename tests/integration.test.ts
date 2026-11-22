import { describe, expect, it } from 'vitest';
import { CARDS, CHARS, ROOTS, cardById, isItemCard } from '../src/data';
import { accuracyOf, createMatcher, createQueue, createTimer, queueFromSnapshot } from '../src/core/index';

/**
 * 端到端：只用 core/index 的公开 API（界面能拿到的就是这些），
 * 把「打开一张卡 → 打完 → 队列变熟 → 快照能恢复」整条链走一遍。
 */
describe('integration · 一张单字卡的一轮完整流程', () => {
  const card = cardById('chars:1-500')!;

  it('卡片数据可以直接喂给队列和比对器', () => {
    expect(isItemCard(card)).toBe(true);
    if (!isItemCard(card)) return;

    const queue = createQueue(card.items, { seed: 'session-1' });
    const head = queue.peek()!;
    expect(card.items).toContain(head.id);

    // 题目 id → 字
    const ch = CHARS.find((c) => `char:${c.ch}` === head.id)!.ch;
    expect(ch.length).toBe(1);

    const matcher = createMatcher(ch, 'strict');
    const timer = createTimer();
    timer.start();

    expect(matcher.commit(ch).done).toBe(true);
    timer.finish();

    expect(accuracyOf(matcher.stats())).toBe(1);
    expect(timer.speed(1)).not.toBeNull();
    queue.answer(true);
    expect(queue.progress()).toMatchObject({ total: 500, mastered: 0 });
  });

  it('500 题全打对：队列里每题都变熟，经验累计 500', () => {
    if (!isItemCard(card)) return;
    const queue = createQueue(card.items, { seed: 'all-correct' });
    let xp = 0;

    // 每题打对 9 次 → 全部进入尾窗（熟）
    for (let round = 0; round < 10; round++) {
      const seen = new Set<string>();
      while (seen.size < card.items.length) {
        const cur = queue.peek()!;
        seen.add(cur.id);
        const ch = CHARS.find((c) => `char:${c.ch}` === cur.id)!.ch;
        const m = createMatcher(ch, 'strict');
        m.commit(ch);
        xp += m.stats().correctChars;
        queue.answer(true);
      }
    }
    expect(xp).toBeGreaterThanOrEqual(500 * 9);
    expect(queue.progress().mastered).toBe(500);
  });
});

describe('integration · 队列跨会话续上', () => {
  it('存档里的队列快照能恢复，且字根卡 328 题不丢不重', () => {
    const card = cardById('roots')!;
    if (!isItemCard(card)) return;

    const queue = createQueue(card.items, { seed: 'roots-session' });
    for (let i = 0; i < 50; i++) queue.answer(i % 7 !== 0);

    const snap = queue.snapshot();
    // 存档往返改成 JSON 往返：真正的落盘就是 JSON.stringify/parse 一个对象，
    // 存档序列化在 app/store，内核只负责队列快照本身。
    const saved = JSON.parse(JSON.stringify({ [card.id]: snap })) as Record<string, typeof snap>;

    const restored = queueFromSnapshot(card.items, saved[card.id]);
    expect(restored.dropped).toEqual([]);
    expect(restored.queue.order()).toEqual(queue.order());
    expect(restored.queue.progress().total).toBe(328);
    expect(new Set(restored.queue.order()).size).toBe(328);
    expect(restored.queue.order().every((id) => id.startsWith('root:') || id.startsWith('shortcode:'))).toBe(true);
    expect(CARDS.length).toBe(10);
    expect(ROOTS.length).toBe(328);
  });
});
