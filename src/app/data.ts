/**
 * app/data.ts — 数据适配层（界面侧唯一的数据入口）。
 *
 * 负责：把 src/data 的原始 JSON 折成界面直接能用的结构：
 *       · 卡片 → 题目序列（单字 / 字根 / 词组 / 文章）
 *       · 单字 → 拆字单元（每个单元是一个码位：字根 or 识别码）
 *       · 词组 → 五笔编码（由单字全码现拼，规则同 86 版）
 * 不负责：判分、计时、经验（都在 src/core）。
 * 调用方：practice.ts / home.ts
 */

import {
  CARDS,
  CHARS,
  ROOTS,
  WORDS,
  cardById,
  isItemCard,
} from '../data';

export { CHARS, WORDS };
import type { Card, CharRecord, RootItem } from '../core/types';

/* ---------- 索引 ---------- */

export const charByKey = new Map<string, CharRecord>();
for (const c of CHARS) charByKey.set(`char:${c.ch}`, c);

export const rootById = new Map<string, RootItem>();
for (const r of ROOTS) rootById.set(r.id, r);

/** 按字母键分组（屏幕键盘 / 字根表用）。键名统一大写。 */
const rootGroups = new Map<string, RootItem[]>();
for (const r of ROOTS) {
  const k = (r.key || '').toUpperCase();
  if (!k) continue;
  const arr = rootGroups.get(k);
  if (arr) arr.push(r); else rootGroups.set(k, [r]);
}

export function rootsByKey(key: string): RootItem[] {
  return rootGroups.get(key.toUpperCase()) ?? [];
}


export function cardList(): Card[] {
  return CARDS;
}

export { cardById };

/* ---------- 单题 ---------- */

export interface Unit {
  /** 稳定 ID（队列用）。 */
  id: string;
  /** 用户需要打出的内容（单字卡＝一个字；字根卡＝键位字母；词组卡＝整个词）。 */
  target: string;
  /** 单字记录（有拆字数据时才给）。 */
  char?: CharRecord;
  /** 字根记录（字根卡才有）。 */
  root?: RootItem;
  /** 词组原文（词组卡才有）。 */
  word?: string;
}

export function unitOf(itemId: string): Unit | null {
  if (itemId.startsWith('char:')) {
    const rec = charByKey.get(itemId);
    return rec ? { id: itemId, target: rec.ch, char: rec } : null;
  }
  for (const prefix of ['word2:', 'word3:', 'idiom:']) {
    if (itemId.startsWith(prefix)) {
      const word = itemId.slice(prefix.length);
      return { id: itemId, target: word, word };
    }
  }
  // 自定义卡片的条目：`raw:文本`。3000 字表里有记录就顺带给出拆解，没有也能练。
  if (itemId.startsWith('raw:')) {
    const text = itemId.slice(4);
    if (!text) return null;
    const rec = charByKey.get(`char:${text}`);
    return rec ? { id: itemId, target: text, char: rec } : { id: itemId, target: text };
  }
  if (itemId.startsWith('root:') || itemId.startsWith('shortcode:')) {
    const r = rootById.get(itemId);
    if (!r) return null;
    // 字根题问的是「这个根在哪个键」；一级简码题也是打那个字母。
    return { id: itemId, target: r.key.toLowerCase(), root: r };
  }
  return null;
}

/* ---------- 卡片 ---------- */

/* 练习题只有一种形态：一题一个目标串（单字 / 词组 / 字根）。 */

export function itemIds(card: Card): string[] {
  return isItemCard(card) ? card.items : [];
}

/* ---------- 拆字 ---------- */

export interface SplitCell {
  /** `root` = 真字根；`idcode` = 识别码（不是字根，不上色）。 */
  kind: 'root' | 'idcode' | 'missing';
  /** 对应码位字母（大写），可能为空。 */
  letter: string;
  /** 字根字形 SVG path（只有 root 且数据里有 path 时才有）。 */
  path?: string;
  /** 字根名（可能为空，界面按「键位 + 序位」回退）。 */
  name?: string;
  /**
   * 这个字根**自己所在的键位**（大写）。和 `letter`（它在本字里占了第几码）不是同一件事：
   * 3000 字里只有「丑」一个字的两个值对不上（数据把 `土` 排在 `nhfd` 的第 2 位），
   * 说明句里据此判断该不该写「土 → H」这种会教错键位的箭头。
   */
  key?: string;
  /** 区号 1–5，0 = 未知。决定颜色。 */
  zone: number;
}

/**
 * 把一个字的 `units` 串（每 3 个十六进制位一个单元）折成码位格。
 *
 * 注意：**颜色表示这个字根所在的区，不表示第几码**（见 visual-spec 7.9）。
 * 最后一个单元常常是识别码 —— 它不是字根，没有字形，也不上色。
 */
