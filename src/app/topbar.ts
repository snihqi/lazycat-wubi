/**
 * app/topbar.ts — 全站顶栏（唯一的顶栏组件）。
 *
 * 负责：品牌 / 版本 / Lv（可点开 100 级表）/ 累计字数 / 进度（存档弹窗）。
 * 不负责：这些数字怎么算（core/xp、store 是唯一来源）。
 * 调用方：home.ts、practice.ts。
 *
 * **三条规矩**：
 *
 * ① 全站只有一个顶栏。无论在哪一页，右侧永远是
 *    **版本 · Lv▾ · 累计字数 · 进度**，同一位置、同一顺序 ——
 *    切换页面时数据区不动，只有左半边的「页面身份」变（主页是品牌，练习页是 ← + 卡名）。
 *
 * ② 顶栏只放驱动练习的数字。等级、字数、经验是一回事；除此之外的东西不进顶栏。
 *
 * ③ 存档弹窗跟着顶栏走，主页和练习页都能随时导出、导入。
 */

import { LEVEL_MAX, XP_CUM, XP_NEED, XP_TOTAL_AT_MAX, levelOf, progressInLevel } from '../core';
import { load, type Progress } from './store';
import { abbr } from './fmt';
import logoUrl from '../assets/logo.png';

export interface TopbarOpts {
  /** 左侧返回按钮的 id；不给就不画返回键。 */
  backId?: string;
  /** 页面身份：练习页传卡名，主页不传（画品牌）。 */
  title?: string;
  /** 当前已经在首页：品牌画成不可点元素，而不是指向自己的链接。 */
  home?: boolean;
}

/** 版本号：构建时由 vite 注入（见 vite.config.ts 的 define）。 */
function versionTag(): string {
  return `<span class="vtag" title="版本">v${__APP_VERSION__}</span>`;
}

/** 品牌标：48px 的图按 24px 显示，窄边框那块才不会糊。 */
function brandMark(): string {
  return `<img class="brandlogo" src="${logoUrl}" alt="" aria-hidden="true" width="24" height="24" decoding="async">`;
}

/**
 * 左上角的品牌区。
 *
 * 三种形态：练习页是卡名（`.ptitle`，纯文字）；首页是「懒猫五笔」但**不可点** ——
 * 已经在首页了，可点却什么都不发生比不可点更糟，所以画 `span` 并标 `aria-current`；
 * 其余页面是「懒猫五笔」链接，点它回首页。
 *
 * 用 `<a href>` 而不是 `<button>`：中键、⌘ 点击要能开新标签，右键要能复制链接，
 * 这些能力只挂在 href 上；而 hash 一变就会派发 `hashchange`，路由已经在那儿等着，
 * 不必再绑 click。不写 `title`：触屏看不见它，而且和 `aria-label` 是同一句话。
 */
function brandHTML(opts: TopbarOpts): string {
  if (opts.title) return `<div class="brand"><span class="ptitle">${escapeAttr(opts.title)}</span></div>`;
  if (opts.home) return `<span class="brand brandhome" aria-current="page">${brandMark()}懒猫五笔</span>`;
  return `<a class="brand brandhome" href="#/" aria-label="回到首页">${brandMark()}懒猫五笔</a>`;
}

export function topbarHTML(opts: TopbarOpts = {}): string {
  const p = load();
  return `
    <header class="topbar">
      ${opts.backId ? `<button class="ghost" id="${opts.backId}" aria-label="返回">←</button>` : ''}
      ${brandHTML(opts)}
      ${versionTag()}
      ${userDataHTML(p)}
    </header>
    ${lvPopHTML()}
    ${saveDlgHTML()}`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
}

/**
 * 本级经验：一条进度 + 下面一行小字 `2,176 / 4,582`。
 *
 * 为什么需要它：Lv 是个**台阶**，而经验是**连续**的。只写 `Lv.3` 的话，
 * 打完一整个 500 字的字表只要没升级，顶栏数字就一动不动，看起来像没记上。
 *
 * 为什么条子下面还要写数字：条子只回答「大概到哪了」，回答不了
 * 「还差多少」和「这一卡给了我多少」。数字用等宽 + tabular-nums，
 * 每次 +1 只在末位跳，不会整行抖。
 *
 * 满级时不写 `x / 0`（分母是 0），只写「已满级」。
 */
