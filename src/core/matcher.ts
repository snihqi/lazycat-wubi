/**
 * matcher.ts — 逐字比对（两种模式，行为不同）。
 *
 * 负责：把"输入法一次上屏的一串字符"逐字消费到目标串上，判定对错、推进位置、记账。
 * 不负责：计时（timer.ts）、经验与货币（xp/currency）、界面标记（界面读 CommitResult）。
 * 调用方：练习页 / 考试页；单字卡把它和 queue.ts 接起来（打错 → 队列退两档）。
 *
 * 两种模式（ux-spec 5.6，规则不同**不是**配置项，是产品决定）：
 *   strict（单字 / 词组卡）：打错**不前进**，标记失败等重新上屏；返回 advanced:false。
 *   follow（长文本）：打错**前进**到下一个字，记 errors；返回 advanced:true。界面当前只用 strict。
 *
 * 不提供的：`undo()` / `backspace()`。已上屏的字不能撤 —— 这是产品决定，不是技术限制。
 * 需要倒带就 `createMatcher()` 重来（界面用「再打一次」实现）。
 */

import type { CommitResult, MatchStats, PracticeMode } from './types';
import { hasEffectiveFrom, isEffectiveChar } from './wordcount';

/** 比对器。所有方法都不会 throw。 */
export interface Matcher {
  readonly mode: PracticeMode;
  /** 目标串（调用方负责先 normalizeTarget）。 */
  readonly target: string;
  /** 当前待打字的索引。 */
  readonly index: number;
  /** 是否已打完。 */
  readonly done: boolean;
  /** 当前应该打的字；已打完为 null。 */
  expecting(): string | null;
  /** 提交一次"新上屏的字符"。 */
  commit(input: string): CommitResult;
  /** 跳过当前字（记为错误）。 */
  skip(): CommitResult;
  /**
   * 退回一个字（跟打器的回删）。撤销上一次 commit / skip 的全部影响：
   * 位置、统计、失败次数。没有可退的返回 false。
   * 严格模式只在真的推进过之后才有效；被挡住的那次也能退（把错误标记撤掉）。
   */
  undo(): boolean;
  /** 累计统计（快照，改不到内部）。 */
  stats(): MatchStats;
  /** 当前字**连续**打错几次（界面：连续 3 次自动展开图解条）。 */
  strikes(): number;
  /** 某个位置一共打错过几次（队列重排 / 统计）。 */
  failuresAt(index: number): number;
  /** 进度（进度条用；total 是有效字数，不含标点/空白）。 */
  progress(): { index: number; total: number; correctChars: number; wrongChars: number; done: boolean };
}

interface Snap {
  i: number;
  acc: MatchStats;
  fail: Array<[number, number]>;
  strikes: number;
}

const EMPTY_STATS = (): MatchStats => ({
  correctChars: 0,
  wrongChars: 0,
  correctPunct: 0,
  wrongPunct: 0,
  skipped: 0,
});

/** 空白（空格 / 换行 / 全角空格）永不要求输入，走到就自动跳过。 */
function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\u3000' || ch === '\r';
}

/** 准确率 = 对的有效字 / (对的有效字 + 错的有效字)。没有数据给 null，不返回 NaN。 */
export function accuracyOf(stats: MatchStats): number | null {
  const denom = stats.correctChars + stats.wrongChars;
  if (denom <= 0) return null;
  return stats.correctChars / denom;
}

class StrictMatcher implements Matcher {
  readonly mode: PracticeMode;
  readonly target: string;
  private i = 0;
  private acc: MatchStats = EMPTY_STATS();
  private failMap = new Map<number, number>();
  private currentStrikes = 0;
  private hist: Snap[] = [];

  constructor(target: string, mode: PracticeMode) {
    this.target = typeof target === 'string' ? target : '';
    this.mode = mode;
    this.skipSpace();
  }

  private push(): void {
    this.hist.push({ i: this.i, acc: { ...this.acc }, fail: [...this.failMap], strikes: this.currentStrikes });
    if (this.hist.length > 400) this.hist.shift();
  }

  undo(): boolean {
    const s = this.hist.pop();
    if (!s) return false;
    this.i = s.i;
    this.acc = { ...s.acc };
    this.failMap = new Map(s.fail);
    this.currentStrikes = s.strikes;
    return true;
  }