export function splitsOf(rec: CharRecord): SplitCell[] {
  const units = rec.units || '';
  const code = mainCode(rec);
  const cells: SplitCell[] = [];
  for (let i = 0; i + 3 <= units.length; i += 3) {
    const gid = `root:e${units.slice(i, i + 3)}`;
    const root = rootById.get(gid);
    const letter = (code[i / 3] || '').toUpperCase();
    if (root) {
      cells.push({
        kind: 'root',
        letter,
        path: root.path || undefined,
        name: root.name || undefined,
        key: root.key || undefined,
        zone: root.zone || 0,
      });
    } else {
      cells.push({ kind: 'idcode', letter, zone: 0 });
    }
  }
  return cells;
}

/** 主码：取候选里最长的一个（同长取最后一条）。 */
export function mainCode(rec: CharRecord): string {
  let best = '';
  for (const c of rec.codes) if (c.length >= best.length) best = c;
  return best;
}

/** 编码表的一行（图解面板用）。纯数据，不碰 DOM —— 判定逻辑可单独测。 */
export interface CodeRow {
  /** 这一行的完整编码，如 `vb`。 */
  code: string;
  /** 级别：全码 / 全码 · 另一写法 / 一级简码 / 二级简码 / 三级简码 / 另一写法。 */
  level: string;
  /** 「怎么打」，一句话动作说明。 */
  how: string;
  /** 是不是主码那一行（表格里要加粗并抬一档字色）。 */
  isFull: boolean;
}

const LEVEL_BY_LEN: Record<number, string> = { 1: '一级简码', 2: '二级简码', 3: '三级简码' };
const HOW_BY_LEN: Record<number, string> = {
  1: '只打这一个字母，按空格上屏',
  2: '取全码前 2 位，按空格上屏',
  3: '取全码前 3 位，按空格上屏',
};
const OTHER: Pick<CodeRow, 'level' | 'how'> = {
  level: '另一写法',
  how: '另一种取法，同样能上屏',
};

/**
 * 一个字的所有候选码 → 编码表的行（按码长升序，同长保持数据原序）。
 *
 * **判据只有一条：全码 = 最长的那一条**（同长取最后一条，见 `mainCode`）。
 * 简码 = 比全码短、**而且是全码的前缀**的那条，级别按这条码自己的长度叫。
 * 绝不能拿「位数」判级别 —— `好` 的全码 `vbg` 只有 3 位，按位数硬套会把它
 * 贴成「三级简码」，而它的 `vb` 才是二级简码。这是本轮最容易做歪的一处。
 */
export function codeRows(rec: CharRecord): CodeRow[] {
  const full = mainCode(rec);
  const rows = (rec.codes ?? []).map((code): CodeRow => {
    if (code === full) return { code, level: '全码', how: `敲完 ${code.length} 位，按空格上屏`, isFull: true };
    // 同长但不是同一个串：数据里给了两种等长取法，都算全码（同样能上屏）。
    if (code.length === full.length) return { code, level: '全码 · 另一写法', how: OTHER.how, isFull: false };
    if (full.startsWith(code) && LEVEL_BY_LEN[code.length]) {
      return { code, level: LEVEL_BY_LEN[code.length]!, how: HOW_BY_LEN[code.length]!, isFull: false };
    }
    // 非前缀的短码（少数冷僻字的变体取法）：写「取全码前 N 位」就是假话。
    return { code, level: OTHER.level, how: OTHER.how, isFull: false };
  });
  // 稳定排序：同长的两行保持数据原序（全码 · 另一写法 会与全码相邻）。
  return rows.sort((a, b) => a.code.length - b.code.length);
}

/* ---------- 词组编码 ---------- */

/**
 * 由单字全码现拼词组编码（86 版规则）：
 *   二字词：各取前两码
 *   三字词：前两字各取首码 + 末字取前两码
 *   四字及以上：前三字各取首码 + 末字取首码
 * 任何一字不在 3000 字表里 → 返回空串（界面不显示编码，不瞎猜）。
 */
export function wordCode(word: string): string {
  const chars = Array.from(word);
  const codes = chars.map((ch) => {
    const rec = charByKey.get(`char:${ch}`);
    return rec ? mainCode(rec) : '';
  });
  if (codes.some((c) => c.length === 0)) return '';
  const at = (i: number, n: number) => (codes[i] ?? '').slice(0, n);
  if (codes.length === 2) return at(0, 2) + at(1, 2);
  if (codes.length === 3) return at(0, 1) + at(1, 1) + at(2, 2);
  if (codes.length >= 4) return at(0, 1) + at(1, 1) + at(2, 1) + at(codes.length - 1, 1);
  return '';
}
