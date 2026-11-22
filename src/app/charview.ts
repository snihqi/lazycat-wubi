/**
 * app/charview.ts — 单个汉字的「资料卡」：类别、拆解图、两句说明、编码表。
 *
 * 负责：把一条 CharRecord 渲染成图解面板的 HTML 片段。
 * 不负责：加载笔画数据（调用方先 `await loadStrokes()`）、面板的开合与容器。
 * 调用方：practice.ts 的 `charHint()` —— **唯一调用点**。
 *
 * 颜色语义：**颜色 = 这个字根在本字里的第几码**。
 *
 *   第 1 码红 / 第 2 码黄 / 第 3 码绿 / 第 4 码蓝 / 识别码紫 / 不取码的灰。
 *
 * 拆解图与编码表用的是**两套语言**：图里按码位上色，表里不上色。
 * 区色（第 N 区）另有自己的位置 —— 字根卡的「第 N 区」、屏幕键盘的键位字母，
 * 那里不动。同一个字根在两张图里的颜色含义不同，不要混用。
 *
 * 两套语言必须分得开（拆解图 vs 编码表）：
 *   · 左图 / 图例：颜色 = 第几码（五色只许出现在这两个容器里）；
 *   · 说明 / 编码表：**不上色**。位次由编码表的列位表达（表头 1 2 3 4），
 *     说明里的键位一律中性键帽 `.kk`。否则同一个字母在左图是蓝、在表里是红 ——
 *     读一句要重学一次配色。
 *
 * 三类规则三套固定句式，措辞不变、只换数据 ——
 * 规则靠重复习得，每次换一套说法反而要多读一遍。
 */

import { codeRows, mainCode, splitsOf } from './data';
import type { CharRecord } from '../core/types';
import { KEY_BY_LETTER } from './keys';
import { segCount, strokeFigure } from './strokes';

/** 末笔区号 → 笔画名（识别码句式用）。 */
const ZONE: Record<number, string> = { 1: '横', 2: '竖', 3: '撇', 4: '捺', 5: '折' };
/** 字型位 → 字型名（识别码句式用）。 */
const SHAPE: Record<number, string> = { 1: '左右', 2: '上下', 3: '杂合' };

const ARW = '<span class="arw">→</span>';

/**
 * 键帽 chip：中性色，不上区色（理由见文件头）。
 * 大小写照调用方给的原样：**键位字母用大写**（G / S），**码串用小写**（ggll）——
 * 和键盘图、编码表里的写法一致，不在这里再转一次。
 */
function kk(text: string, dash = false): string {
  return `<u class="kk${dash ? ' dash' : ''}">${text}</u>`;
}

