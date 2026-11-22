/**
 * app/home.ts — 主页。
 *
 * 负责：顶栏 + 三组卡（字根 / 单字 / 词组）+ 新建 / 删除自定义卡。
 * 不负责：练习本身（practice.ts）、顶栏与存档弹窗（topbar.ts）。
 * 调用方：main.ts 的路由。
 *
 * **布局**：一整列，4 列卡片网格，内容宽 1120 居中。
 *
 * **卡片是竖的「一块砖」**：271×158，顶部一个大字当身份，下面两行小字，
 * 底部一条进度线。中文两行就够，不需要再塞玩法说明。
 *
 * **字根卡与另外两组同形**，不横跨整幅。五区图例属于练习页的 `.legend`，
 * 不是卡片的内容。
 *
 * **三组同级**：16px / 600 / --ink-1，组标题右侧只留一个真数字（本组累计字数）。
 */

import { cardList } from './data';
import {
  CUSTOM_MAX,
  customCards,
  load,
  practicedCount,
  removeCustom,
  restoreCustom,
  type CustomCard,
  type CustomKind,
} from './store';
import { toast } from './toast';
import { mountTopbar, topbarHTML } from './topbar';
import type { Card } from '../core/types';

export interface HomeHandle {
  destroy(): void;
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] as string));
}

/** 某张卡累计打了多少字（含重复）。 */
function cardCharsOf(id: string): number {
  return load().cardChars[id] ?? 0;
}

function countOf(card: Card): number {
  return (card as { count?: number }).count ?? (card as { charCount?: number }).charCount ?? 0;
}

/**
 * 卡片顶部那个大字：这张卡的身份。
 *
 * 内置卡的身份就是它的**范围/类别**，从数据标题里取：
 *   `单字 · 1–500` → `1–500`；`二字词 · 1000` → `二字词`；`字根练习` → `字根`
 *
 * 只有单字卡取「·」右边（那才是它的身份：哪一段字表）；词组卡右边是**数量**，
 * 取右边会让三张卡全变成 `1000`（第一版就是这么错的，截图里三块「1000」并排）。
 * 不去编序号（Lv.1、01…）：那是编出来的，而这几个字真的是他在练的东西。
 */
function bigOf(card: Card): string {
  const t = card.title ?? '';
  if (card.kind === 'roots') return '字根';
  const parts = t.split('·').map((x) => x.trim());
  const right = parts[1] ?? '';
  if (card.kind === 'chars' && /^[\d\-–—~]+$/.test(right)) return right.replace(/-/g, '–');
  return parts[0] || t;
}

/**
 * 副标题：这张卡装的是什么。
 *
 * 词组卡**不写数量**：它的数量下一行（`1,000 题`）已经写了，
 * 两行挨着报同一个数，读起来像渲染错位。单字卡可以写数量 ——
 * 那行 `486 / 500 题` 里的 500 是分母，语义不同（「总共 500 个」vs「已练 486 个」）。
 */
function metaOf(card: Card): string {
  const n = countOf(card).toLocaleString('zh-CN');
  switch (card.kind) {
    case 'roots': return '303 个字根 + 25 个一级简码';
    case 'chars': return `${n} 个常用字`;
    case 'word2': return '高频二字搭配';
    case 'word3': return '高频三字短语';
    // 「成语」这个词不准确：这批 W4 词里大量是普通四字组合（如「一心一意」之外的
    // 「一举两得」「一石二鸟」在库里其实是常用短语，并不都算成语，
    // 所以这一类统一叫「高频四字组合」。
    default: return '高频四字组合';
  }
}

/**
 * 一张内置卡。
 *
 * 两行数字的分工：
 *   · 主行 = 已练题数 / 总题数（没有进度读数时它就是唯一的数）
 *   · 次行 = 累计字数（含重复，回答「我在这一组花了多少功夫」）
 * **没有熟练度快照就不写分数**：那种情况只知道累计字数，写「0 / 500」是假的，
 * 只写静态题数，轨道留空。
 */