function lvProgHTML(p: Progress): string {
  const prog = progressInLevel(p.xp);
  const pct = prog.isMax ? 100 : Math.max(0, Math.min(1, prog.ratio)) * 100;
  const label = prog.isMax
    ? `Lv.${prog.level} 已满级`
    : `Lv.${prog.level} 经验 ${prog.into.toLocaleString('zh-CN')} / ${prog.need.toLocaleString('zh-CN')}`;
  const num = prog.isMax
    ? '已满级'
    : `${prog.into.toLocaleString('zh-CN')} / ${prog.need.toLocaleString('zh-CN')}`;
  return `<span class="lvprog">
      <span class="lvbar" role="progressbar" aria-label="本级经验进度"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"
        title="${label}"><i style="width:${pct.toFixed(1)}%"></i></span>
      <span class="lvnum" title="${label}">${num}</span>
    </span>`;
}

/**
 * 右侧数据条：Lv + 经验条 · 累计字数 · 进度。
 *
 * 顺序是「抽象 → 具体 → 操作」：等级是身份的浓缩，字数是它的证据，
 * 进度是唯一一颗按钮。1px 竖线把可点的和只读的分开。
 */
/**
 * 累计时长的人类读法。
 *
 * 三档：< 60 分钟给分钟（向上取整、最小 1 —— 练了 20 秒写「1 分」比「0 分」诚实）；
 * 1–100 小时给一位小数（小时量级上 0.1h = 6 分钟，够用）；≥ 100 小时后小数已经没有
 * 信息量，只给整数。
 *
 * **0 也要给一个数**（「0 分」）：这个位置是个固定读数，空了就没人知道它存在。
 */
function fmtDuration(ms: number): { num: string; unit: string } {
  if (!(ms > 0)) return { num: '0', unit: '分' };
  const mins = ms / 60_000;
  if (mins < 60) return { num: String(Math.max(1, Math.ceil(mins))), unit: '分' };
  const hours = Math.round((mins / 60) * 10) / 10;
  if (hours >= 100) return { num: String(Math.round(hours)), unit: '小时' };
  return { num: hours.toFixed(1), unit: '小时' };
}

/**
 * 「累计时长 · 累计字数」。
 *
 * 时长在前：它才是「我花了多少功夫」的原文，字数是它的结果。
 * 窄屏会把 `累计` 两个字删掉（见 style.css），靠每个读数的 `title` 补全语义。
 */
function accumHTML(p: Progress): string {
  const chars = `<span class="stat chars" title="累计字数">`
    + `<b class="num">${p.totalChars.toLocaleString('zh-CN')}</b> <i>字</i></span>`;
  const d = fmtDuration(p.totalPracticeMs);
  return `<i class="alabel">累计</i>`
    + `<span class="stat dur" title="累计练习时长"><b class="num">${d.num}</b> <i>${d.unit}</i></span>`
    + `<span class="dsep" aria-hidden="true">·</span>`
    + chars;
}

function userDataHTML(p: Progress): string {
  return `
      <div class="userdata">
        <button class="trig lvtrig" id="lvTrig" type="button"
          aria-haspopup="dialog" aria-expanded="false" aria-controls="lvpop">
          <span class="lv">Lv.${levelOf(p.xp)}</span>
          <span class="sr-only">等级详情</span>
        </button>
        ${lvProgHTML(p)}
        <span class="vsep" aria-hidden="true"></span>
        <span class="accum">${accumHTML(p)}</span>
        <button class="ttool" id="btnSave" type="button" aria-haspopup="dialog">进度</button>
      </div>`;
}

/* ────────────────────────── 等级弹层 ────────────────────────── */

function lvPopHTML(): string {
  return `
    <div class="pop pop-lv" id="lvpop" role="dialog" aria-modal="false" aria-label="等级表" hidden>
      <div class="pophead">
        <span class="ptitle">等级</span>
        <span class="psub">打对一个字 +1 经验 · 满级需 ${abbr(XP_TOTAL_AT_MAX)} 经验</span>
        <button class="popx ghost" type="button" aria-label="关闭等级表">✕</button>
      </div>
      <div class="pbody" tabindex="0" role="region" aria-label="等级表，可滚动" data-slot="body"></div>
    </div>`;
}

