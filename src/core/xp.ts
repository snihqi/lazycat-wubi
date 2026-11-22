/**
 * xp.ts — 经验与 100 级等级。
 *
 * 负责：升级曲线、总经验 → 等级/进度的换算、经验上限与 `∞` 展示值、加经验的结算返回。
 * 不负责：经验从哪来（练习页按"1 个正确字 = 1 点经验"调用 addXp）、升级 toast（界面）。
 * 调用方：练习结算、主页顶栏、段位门槛（rank.ts 用 levelOf）、存档（store.ts）。
 *
 * 曲线：升到第 n+1 级所需经验 `need(n) = round(500 + d × (n − 1))`，n 从 1 起。
 * 斜率 `d` 不是拍出来的 1020.5，而是**从两个锚点反解**出来的（见下方 XP_SLOPE）。
 */

import type { XpDisplay, XpGrant, XpProgress } from './types';
import { safeInt } from './num';

/** 等级上限。满级后等级不再变化，经验继续累积。 */
export const LEVEL_MAX = 100;
/** 经验上限。到了就停止累加，展示值变成 `∞`。 */
export const XP_CAP = 100_000_000;
/** 1 级升 2 级所需经验（锚点之一：第一级必须是 500）。 */
export const LEVEL1_NEED = 500;

/**
 * 名义锚点：对外宣称「满级累计 100 万字」，曲线反解用的就是它。
 *
 * 每一分经验都来自卡片，100 万大约相当于 2000 张 500 字的卡 ——
 * 是「长期目标」而不是「不可能完成」。
 *
 * 它不是表里的真实值（真实值是 `XP_TOTAL_AT_MAX`，取整会差 1 点），所以**不导出**。
 */
const XP_TOTAL_NOMINAL = 1_000_000;

/**
 * 斜率：由「Lv.1→2 = 500」与「累计到 100 级 = 1,000,000」两个锚点反解。
 *
 * 99 次升级，等差递增，故 `d × (0+1+…+98) = 1,000,000 − 99 × 500`：
 *   d = (1,000,000 − 49,500) / 4851 ≈ 195.9
 *
 * 为什么不用「500 + 196 × (n−1)」再单独修补最后一级：那样最后一级会脱离等差数列，
 * 而等差是这条曲线唯一好解释的性质。反解斜率则**每一级都在等差上**（相邻差 195~196），
 * 累计的裸值正好 1,000,000，逐级四舍五入后落在 1,000,0xx。
 * 代价是斜率是个无限小数，但它是从锚点算出来的，改锚点它自己会跟着变。
 */
export const XP_SLOPE = (XP_TOTAL_NOMINAL - LEVEL1_NEED * (LEVEL_MAX - 1)) / (((LEVEL_MAX - 1) * (LEVEL_MAX - 2)) / 2);

/** 建升级表。`XP_NEED[n-1]` = 从 n 级升到 n+1 级所需经验（n = 1…99）。 */
function buildNeedTable(): number[] {
  const need: number[] = [];
  for (let n = 1; n < LEVEL_MAX; n++) {
    need.push(Math.round(LEVEL1_NEED + XP_SLOPE * (n - 1)));
  }
  return need;
}

/** 升到下一级所需经验表。只读，索引 0 对应 1 级。 */
export const XP_NEED: readonly number[] = Object.freeze(buildNeedTable());

/**
 * 到达某等级所需的累计经验。`XP_CUM[1] = 0`。
 * 长度 101，索引 0 空置（给"0 级"留位，避免到处写 `- 1`）。
 */
export const XP_CUM: readonly number[] = Object.freeze(buildCumTable());

function buildCumTable(): number[] {
  const cum = new Array<number>(LEVEL_MAX + 1).fill(0);
  for (let lv = 2; lv <= LEVEL_MAX; lv++) {
    cum[lv] = (cum[lv - 1] ?? 0) + (XP_NEED[lv - 2] ?? 0);
  }
  return cum;
}

/**
 * **满级的真实累计经验**，直接从表里读，永远和 `levelOf` 说得一致。
 *
 * 名义上宣称 100 万，实测值来自 99 次逐级四舍五入的累积（差几点）。
 *
 * 这个常量必须等于 `XP_CUM[LEVEL_MAX]`：早先把它写死成名义值，导致
 * `levelOf(XP_TOTAL_AT_MAX)` 返回 **99**、`progressInLevel` 给出 `toNext: 1` ——
 * 用户打到官方宣称的满级经验会停在 99 级，永远差一点。凡是「满级要多少经验」的地方
 * 都应该读这个常量，而不是手打数字。
 *
 * 界面若要显示「满级需 100 万」，那是显示层的四舍五入；内核只吐真值。
 */
export const XP_TOTAL_AT_MAX: number = XP_CUM[LEVEL_MAX] ?? XP_TOTAL_NOMINAL;

/** 升到第 `level + 1` 级所需经验；满级返回 0。 */
export function needFor(level: number): number {
  const lv = safeInt(level, 1, 1, LEVEL_MAX);
  if (lv >= LEVEL_MAX) return 0;
  return XP_NEED[lv - 1] ?? 0;
}

/** 到达某等级所需的累计经验（1 级 = 0）。 */
export function totalXpForLevel(level: number): number {
  const lv = safeInt(level, 1, 1, LEVEL_MAX);
  return XP_CUM[lv] ?? 0;
}

/** 总经验 → 等级（1–100）。二分，O(log 100)。 */
export function levelOf(totalXp: number): number {
  const xp = safeInt(totalXp, 0, 0, XP_CAP);
  let lo = 1;
  let hi = LEVEL_MAX;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((XP_CUM[mid] ?? 0) <= xp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 等级进度（顶栏经验条）。 */
export function progressInLevel(totalXp: number): XpProgress {
  const xp = safeInt(totalXp, 0, 0, XP_CAP);
  const level = levelOf(xp);
  const into = xp - (XP_CUM[level] ?? 0);
  const isMax = level >= LEVEL_MAX;
  const need = isMax ? 0 : (XP_CUM[level + 1] ?? xp) - (XP_CUM[level] ?? 0);
  const ratio = isMax ? 1 : need > 0 ? Math.min(1, into / need) : 1;
  return {
    level,
    into,
    need,
    ratio,
    toNext: isMax ? 0 : Math.max(0, need - into),
    isMax,
    totalXp: xp,
  };
}

/** 展示值：到达上限后 `text === '∞'`，内部仍是精确的上限值。 */
export function displayXp(totalXp: number): XpDisplay {
  const value = safeInt(totalXp, 0, 0, XP_CAP);
  const capped = value >= XP_CAP;
  return { capped, value, text: capped ? '∞' : String(value) };
}

/**
 * 加经验。越过上限就停在 `XP_CAP`（"到上限即停止累加"）。
 * @param totalXp 当前总经验
 * @param delta 本次新增（负数按 0 处理 —— 经验只涨不跌）
 */
export function addXp(totalXp: number, delta: number): XpGrant {
  const before = safeInt(totalXp, 0, 0, XP_CAP);
  const d = safeInt(delta, 0, 0);
  const after = Math.min(XP_CAP, before + d);
  const levelBefore = levelOf(before);
  const levelAfter = levelOf(after);
  return {
    total: after,
    gained: after - before,
    levelBefore,
    levelAfter,
    levelUp: levelAfter > levelBefore,
    capped: after >= XP_CAP,
  };
}