function builtinCardHTML(card: Card): string {
  const total = countOf(card);
  const practiced = practicedCount(card.id);
  const done = cardCharsOf(card.id);

  const stats = practiced === null
    ? `<span class="cstats"><b>${total.toLocaleString('zh-CN')}</b> 题</span>`
    : `<span class="cstats"><b>${practiced.toLocaleString('zh-CN')}</b> / ${total.toLocaleString('zh-CN')} 题</span>`;

  /**
   * 轨道**永远画**，只有填充依赖快照。
   *
   * 轨道是卡片的下缘，必须一直画：不画的话没练过的卡会短一截，
   * 一组里出现两种卡高。空轨道说的就是「0%」；数字那行仍然只写 `500 题`，
   * 不写假的 `0 / 500`。
   */
  const fill = practiced === null
    ? ''
    : `<i style="width:${(total > 0 ? Math.min(100, (practiced / total) * 100) : 0).toFixed(1)}%"></i>`;
  const bar = `<span class="cline">${fill}</span>`;

  return `<a class="card" href="#/p/${encodeURIComponent(card.id)}">
    <span class="cbig">${bigOf(card)}</span>
    <span class="cmeta">${metaOf(card)}</span>
    ${stats}
    <span class="cdone">累计 <b>${done.toLocaleString('zh-CN')}</b> 字</span>
    ${bar}
  </a>`;
}

/**
 * 自定义卡：大字写「自定」，下面一行是用户起的名字（可能是长句，省略号收）。
 *
 * 删除键是 `<a>` 的**兄弟节点**，不是子节点：HTML 不允许 `a` 套 `button`。
 * 所以外层是 `<div class="card ccard">`，里面一个覆盖整卡的 `<a class="cover">`
 * 负责跳转，删除键 `z-index` 压在它上面。
 */
function customCardHTML(c: CustomCard): string {
  const done = cardCharsOf(c.id);
  // 老存档里「整篇跟打」的卡 items 是空的，这时显示字数而不是「0 题」
  const stats = c.items.length > 0
    ? `<b>${c.items.length.toLocaleString('zh-CN')}</b> 题`
    : `<b>${c.charCount.toLocaleString('zh-CN')}</b> 字`;
  return `<div class="card ccard">
    <a class="cover" href="#/p/${encodeURIComponent(c.id)}"><span class="sr-only">打开「${escapeHTML(c.title)}」</span></a>
    <span class="cbig">自定</span>
    <span class="ctitle">${escapeHTML(c.title)}</span>
    <span class="cstats">${stats}</span>
    <span class="cdone">累计 <b>${done.toLocaleString('zh-CN')}</b> 字</span>
    <button class="cdel" type="button" data-del="${escapeHTML(c.id)}" aria-label="删除「${escapeHTML(c.title)}」这张卡" title="删除">✕</button>
  </div>`;
}

/**
 * 新建卡的文案三档。
 *
 * 0–2 张时**不出现配额**：还没到会撞墙的位置，先把「这里能干什么」说清楚。
 * 3–4 张才提醒还剩几张；5 张时形状换实线 + 一行可见原因，并且
 * `aria-disabled`（语义）之外还要在点击里拦一次 —— `aria-disabled` 不阻止点击。
 */
/** 虚线卡：新建单字卡（自定义只此一种）。 */
function addCardHTML(built: number): string {
  const max = CUSTOM_MAX;
  const full = built >= max;
  const note = full ? '已达上限 · 删一张才能再加' : built <= 2 ? '粘贴文本，只取单字' : `还能建 ${max - built} 张`;
  return `<button class="card cadd${full ? ' cfull' : ''}" type="button" data-add="char"${full ? ' aria-disabled="true"' : ''}>
    <span class="cbig" aria-hidden="true">${full ? '·' : '+'}</span>
    <span class="ctitle">新建单字卡</span>
    <span class="caddnote">${note}</span>
  </button>`;
}

function groupCardsHTML(cards: Card[], customs: CustomCard[], withAdd: boolean): string {
  return `${cards.map(builtinCardHTML).join('')}${customs.map(customCardHTML).join('')}${withAdd ? addCardHTML(customs.length) : ''}`;
}

/**
 * 组标题：名字 + 一个真数字（本组累计字数 = 组内各卡 cardChars 之和）。
 *
 * `kind === null` = 这一组不出现「新建」虚线卡：
 * 字根组拆不出单字，词组组已有三张内置卡、不再收自定义。
 */
