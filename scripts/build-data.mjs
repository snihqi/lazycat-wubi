#!/usr/bin/env node
/**
 * build-data.mjs — 从本地语料抽取题库，产出 src/data/*.json。
 *
 * 干什么：读 86 版五笔语料里的字符串常量与字频表，切成卡片，写 JSON，
 *        并打印每个数据集的条目数供核对。
 * 不干什么：算经验（在 src/core），也不碰 DOM。
 *
 * 谁调：`npm run build:data`。产物已提交进仓库，界面直接 import，
 *       **日常开发不需要跑这个脚本**。
 *
 * 语料目录不随仓库分发，默认读 `../参考资料`，可用环境变量 LAZYCAT_REF_DIR 指定。
 *
 * 幂等：同样输入 → 逐字节相同的输出（无时间戳、无随机、键序固定）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REF = process.env.LAZYCAT_REF_DIR
  ? path.resolve(process.env.LAZYCAT_REF_DIR)
  : path.resolve(ROOT, '..', '参考资料');
const OUT = path.join(ROOT, 'src', 'data');

const SRC_MAIN = path.join(REF, '五笔打字练习_86版.html');
const SRC_ROOT = path.join(REF, '五笔字根练习.html');
const SRC_FREQ = path.join(REF, 'GB2312 字频表.md');
const SRC_DICT = path.join(REF, 'search-wubi-main', 'data');

/* ------------------------------------------------------------------ 抽取 */

/**
 * 从 JS 源码里抠出 `const <name> = <literal>` 的**原始字面量文本**（含引号/括号）。
 * 只支持字符串字面量与 JSON 兼容的数组/对象字面量 —— 够用，且不用 eval。
 */
function extractRaw(source, name, where) {
  const key = `const ${name} = `;
  const at = source.indexOf(key);
  if (at < 0) throw new Error(`${where}: 找不到 const ${name}`);
  const start = at + key.length;
  const first = source[start];

  if (first === '"' || first === "'") {
    const quote = first;
    let i = start + 1;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) break;
      i += 1;
    }
    return source.slice(start, i + 1);
  }

  // 对象 / 数组：做括号配对（跳过字符串内部）
  let depth = 0;
  let i = start;
  let inStr = null;
  let escaped = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return source.slice(start, i);
}

/** `const X = "..."` → 字符串内容（走 JSON.parse 解转义，不 eval）。 */
function extractString(source, name, where) {
  const raw = extractRaw(source, name, where);
  if (raw[0] !== '"') throw new Error(`${where}: const ${name} 不是双引号字符串字面量`);
  return JSON.parse(raw);
}

/** `const X = {...}` / `const X = [...]` → JSON 兼容的字面量解析。 */
function extractJson(source, name, where) {
  return JSON.parse(extractRaw(source, name, where));
}

/** 字面量里带 `/* 注释 *\/` 的对象：先剥注释、再去尾逗号，然后当 JSON 解析。 */
function extractJsonLoose(source, name, where) {
  const raw = extractRaw(source, name, where)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw);
}

/** `{g:'11',f:'12',...}` → `{ g: '11', f: '12', ... }` */
function parseKeymap(source) {
  const at = source.indexOf('const KEYMAP = {');
  if (at < 0) throw new Error('找不到 KEYMAP');
  const end = source.indexOf('};', at);
  const body = source.slice(at, end);
  const map = {};
  const re = /([a-z])\s*:\s*'(\d{2})'/g;
  let m;
  while ((m = re.exec(body)) !== null) map[m[1]] = m[2];
  const keys = Object.keys(map);
  if (keys.length !== 25) throw new Error(`KEYMAP 应有 25 键，实得 ${keys.length}`);
  return map;
}

/** `{g:'一',f:'地',...}` → `{ g: '一', f: '地', ... }`（单引号 + 裸键名，不是 JSON）。 */
function parseSimpleMap(literal, label) {
  const map = {};
  const re = /([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(literal)) !== null) map[m[1]] = m[2];
  const n = Object.keys(map).length;
  if (n === 0) throw new Error(`${label}: 没解析出一个键值对`);
  return map;
}

/* ------------------------------------------------------------------ 工具 */

const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const LATIN = /[A-Za-z]/g;
const DIGIT = /[0-9\uFF10-\uFF19]/g;

/** 与 src/core/wordcount.ts 同一口径（脚本不 import TS，故此处复刻并自检）。 */
function countEffective(text) {
  const han = text.match(HAN)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  const digit = text.match(DIGIT)?.length ?? 0;
  return han + latin + digit;
}

