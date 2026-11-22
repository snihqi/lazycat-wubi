import { describe, expect, it } from 'vitest';
import { createTimer, formatElapsed, speedOf } from '../src/core/timer';

/** 假时钟：手动推进，不用 sleep。 */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('timer · 状态机与耗时', () => {
  it('未开始时显示 —（elapsed 0，speed null 而不是 Infinity）', () => {
    const clock = fakeClock();
    const timer = createTimer({ now: clock.now });
    expect(timer.status).toBe('ready');
    expect(timer.started).toBe(false);
    expect(timer.elapsedMs()).toBe(0);
    expect(timer.speed(0)).toBeNull();
    expect(timer.speed(18)).toBeNull();
    expect(Number.isFinite(timer.speed(18) ?? 0)).toBe(true);
  });

  it('第一次击键才启动，elapsed 随时间推进', () => {
    const clock = fakeClock();
    const timer = createTimer({ now: clock.now });
    clock.advance(5000); // 还没开始，不算
    expect(timer.elapsedMs()).toBe(0);

    timer.start();
    clock.advance(60000);
    expect(timer.elapsedMs()).toBe(60000);
    expect(timer.speed(60)).toBeCloseTo(60, 6); // 60 字 / 1 分钟
  });

  it('暂停 10 秒不计入 elapsed', () => {
    const clock = fakeClock();
    const timer = createTimer({ now: clock.now });
    timer.start();
    clock.advance(30000); // 3 秒… 不，是 30 秒
    timer.pause();
    const atPause = timer.elapsedMs();
    expect(atPause).toBe(30000);

    clock.advance(10000); // 暂停的 10 秒
    expect(timer.elapsedMs()).toBe(30000);

    timer.resume();
    clock.advance(20000);
    expect(timer.elapsedMs()).toBe(50000); // 30 + 20，不含暂停的 10
    expect(timer.speed(100)).toBeCloseTo(120, 6); // 100 字 / (5/6 分钟)
  });

  it('暂停期间反复读数不漂', () => {
    const clock = fakeClock();
    const timer = createTimer({ now: clock.now });
    timer.start();
    clock.advance(1234);
    timer.pause();
    for (let i = 0; i < 50; i++) clock.advance(1000);
    expect(timer.elapsedMs()).toBe(1234);
  });

  it('finish 后 elapsed 冻结，再推进时钟也不变', () => {
    const clock = fakeClock();
    const timer = createTimer({ now: clock.now });
    timer.start();
    clock.advance(45000);
    timer.finish();
    clock.advance(90000);
    expect(timer.status).toBe('finished');
    expect(timer.elapsedMs()).toBe(45000);
    expect(timer.snapshot()).toEqual({ status: 'finished', elapsedMs: 45000, started: true });
  });

  it('状态转换不合法的返回 false，不抛异常', () => {
    const clock = fakeClock();
    const timer = createTimer({ now: clock.now });
    expect(timer.pause()).toBe(false); // ready 不能暂停
    expect(timer.resume()).toBe(false);
    expect(timer.start()).toBe(true);
    expect(timer.start()).toBe(false); // 不能重复启动
    expect(timer.pause()).toBe(true);
    expect(timer.resume()).toBe(true);
    expect(timer.exit()).toBe(true);
    expect(timer.status).toBe('exited');
    expect(timer.finish()).toBe(false);
  });

  it('speedOf 对 0 毫秒返回 null', () => {
    expect(speedOf(100, 0)).toBeNull();
    expect(speedOf(100, -5)).toBeNull();
    expect(speedOf(0, 60000)).toBe(0);
    expect(speedOf(214, 60000)).toBeCloseTo(214, 6);
  });

  it('formatElapsed', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(61_000)).toBe('01:01');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(Number.NaN)).toBe('00:00');
  });
});