export function charDetailHTML(rec: CharRecord): string {
  const cells = splitsOf(rec);
  const code = mainCode(rec);
  const roots = cells.filter((c) => c.kind === 'root');
  const isKeyName = rec.kind === 'k';
  const isRootChar = rec.kind === 'r';

  /**
   * 识别码只在「数据里真有」的时候才讲：`xy` 非空 **且** 全码比字根数多一位。
   * 只有 1271 个字根齐四码的字带 `xy`（那是别的用处），照着写就是瞎编。
   */
  const hasIdent = !isKeyName && !isRootChar && !!rec.xy && code.length > roots.length;

  // `xy` 是两位数字串（区号 + 字型位），空串时取 0 → 句式里显示「—」而不是 NaN。
  const zone = Number(rec.xy.charAt(0)) || 0;
  const shape = Number(rec.xy.charAt(1)) || 0;

  const meta = [
    code,
    rec.py ? rec.py.split(' / ')[0] : '',
    rec.strokes ? `${rec.strokes} 画` : '',
    rec.radical ? `部首 ${rec.radical}` : '',
  ].filter(Boolean).join(' · ');

  /* ---------- 抬头：类别 chip + 全码 · 拼音 · 画数 · 部首 ---------- */

  const tag = isKeyName
    ? '键名字'
    : isRootChar
      ? '成字字根'
      : roots.length
        ? `${roots.length} 个字根${hasIdent ? ' + 识别码' : ''}`
        : '没有拆解';
  const headHTML = `<div class="hintmeta"><span class="tag">${tag}</span><span>${meta}</span></div>`;

  /* ---------- 左栏：拆解图 + 图例 ---------- */

  let figHTML: string;
  let legendHTML: string;

  if (isKeyName || isRootChar) {
    // 键名字 / 成字字根：整字就是一个字根，只画一格、图例只一条，永远是第 1 码（红）。
    const whole = strokeFigure(rec.ch, 'all') ?? strokeFigure(rec.ch, [1]);
    const key = (code.charAt(0) || '·').toUpperCase();
    figHTML = `<div class="wbox">${whole ? whole.svg : `<b>${rec.ch}</b>`}</div>`;
    legendHTML = `<li class="c1"><i></i><b>${rec.ch}</b><em>${key}</em></li>`;
  } else {
    const hasIdCell = cells.some((c) => c.kind !== 'root');
    /**
     * 字根 → 码位（1..4）。**第几个字根就是第几码，颜色跟着它走。**
     *
     * 没占上码位的字根（一个字根多于四个时，五笔只取一、二、三、末）涂灰：
     * 它们在下标 4 之后、且没有 `letter`（`letter` 是从全码逐位取的，
     * 全码只有 4 位，取空了就说明这一位不参与编码）。灰 = 不取码。
     */
    const slotOf = (i: number, letter: string): number => (letter ? Math.min(i + 1, 4) : 0);
    const slots = roots.map((c, i) => slotOf(i, c.letter));

    // 分段数与字根数一致时才画「整字按码位涂色」，否则退回码位格（数据没对上的字不硬拆）。
    const fig = roots.length > 0 && segCount(rec.ch) === roots.length
      ? strokeFigure(rec.ch, slots)
      : null;
    if (fig) {
      figHTML = `<div class="wbox">${fig.svg}</div>`;
    } else if (roots.length) {
      figHTML = `<div class="rboxes">${roots.map((c, i) => `<div class="rbox c${slotOf(i, c.letter)}">${
        c.path ? `<svg viewBox="0 0 100 100"><path d="${c.path}"/></svg>` : `<b>${c.letter}</b>`
      }<u>${c.letter}</u></div>`).join('')}${
        hasIdCell ? '<div class="rbox ident"><b>识别码</b></div>' : ''
      }</div>`;
    } else {
      const whole = strokeFigure(rec.ch, 'all');
      figHTML = whole
        ? `<div class="wbox">${whole.svg}</div>`
        : `<div class="wbox empty"><b>${rec.ch}</b></div>`;
    }

    // 图例与左图**逐格对应**：第 n 条的颜色 = 第 n 格的颜色。识别码是第 5 档（紫）。
    let ri = -1;
    legendHTML = cells.map((c) => {
      if (c.kind !== 'root') return `<li class="lz"><i></i><b>识别码</b><em>${c.letter || '·'}</em></li>`;
      ri += 1;
      return `<li class="c${slotOf(ri, c.letter)}"><i></i><b>${c.name || c.letter}</b><em>${c.letter}</em></li>`;
    }).join('');
  }

  /* ---------- 右栏 · 说明：三类固定句式 ---------- */

  let ex1 = '';
  let ex2 = '';

  if (isKeyName) {
    const key = (code.charAt(0) || '').toUpperCase();
    const name = KEY_BY_LETTER.get(key)?.name ?? '';
    // 「王」的键名就是「王」—— 同一个字不必再括一遍；「一」这种要补（一 ← G 键名是「王」）。
    const paren = name && name !== rec.ch ? `（${name}）` : '';
    ex1 = `「${rec.ch}」是<b>键名字</b>：它本身就是 ${kk(key)} 键上的字根${paren}，整个字就是一个字根。`;
    ex2 = `键名字的规矩是<b>连打四次</b> ${ARW} ${kk(code)}。`;
  } else if (isRootChar) {
    const key = (code.charAt(0) || '').toUpperCase();
    ex1 = `「${rec.ch}」是<b>成字字根</b>：它本身就是一个字根，但不是键名字，所以不能连打四次。`;
    ex2 = `规矩是<b>报户口 + 首笔 + 次笔 + 末笔</b>：先打它所在的键 ${kk(key)}，再把剩下的笔画依次打出来 ${ARW} ${kk(code)}。`;
  } else if (!roots.length) {
    // 没有拆解数据（或者一个真字根都没有）就不编字根 —— 宁可只说这一句。
    ex1 = '这个字没有拆解数据。';
  } else {
    const list = roots.length
      ? roots.map((c) => {
        // 变体字根在数据里没有名字（217/303 才有）—— 回退成「字根」，
        // 别把码位字母当名字念（那会读成「I → I」）。
        const name = `<b>${c.name || '字根'}</b>`;
        // 字根所在的键 ≠ 它在本字里占的那一位时（全表只有「丑」），只报名字 ——
        // 「土 → H」是个会教错键位的箭头。
        return c.key && c.letter && c.key !== c.letter ? name : `${name} ${ARW} ${kk(c.letter)}`;
      }).join('、')
      : '（字根表里查不到它的字根）';
    ex1 = `「${rec.ch}」由 <b>${roots.length} 个字根</b>组成：${list}。`;

    if (hasIdent) {
      const letter = code.charAt(code.length - 1).toUpperCase();
      ex2 = `不足四码要补<b>末笔字型识别码</b>：末笔是<b>${ZONE[zone] ?? '—'}</b>（${zone} 区），`
        + `字型是<b>${SHAPE[shape] ?? '—'}型</b>（第 ${shape} 位） ${ARW} 区位 ${kk(rec.xy)} ${ARW} ${kk(letter, true)}。`;
    } else if (roots.length >= 4) {
      ex2 = `四个字根都齐了，打完这 ${code.length} 码就上屏，不用补识别码。`;
    } else if (code.length >= 4) {
      // 少数 3 字根 / 4 码的字（如「场」fnrt）数据里没有 xy —— 说「不足四码」是假话，
      // 只承认识别码这一格没标出来，全码照打。
      ex2 = `这个字的识别码数据里没存，照全码打就行 ${ARW} ${kk(code)}。`;
    } else {
      ex2 = `不足四码要补一位识别码，这个字的数据里没存，照全码打就行 ${ARW} ${kk(code)}。`;
    }
  }

  /* ---------- 右栏 · 编码表（3 列：码 / 级别 / 怎么打） ---------- */

  /** 4 个定宽位：空位画短横（「有格、没码」），识别码那一格用虚线分位。 */
  function slotCells(row: string, isFullRow: boolean): string {
    const chars = Array.from(row);
    let out = '';
    for (let i = 0; i < 4; i++) {
      const ch = chars[i];
      if (ch === undefined) { out += '<i class="nil"></i>'; continue; }
      const idc = hasIdent && isFullRow && i === chars.length - 1;
      out += `<i${idc ? ' class="idc"' : ''}>${ch}</i>`;
    }
    return out;
  }

  const rows = codeRows(rec);
  const bodyHTML = rows.map((r) => {
    // 全码那一行是整张表的落点；一级简码也加粗（它是「最快能上屏的那一档」）。
    const lv = r.isFull || r.level === '一级简码' ? `<b>${r.level}</b>` : r.level;
    return `<tr${r.isFull ? ' class="main"' : ''}>
      <td class="cod"><span class="cseq">${slotCells(r.code, r.isFull)}</span></td>
      <td class="lv">${lv}</td>
      <td class="how">${r.how}</td>
    </tr>`;
  }).join('');

  const tableHTML = `<table class="ctable">
    <thead><tr>
      <th class="cod"><span class="bits"><i>1</i><i>2</i><i>3</i><i>4</i></span></th>
      <th class="lv">级别</th>
      <th class="how">怎么打</th>
    </tr></thead>
    <tbody>${bodyHTML}</tbody>
  </table>`;

  /**
   * 「没有三级简码」这件事必须写出来 —— 它是编码表最容易被误读的一格。
   * 只在「全码 3 位、且有二级简码」时出现（好 vbg / vb），别的字不凑这句。
   */
  const short2 = code.length === 3 ? rows.find((r) => r.level === '二级简码') : undefined;
  const noteHTML = short2
    ? `<p class="cnote"><b>没有「三级简码」这一行，这是对的。</b>这个字的全码只有 3 位，<b>${code}</b> 敲满就是全码；<b>${short2.code}</b> 是它的二级简码。</p>`
    : '';

  return `${headHTML}
    <div class="hintcols">
      <div class="hintfig">
        ${figHTML}
        <ul class="legend">${legendHTML}</ul>
      </div>
      <div class="hinttext">
        <p class="ex">${ex1}</p>
        ${ex2 ? `<p class="ex">${ex2}</p>` : ''}
        ${tableHTML}
        ${noteHTML}
      </div>
    </div>
    <div class="hintfoot">灰笔画 = 这几笔不取码</div>`;
}