  get index(): number {
    return this.i;
  }

  get done(): boolean {
    return !hasEffectiveFrom(this.target, this.i);
  }

  expecting(): string | null {
    if (this.done) return null;
    return this.target.charAt(this.i);
  }

  stats(): MatchStats {
    return { ...this.acc };
  }

  strikes(): number {
    return this.currentStrikes;
  }

  failuresAt(index: number): number {
    return this.failMap.get(index) ?? 0;
  }

  progress() {
    const total = countTotal(this.target);
    const correctChars = this.acc.correctChars;
    const wrongChars = this.acc.wrongChars;
    return { index: this.i, total, correctChars, wrongChars, done: this.done };
  }

  commit(input: string): CommitResult {
    const src = typeof input === 'string' ? input : '';
    if (src.length > 0 && !this.done) this.push();
    let k = 0;
    let advancedCount = 0;
    let wrong: string | null = null;

    while (k < src.length && !this.done) {
      const got = src.charAt(k);

      // 输入侧的空白无条件丢弃：不比较、不推进、不记错。
      // 目标里的空白已被 skipSpace() 越过，用户从不为它负责；
      // 而界面用透明 textarea 收上屏内容时，'\n'、尾随空格、全角空格
      // 都可能混进来（Shift+Enter、输入法尾巴）。一旦拿去比对，
      // 就会把后面的目标字当成"打错"吃掉，且从该处起整篇错位。
      if (isSpace(got)) {
        k += 1;
        continue;
      }

      const expected = this.target.charAt(this.i);

      if (got === expected) {
        if (isEffectiveChar(got)) this.acc.correctChars += 1;
        else this.acc.correctPunct += 1;
        this.i += 1;
        k += 1;
        advancedCount += 1;
        this.currentStrikes = 0;
        this.skipSpace();
        continue;
      }

      // 打错：记失败次数，**不前进**，把这个错字消费掉就停手。
      if (isEffectiveChar(got)) this.acc.wrongChars += 1;
      else this.acc.wrongPunct += 1;
      wrong = got;
      this.failMap.set(this.i, (this.failMap.get(this.i) ?? 0) + 1);
      this.currentStrikes += 1;
      k += 1;
      break;
    }

    // 严格模式：遇到错字就是"这次上屏被挡住了"，哪怕前面已经推进了几十个字。
    const blocked = wrong !== null;
    return {
      consumed: k,
      rest: src.slice(k),
      advanced: !blocked && advancedCount > 0,
      blocked,
      correct: wrong === null,
      expecting: this.expecting(),
      index: this.i,
      done: this.done,
      wrong,
      stats: { ...this.acc },
    };
  }

  skip(): CommitResult {
    if (this.done) return this.result(0, 0, true, null);
    const expected = this.target.charAt(this.i);
    this.acc.skipped += 1;
    if (isEffectiveChar(expected)) this.acc.wrongChars += 1;
    else this.acc.wrongPunct += 1;
    this.failMap.set(this.i, (this.failMap.get(this.i) ?? 0) + 1);
    this.currentStrikes += 1;
    this.i += 1;
    this.skipSpace();
    return this.result(0, 1, false, null);
  }

  private result(consumed: number, advancedCount: number, correct: boolean, wrong: string | null): CommitResult {
    const blocked = wrong !== null;
    return {
      consumed,
      rest: '',
      advanced: !blocked && advancedCount > 0,
      blocked,
      correct,
      expecting: this.expecting(),
      index: this.i,
      done: this.done,
      wrong,
      stats: { ...this.acc },
    };
  }

  /** 目标串里的空白不要求输入：走到就跳过去。 */
  private skipSpace(): void {
    while (this.i < this.target.length && isSpace(this.target.charAt(this.i))) this.i += 1;
  }
}

class FollowMatcher implements Matcher {
  readonly mode: PracticeMode;
  readonly target: string;
  private i = 0;
  private acc: MatchStats = EMPTY_STATS();
  private failMap = new Map<number, number>();
  private hist: Snap[] = [];

  constructor(target: string, mode: PracticeMode) {
    this.target = typeof target === 'string' ? target : '';
    this.mode = mode;
    this.skipSpace();
  }

