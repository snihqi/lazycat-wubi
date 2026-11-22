/**
 * app/strokes.ts — 整字按码位涂色的拆解图。
 *
 * 负责：把 `src/data/strokes.json` 里的紧凑笔画串解码成 SVG path，
 *       并按「第几码」给笔画上色：一格是一个字，颜色表示这一笔属于第几码。
 *       没被任何码位覆盖的笔画涂灰 —— 那是「这几笔不取码」，不是漏画。
 * 不负责：字根名与键位的图例（practice.ts 拼）。
 * 调用方：practice.ts 的图解面板。
 *
 * 数据体积 3.4MB，所以**按需动态加载**：只有用户第一次展开图解时才拉这个 chunk。
 */

interface StrokesFile {
  version: number;
  off: number;
  chars: string;
  segs: Record<string, string>;
}

const B64T = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/';
const B64X: Record<string, number> = {};
for (let i = 0; i < 64; i++) B64X[B64T.charAt(i)] = i;

let strokeMap: Map<string, string[]> | null = null;
let segMap: Record<string, string> = {};
let off = 512;
let loading: Promise<boolean> | null = null;

export function loadStrokes(): Promise<boolean> {
  if (strokeMap) return Promise.resolve(true);
  if (loading) return loading;
  loading = (async () => {
    try {
      const mod = (await import('../data/strokes.json')) as { default: StrokesFile };
      const file = mod.default;
      off = file.off ?? 512;
      const map = new Map<string, string[]>();
      for (const rec of file.chars.split('|')) {
        const bang = rec.indexOf('!');
        if (bang <= 0) continue;
        map.set(rec.slice(0, bang), rec.slice(bang + 1).split('~'));
      }
      strokeMap = map;
      segMap = file.segs ?? {};
      return true;
    } catch {
      return false;
    }
  })();
  return loading;
}

/** 这个字有没有逐笔分段；`null` = 没有数据。 */
export function segCount(ch: string): number {
  return segOf(ch).length;
}

/** 一条笔画（紧凑编码）→ SVG path 的 d。编码时整格加了 off，这里减回去。 */
function strokePath(enc: string): string {
  let d = '';
  let i = 0;
  while (i < enc.length) {
    const c = enc.charAt(i++);
    if (c === 'Z') { d += 'Z'; continue; }
    d += c;
    const k = c === 'Q' ? 2 : c === 'C' ? 3 : 1;
    for (let j = 0; j < k; j++) {
      const x = ((B64X[enc.charAt(i)] ?? 0) << 6 | (B64X[enc.charAt(i + 1)] ?? 0)) - off;
      i += 2;
      const y = ((B64X[enc.charAt(i)] ?? 0) << 6 | (B64X[enc.charAt(i + 1)] ?? 0)) - off;
      i += 2;
      d += `${x} ${y} `;
    }
  }
  return d;
}

/** 「0-2/3,4/5」→ [[0,1,2],[3,4],[5]] */
function segOf(ch: string): number[][] {
  const src = segMap[ch];
  if (!src) return [];
  const out: number[][] = [];
  for (const part of src.split('/')) {
    const g: number[] = [];
    for (let v of part.split(',')) {
      v = v.replace(/^\*/, '');
      if (!v) continue;
      if (v.indexOf('-') > 0) {
        const [a, b] = v.split('-');
        for (let k = Number(a); k <= Number(b); k++) g.push(k);
      } else {
        g.push(Number(v));
      }
    }
    if (g.length) out.push(g);
  }
  return out;
}

export interface StrokeFigure {
  /** 整字的 SVG 内联串。 */
  svg: string;
  /** 实际画出来的笔画数。 */
  total: number;
}

/**
 * 画一个整字，按码位上色。
 * @param slots `null` = 全灰；`'all'` = 整字第 1 色（键名字 / 成字字根）；
 *              数组 = 第 i 段用第几色（1..4）。
 */
export function strokeFigure(ch: string, slots: number[] | 'all' | null): StrokeFigure | null {
  const list = strokeMap?.get(ch);
  if (!list) return null;

  const paint = new Array<number>(list.length).fill(0);
  if (slots === 'all') {
    paint.fill(1);
  } else if (slots) {
    const grp = segOf(ch);
    const done = new Set<number>();
    slots.forEach((slot, k) => {
      const g = (grp[k] ?? []).filter((i) => i < paint.length);
      if (!g.length) return;
      // 后段可以盖住前段的一部分（成字字根的段是叠加关系），
      // 但不能把已经涂满的那一整片全盖掉，否则「一」「已」就只剩一个颜色。
      if (done.size && [...done].every((i) => g.includes(i))) return;
      for (const i of g) { paint[i] = slot; done.add(i); }
    });
  }

  let ps = '';
  for (let i = 0; i < list.length; i++) {
    const v = paint[i] ?? 0;
    ps += `<path d="${strokePath(list[i] ?? '')}"${v ? ` class="s${v}"` : ''}/>`;
  }
  return {
    svg: `<svg viewBox="0 0 1024 1024" aria-hidden="true"><g transform="translate(0,900) scale(1,-1)">${ps}</g></svg>`,
    total: list.length,
  };
}