/** 等级表：100 行全量 + 每 10 级一个分段行。数据只来自 XP_CUM / XP_NEED，不手写。 */
function levelBody(): string {
  const cur = levelOf(load().xp);
  const out: string[] = [];
  for (let lv = 1; lv <= LEVEL_MAX; lv += 1) {
    if ((lv - 1) % 10 === 0) {
      const to = Math.min(LEVEL_MAX, lv + 9);
      out.push(`<tr class="pseg"><th colspan="3" scope="rowgroup">Lv.${lv}–${to}</th></tr>`);
    }
    const need = lv >= LEVEL_MAX ? '—' : (XP_NEED[lv - 1] ?? 0).toLocaleString('zh-CN');
    const cum = (XP_CUM[lv] ?? 0).toLocaleString('zh-CN');
    out.push(
      `<tr class="prow${lv === cur ? ' cur' : ''}">`
      // 第一格是**行头**：读屏从「Lv.5」开始念这一行，而不是从「4,582」开始
      + `<th scope="row" class="plv">Lv.${lv}</th><td class="pneed">${need}</td><td class="pcum">${cum}</td></tr>`,
    );
  }
  return `<table class="ptable ptable-lv">
      <colgroup><col class="c1"><col class="c2"><col class="c3"></colgroup>
      <thead><tr><th scope="col">等级</th><th scope="col">本级需要</th><th scope="col">累计经验</th></tr></thead>
      <tbody>${out.join('')}</tbody>
    </table>`;
}

/* ────────────────────────── 存档弹窗 ────────────────────────── */

function saveDlgHTML(): string {
  return `
    <dialog class="savedlg" id="saveDlg" aria-labelledby="saveH">
      <div class="savehead">
        <h2 id="saveH">进度</h2>
        <button class="ghost" id="saveClose" type="button" aria-label="关闭">✕</button>
      </div>
      <p class="savesub">进度只存在这台电脑的浏览器里。换设备、清缓存、换浏览器之前先导出一份。</p>
      <div class="saveacts2">
        <button class="btn primary" id="btnExport" type="button">导出存档</button>
        <button class="btn" id="btnImport" type="button">导入存档</button>
        <button class="btn danger" id="btnReset" type="button">清空进度</button>
      </div>
    </dialog>`;
}

/* ────────────────────────── 挂载 ────────────────────────── */

/**
 * 把当前行滚到可视区中间（顶到头就停在顶部，不能滚出 Lv.1）。
 *
 * **用 rect 差算，不用 offsetTop**：`.pbody` 不是定位元素，行的 offsetParent
 * 会一路找到弹层甚至页面，offsetTop 把 pophead 的高度也算了进去，滚出来偏一行。
 */
function centerCurrent(pop: HTMLElement): void {
  const body = pop.querySelector<HTMLElement>('.pbody');
  const cur = pop.querySelector<HTMLElement>('.prow.cur');
  if (!body || !cur) return;
  const r = cur.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  body.scrollTop = Math.max(0, body.scrollTop + (r.top - b.top) - body.clientHeight / 2 + r.height / 2);
}

type Off = () => void;

/**
 * 绑顶栏上的一切：Lv 弹层 + 进度弹窗。每页都调，返回 dispose。
 *
 * Lv 弹层**不是** `<dialog>.show()`：非模态 dialog 不派发 `cancel` 事件，
 * Esc 根本不会关（只有 showModal 才有）。所以是 `div[role=dialog]` + 自己绑 keydown。
 */
