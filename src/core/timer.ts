/**
 * timer.ts — 计时（注入 now()，不累加）。
 *
 * 负责：ready → running → paused ⇄ running → finished（另有 exited）的状态机，以及用时分/速度。
 * 不负责：字数（wordcount.ts 给）、界面刷新节流（界面自己的事）。
 * 调用方：练习页、考试页、结算。
 *
 * 两条硬约束（ux-spec 5.1 / 16）：
 *   1. 用**单调时钟**（`performance.now()`）读数相减，**不用 `setInterval` 累加** —— 累加会漂，
 *      长跑 30 分钟能偏出几秒，而速度是段位门槛，偏一点就不可比。
 *   2. 暂停的时长必须排除在 elapsed 之外。`elapsedMs()` 永远由"累计 + 当前段"算出，
 *      所以暂停期间读多少次都不变。
 */

import type { TimerSnapshot, TimerStatus } from './types';
import { isFiniteNumber } from './num';

/** 时钟。测试注入假时钟，生产用 `performance.now`。 */
export type Clock = () => number;

export interface TimerOptions {
  now?: Clock;
}

/** 计时器。 */
export interface Timer {
  readonly status: TimerStatus;
  /** 是否已经开始过（第一次有效击键）。 */
  readonly started: boolean;
  /** 已用毫秒（不含暂停）。 */
  elapsedMs(): number;
  /** 第一次有效击键时调用。只有 ready 会生效。 */
  start(): boolean;
  /** running → paused。 */
  pause(): boolean;
  /** paused → running。 */
  resume(): boolean;
  /** 任意未结束状态 → finished（冻结 elapsed）。 */
  finish(): boolean;
  /** 任意未退出状态 → exited（冻结 elapsed，但语义上不计成绩）。 */
  exit(): boolean;
  /**
   * 速度 = 正确字数 ÷ elapsed 分钟。
   * elapsed 为 0（还没开始 / 刚点开）返回 `null`，**不返回 Infinity** —— 界面据此显示 `—`。
   */
  speed(correctChars: number): number | null;
  snapshot(): TimerSnapshot;
}

/** 默认时钟：优先单调时钟，退回墙上时钟。不会在模块加载时就碰 `performance`。 */
export function defaultClock(): Clock {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') {
    const fn = perf.now.bind(perf);
    return () => fn();
  }
  return () => Date.now();
}

/**
 * 速度的唯一算法。考试结算（三篇各自的速度）也必须走这里，否则会和练习页对不上。
 * @returns 字/分；elapsedMs ≤ 0 时返回 null。
 */
export function speedOf(correctChars: number, elapsedMs: number): number | null {
  const chars = isFiniteNumber(correctChars) ? Math.max(0, correctChars) : 0;
  const ms = isFiniteNumber(elapsedMs) ? elapsedMs : 0;
  if (ms <= 0) return null;
  return chars / (ms / 60000);
}

class PracticeTimer implements Timer {
  private st: TimerStatus = 'ready';
  /** 已经结算掉的纯净时长。 */
  private acc = 0;
  /** 当前这一段的起点（仅 running 有意义）。 */
  private segStart = 0;
  private readonly now: Clock;

  constructor(opts: TimerOptions = {}) {
    this.now = opts.now ?? defaultClock();
  }

  get status(): TimerStatus {
    return this.st;
  }

  get started(): boolean {
    return this.st !== 'ready';
  }

  elapsedMs(): number {
    if (this.st === 'ready') return 0;
    if (this.st === 'running') {
      const delta = this.now() - this.segStart;
      return this.acc + (delta > 0 ? delta : 0);
    }
    return this.acc;
  }

  start(): boolean {
    if (this.st !== 'ready') return false;
    this.segStart = this.now();
    this.st = 'running';
    return true;
  }

  pause(): boolean {
    if (this.st !== 'running') return false;
    this.settle();
    this.st = 'paused';
    return true;
  }

  resume(): boolean {
    if (this.st !== 'paused') return false;
    this.segStart = this.now();
    this.st = 'running';
    return true;
  }

  finish(): boolean {
    if (this.st === 'finished' || this.st === 'exited') return false;
    if (this.st === 'running') this.settle();
    this.st = 'finished';
    return true;
  }

  exit(): boolean {
    if (this.st === 'exited') return false;
    if (this.st === 'running') this.settle();
    this.st = 'exited';
    return true;
  }

  speed(correctChars: number): number | null {
    return speedOf(correctChars, this.elapsedMs());
  }

  snapshot(): TimerSnapshot {
    return { status: this.st, elapsedMs: this.elapsedMs(), started: this.started };
  }

  private settle(): void {
    const delta = this.now() - this.segStart;
    this.acc += delta > 0 ? delta : 0;
  }
}

/**
 * 建计时器。`now` 可注入（单测里用假时钟：`createTimer({ now: () => t })`）。
 * 只收一个形状 —— 不再兼收裸函数，签名的意图必须一眼看出来。
 */
export function createTimer(opts: TimerOptions = {}): Timer {
  return new PracticeTimer(opts);
}

/** 毫秒 → `mm:ss`（界面展示；超过一小时给 `h:mm:ss`）。 */
export function formatElapsed(ms: number): string {
  if (!isFiniteNumber(ms) || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