function groupHTML(
  title: string,
  total: number,
  kind: CustomKind | null,
  cards: Card[],
  customs: CustomCard[],
): string {
  const body = groupCardsHTML(cards, customs, kind !== null);
  return `<section class="grp" data-grp="${kind ?? 'roots'}">
    <h2 class="ghead">
      <span class="gtitle">${title}</span>
      <span class="gsum">累计 ${total.toLocaleString('zh-CN')} 字</span>
    </h2>
    <div class="grid">${body}</div>
  </section>`;
}

/* ---------------- 挂载 ---------------- */

/** 上一轮的监听器：重新挂载时先解掉，避免每删一张卡就多一套 click 监听。 */
let liveAbort: AbortController | null = null;

export function mountHome(root: HTMLElement, go: (hash: string) => void): HomeHandle {
  liveAbort?.abort();
  const ac = new AbortController();
  liveAbort = ac;
  const signal = ac.signal;

  const cards = cardList();
  const customs = customCards();
  const rootCards = cards.filter((c) => c.kind === 'roots');
  const charCards = cards.filter((c) => c.kind === 'chars');
  const wordCards = cards.filter((c) => c.kind === 'word2' || c.kind === 'word3' || c.kind === 'idiom');
  const charCustoms = customs.filter((c) => c.kind === 'char');
  const wordCustoms = customs.filter((c) => c.kind === 'word');

  /** 一组累计 = 组内各卡（内置 + 自定义）的 cardChars 之和。不能手写。 */
  const groupTotal = (list: Card[], list2: CustomCard[]) =>
    list.reduce((n, c) => n + cardCharsOf(c.id), 0) + list2.reduce((n, c) => n + cardCharsOf(c.id), 0);

  root.innerHTML = `
    <div class="hm">
      ${topbarHTML({ home: true })}

      <div class="hmbody">
        <div class="hmleft">
          <div class="hmwrap">
            ${groupHTML('字根练习', groupTotal(rootCards, []), null, rootCards, [])}
            ${groupHTML('单字练习', groupTotal(charCards, charCustoms), 'char', charCards, charCustoms)}
            ${groupHTML('词组练习', groupTotal(wordCards, wordCustoms), null, wordCards, wordCustoms)}

            <footer class="foot">
              <span>开源协议 AGPL-3.0</span>
              <span class="footdot" aria-hidden="true">·</span>
              <span>进度仅存本机</span>
            </footer>
          </div>
        </div>
      </div>
    </div>`;

  document.title = '懒猫五笔';

  const remount = () => mountHome(root, go);

  const disposeTopbar = mountTopbar(root);
  signal.addEventListener('abort', disposeTopbar);

  /* 新建卡：虚线卡（含到顶时的拦截） */
  root.addEventListener('click', (e) => {
    const add = (e.target as HTMLElement).closest('[data-add]') as HTMLElement | null;
    if (!add?.dataset.add) return;
    e.preventDefault();
    /**
     * `aria-disabled` 只是语义，浏览器不拦点击 —— 到顶时必须在这里拦一次。
     * 拦的方式是**说明原因**，不是静默失效：`cursor:not-allowed` 只是个形状提示。
     */
    if (add.getAttribute('aria-disabled') === 'true') {
      toast({
        text: '单字卡已达上限',
        sub: `最多 ${CUSTOM_MAX} 张，删一张才能再加。`,
      });
      return;
    }
    void import('./custom').then((m) => m.openCustomDialog({ onSaved: remount }));
  }, { signal });

  /* 删除自定义卡（带撤销） */
  root.addEventListener('click', (e) => {
    const del = (e.target as HTMLElement).closest('[data-del]') as HTMLElement | null;
    if (!del?.dataset.del) return;
    e.preventDefault();
    e.stopPropagation();
    const id = del.dataset.del;
    const card = customCards().find((c) => c.id === id);
    if (!card) return;
    // 撤销要能把它**连累计字数一起**放回去，所以先留一份
    const chars = cardCharsOf(id);
    removeCustom(id);
    remount();
    toast({
      text: `已删除「${card.title}」`,
      sub: chars > 0 ? `这张卡的累计 ${chars.toLocaleString('zh-CN')} 字会一起恢复` : undefined,
      action: {
        label: '撤销',
        run: () => {
          restoreCustom(card, chars);
          remount();
        },
      },
    });
  }, { signal });

  return {
    destroy() {
      ac.abort();
      if (liveAbort === ac) liveAbort = null;
    },
  };
}