  private push(): void {
    this.hist.push({ i: this.i, acc: { ...this.acc }, fail: [...this.failMap], strikes: 0 });
    if (this.hist.length > 400) this.hist.shift();
  }

  undo(): boolean {
    const s = this.hist.pop();
    if (!s) return false;
    this.i = s.i;
    this.acc = { ...s.acc };
    this.failMap = new Map(s.fail);
    return true;
  }

  get index(): number {
    return this.i;
  }

  get done(): boolean {
    // 剩余里只剩标点也算打完（ux-spec 5.7：标点错不算没打完）。
    return !hasEffectiveFrom(this.target, this.i);
  }

  expecting(): string | null {
    if (this.done) return null;
    return this.target.charAt(this.i);
  }

  stats(): MatchStats {
    return { ...this.acc };
  }

  strikes(): number {
    return 0;
  }

  failuresAt(index: number): number {
    return this.failMap.get(index) ?? 0;
  }

  progress() {
    const total = countTotal(this.target);
    return {
      index: this.i,
      total,
      correctChars: this.acc.correctChars,
      wrongChars: this.acc.wrongChars,
      done: this.done,
    };
  }

  commit(input: string): CommitResult {
    const src = typeof input === 'string' ? input : '';
    if (src.length > 0 && !this.done) this.push();
    let k = 0;
    let advancedCount = 0;
    let wrong: string | null = null;

    while (k < src.length && !this.done) {
      const got = src.charAt(k);

      // 输入侧的空白无条件丢弃（见 StrictMatcher.commit 的同名注释）。
      // 跟打模式尤其致命：错一个就会从该处起整篇错位。
      if (isSpace(got)) {
        k += 1;
        continue;
      }

      const expected = this.target.charAt(this.i);

      if (got === expected) {
        if (isEffectiveChar(got)) this.acc.correctChars += 1;
        else this.acc.correctPunct += 1;
      } else {
        if (isEffectiveChar(got)) this.acc.wrongChars += 1;
        else this.acc.wrongPunct += 1;
        if (wrong === null) wrong = got;
        this.failMap.set(this.i, (this.failMap.get(this.i) ?? 0) + 1);
      }

      // 跟打模式：对错都前进，节奏不能断。
      this.i += 1;
      k += 1;
      advancedCount += 1;
      this.skipSpace();
    }

    return {
      consumed: k,
      rest: src.slice(k),
      advanced: advancedCount > 0,
      blocked: false, // 跟打模式打错也前进，永远不挡
      correct: wrong === null,
      expecting: this.expecting(),
      index: this.i,
      done: this.done,
      wrong,
      stats: { ...this.acc },
    };
  }

  skip(): CommitResult {
    if (this.done) {
      return this.pack(0, 0, null, true);
    }
    const expected = this.target.charAt(this.i);
    this.acc.skipped += 1;
    if (isEffectiveChar(expected)) this.acc.wrongChars += 1;
    else this.acc.wrongPunct += 1;
    this.failMap.set(this.i, (this.failMap.get(this.i) ?? 0) + 1);
    this.i += 1;
    this.skipSpace();
    return this.pack(0, 1, null, false);
  }

  private pack(consumed: number, advancedCount: number, wrong: string | null, correct: boolean): CommitResult {
    return {
      consumed,
      rest: '',
      advanced: advancedCount > 0,
      blocked: false,
      correct,
      expecting: this.expecting(),
      index: this.i,
      done: this.done,
      wrong,
      stats: { ...this.acc },
    };
  }

  private skipSpace(): void {
    while (this.i < this.target.length && isSpace(this.target.charAt(this.i))) this.i += 1;
  }
}

function countTotal(target: string): number {
  let n = 0;
  for (let i = 0; i < target.length; i++) {
    if (isEffectiveChar(target.charAt(i))) n += 1;
  }
  return n;
}

/**
 * 建一个比对器。
 * @param target 目标串；文章请先过 `normalizeTarget()`。
 * @param mode `strict`（单字/词组）或 `follow`（文章/考试）。
 */
export function createMatcher(target: string, mode: PracticeMode): Matcher {
  return mode === 'strict' ? new StrictMatcher(target, mode) : new FollowMatcher(target, mode);
}