/** 汉字数（不含英文数字）。设计稿上的"字数"指的是这个数。 */
function countHan(text) {
  return text.match(HAN)?.length ?? 0;
}

/** 与 src/core/wordcount.ts 的 normalizeTarget 同一口径。 */
function normalizeTarget(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, ''))
    .filter((line) => line.length > 0)
    .join('\n');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function pct(n, d) {
  return d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`;
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  for (const f of [SRC_MAIN, SRC_ROOT, SRC_FREQ, SRC_DICT]) {
    if (!fs.existsSync(f)) throw new Error(`缺参考资料：${f}`);
  }

  const mainHtml = fs.readFileSync(SRC_MAIN, 'utf8');
  const rootHtml = fs.readFileSync(SRC_ROOT, 'utf8');

  /* ---------- 1. 3000 字表 ---------- */
  const data3000 = extractString(mainHtml, 'DATA_3000', SRC_MAIN);
  const rows = data3000.split('\n').filter((line) => line.length > 0);
  if (rows.length !== 3000) throw new Error(`DATA_3000 应有 3000 行，实得 ${rows.length}`);

  /* ---------- 2. 字频表（校验 + freqRank） ---------- */
  const freqText = fs.readFileSync(SRC_FREQ, 'utf8');
  const freqChars = [];
  let rangeStart = 0;
  for (const rawLine of freqText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(line);
    if (range) {
      rangeStart = Number(range[1]);
      continue;
    }
    if (rangeStart === 0) continue; // 标题行
    for (const ch of line) {
      if (/[\u4E00-\u9FFF]/.test(ch)) freqChars.push(ch);
    }
  }
  const freqRank = new Map();
  freqChars.forEach((ch, i) => {
    if (!freqRank.has(ch)) freqRank.set(ch, i + 1);
  });

  const chars = [];
  let orderMismatch = 0;
  rows.forEach((line, index) => {
    const f = line.split('|');
    const ch = f[0] ?? '';
    if (!ch) return;
    const rank = freqRank.get(ch);
    // DATA_3000 本身按字频排；与独立字频表逐位比对，用来发现数据源漂移。
    if (freqChars[index] && freqChars[index] !== ch) orderMismatch += 1;
    chars.push({
      ch,
      codes: f[1] ? f[1].split(',') : [],
      units: f[2] ?? '',
      xy: f[3] ?? '',
      kind: f[4] ?? '',
      py: f[5] ?? '',
      strokes: f[6] ?? '',
      radical: f[7] ?? '',
      freqRank: rank ?? index + 1,
    });
  });
  if (chars.length !== 3000) throw new Error(`合法单字应为 3000，实得 ${chars.length}`);

  /* ---------- 3. 字根（303）+ 一级简码（25） ---------- */
  const glyphs = extractJson(rootHtml, 'GLYPHS', SRC_ROOT);
  const yijian = parseSimpleMap(extractRaw(rootHtml, 'YIJIAN', SRC_ROOT), 'YIJIAN');
  const keymap = parseKeymap(mainHtml);

  const keyZone = (key) => Number((keymap[key.toLowerCase()] ?? '00')[0]);
  const keyCode = (key) => keymap[key.toLowerCase()] ?? '00';

  const rootKeys = Object.keys(glyphs.root);
  const totalRoots = rootKeys.reduce((n, k) => n + glyphs.root[k].length, 0);
  if (totalRoots !== 303) throw new Error(`字根应为 303，实得 ${totalRoots}`);
  if (Object.keys(yijian).length !== 25) throw new Error(`一级简码应为 25，实得 ${Object.keys(yijian).length}`);

  const rootItem = (key, entry) => {
    const [gid, d, name] = entry;
    return {
      id: `root:${gid}`,
      kind: 'root',
      key: key.toUpperCase(),
      glyph: name || '',
      name: name || '',
      zone: keyZone(key),
      path: d || '',
    };
  };

  const shortItem = (key) => ({
    id: `shortcode:${key.toLowerCase()}`,
    kind: 'shortcode',
    key: key.toUpperCase(),
    glyph: yijian[key.toLowerCase()],
    name: '一级简码',
    zone: keyZone(key),
    path: '',
  });

  /*
   * 池序 = 按区分块、块内交错，保证相邻两题不会落在同一个键上：
   *   ① 键按「位优先」排（G H T Y N / F J R U B / …），每 5 张走完横竖撇捺折各一次；
   *   ② 每个键的字根按 `i / n × 总数` 等间隔铺开，避免某个键扎堆（K 键 3 个、N 键 32 个）；
   *   ③ 25 个一级简码按固定间隔（约每 12 张）撒进去；
   *   ④ 收尾把相邻同键的换开。
   * 这段是"数据侧的排列"，不是队列算法 —— 队列只管在这个顺序上做间隔重复。
   */
  const order = rootKeys.slice().sort((a, b) => {
    const ca = keyCode(a);
    const cb = keyCode(b);
    const pa = Number(ca[1]);
    const pb = Number(cb[1]);
    return pa !== pb ? pa - pb : keyZone(a) - keyZone(b);
  });

  const buckets = order.map((key) => ({ key, items: glyphs.root[key] }));
  const grand = buckets.reduce((n, b) => n + b.items.length, 0);

  const slots = [];
  buckets.forEach((bucket, ki) => {
    bucket.items.forEach((entry, i) => {
      slots.push({
        // ki*1e-4 只决定「同一位置」的先后：所有键的第 1 张都在 0，加上偏移正好按键序排
        pos: (i / bucket.items.length) * grand + ki * 1e-4,
        item: rootItem(bucket.key, entry),
      });
    });
  });
  slots.sort((a, b) => a.pos - b.pos);
  const laid = slots.map((s) => s.item);

  const shorts = order.filter((k) => yijian[k.toLowerCase()]).map((k) => shortItem(k));
  const step = Math.max(1, Math.round(laid.length / shorts.length));

  const pool = [];
  let sj = 0;
  for (let i = 0; i < laid.length; i++) {
    pool.push(laid[i]);
    if (sj < shorts.length && (i + 1) % step === 0) pool.push(shorts[sj++]);
  }
  while (sj < shorts.length) pool.push(shorts[sj++]);

  // 收尾：一简插进去可能和邻居撞键，往后找一个不同键的换过来
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].key !== pool[i - 1].key) continue;
    for (let k = i + 1; k < pool.length; k++) {
      if (pool[k].key !== pool[i - 1].key) {
        const t = pool[i];
        pool[i] = pool[k];
        pool[k] = t;
        break;
      }
    }
  }

  if (pool.length !== 328) throw new Error(`字根池应为 328，实得 ${pool.length}`);
  const poolIds = new Set(pool.map((p) => p.id));
  if (poolIds.size !== 328) throw new Error('字根池有重复 id');
  const adjacentSameKey = pool.reduce((n, it, i) => (i > 0 && it.key === pool[i - 1].key ? n + 1 : n), 0);

  /* ---------- 4. 词组（W2A…W4B，定长切） ---------- */
  const parts = {};
  for (const name of ['W2A', 'W2B', 'W3A', 'W3B', 'W4A', 'W4B']) {
    parts[name] = extractString(mainHtml, name, SRC_MAIN);
  }
  const cut = (text, n) => {
    const out = [];
    for (let i = 0; i + n <= text.length; i += n) out.push(text.slice(i, i + n));
    return out;
  };
  const dedupe = (list, label) => {
    const seen = new Set();
    const out = [];
    let dup = 0;
    for (const w of list) {
      if (seen.has(w)) {
        dup += 1;
        continue;
      }
      seen.add(w);
      out.push(w);
    }
    if (dup > 0) console.log(`   · ${label}：去重 ${dup} 条`);
    return out;
  };

  const word2 = dedupe(cut(parts.W2A + parts.W2B, 2), '二字词');
  const word3 = dedupe(cut(parts.W3A + parts.W3B, 3), '三字词');
  const word4 = dedupe(cut(parts.W4A + parts.W4B, 4), '成语');

  /* ---------- 6. 卡片索引 ---------- */
  const charItemIds = chars.map((c) => `char:${c.ch}`);
  const wordsJson = { version: 1, word2, word3, word4 };

  const cards = [
    {
      id: 'roots',
      kind: 'roots',
      title: '字根 · 328 题',
      source: '86 版五笔字根表（303 字根 + 25 一级简码）',
      charCount: pool.length,
      count: pool.length,
      items: [...poolIds],
    },
    ...[
      [0, 'chars:1-500', '单字 · 1–500'],
      [500, 'chars:501-1000', '单字 · 501–1000'],
      [1000, 'chars:1001-1500', '单字 · 1001–1500'],
      [1500, 'chars:1501-2000', '单字 · 1501–2000'],
      [2000, 'chars:2001-2500', '单字 · 2001–2500'],
      [2500, 'chars:2501-3000', '单字 · 2501–3000'],
    ].map(([from, id, title]) => ({
      id,
      kind: 'chars',
      title,
      source: `3000 常用字表（按字频排序）· 第 ${from + 1}–${from + 500} 位`,
      charCount: 500,
      count: 500,
      items: charItemIds.slice(from, from + 500),
    })),
    ...[
      ['words:2', 'word2', '二字词 · 1000', word2, '常用二字词'],
      ['words:3', 'word3', '三字词 · 1000', word3, '常用三字词'],
      ['words:4', 'idiom', '四字词 · 1000', word4, '常用四字组合'],
    ].map(([id, kind, title, list, src]) => ({
      id,
      kind,
      title,
      source: src,
      charCount: list.reduce((n, w) => n + countEffective(w), 0),
      count: list.length,
      items: list.map((w) => `${kind}:${w}`),
    })),
  ];

  /* ---------- 6.5 笔画轮廓与字根分段（拆解图用） ----------
     来源：86 版语料的 STROKE 字段，「字!笔画1~笔画2…」的紧凑串，
     每条笔画用 B64 存坐标；SEGS 是「第1段笔号/第2段笔号…」，笔号从 0 起、可写 a-b。
     只保留本项目用得到的字（3000 字表），其余丢掉；原始 3129 条 → 约 3000 条。 */
  const keep = new Set(chars.map((c) => c.ch));

  const rawStroke = extractString(mainHtml, 'STROKE', SRC_MAIN);
  const strokeParts = [];
  if (rawStroke) {
    for (const rec of rawStroke.split('|')) {
      const bang = rec.indexOf('!');
      if (bang <= 0) continue;
      const ch = rec.slice(0, bang);
      if (!keep.has(ch)) continue;
      strokeParts.push(rec);
    }
  }

  const rawSegs = extractJsonLoose(mainHtml, 'SEGS', SRC_MAIN);
  const rawGuess = extractJsonLoose(mainHtml, 'SEGS_GUESS', SRC_MAIN);
  const segs = {};
  for (const [ch, v] of Object.entries({ ...(rawSegs || {}), ...(rawGuess || {}) })) {
    if (keep.has(ch) && typeof v === 'string') segs[ch] = v;
  }

  /* 补充：语料的 STROKE 里没有分段、但词典里有分段的字。
     分段格式统一为 `0-2/3-4`，逐笔轮廓从 hanzi-writer（makemeahanzi）取。
     **两边是同一套坐标**：y 向上、基线 900，与 STROKE 逐值相同
     （实测「上」第 3 笔长横 old=30–178、hanzi=30–178）。所以原样存，画图侧的
     `translate(0,900) scale(1,-1)` 负责翻成屏幕方向。再取 900−y 等于翻两次，
     字会上下颠倒且顶部越出 viewBox —— 之前就是这样，3552 字里有 358 字画布 y 为负。 */
  const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/';
  const b64pair = (n) => B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
  const addOff = (v) => Math.max(0, Math.min(4095, Math.round(v) + 512));

  function encodePath(d) {
    const toks = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/gi) ?? [];
    let out = '';
    let i = 0;
    while (i < toks.length) {
      const cmd = String(toks[i++]).toUpperCase();
      if (!/[MLQCZ]/.test(cmd)) continue;
      out += cmd;
      const pairs = cmd === 'Q' ? 2 : cmd === 'C' ? 3 : cmd === 'Z' ? 0 : 1;
      for (let k = 0; k < pairs; k++) {
        const x = Number(toks[i++]);
        const y = Number(toks[i++]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
        // 画布坐标 = `translate(0,900) scale(1,-1)` 之后的坐标：y_canvas = 900 − y_data。
        // 数据本身已是 y 向上（基线 900），所以 y_data = y，y_canvas = 900 − y。
        // 全量 9574 字实测 y ∈ [−119, 898] → y_canvas ∈ [2, 1019]，正好落在 1024 的框里。
        out += b64pair(addOff(x)) + b64pair(addOff(y));
      }
    }
    return out;
  }

  const hwDir = path.join(SRC_DICT, 'hanzi-writer-data');
  const wubiTsv = path.join(SRC_DICT, 'data-wubi-v86.tsv');
  let extraCount = 0;
  let skipped = 0;

  if (fs.existsSync(hwDir) && fs.existsSync(wubiTsv)) {
    const have = new Set(strokeParts.map((rec) => rec.slice(0, rec.indexOf('!'))));
    const segRows = new Map();
    const lines = fs.readFileSync(wubiTsv, 'utf8').split('\n');
    const head = (lines[0] ?? '').split('\t');
    const ci = head.indexOf('char');
    const si = head.indexOf('segments');
    for (let i = 1; i < lines.length; i++) {
      const cells = (lines[i] ?? '').split('\t');
      const ch = cells[ci];
      const seg = (cells[si] ?? '').trim();
      if (ch && seg) segRows.set(ch, seg);
    }

    for (const [ch, seg] of segRows) {
      if (have.has(ch)) continue;
      const file = path.join(hwDir, `${ch}.json`);
      if (!fs.existsSync(file)) { skipped += 1; continue; }
      let strokes;
      try {
        strokes = JSON.parse(fs.readFileSync(file, 'utf8')).strokes;
      } catch { skipped += 1; continue; }
      if (!Array.isArray(strokes) || strokes.length === 0) { skipped += 1; continue; }

      // 分段索引必须落在笔画数以内，否则上色会错位 —— 宁可不上色也不画错。
      const maxIdx = Math.max(...seg.split('/').flatMap((part) =>
        part.split(',').map((v) => Number(String(v).replace(/^\*/, '').split('-').pop()))));
      if (!Number.isFinite(maxIdx) || maxIdx >= strokes.length) { skipped += 1; continue; }

      const enc = strokes.map((d) => encodePath(d));
      if (enc.some((e) => !e)) { skipped += 1; continue; }
      strokeParts.push(`${ch}!${enc.join('~')}`);
      segs[ch] = seg;
      extraCount += 1;
    }
    if (skipped > 0) console.log(`  笔画补充 跳过 ${skipped} 字（缺轮廓或分段索引越界）`);
  }

  // 去重：STROKE 与补充段可能收同一个字（两种轮廓会画两次），
  // 保留先出现的，后面的丢掉。
  const uniqStroke = new Map();
  for (const rec of strokeParts) {
    const ch = rec.slice(0, rec.indexOf('!'));
    if (ch && !uniqStroke.has(ch)) uniqStroke.set(ch, rec);
  }
  const finalStrokes = [...uniqStroke.values()];

  writeJson(path.join(OUT, 'strokes.json'), {
    version: 1,
    off: 512,
    chars: finalStrokes.join('|'),
    segs,
  });
  console.log(`  笔画     ${finalStrokes.length} 字（分段 ${Object.keys(segs).length} 条，其中补充 ${extraCount} 字、去重 ${strokeParts.length - finalStrokes.length} 条，${(finalStrokes.join('|').length / 1024 / 1024).toFixed(1)}MB）`);

  /* ---------- 7. 落盘 ---------- */
  writeJson(path.join(OUT, 'roots.json'), { version: 1, items: pool });
  writeJson(path.join(OUT, 'chars.json'), { version: 1, chars });
  writeJson(path.join(OUT, 'words.json'), wordsJson);
  writeJson(path.join(OUT, 'cards.json'), { version: 1, cards });

  const dataIndex = `/**
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

/** 整篇跟打的卡（带 chars）。 */
export function isTextCard(card: Card): card is TextCard {
  return typeof (card as TextCard).chars === 'string';
}
`;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.ts'), dataIndex, 'utf8');

  /* ---------- 8. 核对输出 ---------- */
  console.log('懒猫五笔 · 数据构建完成\n');
  console.log(`  字表     ${chars.length} 字（字频表对齐偏差 ${orderMismatch} 处，${pct(orderMismatch, 3000)}）`);
  console.log(`  字根     ${pool.length} 题（303 字根 + 25 一级简码，相邻同键 ${adjacentSameKey} 处）`);
  console.log(`  二字词   ${word2.length} 条`);
  console.log(`  三字词   ${word3.length} 条`);
  console.log(`  成语     ${word4.length} 条`);
  console.log(`  卡片     ${cards.length} 张：`);
  for (const c of cards) console.log(`           ${c.id.padEnd(22)} ${String(c.title).padEnd(16)} 字数 ${c.charCount}`);
  console.log(`\n  输出目录 ${OUT}`);
  if (adjacentSameKey > 0) {
    console.log(`  ⚠ 池序仍有 ${adjacentSameKey} 处相邻同键（收尾算法能做到的极限）`);
  }
}

main();
