/**
 * wordcount.ts — 有效字数口径（**全局唯一一份**）。
 *
 * 负责：定义"什么算一个字"，并把长文本预处理成"可以直接比对的目标串"。
 * 不负责：判对错（matcher.ts）、速度（timer.ts）、任务进度（daily.ts）——它们都必须调这里。
 * 调用方：matcher / timer / daily / xp / store（以及界面上的"本卡字数"）。
 *
 * 口径（ux-spec 4.2 写死）：
 *   有效字数 = 汉字数 + 英文字符数 + 数字字符数
 *   不含标点、不含空白。
 * 任何一个地方用第二套口径，段位就不可比了 —— 所以别的文件里**不许**再出现字数正则。
 */

/** 汉字：扩展 A + 基本区 + 兼容区。与参考实现完全一致。 */
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const HAN_RE_G = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
/** 英文字符（只算半角，全角字母按标点处理 —— 五笔目标串里不会出现）。 */
const LATIN_RE = /[A-Za-z]/;
const LATIN_RE_G = /[A-Za-z]/g;
/** 数字：ASCII 0-9 + 全角 ０-９（自定义卡片里常见）。 */
const DIGIT_RE = /[0-9\uFF10-\uFF19]/;
const DIGIT_RE_G = /[0-9\uFF10-\uFF19]/g;

/** 一个字面量是不是汉字。 */
export function isHanzi(ch: string): boolean {
  return ch.length > 0 && HAN_RE.test(ch);
}

/** 是不是计入字数的字符（汉字 / 英文 / 数字）。标点与空白都不是。 */
export function isEffectiveChar(ch: string): boolean {
  if (ch.length === 0) return false;
  return HAN_RE.test(ch) || LATIN_RE.test(ch) || DIGIT_RE.test(ch);
}

/** 字数拆解。给"自定义卡片非法字符提示"和调试用。 */
export interface CharBreakdown {
  han: number;
  latin: number;
  digit: number;
  /** 标点、符号、空白之外的"其它"字符数（emoji 等）。 */
  other: number;
  /** 空白（空格 / 换行 / 制表）。 */
  space: number;
  /** 有效字数 = han + latin + digit。 */
  total: number;
}

/** 拆解一段文本。O(n)，不要在一次击键里对整篇反复调用。 */
export function breakdown(text: string): CharBreakdown {
  const src = typeof text === 'string' ? text : '';
  const han = src.match(HAN_RE_G)?.length ?? 0;
  const latin = src.match(LATIN_RE_G)?.length ?? 0;
  const digit = src.match(DIGIT_RE_G)?.length ?? 0;
  const space = src.match(/[\s\u3000]/g)?.length ?? 0;
  const other = src.length - han - latin - digit - space;
  return { han, latin, digit, other, space, total: han + latin + digit };
}

/** 有效字数。**全站唯一**的字数入口。 */
export function countEffective(text: string): number {
  return breakdown(text).total;
}

/**
 * 预处理长文本，得到"可以直接比对的目标串"。
 *
 * - `\r\n` / `\r` → `\n`
 * - 去掉每行行首缩进（全角 / 半角空格、制表）与行尾空白：**段落缩进不要求输入**
 * - 去掉空行（避免用户要打一堆换行）
 * - 去掉 BOM / 零宽字符
 *
 * 注意：这里**不**删句中标点、不重排段落。标点保留在目标串里（打错算错、不计字数）。
 */
export function normalizeTarget(text: string): string {
  const src = typeof text === 'string' ? text : '';
  return src
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, ''))
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 目标串里是否还剩有效字（用于"打完"判定）。`from` 是当前索引。 */
export function hasEffectiveFrom(target: string, from: number): boolean {
  const start = from < 0 ? 0 : from;
  for (let i = start; i < target.length; i++) {
    const ch = target.charAt(i);
    if (isEffectiveChar(ch)) return true;
  }
  return false;
}

/** 剩余有效字数（进度条用）。 */
export function countEffectiveFrom(target: string, from: number): number {
  const start = from < 0 ? 0 : from;
  let n = 0;
  for (let i = start; i < target.length; i++) {
    if (isEffectiveChar(target.charAt(i))) n += 1;
  }
  return n;
}
