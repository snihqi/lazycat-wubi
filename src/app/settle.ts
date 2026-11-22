/**
 * app/settle.ts — 一次练习的结算。
 *
 * 负责：把「本次打对多少字」变成 经验 / 总字数 / 卡片累计，并算出升级前后。
 * 不负责：经验曲线（core/xp）、落盘细节（store）。
 * 调用方：practice.ts 的 finish() / leave / destroy。
 *
 * 结算只回答三个问题：这次打对多少字、涨了多少经验、有没有升级。
 */

import { levelOf } from '../core';
import { addPractice, load } from './store';

export interface SettleInput {
  /** 练习页是边打边记经验（顶栏数字实时涨），结算时传 false 避免重复计。 */
  creditXp?: boolean;
  cardId: string;
  /** 本次打对的有效字数 —— 经验、卡片累计都按它算。 */
  correctChars: number;
}

export interface SettleResult {
  /** 本次新增经验（= 打对字数）。 */
  xpGained: number;
  xpTotal: number;
  levelBefore: number;
  levelAfter: number;
  levelUp: boolean;
  /** 是否已达经验上限（界面提示一次即可）。 */
  capped: boolean;
}

export function settlePractice(input: SettleInput): SettleResult {
  const before = load();
  const levelBefore = levelOf(before.xp);

  const gained = Math.max(0, Math.floor(input.correctChars));
  if (gained > 0 && input.creditXp !== false) addPractice(input.cardId, gained);

  const after = load();
  return {
    xpGained: gained,
    xpTotal: after.xp,
    levelBefore,
    levelAfter: levelOf(after.xp),
    levelUp: levelOf(after.xp) > levelBefore,
    capped: after.xp >= 100_000_000,
  };
}
