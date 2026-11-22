import { describe, expect, it } from 'vitest';
import {
  INITIAL_COUNT,
  MASTERED_COUNT,
  POS_TABLE,
  TAIL_FROM,
  TAIL_SPAN,
  createQueue,
  queueFromSnapshot,
} from '../src/core/queue';
import type { QueueSnapshot } from '../src/core/types';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `q${i}`);

describe('queue · 可复现', () => {
  it('同 seed + 同操作序列 → 出题顺序完全一致', () => {
    const run = () => {
      const q = createQueue(ids(60), { seed: 'lazycat' });
      const drawn: string[] = [];
      for (let i = 0; i < 300; i++) {
        const cur = q.peek();
        expect(cur).not.toBeNull();
        drawn.push(cur!.id);
        q.answer(i % 4 !== 0); // 每 4 题错一次
      }
      return drawn;
    };
    expect(run()).toEqual(run());
  });

  it('不同 seed 会走出不同的尾窗顺序（不然 seed 就白设了）', () => {
    const run = (seed: string) => {
      const q = createQueue(ids(60), { seed });
      const drawn: string[] = [];
      for (let i = 0; i < 800; i++) {
        drawn.push(q.peek()!.id);
        q.answer(true);
      }
      return drawn.join(',');
    };
    expect(run('a')).not.toBe(run('b'));
  });

  it('jitter 打开也保持可复现', () => {
    const run = () => {
      const q = createQueue(ids(40), { seed: 'j', jitter: true });
      const drawn: string[] = [];
      for (let i = 0; i < 200; i++) {
        drawn.push(q.peek()!.id);
        q.answer(true);
      }
      return drawn;
    };
    expect(run()).toEqual(run());
  });
});

describe('queue · 插回位置（POS_TABLE 语义）', () => {
  it('新题答对一次后插到第 2 位', () => {
    const q = createQueue(ids(50), { seed: 's' });
    const first = q.peek()!.id;
    const answered = q.answer(true);
    expect(answered?.count).toBe(0);
    expect(q.order().indexOf(first)).toBe(2);
  });

  it('连续答对：位置依次是 2 / 4 / 8 / 12 / 20 / 30 / 60 / 100', () => {
    const list = ids(200);
    // 直接把第 0 题的 count 摆到 k，验证"答对后"落点
    for (let k = 0; k <= 6; k++) {
      const snap: QueueSnapshot = {
        v: 1,
        seedState: 12345,
        jitter: false,
        ids: list,
        counts: list.map((_, i) => (i === 0 ? k : INITIAL_COUNT)),
        failed: list.map(() => false),
      };
      const { queue } = queueFromSnapshot(list, snap);
      const target = queue.peek()!.id;
      queue.answer(true); // count → k+1
      expect(queue.order().indexOf(target)).toBe(POS_TABLE[k + 1]);
    }
  });

  it('答对 8 次后该题不再出现在前 100 次内', () => {
    const list = ids(328);
    const snap: QueueSnapshot = {
      v: 1,
      seedState: 999,
      jitter: false,
      ids: list,
      counts: list.map((_, i) => (i === 0 ? 6 : INITIAL_COUNT)),
      failed: list.map(() => false),
    };
    const { queue } = queueFromSnapshot(list, snap);
    const target = queue.peek()!.id;
    expect(target).toBe('q0');
    queue.answer(true); // count 6 → 7 → 插回第 100 位
    expect(queue.order().indexOf('q0')).toBe(100);

    const drawn: string[] = [];
    for (let i = 0; i < 100; i++) {
      drawn.push(queue.peek()!.id);
      queue.answer(true);
    }
    expect(drawn).not.toContain('q0');
  });

  it('第 9 次答对起落进尾窗（最后 12%，窗口最小 4）', () => {
    const list = ids(100);
    const snap: QueueSnapshot = {
      v: 1,
      seedState: 4242,
      jitter: false,
      ids: list,
      counts: list.map((_, i) => (i === 0 ? 7 : INITIAL_COUNT)),
      failed: list.map(() => false),
    };
    const { queue } = queueFromSnapshot(list, snap);
    const target = queue.peek()!.id;
    queue.answer(true); // count 7 → 8 ≥ TAIL_FROM
    const pos = queue.order().indexOf(target);
    const len = queue.size;
    const span = Math.max(4, Math.round(len * TAIL_SPAN));
    expect(pos).toBeGreaterThanOrEqual(len - span);
    expect(pos).toBeLessThanOrEqual(len - 1);
    expect(TAIL_FROM).toBe(8);
  });

  it('答错：留在队首、熟练度退两档、打 failed 标记', () => {
    const list = ids(10);
    const snap: QueueSnapshot = {
      v: 1,
      seedState: 7,
      jitter: false,
      ids: list,
      counts: list.map((_, i) => (i === 0 ? 5 : INITIAL_COUNT)),
      failed: list.map(() => false),
    };
    const { queue } = queueFromSnapshot(list, snap);
    const target = queue.peek()!.id;
    const after = queue.answer(false);
    expect(after).toMatchObject({ id: target, count: 3, failed: true });
    expect(queue.peek()!.id).toBe(target);
    expect(queue.order().indexOf(target)).toBe(0);
  });

  it('答错从没答对过的题：count 仍是 -1（不清零、也不乱涨）', () => {
    const q = createQueue(ids(5), { seed: 'w' });
    const target = q.peek()!.id;
    const after = q.answer(false);
    expect(after).toMatchObject({ id: target, count: INITIAL_COUNT, failed: true });
    // 答对一次就从 -1 走到 0，不会因为错了几次而跳档
    const fixed = q.answer(true);
    expect(fixed!.failed).toBe(false);
    expect(fixed!.count).toBe(0);
  });
});

