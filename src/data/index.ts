/**
 * src/data/index.ts — 由 scripts/build-data.mjs 生成，**请勿手改**。
 * 重新生成：npm run build:data
 *
 * 这里是"数据侧"的唯一入口。内核（src/core）不 import 这里 —— 依赖方向只能是 data → core。
 */

import type { Card, CharRecord, ItemCard, RootItem } from '../core/types';
import cardsJson from './cards.json';
import charsJson from './chars.json';
import rootsJson from './roots.json';
import wordsJson from './words.json';

/** 328 题（303 字根 + 25 一级简码），已按"键位交错"排好序。 */
export const ROOTS = rootsJson.items as unknown as RootItem[];

/** 3000 字表，按字频排序。 */
export const CHARS = charsJson.chars as unknown as CharRecord[];

/** 词组：二字词 / 三字词 / 成语。 */
export const WORDS = {
  2: wordsJson.word2,
  3: wordsJson.word3,
  4: wordsJson.word4,
} as const;

/** 文章正文（已预处理：去掉段落缩进、统一换行）。 */

/** 主页卡片索引。 */
export const CARDS = cardsJson.cards as unknown as Card[];

/** 按 id 取卡。 */
export function cardById(id: string): Card | undefined {
  return CARDS.find((card) => card.id === id);
}

/** 逐条出题的卡（带 items）。 */
export function isItemCard(card: Card): card is ItemCard {
  return Array.isArray((card as ItemCard).items);
}