export function mountTopbar(root: ParentNode): Off {
  const bar = root.querySelector<HTMLElement>('.topbar');
  const pop = root.querySelector<HTMLElement>('#lvpop');
  const trig = bar?.querySelector<HTMLElement>('#lvTrig') ?? null;
  const offs: Off[] = [];

  const on = (el: EventTarget | null, ev: string, fn: EventListener) => {
    if (!el) return;
    el.addEventListener(ev, fn);
    offs.push(() => el.removeEventListener(ev, fn));
  };

  /* ---- Lv 弹层 ---- */
  if (pop && trig) {
    const body = pop.querySelector<HTMLElement>('[data-slot="body"]');
    const isOpen = () => !pop.hidden;
    const close = (focus: boolean) => {
      if (!isOpen()) return;
      pop.hidden = true;
      trig.setAttribute('aria-expanded', 'false');
      if (focus) trig.focus();
    };
    const open = () => {
      if (body) body.innerHTML = levelBody();
      pop.hidden = false;
      trig.setAttribute('aria-expanded', 'true');
      centerCurrent(pop);
      body?.focus({ preventScroll: true });
    };

    on(trig, 'click', (e) => {
      e.preventDefault();
      if (isOpen()) close(true);
      else open();
    });
    on(pop.querySelector('.popx'), 'click', (e) => {
      e.preventDefault();
      close(true);
    });
    // Esc：非模态 dialog 不会给 cancel，只能自己听
    on(document, 'keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Escape' || !isOpen()) return;
      e.preventDefault();
      close(true);
    });
    // 点外部关闭：pointerdown 而不是 click —— 按住拖选到弹层外时不该关
    on(document, 'pointerdown', (e) => {
      const t = e.target as Node | null;
      if (!t || pop.contains(t) || trig.contains(t)) return;
      close(false);
    });

    offs.push(() => { pop.hidden = true; trig.setAttribute('aria-expanded', 'false'); });
  }

  /* ---- 进度弹窗 ---- */
  const dlg = root.querySelector<HTMLDialogElement>('#saveDlg');
  if (dlg) {
    on(root.querySelector('#btnSave'), 'click', () => dlg.showModal());
    on(root.querySelector('#saveClose'), 'click', () => dlg.close());

    on(root.querySelector('#btnExport'), 'click', () => {
      void import('./store').then((m) => {
        const blob = new Blob([m.exportJson()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `懒猫五笔-存档-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        dlg.close();
      });
    });

    on(root.querySelector('#btnImport'), 'click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        if (!confirm('导入会覆盖当前进度，继续？')) return;
        // 顶栏与卡片全站读同一份数据，导完直接重载：不留半页旧 DOM，也不必写两套刷新
        const m = await import('./store');
        if (m.importJson(text)) location.reload();
        else alert('这个文件读不出来，可能不是本项目的存档。');
      });
      input.click();
    });

    on(root.querySelector('#btnReset'), 'click', () => {
      if (!confirm('清空所有进度和自定义卡片？此操作不可撤销。')) return;
      void import('./store').then((m) => {
        m.resetAll();
        location.reload();
      });
    });
  }

  return () => { for (const off of offs) off(); };
}

/**
 * 练习中局部刷新顶栏数字（不重建 DOM，避免闪）。
 *
 * 经验条也要跟着走：打对一个字经验 +1，条子每 250ms 涨一点 ——
 * 只刷新 Lv 文字的话，整卡练完没升级，那条子会一直停在进页面时的位置。
 */
export function refreshTopbar(root: ParentNode): void {
  const bar = root.querySelector('.topbar');
  if (!bar) return;
  const p = load();
  const lvEl = bar.querySelector('.lv');
  if (lvEl) lvEl.textContent = `Lv.${levelOf(p.xp)}`;
  // 整块重建而不是只改一个 number：时长段有「不显示 / 分 / 小时」三种形态，
  // 逐段 find 再分别改会在这里长出一棵 DOM 补丁树。整块只有 3–5 个节点。
  // 但只在读数真的变了才重建 —— 练习页每打对一个字都会调这里。
  const accum = bar.querySelector<HTMLElement>('.accum');
  const sig = `${p.totalPracticeMs}|${p.totalChars}`;
  if (accum && accum.dataset.sig !== sig) {
    accum.innerHTML = accumHTML(p);
    accum.dataset.sig = sig;
  }

  const barEl = bar.querySelector<HTMLElement>('.lvbar');
  if (barEl) {
    const prog = progressInLevel(p.xp);
    const pct = prog.isMax ? 100 : Math.max(0, Math.min(1, prog.ratio)) * 100;
    const fill = barEl.querySelector<HTMLElement>('i');
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    barEl.setAttribute('aria-valuenow', String(Math.round(pct)));
    const label = prog.isMax
      ? `Lv.${prog.level} 已满级`
      : `Lv.${prog.level} 经验 ${prog.into.toLocaleString('zh-CN')} / ${prog.need.toLocaleString('zh-CN')}`;
    barEl.title = label;
    const numEl = bar.parentElement?.querySelector('.lvnum') ?? null;
    if (numEl) {
      numEl.textContent = prog.isMax
        ? '已满级'
        : `${prog.into.toLocaleString('zh-CN')} / ${prog.need.toLocaleString('zh-CN')}`;
      numEl.setAttribute('title', label);
    }
  }
}
