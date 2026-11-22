/**
 * app/store.ts — 本机进度存档。
 *
 * 负责：总经验 / 累计字数 / 每张卡累计字数 / 每卡队列快照 / 自定义卡片；
 *       2 秒节流落盘、切后台强写、导出与导入。
 * 不负责：经验曲线（core/xp）。
 * 调用方：practice.ts（写）、home.ts / topbar.ts（读）。
 *
 * 介质是 localStorage，一个键。数据量很小（每卡一个数字 + 一份队列快照）。
 *
 * 存档里只保留界面真正用得到的字段；多出来的键在 `sanitize` 时直接无视 ——
 * 不迁移、不报错、不显示。
 */

import { safeInt, type QueueSnapshot } from '../core';

const KEY = 'lazycat-wubi/v1';
const SAVE_DELAY = 2000;

/**
 * 自定义卡片的种类。`word` 只为读得懂老存档而保留：
 * 现在只新建单字卡，词组练习用内置的三张卡。
 */
export type CustomKind = 'char' | 'word';

/** 自定义卡张数上限。 */
export const CUSTOM_MAX = 5;

/** 单卡条目上限：粘贴一整篇小说进去也只取这么多。 */
export const CUSTOM_ITEM_CAP = 1000;

/** 自定义卡片：用户自己粘贴的文本。 */
export interface CustomCard {
  id: string;
  title: string;
  /** 练习形态：一题一个目标串。 */
  mode: 'item';
  /** 这张卡属于哪一组。没有这个字段的老存档由 `sanitizeCustom` 从 items 推断。 */
  kind: CustomKind;
  /** 卡片原文（留档用，方便用户回看自己粘过什么）。 */
  raw: string;
  /** 单题目标（item 模式，按用户选的切法切好）。 */
  items: string[];
  /** 有效字数（卡上显示用）。 */
  charCount: number;
  createdAt: number;
}

export interface Progress {
  v: 2;
  /** 总经验（1 个打对的有效字 = 1 点）。 */
  xp: number;
  /** 累计打对的有效字数。 */
  totalChars: number;
  /**
   * 累计练习时长（整数毫秒）。
   *
   * 口径只有一条：**计时器真正在走的时长**。暂停、轮次结束浮层冻住的那几分钟都不算，
   * 所以它和「本轮已用」「本次用时」是同一只表量出来的，两个数一定对得上。
   * 中途退出、一个字没打也记 —— 用户确实在这一页待了这些时间。
   */
  totalPracticeMs: number;
  /** 每张卡累计打对的字数，键是卡片 id。 */
  cardChars: Record<string, number>;
  /** 自定义卡片。 */
  custom: CustomCard[];
  /** 累计练习次数（结算一次 +1）。 */
  sessions: number;
  /**
   * 每张卡的出题队列快照（熟练度）。
   *
   * 之前这里是空的，于是每次进卡都 `createQueue()` 从零开始 ——
   * 「已熟 0/500」不是算法算错，是**从来没存过**。core 早就写好了
   * `snapshot()` / `queueFromSnapshot()`，只是 app 层没接。
   */
  queues: Record<string, QueueSnapshot>;
}

export function emptyProgress(): Progress {
  return {
    v: 2,
    xp: 0,
    totalChars: 0,
    totalPracticeMs: 0,
    cardChars: {},
    custom: [],
    sessions: 0,
    queues: {},
  };
}

let cache: Progress | null = null;
let dirty = false;
let timer: number | null = null;

/** 老存档没有 `kind` 字段，从 `items` 推断：全部是单个字符 → 单字卡，否则词组卡。 */
function inferKind(items: string[]): CustomKind {
  return items.length > 0 && items.every((t) => Array.from(t).length === 1) ? 'char' : 'word';
}

