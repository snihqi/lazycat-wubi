/**
 * app/keys.ts — 25 个字母键的区位与助记词，以及屏幕键盘的排布。
 *
 * 负责：给字根卡画键盘、给「字根表」提供每键的口诀。
 * 不负责：每个键下有哪些字根（从 data 的 ROOTS 按 key 分组，见 rootsByKey）。
 * 区位与助记词依 86 版字根表整理。
 */

export interface KeyDef {
  /** 大写字母。 */
  k: string;
  /** 键名汉字。 */
  name: string;
  /** 区位码，如 `11`。 */
  code: string;
  /** 区号 1–5。 */
  zone: number;
  /** 助记词。 */
  mn: string;
}

export const KEYS: KeyDef[] = [
  { k: 'G', name: '王', code: '11', zone: 1, mn: '王旁青头戋（兼）五一' },
  { k: 'F', name: '土', code: '12', zone: 1, mn: '土士二干十寸雨' },
  { k: 'D', name: '大', code: '13', zone: 1, mn: '大犬三羊古石厂' },
  { k: 'S', name: '木', code: '14', zone: 1, mn: '木丁西' },
  { k: 'A', name: '工', code: '15', zone: 1, mn: '工戈草头右框七' },
  { k: 'H', name: '目', code: '21', zone: 2, mn: '目具上止卜虎皮' },
  { k: 'J', name: '日', code: '22', zone: 2, mn: '日早两竖与虫依' },
  { k: 'K', name: '口', code: '23', zone: 2, mn: '口与川，字根稀' },
  { k: 'L', name: '田', code: '24', zone: 2, mn: '田甲方框四车力' },
  { k: 'M', name: '山', code: '25', zone: 2, mn: '山由贝，下框几' },
  { k: 'T', name: '禾', code: '31', zone: 3, mn: '禾竹一撇双人立，反文条头共三一' },
  { k: 'R', name: '白', code: '32', zone: 3, mn: '白手看头三二斤' },
  { k: 'E', name: '月', code: '33', zone: 3, mn: '月彡（衫）乃用家衣底' },
  { k: 'W', name: '人', code: '34', zone: 3, mn: '人和八，三四里' },
  { k: 'Q', name: '金', code: '35', zone: 3, mn: '金勺缺点无尾鱼，犬旁留乂儿一点夕，氏无七（妻）' },
  { k: 'Y', name: '言', code: '41', zone: 4, mn: '言文方广在四一，高头一捺谁人去' },
  { k: 'U', name: '立', code: '42', zone: 4, mn: '立辛两点六门疒' },
  { k: 'I', name: '水', code: '43', zone: 4, mn: '水旁兴头小倒立' },
  { k: 'O', name: '火', code: '44', zone: 4, mn: '火业头，四点米' },
  { k: 'P', name: '之', code: '45', zone: 4, mn: '之宝盖，摘示衣' },
  { k: 'N', name: '已', code: '51', zone: 5, mn: '已半巳满不出己' },
  { k: 'B', name: '子', code: '52', zone: 5, mn: '子耳了也框向上' },
  { k: 'V', name: '女', code: '53', zone: 5, mn: '女刀九臼山朝西' },
  { k: 'C', name: '又', code: '54', zone: 5, mn: '又巴马，丢矢矣' },
  { k: 'X', name: '纟', code: '55', zone: 5, mn: '慈母无心弓和匕，幼无力' },
];

export const KEY_BY_LETTER = new Map<string, KeyDef>(KEYS.map((x) => [x.k, x]));

/** 屏幕键盘的三行（QWERTY 排列，与真实键盘一致）。 */
export const KEY_ROWS: string[][] = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
];
