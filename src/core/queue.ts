/**
 * queue.ts — 间隔重复出题队列。
 *
 * 负责：按"答对次数"决定一题插回队列的位置、答错退档、进度统计、可存档/可复现。
 * 不负责：题目内容（src/data）、判对错（matcher.ts）、界面渲染。
 * 调用方：字根卡 / 单字卡 / 词组卡（每张卡一个队列实例）。
 *
 * 算法是固定档位的间隔重复，随机数走 seeded rng，因此顺序可复现：
 *   - 答对后 `count += 1`，插回第 `POS_TABLE[count]` 位（0→2, 1→4, …7→100）；
 *   - `count >= 8`（第 9 次答对起）不再排队尾，而是落在**队尾一个窗口**里：
 *     窗口 = `max(4, round(len × 0.12))`，在窗口内随机取位 —— 直接排队尾会让整组
 *     变成"每轮一模一样的一条环"，窗口随机化保住"越熟隔得越远"又每轮不同；
 *   - 答错：**留在队首**，`count` 退两档（`max(0, count − 2)`，从没答对过的仍是 −1），
 *     打 `failed` 标记。不清零是因为"手滑一次就退回起点"太伤人，而且会让这个字立刻
 *     变回"每 2 个字出现一次"，反复抢走本该给生字的时间。
 *
 * 可复现：同一 seed + 同一操作序列 → 同一出题顺序。快照里存的是**身份 + 熟练度**，
 * 不存数组下标，所以以后改题目顺序，进度不会错位。
 */

import type { QueueItem, QueueProgress, QueueSnapshot } from './types';
import { createRng, rngFromState, type Rng } from './rng';
import { safeInt } from './num';

/** 第 n 次答对后插回的位置（n = count）。 */
export const POS_TABLE: Readonly<Record<number, number>> = Object.freeze({
  0: 2,
  1: 4,
  2: 8,
  3: 12,
  4: 20,
  5: 30,
  6: 60,
  7: 100,
});

/** 从第几次答对起改为"尾窗随机落位"。 */
export const TAIL_FROM = 8;
/** 尾窗占队列的比例。 */
export const TAIL_SPAN = 0.12;
/** 尾窗最小宽度（题少时也要有随机余地）。 */
export const TAIL_MIN_WINDOW = 4;
/** 低档位抖动比例（可选，默认关闭，见 createQueue 的 `jitter`）。 */
export const JITTER_RATIO = 0.3;
/** 从没答对过的题的 count。 */
export const INITIAL_COUNT = -1;
/** 熟练门槛：count ≥ 8 视为"熟"（第 9 次答对起进尾窗，间隔最长）。 */
export const MASTERED_COUNT = TAIL_FROM;

export interface QueueOptions {
  /** seed。同一 seed + 同一操作序列 → 同一出题顺序。 */
  seed?: string | number;
  /**
   * 低档位抖动。
   * 默认 **false**：按 POS_TABLE 的确定位置落座，顺序完全可复现，便于写断言。
   * 打开后"刚答对一次"的字不会成批挤在第 4 位，代价是位置有 ±30% 浮动。
   */
  jitter?: boolean;
}

/** 队列。 */
export interface SrsQueue {
  readonly size: number;
  /**
   * 看**当前**这道题（**幂等**，取多少次都是同一道，不推进）。
   *
   * 不叫 `next()`：`next()` 在任何语言里都隐含"取下一个"，而这里只是"看当前这个"。
   * 写成循环里连调 next 会拿到同一道题 12 次（死循环或永远第一题）。
   * 推进只有一个入口：`answer(correct)`。
   */
  peek(): QueueItem | null;
  /** 记一次作答并推进队列；返回刚作答的那道题（已更新 count/failed）。 */
  answer(correct: boolean): QueueItem | null;
  /**
   * 把**队首**那道题标成「这一轮答错过」；队列空则返回 false。
   *
   * 为什么不叫界面自己写 `peek().failed = true`：`peek()` 返回的是副本
   * （见它的注释与实现），赋值只改到一个用完就丢的对象，队列里那道题
   * 永远不会被打上标记 —— 界面据此判断「答错也要给提示」时就永远不生效。
   *
   * 它**不是**一次作答：不动 count、不动顺序、不动 answers，排位与熟练度
   * 仍然只由 `answer()` 决定。存在的意义只是「这一轮答错过」这个界面标记。
   */
  markFailed(): boolean;
  progress(): QueueProgress;
  snapshot(): QueueSnapshot;
  /** 当前顺序（调试/测试用，不要拿它存盘）。 */
  order(): string[];
}

class Queue implements SrsQueue {
  private items: QueueItem[];
  private rng: Rng;
  private readonly jitter: boolean;
  private answers = 0;

  constructor(items: QueueItem[], rng: Rng, jitter: boolean, answers = 0) {
    this.items = items;
    this.rng = rng;
    this.jitter = jitter;
    this.answers = answers;
  }

  get size(): number {
    return this.items.length;
  }

  peek(): QueueItem | null {
    const head = this.items[0];
    return head ? { ...head } : null;
  }