function sanitizeCustom(raw: unknown): CustomCard[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomCard[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    const rawText = typeof o.raw === 'string' ? o.raw : '';
    if (!rawText) continue;
    // 老存档里「整篇跟打」的自定义卡（mode: 'text'）已经无处可练 —— 读完直接丢弃，
    // 免得主页上挂着一张点开是空白的卡。
    if (o.mode === 'text') continue;
    const items = Array.isArray(o.items) ? o.items.filter((x): x is string => typeof x === 'string') : [];
    if (items.length === 0) continue;
    const kind: CustomKind =
      o.kind === 'char' || o.kind === 'word' ? o.kind : inferKind(items);
    out.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '自定义',
      mode: 'item',
      kind,
      raw: rawText,
      items,
      charCount: safeInt(o.charCount, 0, 0),
      createdAt: safeInt(o.createdAt, 0, 0),
    });
  }
  return out.slice(0, 60);
}

function sanitize(raw: unknown): Progress {
  const base = emptyProgress();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  const cardChars: Record<string, number> = {};
  const src = o.cardChars;
  if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (typeof k !== 'string' || !k) continue;
      cardChars[k] = safeInt(v, 0, 0);
    }
  }
  return {
    v: 2,
    xp: safeInt(o.xp, 0, 0),
    totalChars: safeInt(o.totalChars, 0, 0),
    // 老存档没有这个字段：兜底 0，顶栏据此不画时长那一段（而不是画「0 分」）
    totalPracticeMs: safeInt(o.totalPracticeMs, 0, 0),
    cardChars,
    custom: sanitizeCustom(o.custom),
    sessions: safeInt(o.sessions, 0, 0),
    queues: sanitizeQueues(o.queues),
  };
}

export function load(): Progress {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? sanitize(JSON.parse(raw)) : emptyProgress();
  } catch {
    cache = emptyProgress();
  }
  return cache;
}

export function writeNow(): void {
  if (!cache || !dirty) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
    dirty = false;
  } catch {
    /* 配额满 / 隐私模式：静默失败 */
    dirty = true;
  }
  if (timer !== null) { window.clearTimeout(timer); timer = null; }
}

function schedule(): void {
  dirty = true;
  if (timer !== null) return;
  timer = window.setTimeout(() => { timer = null; writeNow(); }, SAVE_DELAY);
}

/** 改档之后统一走这里，保证节流 + 脏标记。 */
export function update(fn: (p: Progress) => void): Progress {
  const p = load();
  fn(p);
  schedule();
  return p;
}

/** 记一次练习：打卡片累计 + 总经验 + 总字数。 */
/**
 * 队列快照的容错：只接受「三个数组等长且都是基本类型」的记录。
 * 坏一条就丢掉那一条（那张卡退回全新），其余卡不受影响 ——
 * 不能因为一个字的进度坏了就把整份熟练度清空。
 */
function sanitizeQueues(raw: unknown): Record<string, QueueSnapshot> {
  const out: Record<string, QueueSnapshot> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === 'string') : null;
    const counts = Array.isArray(o.counts) ? o.counts : null;
    const failed = Array.isArray(o.failed) ? o.failed : null;
    if (!ids || !counts || !failed) continue;
    if (ids.length !== counts.length || ids.length !== failed.length) continue;
    out[id] = {
      v: 1,
      seedState: safeInt(o.seedState, 0, 0),
      jitter: o.jitter === true,
      ids,
      counts: counts.map((n) => safeInt(n, -1, -1)),
      failed: failed.map((b) => b === true),
      answers: safeInt(o.answers, 0, 0),
    };
  }
  return out;
}

/** 取某张卡的队列快照；没有返回 null（= 全新一张卡）。 */
export function queueSnap(cardId: string): QueueSnapshot | null {
  return load().queues[cardId] ?? null;
}