describe('queue · markFailed（界面用的「这一轮答错过」标记）', () => {
  it('标记落在队列里的那道题上，不动顺序、不动进度', () => {
    const list = ids(4);
    const snap: QueueSnapshot = {
      v: 1,
      seedState: 7,
      jitter: false,
      ids: list,
      counts: list.map((_, i) => (i === 0 ? 2 : INITIAL_COUNT)),
      failed: list.map(() => false),
    };
    const { queue } = queueFromSnapshot(list, snap);
    const before = queue.progress();

    expect(queue.peek()!.failed).toBe(false);
    expect(queue.markFailed()).toBe(true);
    // 这一条就是原来的 bug：peek() 给的是副本，改那个副本等于什么都没改
    expect(queue.peek()!.failed).toBe(true);
    expect(queue.peek()!.count).toBe(2);      // 不打熟练度
    expect(queue.order()).toEqual(list);      // 不换位
    expect(queue.progress()).toEqual(before); // 不动 count / answers

    // 答对之后标记回 false：提示只在「这一轮」有效
    const ok = queue.answer(true);
    expect(ok).toMatchObject({ id: 'q0', count: 3, failed: false });
    expect(queue.peek()!.id).not.toBe('q0');
  });

  it('空队列：返回 false，不抛异常', () => {
    const q = createQueue([], { seed: 'empty' });
    expect(q.markFailed()).toBe(false);
    expect(q.peek()).toBeNull();
  });
});

describe('queue · 进度与存档', () => {
  it('progress：已熟 / 总数（count ≥ 8 为熟）', () => {
    const list = ids(10);
    const snap: QueueSnapshot = {
      v: 1,
      seedState: 1,
      jitter: false,
      ids: list,
      counts: [INITIAL_COUNT, 0, 3, MASTERED_COUNT, 9, INITIAL_COUNT, INITIAL_COUNT, 7, MASTERED_COUNT - 1, 100],
      failed: list.map(() => false),
    };
    const { queue } = queueFromSnapshot(list, snap);
    const p = queue.progress();
    expect(p.total).toBe(10);
    expect(p.mastered).toBe(3);
    expect(p.ratio).toBeCloseTo(0.3, 6);
    expect(MASTERED_COUNT).toBe(8);
  });

  it('快照 → 恢复：顺序、熟练度、随机状态都不丢', () => {
    const q = createQueue(ids(30), { seed: 'roundtrip' });
    for (let i = 0; i < 40; i++) q.answer(i % 5 !== 0);

    const snap = q.snapshot();
    const restored = queueFromSnapshot(ids(30), snap).queue;

    expect(restored.order()).toEqual(q.order());
    const pa = q.progress();
    const pb = restored.progress();
    expect({ total: pb.total, mastered: pb.mastered }).toEqual({ total: pa.total, mastered: pa.mastered });
    expect(pb.ratio).toBeCloseTo(pa.ratio, 9);

    // 恢复后继续跑，出题顺序与不中断的那一份一致（seed 状态确实存下来了）
    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 100; i++) {
      a.push(q.peek()!.id);
      b.push(restored.peek()!.id);
      q.answer(true);
      restored.answer(true);
    }
    expect(b).toEqual(a);
  });

  it('快照里存的是题目 id，不是下标（改成新题序也不串位）', () => {
    const q = createQueue(ids(5), { seed: 'x' });
    q.answer(true);
    q.answer(true);
    const snap = q.snapshot();
    expect(snap.ids.every((id) => typeof id === 'string' && id.startsWith('q'))).toBe(true);
    expect(snap.ids).toHaveLength(5);
  });

  it('遇到陌生 id / 重复 id 跳过，缺失的补到队尾（不整份丢掉）', () => {
    const snap: QueueSnapshot = {
      v: 1,
      seedState: 3,
      jitter: false,
      ids: ['q2', 'ghost:1', 'q2', 'q0'],
      counts: [4, 99, 9, 1],
      failed: [false, false, false, true],
    };
    const { queue, dropped } = queueFromSnapshot(['q0', 'q1', 'q2'], snap);
    expect(queue.order()).toEqual(['q2', 'q0', 'q1']); // q1 是新补的
    expect(dropped).toEqual(['ghost:1', 'q2']);
    expect(queue.progress().total).toBe(3);
  });

  it('空队列：peek() 返回 null，不抛异常', () => {
    const q = createQueue([], { seed: 'empty' });
    expect(q.size).toBe(0);
    expect(q.peek()).toBeNull();
    expect(q.answer(true)).toBeNull();
    // seen = 练过（至少答对一次）；mastered = 答对 8 次以上。两个数分开报，
    // 因为大卡（500 题）要 4000 次作答才会出现第一个熟题。
    expect(q.progress()).toEqual({ total: 0, seen: 0, mastered: 0, ratio: 1, answers: 0 });
  });

  it('peek() 幂等：取多少次都是同一道题', () => {
    const q = createQueue(ids(4), { seed: 'peek' });
    const first = q.peek()!.id;
    for (let i = 0; i < 12; i++) expect(q.peek()!.id).toBe(first);
    expect(q.size).toBe(4); // 取了 12 次也没推进
  });
});