  answer(correct: boolean): QueueItem | null {
    const item = this.items.shift();
    if (!item) return null;

    if (correct) {
      item.count += 1;
      item.failed = false;
      this.answers += 1;
      this.reinsert(item);
    } else {
      // 退两档，不清零；原地留在队首（一步都不往后挪）。
      item.count = item.count < 0 ? INITIAL_COUNT : Math.max(0, item.count - 2);
      item.failed = true;
      this.items.unshift(item);
    }

    return { ...item };
  }

  markFailed(): boolean {
    const head = this.items[0];
    if (!head) return false;
    head.failed = true;
    return true;
  }

  progress(): QueueProgress {
    const total = this.items.length;
    // 「练过」= 至少答对过一次；「已熟」= 答对 8 次以上。前者是看得见的进度，
    // 后者是长期目标 —— 只报后者会让大卡（500 题）永远停在 0。
    const seen = this.items.reduce((n, it) => (it.count >= 0 ? n + 1 : n), 0);
    const mastered = this.items.reduce((n, it) => (it.count >= MASTERED_COUNT ? n + 1 : n), 0);
    return {
      total,
      seen,
      mastered,
      ratio: total > 0 ? mastered / total : 1,
      answers: this.answers,
    };
  }

  snapshot(): QueueSnapshot {
    return {
      v: 1,
      seedState: this.rng.state,
      jitter: this.jitter,
      ids: this.items.map((it) => it.id),
      counts: this.items.map((it) => it.count),
      failed: this.items.map((it) => it.failed),
      answers: this.answers,
    };
  }

  order(): string[] {
    return this.items.map((it) => it.id);
  }

  /** 按原算法算插回位置并插入（位置基于 shift 之后的长度，与原实现一致）。 */
  private reinsert(item: QueueItem): void {
    const len = this.items.length;
    const r = item.count;
    let pos: number;

    if (r >= TAIL_FROM) {
      pos = this.tailPos(len);
    } else {
      const base = POS_TABLE[r];
      pos = base === undefined ? len : Math.min(base, len);
    }

    if (this.jitter && pos < len) pos = this.jitterPos(pos, len);

    this.items.splice(pos, 0, item);
  }

  /** 尾窗：`len − k`，k 在 `[0, max(4, round(len×0.12))]` 里。 */
  private tailPos(len: number): number {
    if (len < TAIL_MIN_WINDOW) return len;
    const span = Math.max(TAIL_MIN_WINDOW, Math.round(len * TAIL_SPAN));
    return len - this.rng.int(span + 1);
  }

  /** 低档位抖动：±30%，但不小于 1（不把熟题甩回队首）。 */
  private jitterPos(pos: number, len: number): number {
    const d = Math.max(1, Math.round(pos * JITTER_RATIO));
    const raw = pos - d + this.rng.int(2 * d + 1);
    return Math.max(1, Math.min(len, raw));
  }
}

/**
 * 建队列。
 * @param ids 题目稳定 ID，按**出题顺序**给（字根卡请用 build-data 生成的池序，
 *            它已经把 25 个键交错铺开，不会连着出同一个键）。
 */
export function createQueue(ids: readonly string[], opts: QueueOptions = {}): SrsQueue {
  const items: QueueItem[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, count: INITIAL_COUNT, failed: false });
  }
  const rng = createRng(opts.seed ?? 'lazycat-wubi');
  return new Queue(items, rng, opts.jitter === true);
}

/**
 * 从快照恢复。
 *
 * 容错口径：不认识的 ID、重复 ID 直接跳过，能救多少救多少；
 * `allIds` 里没出现在快照中的题**补到队尾**当新题。绝不因为"有一个 id 坏了"就丢掉整套熟练度。
 */
export function queueFromSnapshot(
  allIds: readonly string[],
  snap: QueueSnapshot | null | undefined,
): { queue: SrsQueue; dropped: string[] } {
  const valid = new Set(allIds);
  const dropped: string[] = [];
  const items: QueueItem[] = [];
  const seen = new Set<string>();

  const ids = snap && Array.isArray(snap.ids) ? snap.ids : [];
  const counts = snap && Array.isArray(snap.counts) ? snap.counts : [];
  const failed = snap && Array.isArray(snap.failed) ? snap.failed : [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== 'string' || !valid.has(id) || seen.has(id)) {
      if (typeof id === 'string') dropped.push(id);
      continue;
    }
    seen.add(id);
    // 该位没有数字就当新题（count = -1），别当成"答对过"。
    const raw = i < counts.length ? counts[i] : undefined;
    items.push({
      id,
      count: safeInt(raw, INITIAL_COUNT, -1),
      failed: failed[i] === true,
    });
  }

  for (const id of allIds) {
    if (seen.has(id)) continue;
    items.push({ id, count: INITIAL_COUNT, failed: false });
  }

  const jitter = snap?.jitter === true;
  const rng = snap && Number.isFinite(snap.seedState) ? rngFromState(safeInt(snap.seedState, 0, 0)) : createRng('lazycat-wubi');
  const answers = snap ? safeInt(snap.answers, 0, 0) : 0;
  return { queue: new Queue(items, rng, jitter, answers), dropped };
}