/**
 * 某张卡「已经过了几题」—— 主页卡片那条进度条的分子。
 *
 * **返回 `null` = 这张卡没有快照**，不是 0。
 * 这个区分不是洁癖：队列快照是两轮前才加的，在那之前练过的卡只有 `cardChars`、
 * 没有 `queues`。老档升级后如果用 0 兜底，同一张卡上会并排出现
 * 「累计 2,480 字」和「0 / 500 题 · 进度条空」—— 两把尺子量同一件事，
 * 而后者是假的（他明明练过）。所以 `null` 一路传到界面，由界面**不画**分数与条。
 * 「0 / 500 题」只留给「有快照、但一道都没答对」这张真情况。
 *
 * 口径必须与 `core/queue.ts` 的 `progress().seen` **一模一样**：数 `count >= 0` 的条目。
 * `QueueItem.count` 的初值是 `INITIAL_COUNT = -1`，**答对一次就变 0**；
 * 写成 `> 0` 会把「只答对过一次」的题全部漏掉，进度条于是长期不动 ——
 * 用户上一轮抱怨的正是这个症状。改这里之前先看 queue.ts 第 126 行。
 */
export function practicedCount(cardId: string): number | null {
  const snap = load().queues[cardId];
  if (!snap) return null;
  let n = 0;
  for (const c of snap.counts) if (c >= 0) n += 1;
  return n;
}

/** 存某张卡的队列快照（每次作答后调，节流落盘）。 */
export function saveQueue(cardId: string, snap: QueueSnapshot): void {
  update((p) => {
    p.queues[cardId] = snap;
  });
}

export function addPractice(cardId: string, chars: number): Progress {
  const p = load();
  const n = safeInt(chars, 0, 0);
  if (n <= 0) return p;
  p.xp += n;
  p.totalChars += n;
  p.cardChars[cardId] = safeInt(p.cardChars[cardId], 0, 0) + n;
  schedule();
  return p;
}

export function cardChars(cardId: string): number {
  return safeInt(load().cardChars[cardId], 0, 0);
}

/**
 * 累加练习时长（毫秒）。
 *
 * 调用方**按会话水位线提交增量**（见 practice.ts 的 `commitTime`），
 * 所以这里只做累加、不做去重 —— 去重必须发生在「知道一次会话从哪开始」的那一层。
 * 负数与小数一律夹掉：存档里这个字段必须是整数毫秒。
 */
export function addPracticeTime(ms: number): void {
  const n = Math.max(0, Math.floor(ms));
  if (n <= 0) return;
  update((p) => {
    p.totalPracticeMs += n;
  });
}

/* ---------- 自定义卡片 ---------- */

export function customCards(): CustomCard[] {
  return load().custom;
}

export function findCustom(id: string): CustomCard | undefined {
  return load().custom.find((c) => c.id === id);
}

export function addCustom(card: CustomCard): void {
  update((p) => {
    p.custom = [card, ...p.custom.filter((c) => c.id !== card.id)].slice(0, 60);
  });
}

export function removeCustom(id: string): void {
  update((p) => {
    p.custom = p.custom.filter((c) => c.id !== id);
    delete p.cardChars[id];
  });
}

/**
 * 撤销删除：把卡片**和它的累计字数**一起放回去。
 *
 * 只用 `addCustom` 不够 —— `removeCustom` 会顺手删掉 `cardChars[id]`，
 * 只复原卡片会让「撤销」变成「撤销了一半」，那张卡的进度永久归零。
 * 所以这里把两个字段一起写回，撤销才是真的撤销。
 */
export function restoreCustom(card: CustomCard, chars: number): void {
  update((p) => {
    p.custom = [card, ...p.custom.filter((c) => c.id !== card.id)].slice(0, 60);
    if (chars > 0) p.cardChars[card.id] = chars;
  });
}

/* ---------- 存档导出 / 导入 ---------- */

export function exportJson(): string {
  return JSON.stringify({ app: '懒猫五笔', ...load() }, null, 1);
}

export function importJson(text: string): boolean {
  try {
    const obj = JSON.parse(text);
    cache = sanitize(obj);
    dirty = true;
    writeNow();
    return true;
  } catch {
    return false;
  }
}

export function resetAll(): void {
  cache = emptyProgress();
  dirty = true;
  writeNow();
}

/** 页面隐藏或关闭前强制落盘。 */
export function bindAutoFlush(): void {
  const flush = () => writeNow();
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}

bindAutoFlush();
