/**
 * app/main.ts — 入口与路由。
 *
 * 负责：解析 hash（`#/` 主页、`#/p/<cardId>` 练习），
 *       把自定义卡片解析成练习页认得的 Card，挂载/卸载页面。
 * 不负责：任何练习逻辑。
 */

import './style.css';
import { cardById } from './data';
import { findCustom } from './store';
import { mountHome } from './home';
import { mountPractice, type PracticeHandle } from './practice';
import type { Card } from '../core/types';

const root = document.getElementById('app') as HTMLElement;
let current: PracticeHandle | { destroy(): void } | null = null;

function destroyCurrent() {
  if (current) { current.destroy(); current = null; }
  root.innerHTML = '';
}

/** 自定义卡片存的是原文，这里折成练习页认得的 Card 形状。 */
function resolveCard(id: string): Card | null {
  if (!id.startsWith('custom:')) return cardById(id) ?? null;
  const c = findCustom(id);
  // 只认逐题卡；没有题面的老存档条目当作不存在。
  if (!c || c.mode !== 'item' || c.items.length === 0) return null;
  const single = c.items.every((t) => Array.from(t).length === 1);
  return {
    id: c.id,
    kind: single ? 'chars' : 'word2',
    title: c.title,
    charCount: c.charCount,
    count: c.items.length,
    items: c.items.map((t) => `raw:${t}`),
  } as unknown as Card;
}

function host(): HTMLElement {
  destroyCurrent();
  const el = document.createElement('div');
  el.className = 'host';
  root.appendChild(el);
  return el;
}

/* ---------- 页面 ---------- */

function renderHome() {
  destroyCurrent();
  const el = document.createElement('div');
  el.className = 'host';
  root.appendChild(el);
  current = mountHome(el, (hash) => { location.hash = `#${hash}`; });
  document.title = '懒猫五笔';
}

function renderPractice(cardId: string) {
  const card = resolveCard(cardId);
  if (!card) { location.hash = '#/'; return; }
  const el = host();
  current = mountPractice(el, card, () => { location.hash = '#/'; });
  document.title = `${card.title} · 懒猫五笔`;
}

/* ---------- 路由 ---------- */

/**
 * 解析 hash。`decodeURIComponent` 遇到畸形的百分号转义（`#/p/100%`）会 throw ——
 * 直接打开这样的地址会让整页白屏（初始 route() 抛在上层，没人接）。
 * 所以这里自己兜住：解不出来就回主页，而不是让整个应用不启动。
 */
function route() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('/p/')) {
    let id = h.slice(3);
    try {
      id = decodeURIComponent(id);
    } catch {
      location.hash = '#/';
      return;
    }
    renderPractice(id);
  } else {
    renderHome();
  }
}

window.addEventListener('hashchange', route);
route();
