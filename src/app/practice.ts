/**
 * app/practice.ts — 练习页。
 *
 * 负责：题面 / 输入 / 屏幕键盘 / 图解 / 时长与状态机，并把打对写进存档。
 * 不负责：主页（main.ts）、经验曲线（core/xp）。
 * 调用方：main.ts
 *
 * 两种作答方式，不能一套通吃：
 *   · 字根卡：物理按键作答 + 下方 25 键屏幕键盘，不经过输入法。
 *   · 单字 / 词组卡：可见输入框，任意输入法上屏即判。
 *
 * 时长（3 / 10 / 25 / 60 分钟）是「今天练多久」的单位，到点切一轮、不结束本卡。
 */

import {
  createMatcher,
  createQueue,
  queueFromSnapshot,
  createTimer,
  formatElapsed,
  type Matcher,
  type SrsQueue,
  type Timer,
} from '../core';
import {
  itemIds,
  rootsByKey,
  splitsOf,
  unitOf,
  wordCode,
  type Unit,
} from './data';
import type { Card, CharRecord, RootItem } from '../core/types';
import { addPractice, addPracticeTime, cardChars, queueSnap, saveQueue } from './store';
import { settlePractice, type SettleResult } from './settle';
import { toast } from './toast';
import { mountTopbar, refreshTopbar, topbarHTML } from './topbar';
import { loadStrokes, segCount, strokeFigure } from './strokes';
import { charDetailHTML } from './charview';
import { KEY_BY_LETTER, KEY_ROWS } from './keys';

export interface PracticeHandle {
  destroy(): void;
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const LATIN = /[a-zA-Z]/;
const SESSIONS = [3, 10, 25, 60];
/** 键帽「答对」闪烁的时长；提示态（`.hint`）与它共用一个撤除时刻。 */
const FLASH_MS = 170;
/**
 * 字根提示的撤除总时长：口诀 80ms 走完，字母行延迟 60ms 再走 120ms = 180。
 * 字在这之后才清（见 renderRootCodes），否则没有内容可淡。
 */
const CODES_OUT_MS = 180;

const KEY_ZONE: Record<string, number> = {
  g: 1, f: 1, d: 1, s: 1, a: 1,
  h: 2, j: 2, k: 2, l: 2, m: 2,
  t: 3, r: 3, e: 3, w: 3, q: 3,
  y: 4, u: 4, i: 4, o: 4, p: 4,
  n: 5, b: 5, v: 5, c: 5, x: 5,
};

export function mountPractice(root: HTMLElement, card: Card, onExit: () => void): PracticeHandle {
  const rootsMode = card.kind === 'roots';
  /** 目前所有卡都是严格模式（答错即挡，不让它顺着错下去）。 */
  const strict = true;

  /**
   * 出题队列：**必须先读快照再建**。
   *
   * 熟练度是跨会话累计的：进卡先取快照，取不到才用 seed 新建。
   * 新建时用卡 id 当 seed，同一张卡的出题顺序因此固定可复现。
   */
  const queueIds = itemIds(card);
  const savedQueue = queueSnap(card.id);
  const queue: SrsQueue = savedQueue
    ? queueFromSnapshot(queueIds, savedQueue).queue
    : createQueue(queueIds, { seed: card.id });

  /**
   * 进来那一刻的累计答题数。
   *
   * `queue.progress().answers` 现在是**跨会话累计**的（快照会存它），
   * 如果直接拿它当「本次答题」，第二次结算就会把历史次数再加一遍。
   * 所有对外口径都取差值。
   */
  let answersAtStart = queue.progress().answers;

  /** 本次答对了几题（结算与结算浮层都用这个）。 */
  function sessionAnswers(): number {
    return Math.max(0, queue.progress().answers - answersAtStart);
  }

  /** 每次作答后立刻落一份快照（store 有 2s 节流，不会每键写盘）。 */
  function persistQueue(): void {
    saveQueue(card.id, queue.snapshot());
  }

  let unit: Unit | null = null;
  let matcher: Matcher = createMatcher('', 'follow');
  const wrongPos = new Set<number>();
  let hintOpen = false;
  let hintKey = '';
  let strokesReady = false;
  let sessionMs = 10 * 60_000;

  root.innerHTML = `
    <div class="pc mode-item${rootsMode ? ' mode-roots' : ''}">
      ${topbarHTML()}
      <main class="stage">
        <div class="session" id="session">
          <span class="cname-sm" title="${card.title}">${card.title}</span>
          <span class="slabel">练习时长</span>
          <span class="sopts" id="sopts">
            ${SESSIONS.map((m) => `<button class="sopt" data-min="${m}" type="button">${m} 分</button>`).join('')}
          </span>
          <span class="sremain" id="sremain">10:00</span>
          <span class="sbar"><i id="sbar"></i></span>
          <button class="backbtn" id="pBack" type="button" aria-label="返回主页">← 返回</button>
        </div>

        <div class="paper" id="paper">
          <div class="item" id="item" hidden>
            <div class="bigwrap" id="bigwrap"></div>
            <div class="codes${rootsMode ? ' roots' : ''}" id="codes" aria-hidden="true"></div>
          </div>
          <div class="kb" id="kb" hidden></div>
        </div>

        <div class="typebar" id="typebar" ${rootsMode ? 'hidden' : ''}>
          <input class="typebox" id="tin" type="text" autocomplete="off" autocorrect="off"
            autocapitalize="off" spellcheck="false" inputmode="text" aria-label="在这里打字">
          <div class="fb" id="fb"></div>
        </div>
        <div class="fb standalone" id="fb2" hidden></div>

        <section class="hintp" id="hintp"${rootsMode ? ' hidden' : ''}>
          <button class="hintbar" id="hintbar" type="button" aria-expanded="false">
            <span id="hintbarTx">查看拆解</span><em>Tab</em>
            <svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <div class="hintbody" id="hintbody"></div>
        </section>
      </main>

      <footer class="pfoot">
        <span class="fp" id="fp">—</span>
        <div class="bar"><i id="fbar"></i></div>
        <span class="keys" id="fkeys">${rootsMode ? 'Esc 暂停 · 直接按字母键' : 'Esc 暂停 · Tab 图解 · ⌫ 回删'}</span>
      </footer>

      <div class="resthint" id="resthint" role="status" aria-live="polite" hidden>
        已练 20 分钟 · 看看 6 米外 20 秒
      </div>

      <div class="ov" id="ovPause" hidden>
        <div class="ovbox">
          <h2>已暂停</h2>
          <p class="ovmeta" id="ovPauseMeta"></p>
          <div class="ovrow">
            <button class="btn primary" id="btnResume">继续</button>
            <button class="btn" id="btnGiveUp">放弃本卡</button>
          </div>
        </div>
      </div>

      <!-- 轮次结束 / 本卡结算：**同一个浮层**的两态。
           到点只切轮、不结束本卡；「结束本卡」不换浮层，只在同一只盒子里换成结算态 ——
           两只全屏浮层互相顶替时，背板会连闪两次、盒子宽度也差 60px。 -->
      <div class="ov" id="ovRound" hidden>
        <div class="ovbox ovround" id="ovRoundBox" role="dialog" aria-modal="true"
          aria-labelledby="ovrTitle" aria-describedby="ovrMeta" tabindex="-1">
          <button class="ghost rnd-x" id="btnRoundClose" type="button" aria-label="关闭并继续">✕</button>
          <h2 id="ovrTitle">第 1 轮结束</h2>
          <p class="ovr-meta" id="ovrMeta"></p>
          <div class="ovfade" id="ovrFade">
            <!-- 两态共用一张网格：切态只换标题和按钮，数字的位置一格都不动。
                 轮次态给「本轮 / 本卡」两组数，结算态给「本次」那组 —— 都是 7 格，
                 所以盒子高度不会跳。 -->
            <div class="ovr-slot">
              <div class="resgrid" id="resGrid"></div>
            </div>
            <div class="ovrow" id="ovrRowRound">
              <button class="btn primary" id="btnRoundAgain" type="button">继续下一轮</button>
              <button class="btn" id="btnRoundEnd" type="button">结束本卡</button>
            </div>
            <div class="ovrow" id="ovrRowResult" hidden>
              <button class="btn primary" id="btnAgain" type="button">再打一次</button>
              <button class="btn" id="btnBack" type="button">返回</button>
            </div>
          </div>
        </div>
      </div>

      <dialog class="kbdialog" id="kbDlg">
        <div class="kbhead">
          <span>键位速查</span>
          <button class="ghost" id="kbClose" aria-label="关闭">✕</button>
        </div>
        <div class="kbdetail" id="kbDetail"></div>
      </dialog>
    </div>
  `;

  const q = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  const elItem = q('item');
  const elBig = q('bigwrap');
  const elCodes = q('codes');
  const elPaper = q('paper');
  const elKb = q('kb');
  const elTypebar = root.querySelector('#typebar') as HTMLElement | null;
  const elFb = q('fb');
  const elFb2 = q('fb2');
  const elTin = q('tin') as unknown as HTMLInputElement;
  const elHint = q('hintp');
  const elHintBody = q('hintbody');
  const elFkeys = root.querySelector('#fkeys') as HTMLElement | null;
  const elRest = root.querySelector('#resthint') as HTMLElement | null;
  /** 休息提示只出一次：出过就不再出（不然每 20 分钟弹一次等于噪音）。 */
  let restShown = false;
  const sOpts = q('sopts');
  const sRemain = q('sremain');
  const sBar = q('sbar') as HTMLElement;
  const fp = q('fp');
  const fbar = q('fbar') as HTMLElement;
  const ovPause = q('ovPause');
  const ovRound = q('ovRound');
  const ovBox = q('ovRoundBox');
  const ovFade = q('ovrFade');
  const sessionEl = q('session');
  const kbDlg = q('kbDlg') as unknown as HTMLDialogElement;

  /* ---------- 状态 ---------- */

  type Phase = 'ready' | 'running' | 'paused' | 'finished';
  let phase: Phase = 'ready';
  let keystrokes = 0;
  let correctAll = 0;
  let wrongAll = 0;
  let statCorrect = 0;
  let statWrong = 0;
  let sessionLeft = sessionMs;
  /**
   * 换档后的「下一轮档位」。本轮进行中改档不立刻生效 ——
   * 否则剩余时间会在用户眼皮下从 04:12 跳成 01:02，进度条跟着倒流。
   */
  let pendingSessionMs: number | null = null;

  /* ---------- 轮次（倒计时到点只切轮，不结束本卡） ---------- */

  /** 当前第几轮，从 1 起。 */
  let round = 1;
  /** 本轮到底、弹窗已经弹过一次。置 true 后 `updateSession()` 不再复弹。 */
  let roundEnded = false;
  /** 本轮起点的计时读数：之后 `used = elapsed - roundBase`。 */
  let roundBase = 0;
  /** 本轮起点的字数增量基准（结算里「本轮」取的是差值，不是本卡累计）。 */
  let roundBaseCorrect = 0;
  let roundBaseWrong = 0;
  /** 弹窗开着时把计时冻住（用户读弹窗的时间不该算进任何一轮）。 */
  let roundFrozen = false;

  let timer: Timer = createTimer();

  /* ---------- 合并浮层（轮次结束 / 本卡结算） ---------- */

  type OvState = 'round' | 'result';
  let ovState: OvState = 'round';

  /** 归零后延迟显示浮层：最后几个字常常正好压在归零那一刻，浮层立刻出现会被当成「下一页」。 */
  const ROUND_REVEAL_MS = 240;
  /** 浮层出现后按钮的静默期：这段时间里的 Enter / Space 一定是「还在打字」的余波。 */
  const OV_LOCK_MS = 400;
  /** 两态交叉淡入的半步（出 80ms + 入 80ms = 160ms，与 --t-0 同源）。 */
  const OV_FADE_STEP_MS = 80;

  let revealTimer = 0;
  let lockTimer = 0;
  let fadeTimer = 0;
  /** 浮层在场、按钮还没解锁：所有激活都被吞掉（含程序化 click）。 */
  let ovLocked = false;
  /** 归零到浮层出现之间：这一段里的击键既不属于第 N 轮，也不属于第 N+1 轮。 */
  let roundSettling = false;


  // 字根卡没有输入区（不走输入法），提示走纸下方那一行独立的 fb。
  function fb(text: string, tone: '' | 'ok' | 'bad' = '') {
    const standalone = rootsMode || !elTypebar || elTypebar.hidden;
    const el = standalone ? elFb2 : elFb;
    if (standalone) elFb2.hidden = false;
    el.textContent = text;
    el.className = `fb${standalone ? ' standalone' : ''}${tone ? ' ' + tone : ''}`;
  }

  /* ---------- 屏幕键盘（字根卡） ---------- */

  if (rootsMode) {
    elKb.hidden = false;
    elKb.innerHTML = KEY_ROWS.map((row) => `
      <div class="kbrow">${row.map((k) => {
        const def = KEY_BY_LETTER.get(k);
        // Z 是万能键，没有字根也没有口诀，单独标出来，不占区色。
        if (!def) {
          return `<button class="key z0" data-k="${k}" type="button"><span>${k}</span><em>万能</em></button>`;
        }
        return `<button class="key z${def.zone}" data-k="${k}" type="button"
          title="点击查看 ${k} 键的全部字根">
          <span>${k}</span><em>${def.code}</em>
        </button>`;
      }).join('')}</div>`).join('') + `
      <div class="kbfoot">
        <span class="kbtip">直接按字母键作答 · 点键帽查这个键有哪些字根 · Z 是万能键</span>
      </div>`;

    // 点键帽 = 查该键字根（原版注释：没人会用鼠标打字，所以键帽不复制作答）
    elKb.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.key') as HTMLElement | null;
      if (btn?.dataset.k) openKeyDetail(btn.dataset.k);
    });
  }

  function flashKey(k: string, ok: boolean) {
    const btn = elKb.querySelector(`.key[data-k="${k}"]`) as HTMLElement | null;
    if (!btn) return;
    btn.classList.add(ok ? 'ok' : 'bad');
    window.setTimeout(() => btn.classList.remove('ok', 'bad'), FLASH_MS);
  }

  /** 点键帽：弹出这个键的全部字根；再点同一个键收起（原版 openKbHelp 同款）。 */
  let kbKey: string | null = null;
  function openKeyDetail(k: string) {
    const def = KEY_BY_LETTER.get(k);
    if (!def) { fb('Z 是万能键，不对应任何字根'); return; }
    if (kbDlg.open && kbKey === k) { kbDlg.close(); return; }

    kbKey = k;
    const roots = rootsByKey(k);
    const curId = unit?.root?.id ?? '';
    const isHere = roots.some((r) => r.id === curId);

    kbDlg.style.setProperty('--gc', `var(--zone-${def.zone})`);
    q('kbDetail').innerHTML = `
      <div class="kdhead">
        <b>${k}</b>
        <span class="kdname">${def.name}</span>
        <span class="kdcode">${def.code}</span>
      </div>
      <div class="kdmn">${def.mn}</div>
      <div class="kdroots">${roots.map((r) => `
        <div class="kdroot${r.id === curId ? ' cur' : ''}" title="${r.name || r.glyph || ''}">
          ${r.path ? `<svg viewBox="0 0 100 100"><path d="${r.path}"/></svg>` : `<b>${r.glyph || r.key}</b>`}
          <i>${r.id === curId ? '这是本题' : ''}</i>
        </div>`).join('')}</div>
      <div class="kdnote">${isHere ? '描边那个就是这道题' : `${def.name}键 · 共 ${roots.length} 个字根`}</div>`;

    if (!kbDlg.open) kbDlg.showModal();
  }

  /* ---------- 装载 ---------- */

  function loadItem() {
    const it = queue.peek();
    // 题库打完：提示态要一起收掉，否则最后一颗键的高亮会留在结算浮层背后
    if (!it) { setKeyHint(null); return finish(); }
    unit = unitOf(it.id);
    // 拿不到题面（数据里没有这条）就跳过它；跳过也算推进队列，同样要落快照，
    // 否则下次进来还会在同一道空题上转圈。
    if (!unit) { queue.answer(true); persistQueue(); return loadItem(); }

    elItem.hidden = false;

    /**
     * 字根图形**不上区色**，和单字卡同一个读数色：
     * 它是要盯着看一晚上的对象，跟着区换色只会让人眼累。
     * 区色留给键盘、键位方块和键帽提示，那里看一秒就够。
     */
    if (unit.root) {
      const r = unit.root;
      elBig.innerHTML = r.path
        ? `<svg viewBox="0 0 100 100" class="rglyph" aria-hidden="true"><path d="${r.path}"/></svg>`
        : `<span class="rglyph-text">${r.glyph || r.key}</span>`;
    } else {
      const n = Array.from(unit.target).length;
      const cls = n === 2 ? ' w2' : n === 3 ? ' w3' : n >= 4 ? ' w4' : '';
      elBig.innerHTML = `<span class="bigchar${cls}">${unit.target}</span>`;
    }

    renderCodes(strict && (it.count < 0 || it.failed));

    matcher = createMatcher(unit.target, 'strict');
    afterLoad();
  }

  function renderCodes(show: boolean) {
    if (rootsMode) {
      renderRootCodes(show);
      return;
    }
    if (!show || !unit) { elCodes.textContent = ''; elCodes.classList.remove('on'); return; }
    let text = '';
    if (unit.char) text = unit.char.codes.join('  ');
    else if (unit.word) text = wordCode(unit.word);
    else if (unit.root) text = unit.root.key.toLowerCase();
    elCodes.textContent = text;
    elCodes.classList.add('on');
  }

  /**
   * 字根卡的键位提示：`G 王` +（生字才有）一行口诀，同时点亮键盘上那颗键。
   *
   * 三种状态，界面只认这一处：
   *   · 从没答对过（count < 0）：字母 + 键名 + 口诀 —— 第一次见到这个字根的人
   *     要的是「为什么是 G」，光给键位等于让他背 25 个键；
   *   · 答对过又答错（failed && count ≥ 0）：只给字母 + 键名 —— 口诀他见过，
   *     此刻挡住键位反而要重新找；
   *   · 其余：整块留空（高度照占，见 style.css 的 .codes.roots）。
   */
  function renderRootCodes(show: boolean) {
    const r = unit?.root;
    const letter = (r?.key ?? '').toUpperCase();
    const def = KEY_BY_LETTER.get(letter);
    const it = queue.peek();
    const valid = show && !!def;

    // 两段结构只建一次：每次重建的节点在当前帧还没有「opacity: 0」的历史，
    // 同一帧再加 `.on` 会直接跳到终态 —— 淡入根本跑不起来。
    const built = !codesBuilt;
    if (built) {
      elCodes.innerHTML =
        '<span class="cr-keys"><b class="cr-k"></b><span class="cr-name"></span></span>' +
        '<span class="cr-mn"></span>';
      codesBuilt = true;
    }
    const elK = elCodes.querySelector('.cr-k') as HTMLElement;
    const elName = elCodes.querySelector('.cr-name') as HTMLElement;
    const elMn = elCodes.querySelector('.cr-mn') as HTMLElement;

    // 上一次的「淡出结束后清字」还没跑，就先取消 —— 否则它会把新内容清掉
    window.clearTimeout(codesOffTimer);
    codesOffTimer = 0;

    if (!valid) {
      // 已经空着就不用再排一次撤除（答错时这条路径每敲一个错键都会走一遍）
      if (!elCodes.classList.contains('on')) return;
      elCodes.classList.remove('on');
      /**
       * 字**在淡出之后**才清：口诀 80ms 先走、字母行延迟 60ms 再走 120ms。
       * 同一帧清 innerHTML 等于没有内容可淡 —— 整块会直接消失，
       * 那两条 transition 就成了摆设。
       */
      codesOffTimer = window.setTimeout(() => {
        codesOffTimer = 0;
        if (elCodes.classList.contains('on')) return;
        elK.textContent = '';
        elName.textContent = '';
        elMn.textContent = '';
      }, CODES_OUT_MS);
      setKeyHint(null);
      return;
    }

    elK.textContent = letter;
    elName.textContent = def.name;
    // 口诀只跟「生字」走，不跟「答错」走：答错只需键位。
    elMn.textContent = it && it.count < 0 ? def.mn : '';
    // 刚建好的那一帧补一次样式结算，让淡入有起点可过渡（一次性，每页只发生一次）
    if (built) void elCodes.offsetWidth;
    elCodes.classList.add('on');
    setKeyHint(letter);
  }

  /** 当前带 `.hint` 的那颗键（大写字母，空串 = 没有）。 */
  let hintLetter = '';
  /** 提示态延迟撤除的定时器（见 setKeyHint）。 */
  let hintOffTimer = 0;
  /** 字根提示的两段结构是否已经建好（只建一次，见 renderRootCodes）。 */
  let codesBuilt = false;
  /** 「淡出结束后再清字」的定时器。 */
  let codesOffTimer = 0;

  function keyEl(k: string): HTMLElement | null {
    return elKb.querySelector(`.key[data-k="${k}"]`) as HTMLElement | null;
  }

  /**
   * 点亮 / 熄灭屏幕键盘上的提示键。
   *
   * 熄灭有两条路，差别只在于这颗键是不是刚刚被判对：
   *   · 普通换题 —— 立刻撤，新键立刻亮；
   *   · 刚判对（还挂着 `.ok`）—— 交给同一个 170ms 定时器。
   *     提前撤会让这颗键「先把光晕掉光、描边还亮着」，读起来像闪了两下；
   *     规格要的是 `.ok` 与 `.hint` 同一帧一起撤。
   */
  function setKeyHint(letter: string | null) {
    const next = (letter ?? '').toUpperCase();
    if (next === hintLetter) return;
    const prev = hintLetter;
    hintLetter = next;
    window.clearTimeout(hintOffTimer);
    hintOffTimer = 0;
    if (prev) {
      const btn = keyEl(prev);
      if (btn && btn.classList.contains('ok')) {
        hintOffTimer = window.setTimeout(() => btn.classList.remove('hint'), FLASH_MS);
      } else {
        btn?.classList.remove('hint');
      }
    }
    if (next) keyEl(next)?.classList.add('hint');
  }

  /** 下一次按键就把休息提示收起来（它已经完成了提醒的职责，不该一直挂着）。 */
  function dismissRest() {
    if (!elRest || elRest.hidden) return;
    elRest.classList.remove('on');
    window.setTimeout(() => { if (elRest) elRest.hidden = true; }, 300);
  }

  function afterLoad() {
    elTin.value = '';
    statCorrect = 0;
    statWrong = 0;
    hintKey = '';
    wrongPos.clear();
    if (rootsMode) {
      fb('按这个字根所在的键');
    } else {
      fb('用任意输入法打出上面的字，上屏自动判定');
    }
    refreshMeters();
    updateSession();
    renderHint();
    refreshTopbar(root);
    focusInput();
  }

  /* ---------- 图解 ---------- */

  function setHint(open: boolean) {
    hintOpen = open;
    elHint.classList.toggle('open', open);
    q('hintbar').setAttribute('aria-expanded', open ? 'true' : 'false');
    q('hintbarTx').textContent = open ? '收起' : '查看拆解';
    if (open) renderHint(true);
    /**
     * 展开后把整条拆解滚进视野。
     *
     * 拆解条是 `.stage` 的最后一个子项，高度约 340；900 高的窗口里它正好落在
     * 底线以上，768 的窗口里就会超出舞台 —— 舞台现在是 `overflow-y:auto`
     * （不会再被底栏盖住），但如果用户看不见字根表的最后两行，等于还是被盖住了。
     *
     * 量两次：两个 rAF 之后布局才结算（`.open` 刚把 display 从 none 改回 block，
     * 同一帧里量到的是旧值）；再补一个 180ms 的定时，是因为字根图是异步加载的，
     * 加载完成后拆解条会再长高一截。
     */
    const box = elHint.parentElement as HTMLElement | null;
    const reveal = () => {
      if (!box) return;
      const over = elHint.getBoundingClientRect().bottom - (box.getBoundingClientRect().bottom - 12);
      if (over > 0) box.scrollTop += over;
    };
    if (open) {
      requestAnimationFrame(() => requestAnimationFrame(reveal));
      window.setTimeout(reveal, 180);
    } else if (box) {
      box.scrollTop = 0;
    }
  }

  function renderHint(force = false) {
    if (!hintOpen) return;
    const key = `${matcher.index}|${unit?.id ?? ''}`;
    if (!force && key === hintKey) return;
    hintKey = key;

    if (!strokesReady) {
      elHintBody.innerHTML = '<div class="hint-empty">拆解图加载中…</div>';
      void loadStrokes().then((ok) => {
        strokesReady = ok;
        if (hintOpen) { hintKey = ''; renderHint(true); }
      });
      return;
    }

    if (unit?.char) { elHintBody.innerHTML = charHint(unit.char); return; }
    if (unit?.word) { elHintBody.innerHTML = wordHint(unit.word); return; }
    if (unit?.root) { elHintBody.innerHTML = rootHint(unit.root); return; }
    elHintBody.innerHTML = '';
  }

  function charHint(rec: CharRecord) {
    return charDetailHTML(rec);
  }

  function wordHint(word: string) {
    const code = wordCode(word);
    const chars = Array.from(word);
    const plan = chars.length === 2 ? [[0, 0], [0, 1], [1, 0], [1, 1]]
      : chars.length === 3 ? [[0, 0], [1, 0], [2, 0], [2, 1]]
      : chars.length === 4 ? [[0, 0], [1, 0], [2, 0], [3, 0]]
      : [];
    const boxes = chars.map((ch, ci) => {
      const rec = unitOf(`char:${ch}`)?.char;
      const slots = plan.filter((p) => p[0] === ci).map((p) => (p[1] ?? 0) + 1);
      const keys = plan.map((p, k) => (p[0] === ci ? (code.charAt(k) || '').toUpperCase() : '')).filter(Boolean);
      const rootCount = rec ? splitsOf(rec).filter((c) => c.kind === 'root').length : 0;
      const fig = rec && slots.length && segCount(ch) === rootCount ? strokeFigure(ch, slots) : null;
      return `<div class="wcell">
        <div class="wbox">${fig ? fig.svg : `<b>${ch}</b>`}</div>
        <div class="wkeys">${keys.map((k, i) => `<span class="k${slots[i] ?? 1}">${k}</span>`).join('')}</div>
      </div>`;
    }).join('');
    return `<div class="hintmeta">${code || '—'} · ${chars.length} 字词</div>
      <div class="wgrid">${boxes}</div>
      <div class="hintfoot">颜色 = 这个字的第几码；灰笔画 = 没取到的部分</div>`;
  }

  function rootHint(r: RootItem) {
    const zone = r.zone || KEY_ZONE[r.key.toLowerCase()] || 0;
    return `<div class="hintmeta">第 ${zone} 区 · ${r.kind === 'shortcode' ? '一级简码' : '字根'}</div>
      <div class="hintrow">
        <div class="wbox">${r.path ? `<svg viewBox="0 0 100 100"><path d="${r.path}"/></svg>` : `<b>${r.glyph || r.key}</b>`}</div>
        <ul class="legend"><li class="l${zone}"><i></i><b>${r.name || '字根'}</b><em>${r.key}</em></li></ul>
      </div>`;
  }

  /* ---------- 输入 ---------- */

  let composing = false;

  function firstChar(raw: string, allowLetter: boolean): string | null {
    for (const ch of raw) {
      if (CJK.test(ch)) return ch;
      if (allowLetter && LATIN.test(ch)) return ch.toLowerCase();
    }
    return null;
  }

  function cjkOnly(raw: string): string {
    let out = '';
    for (const ch of raw) if (CJK.test(ch)) out += ch;
    return out;
  }

  function onCommit() {
    if (phase === 'finished' || phase === 'paused') return;
    // 归零那一刻到浮层出现之间，以及浮层在场的整段时间：不判题、不计数。
    // 用户还在按上屏键，那些字既不属于刚结束的这一轮，也不属于下一轮。
    if (keysToOverlay()) return;
    const raw = elTin.value;
    if (!raw) return;

    const target = unit?.target ?? '';
    if (target.length > 1) {
      const typed = cjkOnly(raw);
      if (!typed) return;
      if (target.startsWith(typed) && typed.length < target.length) {
        fb('对了一个字，接着打');
        return;
      }
      elTin.value = '';
      feedText(typed);
      return;
    }

    const ch = firstChar(raw, !!unit?.root);
    if (!ch) { fb('输入法现在是英文状态，切到中文再打', 'bad'); return; }
    elTin.value = '';
    feedText(ch);
  }

  /** 字根卡：直接按字母（不走输入法），点键帽也走这里。 */
  function answerKey(letter: string) {
    if (phase === 'finished' || phase === 'paused') return;
    if (keysToOverlay()) return;
    const k = letter.toUpperCase();
    if (k === 'Z') { fb('Z 是万能键，不参与字根练习'); return; }
    feedText(k.toLowerCase());
  }

  function feedText(txt: string) {
    /**
     * 判题前先看一眼倒计时。
     *
     * 归零是 `hudTimer`（250ms 一轮）发现的，那最多 250ms 里的上屏会落到
     * 「已经结束的这一轮」上 —— 用户按的还是同一口气，字却记进了上一轮。
     * 这里按实时读数补一刀：到点就地开浮层（冻结 + 吞键），这一次击键直接丢掉。
     * `roundEnded` 之后不再判（Esc 关窗继续打时，字照旧记在本卡上）。
     */
    if (!roundEnded && phase === 'running' && timer.elapsedMs() - roundBase >= sessionMs) {
      openRoundEnd();
      return;
    }

    let added = 0;
    for (const ch of txt) {
      if (matcher.done) break;
      if (phase === 'ready') start();
      const r = matcher.commit(ch);
      if (r.consumed === 0) break;

      const c = r.stats.correctChars;
      const w = r.stats.wrongChars + r.stats.wrongPunct;
      const dc = Math.max(0, c - statCorrect);
      const dw = Math.max(0, w - statWrong);
      correctAll += dc;
      wrongAll += dw;
      added += dc;
      statCorrect = c;
      statWrong = w;

      if (rootsMode) flashKey(ch.toUpperCase(), r.correct);

      if (r.blocked) {
        // 标记必须写在队列内部：`peek()` 给的是副本，改它等于改一个用完就丢的对象
        // （原来就是这么写的，于是「答错也显示提示」从来没生效过）。
        queue.markFailed();
        renderCodes(true);
        fb(unit?.root ? '键位不对，再试一次' : '打错了，再打一次', 'bad');
        break;
      }

      if (r.done) {
        if (added > 0) { addPractice(card.id, added); refreshTopbar(root); }
        endItem();
        return;
      }
    }

    if (added > 0) {
      addPractice(card.id, added);
      refreshTopbar(root);
    }

    if (unit) {
      renderHint();
    }
    refreshMeters();
  }

  function endItem() {
    const it = queue.peek();
    if (it) queue.answer(true);
    // 答完立刻存：中途退出、关标签页也不会把这次熟练度丢掉。
    persistQueue();
    if (!queue.peek()) return finish();
    fb('对了', 'ok');
    loadItem();
    // 这一行不能省：答题分支是 `return` 走的，原本不会经过 feedText 末尾的
    // refreshMeters()，于是「练过」要等 250ms 的 HUD 定时器才跳 —— 看起来像没记上。
    refreshMeters();
  }

  /* ---------- 时长 / 数据 ---------- */

  function start() {
    if (phase !== 'ready') return;
    phase = 'running';
    timer.start();
    sessionLeft = sessionMs;
    updateSession();
  }

  /**
   * 刷新时长条。
   *
   * `used` 是**本轮**已用（`elapsed - roundBase`），不是整卡的 —— 否则点「再练」
   * 之后条子会停满格不动。到点也不 `finish()`，只弹「轮次结束」：
   * 用户选的是「练 25 分钟」，不是「25 分钟后这张卡就锁死」。
   */
  function updateSession() {
    if (!sRemain) return;
    const elapsed = phase === 'ready' ? 0 : timer.elapsedMs();
    const used = Math.max(0, elapsed - roundBase);
    sessionLeft = Math.max(0, sessionMs - used);
    sRemain.textContent = formatElapsed(sessionLeft);
    if (sBar) sBar.style.width = `${Math.min(100, (used / Math.max(1, sessionMs)) * 100)}%`;
    sRemain.classList.toggle('low', sessionLeft <= 30_000 && sessionLeft > 0);
    // 00:00 转金色：它不是「快没时间了」，而是「本轮已经用完」（--neon-magenta 留给 .low）
    sessionEl?.classList.toggle('ended', sessionLeft === 0);
    if (sessionLeft === 0 && phase === 'running' && !roundEnded) openRoundEnd();
  }

  /** 本轮统计 = 从本轮起点到现在的增量（不是本卡累计）。 */
  function roundStats() {
    const correct = Math.max(0, correctAll - roundBaseCorrect);
    const wrong = Math.max(0, wrongAll - roundBaseWrong);
    const ms = Math.max(0, timer.elapsedMs() - roundBase);
    const eff = correct + wrong;
    return {
      eff,
      correct,
      // 一个字都没打的轮次不报「0.0 字/分」——没数据就是没数据，和别处一样给 —。
      speed: eff > 0 && ms > 0 ? correct / (ms / 60_000) : null,
      acc: eff > 0 ? correct / eff : null,
    };
  }

  /* ---------- 合并浮层：显示 / 静默期 / 两态 ---------- */

  function overlayOpen(): boolean {
    return !ovRound.hidden;
  }

  /**
   * 键盘此刻归浮层管：归零后的 240ms 缓冲 + 浮层在场的整段时间。
   * 只有一条判据，判题入口（`onCommit` / `answerKey`）与键盘分支都用它 ——
   * 分成两个标志就一定会有一条路径忘记检查。
   */
  function keysToOverlay(): boolean {
    return roundSettling || overlayOpen();
  }

  function cancelReveal() {
    if (!revealTimer) return;
    window.clearTimeout(revealTimer);
    revealTimer = 0;
  }

  function cancelFade() {
    if (!fadeTimer) return;
    window.clearTimeout(fadeTimer);
    fadeTimer = 0;
    ovFade.classList.remove('is-out');
  }

  /** 状态一的三个激活点：两个按钮 + ✕。 */
  function ovCtrl(): HTMLButtonElement[] {
    return [
      q('btnRoundClose') as HTMLButtonElement,
      q('btnRoundAgain') as HTMLButtonElement,
      q('btnRoundEnd') as HTMLButtonElement,
    ];
  }

  /**
   * 400ms 静默期。
   *
   * `pointer-events:none` 只挡鼠标；焦点若落在按钮上，一个 Enter 照样走 click。
   * 所以真正的闸是 JS 里的 `ovLocked` —— 每个 handler 先看它，指针与键盘一起关。
   */
  function lockOv() {
    ovLocked = true;
    for (const b of ovCtrl()) {
      b.setAttribute('aria-disabled', 'true');
      b.style.pointerEvents = 'none';
    }
    window.clearTimeout(lockTimer);
    lockTimer = window.setTimeout(() => { lockTimer = 0; unlockOv(); }, OV_LOCK_MS);
  }

  function unlockOv() {
    ovLocked = false;
    for (const b of ovCtrl()) {
      b.removeAttribute('aria-disabled');
      b.style.pointerEvents = '';
    }
  }

  /** 立刻把盒子画成某一态（不做动画）。标题、meta、网格内容由调用方写。 */
  function paintOvState(next: OvState) {
    ovState = next;
    const isRound = next === 'round';
    q('ovrRowRound').hidden = !isRound;
    q('ovrRowResult').hidden = isRound;
    // 结算态没有 ✕：它是「这一页已经结束」，出口是两个按钮，不是一个叉
    q('btnRoundClose').hidden = !isRound;
  }

  /**
   * meta 行。
   *
   * 空字符串就直接把这一行收掉：留一个空 `<p>` 会白占一行高度，
   * 两态的高度就对不齐了 —— 这条槽的存在意义就是「零跳变」。
   */
  function setOvMeta(text: string) {
    const el = q('ovrMeta');
    el.textContent = text;
    el.hidden = !text;
  }

  /**
   * 切态。只做 opacity：旧内容 80ms 淡出、新内容 80ms 淡入。
   * 不做位移 —— 两态按钮行的宽度与文案都不同，一滑就会读成「盒子在抖」。
   */
  function setOvState(next: OvState, fade: boolean) {
    cancelFade();
    if (!fade) { paintOvState(next); return; }
    ovFade.classList.add('is-out');
    fadeTimer = window.setTimeout(() => {
      fadeTimer = 0;
      paintOvState(next);
      ovFade.classList.remove('is-out');
    }, OV_FADE_STEP_MS);
  }

  /** 显示浮层。焦点给盒子，**从不给按钮**（见 openRoundEnd 的注释）。 */
  function showOv(lock: boolean) {
    ovRound.hidden = false;
    ovBox.focus({ preventScroll: true });
    if (lock) lockOv(); else unlockOv();
  }

  /** 浮层里的 Tab 不穿透：在盒子内**当前真的看得见**的控件之间循环。 */
  function trapTab(back: boolean) {
    // 不能用 `el.hidden` 过滤：另一态的按钮挂在 `display:none` 的父行里，
    // 它自己的 hidden 属性是 false —— 焦点会落到一个看不见的按钮上，
    // 读起来就是「Tab 按了没反应」。按是否真的渲染出来判断。
    const items = Array.from(ovBox.querySelectorAll<HTMLElement>('button'))
      .filter((el) => el.getClientRects().length > 0 && el.getAttribute('aria-disabled') !== 'true');
    if (items.length === 0) { ovBox.focus({ preventScroll: true }); return; }
    const cur = document.activeElement as HTMLElement | null;
    const i = cur ? items.indexOf(cur) : -1;
    const last = items.length - 1;
    if (back) ovBoxFocus(i <= 0 ? items[last] : items[i - 1]);
    else ovBoxFocus(i === -1 || i === last ? items[0] : items[i + 1]);
  }

  function ovBoxFocus(el: HTMLElement | undefined) {
    (el ?? ovBox).focus({ preventScroll: true });
  }

  function openRoundEnd() {
    roundEnded = true;
    roundSettling = true;
    cancelReveal();
    // 冻住计时，且**立刻**进吞键态：`updateSession()` 是 250ms 一轮的，
    // 归零到浮层出现之间还有一段时间，这段里的上屏会被记进「已经结束的轮次」。
    if (timer.status === 'running') { timer.pause(); roundFrozen = true; }

    const st = roundStats();
    /**
     * 轮次态用和结算态同款的网格，不用一行说明。
     *
     * 原来那句「接着练会记在第 N 轮，本卡进度最后一起结算」是纯解释，占一行还留下
     * 一大片空白（看起来像内容没加载完）。这一轮到底发生了什么，四个数说得比它清楚。
     * 文案只写「继续下一轮」，不报分钟数 —— 行为是「从现在起重新计时，随时可以停」，
     * 写「再练 25 分钟」会被读成「必须再练满 25 分钟」。
     */
    /**
     * 轮次态的数字**和结算态一样多**（7 格）。原因：点「结束本卡」之后不再弹第二个
     * 窗口 —— 这一个窗口必须把「这次练成什么样」说完，缺项就得让用户回去自己算。
     *
     * 「本卡累计」要把还没结算的本次字数加进去，否则它比实际少一截。
     */
    const cardTotal = cardChars(card.id) + correctAll;
    const roundRows: Array<[string, string]> = [
      ['本轮用时', formatElapsed(Math.max(0, timer.elapsedMs() - roundBase))],
      ['本轮字数', `${st.eff.toLocaleString('zh-CN')} 字`],
      ['打错', `${st.eff - st.correct} 处`],
      ['速度', st.speed === null ? '—' : `${st.speed.toFixed(1)} 字/分`],
      ['准确率', st.acc === null ? '—' : `${(st.acc * 100).toFixed(1)}%`],
      ['本卡累计', `${cardTotal.toLocaleString('zh-CN')} 字`],
      ['本次经验', `+${correctAll.toLocaleString('zh-CN')}`],
    ];
    q('resGrid').innerHTML = roundRows
      .map(([k, v]) => `<div class="rc"><s>${k}</s><b>${v}</b></div>`).join('');
    q('ovrTitle').textContent = `第 ${round} 轮结束`;
    /**
     * meta 只放定位信息，数字全部让网格说。
     * 标题里已经有「第 N 轮」，这里不再重复；只写档位。
     * 待生效的下一轮档位必须在这里提一句 —— 浮层把时长条整个盖住了，
     * 那颗 `.sopt.pending` 的角点此刻是看不见的。
     */
    const tier = Math.round(sessionMs / 60_000);
    const nextTier = pendingSessionMs === null
      ? ''
      : ` · 下一轮 ${Math.round(pendingSessionMs / 60_000)} 分钟`;
    setOvMeta(`${tier} 分钟档${nextTier}`);
    q('btnRoundAgain').textContent = '继续下一轮';

    /**
     * 240ms 之后再显示，而且**不把焦点放到任何按钮** ——
     * 用户高速打字时 Enter/Space 正好落在浮层出现的那一帧，焦点在「继续」上
     * 就等于让下一个上屏键替他把浮层关掉（浮层一闪而过的根因）。
     */
    revealTimer = window.setTimeout(() => {
      revealTimer = 0;
      roundSettling = false;
      setOvState('round', false);   // 第一次显示：没有「旧内容」可淡出
      showOv(true);
    }, ROUND_REVEAL_MS);
  }

  /** 弹窗开了才需要解冻；phase 不动（它还是 running，暂停浮层不许跟着冒出来）。 */
  function thawTimer() {
    if (!roundFrozen) return;
    roundFrozen = false;
    if (timer.status === 'paused') timer.resume();
  }

  /**
   * 本轮重置 = 从这里重新计时。`roundAgain()` 与「立即重开本轮」共用，
   * 差别只在调用方是否 `round += 1`。
   */
  function resetRoundBase() {
    // 必须在解冻前取：此刻读数是冻住的，解冻后再读会把浮层停留的时间算进新一轮
    roundBase = timer.elapsedMs();
    roundBaseCorrect = correctAll;
    roundBaseWrong = wrongAll;
    roundEnded = false;
    roundSettling = false;
    cancelReveal();
    thawTimer();
  }

  /** 「继续下一轮」：新一轮从**现在**起算（时长默认仍是原来的那档），本卡统计不清零。 */
  function roundAgain() {
    // 唯一把 pending 档位落地的时刻：换档只在轮次边界生效。
    if (pendingSessionMs !== null) {
      sessionMs = pendingSessionMs;
      pendingSessionMs = null;
      markSel(sessionMs / 60_000);
      markPending(null);
    }
    cancelFade();
    ovRound.hidden = true;
    ovFade.classList.remove('is-out');
    unlockOv();
    round += 1;
    resetRoundBase();
    updateSession();
    refreshMeters();
    focusInput();
  }

  /**
   * Esc / ✕：关掉浮层继续打 —— **不新起计时**。
   * `roundEnded` 保持 true（不会 250ms 后再弹一次），时长条停在 00:00 转金色，
   * 接着打的字仍然记在本卡上，结算也不发生。
   * 归零后的 240ms 缓冲里按 Esc 走的也是这里：取消这次显示，直接回到打字。
   */
  function closeRoundKeepGoing() {
    cancelReveal();
    cancelFade();
    ovRound.hidden = true;
    unlockOv();          // 关掉浮层，静默期一并结束（下次显示会重新上锁）
    roundSettling = false;
    thawTimer();
    updateSession();
    focusInput();
  }

  /**
   * 换档：本轮进行中只记 pending，不动当前轮的任何读数。
   * `ms` 是目标档位。
   */
  function pickSession(ms: number) {
    const min = ms / 60_000;
    // 点的就是当前档（且没有待生效档）→ 什么都不做
    if (ms === sessionMs && pendingSessionMs === null) return;
    // 点的就是已经挂着的那一档 → 重复点不该再弹一次提示
    if (ms === pendingSessionMs) return;

    const elapsed = phase === 'ready' ? 0 : timer.elapsedMs();
    const used = Math.max(0, elapsed - roundBase);
    const beforeRoundStart = phase === 'ready' || used === 0;

    // ① 本轮还没开始：直接生效，静默（没有任何读数会跳）
    if (beforeRoundStart) {
      sessionMs = ms;
      pendingSessionMs = null;
      markSel(min);
      markPending(null);
      updateSession();
      focusInput();
      return;
    }

    // ② 本轮已经结束（条子停在金色 00:00）：这就是边界，直接生效并重开本轮
    if (roundEnded) {
      cancelFade();
      ovRound.hidden = true;
      unlockOv();
      sessionMs = ms;
      pendingSessionMs = null;
      markSel(min);
      markPending(null);
      resetRoundBase();
      updateSession();
      refreshMeters();
      focusInput();
      return;
    }

    // ③ 本轮进行中：只挂待生效。当前的剩余时间、进度条、轮次统计一概不动 ——
    //    中途改档会让剩余时间在用户眼皮下跳，进度条还要倒流。
    pendingSessionMs = ms;
    markSel(sessionMs / 60_000);
    markPending(min);
    toast({
      text: `下一轮改为 ${min} 分钟`,
      sub: '本轮的剩余时间和统计不变',
      action: { label: '立即重开本轮', run: applyPendingNow },
    });
    focusInput();
  }

  /** 「立即重开本轮」：把 pending 落地并把当前轮从 0 重开，`round` 不 +1。 */
  function applyPendingNow() {
    if (pendingSessionMs === null) return;
    cancelFade();
    ovRound.hidden = true;
    unlockOv();
    sessionMs = pendingSessionMs;
    pendingSessionMs = null;
    markSel(sessionMs / 60_000);
    markPending(null);
    resetRoundBase();
    updateSession();
    refreshMeters();
    focusInput();
  }

  function refreshMeters() {
    {
      const p = queue.progress();
      // 进度条按「练过」而不是「已熟」：已熟要答对 8 次，500 题的卡得 4000 次作答
      // 才会动一格 —— 永远 0/500 的条等于告诉用户「你的努力没被记录」。
      fbar.style.width = `${(p.seen / Math.max(1, p.total)) * 100}%`;
      // 「已熟」要答对 8 次才算，所以大多数卡长期是 0；它仍然恒显示 ——
      // 这一行是三个固定槽位（练过 / 已熟 / 累计），少一个槽位就看不出后面还会不会长东西。
      /**
       * 底栏左边一条读全：`本卡 练过 486 / 500 · 已熟 312 · 累计 2,480 字`。
       *
       * 「累计 N 字」原来单独挂在纸面（大字下面那行 12px 灰字），
       * 它和「练过」回答的是同一个问题（这张卡我花了多少功夫），
       * 分在两个位置就要扫两眼。现在合并到一行，纸面上只剩大字和编码。
       */
      const chars = cardChars(card.id).toLocaleString('zh-CN');
      // 「已熟」恒显示（含 0）：它是这一行的固定槽位，空了就没人知道这行还有第三个数
      fp.textContent = `本卡 练过 ${p.seen} / ${p.total} · 已熟 ${p.mastered} · 累计 ${chars} 字`;
    }
  }

  /**
   * 底栏的快捷键提示 30 秒后退到次要：它是「第一次用需要、以后不需要」的信息，
   * 一直以 12px 的全亮度停在屏幕右下角，是长时段里唯一一块「不动的亮字」。
   * 不删掉（新用户仍然需要），只降不透明度；鼠标动一下回来。
   */
  const keysTimer = window.setTimeout(() => elFkeys?.classList.add('is-dim'), 30_000);

  const hudTimer = window.setInterval(() => {
    if (phase !== 'running') return;
    refreshMeters();
    updateSession();

    /* 连续练满 20 分钟：出一行提示，**不暂停计时、不弹模态**。
       只出一次；下一次按键就淡出。眼疲劳是累积的，机器能做的只有提醒。 */
    if (!restShown && timer.elapsedMs() >= 20 * 60_000 && elRest) {
      restShown = true;
      elRest.hidden = false;
      requestAnimationFrame(() => elRest.classList.add('on'));
    }
  }, 250);

  /* ---------- 暂停 / 结算 ---------- */

  function pause() {
    if (phase !== 'running') return;
    /**
     * 浮层在场、或正在等它出现时，不再叠一层暂停浮层。
     * 切后台正好撞上归零的 240ms 缓冲时，这一句就是「两层浮层叠在一起」的唯一防线；
     * 计时此刻已经冻住，不需要第二个暂停来保护它。
     */
    if (keysToOverlay()) return;
    phase = 'paused';
    timer.pause();
    q('ovPauseMeta').textContent = `已用 ${formatElapsed(timer.elapsedMs())} · 本次 ${correctAll} 字`;
    ovPause.hidden = false;
    (q('btnResume') as HTMLButtonElement).focus();
  }

  function resume() {
    if (phase !== 'paused') return;
    ovPause.hidden = true;
    phase = 'running';
    timer.resume();
    focusInput();
  }

  /**
   * 结算一次，且只结算一次。
   *
   * 经验是边打边记的（顶栏数字实时涨），结算这一步只负责把**本卡累计**补齐 ——
   * 中途按返回、按浏览器后退、关标签页都不经过 finish()，不在这里补一次，
   * 那部分字就白打了。三个出口（finish / 返回 / 卸载）都走这里，
   * `settled` 保证不会重复计。
   */
  let settled = false;
  let settleResult: SettleResult | null = null;

  /**
   * 已提交进「累计练习时长」的水位线。
   *
   * 计时器只增不减，所以「已记过的读数」就是增量基准：重复调用 `commitTime()`
   * 不会重复记（`destroy()` 与 `leave()` 都会走到这里，不设水位线就是记两遍）。
   */
  let timeCommitted = 0;

  function commitTime(): void {
    const now = timer.elapsedMs();
    const delta = now - timeCommitted;
    if (delta <= 0) return;
    timeCommitted = now;
    addPracticeTime(delta);
  }

  function settleOnce(): SettleResult | null {
    if (settled) return settleResult;
    settled = true;
    // 时长与字数是两件事：一个字没打，用户也确实在这一页待了这么久。
    // `elapsedMs()` 天然排除暂停与浮层冻结，口径与「轮次时长」完全同一只表。
    commitTime();
    // 一个字都没打就退出，不结算（不给自己记一次 0 字的练习）。
    if (correctAll <= 0 && wrongAll <= 0) return null;
    settleResult = settlePractice({
      cardId: card.id,
      correctChars: correctAll,
      creditXp: false,
    });
    return settleResult;
  }

  /**
   * 结算态。
   *
   * 浮层没显示过（题库打完、`loadItem()` 直接走到头）时**以结算态打开**，
   * 不做交叉淡入 —— 没有「旧内容」可以淡出，淡入淡出只会闪一下。
   */
  function finish() {
    if (phase === 'finished') return;
    phase = 'finished';
    cancelReveal();
    roundSettling = false;
    timer.finish();

    const used = formatElapsed(timer.elapsedMs());
    const sp = timer.speed(correctAll);
    const acc = correctAll + wrongAll === 0 ? null : correctAll / (correctAll + wrongAll);
    const settledThis = settleOnce();

    // 「本次用时」搬到 meta（单行），网格里只留成组的数据：两处写同一个读数没有意义
    const rows: Array<[string, string]> = [
      ['打对', `${correctAll} 字`],
      ['打错', `${wrongAll} 处`],
      ['速度', sp === null ? '—' : `${sp.toFixed(1)} 字/分`],
      ['准确率', acc === null ? '—' : `${(acc * 100).toFixed(0)}%`],
      ['本次答题', `${sessionAnswers()} 题`],
      ['本卡累计', `${cardChars(card.id).toLocaleString('zh-CN')} 字`],
    ];
    // 只有真的切过轮才提这件事；一轮到底的卡写「轮次 1」是废话。
    if (round >= 2) rows.push(['轮次', `${round} 轮`]);
    if (settledThis) {
      rows.push(['本次经验', `+${settledThis.xpGained.toLocaleString('zh-CN')}`]);
      if (settledThis.levelUp) rows.push(['升级', `Lv.${settledThis.levelBefore} → Lv.${settledThis.levelAfter}`]);
    }
    q('resGrid').innerHTML = rows
      .map(([k, v]) => `<div class="rc"><s>${k}</s><b>${v}</b></div>`).join('');

    q('ovrTitle').textContent = '本卡结算';
    setOvMeta(`本次用时 ${used}`);
    const wasOpen = overlayOpen();
    setOvState('result', wasOpen);
    if (!wasOpen) showOv(false);
    refreshMeters();
    refreshTopbar(root);
  }

  /**
   * 「再打一次」：同一张卡从头再练。
   *
   * 不换页、不改 hash：队列（熟练度）本来就存在存档里，重开只需要把**本次**的
   * 读数与轮次归零。计时器换一只新的 —— 旧的那只已经 `finish()`，状态机不允许倒回。
   */
  function restartCard() {
    settleOnce();
    settled = false;
    settleResult = null;
    timer = createTimer();
    timeCommitted = 0;
    answersAtStart = queue.progress().answers;
    correctAll = 0;
    wrongAll = 0;
    statCorrect = 0;
    statWrong = 0;
    keystrokes = 0;
    round = 1;
    roundBase = 0;
    roundBaseCorrect = 0;
    roundBaseWrong = 0;
    roundEnded = false;
    roundFrozen = false;
    roundSettling = false;
    restShown = false;
    phase = 'ready';
    sessionLeft = sessionMs;
    cancelReveal();
    cancelFade();
    cancelLock();
    ovRound.hidden = true;
    ovPause.hidden = true;
    // 盒子退回「轮次态」的空壳：下一次到点时会重新写标题与 meta，
    // 但状态标记与可见行必须是干净的（否则结算网格还挂在里面）。
    paintOvState('round');
    if (elRest) { elRest.classList.remove('on'); elRest.hidden = true; }
    loadItem();
    updateSession();
    refreshMeters();
    refreshTopbar(root);
    focusInput();
  }

  /** 关掉浮层上的一切定时器（离开 / 重开 / 卸载时用）。 */
  function cancelLock() {
    window.clearTimeout(lockTimer);
    lockTimer = 0;
    unlockOv();
  }

  /* ---------- 事件 ---------- */

  function focusInput() {
    if (phase === 'finished' || phase === 'paused') return;
    if (rootsMode) return;           // 字根卡不靠输入法，键直接按
    elTin.focus({ preventScroll: true });
  }

  function undoOne() {
    if (phase === 'finished' || phase === 'paused') return;
    if (!matcher.undo()) { fb('已经回到开头了'); return; }
    const c = matcher.stats().correctChars;
    const w = matcher.stats().wrongChars + matcher.stats().wrongPunct;
    correctAll = Math.max(0, correctAll - Math.max(0, statCorrect - c));
    wrongAll = Math.max(0, wrongAll - Math.max(0, statWrong - w));
    statCorrect = c;
    statWrong = w;
    refreshMeters();
    focusInput();
  }

  const onInput = () => { if (!composing) onCommit(); };
  const onCompStart = () => { composing = true; };
  const onCompEnd = () => { composing = false; onCommit(); };
  const onPaste = (e: ClipboardEvent) => e.preventDefault();

  elTin.addEventListener('input', onInput);
  elTin.addEventListener('compositionstart', onCompStart);
  elTin.addEventListener('compositionend', onCompEnd);
  elTin.addEventListener('paste', onPaste);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 20 分钟那条休息提示：按下一次键就收掉。原来定义了 dismissRest 却没人调用，
    // 提示一旦出现就一直挂在页面上。
    dismissRest();
    /**
     * 浮层在场（或正等它出现）时，键盘只属于浮层。
     *
     * 少这一句就会出现「Esc 关掉浮层的同时又暂停」—— 两层浮层叠在一起，
     * 用户点「继续」回到的还是浮层下面的暂停态。所以这里先截住，再 `stopPropagation`，
     * 绝不让它落到下面的全局暂停分支。
     */
    if (keysToOverlay()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // 结算态没有「继续打」这条路：Esc 等同于「返回」，否则关掉就再没有出口
        if (!roundSettling && ovState === 'result') { leave(); return; }
        closeRoundKeepGoing();
        return;
      }
      // Tab 不穿透：焦点在盒子里的可用控件之间循环
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        trapTab(e.shiftKey);
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        // 焦点在可用按钮上时，回车/空格必须真的能按下去；
        // 焦点在盒子本身（解锁后就是常态）时，只需要拦住空格把底下的页面滚走。
        if (!isEnabledButton(e.target)) e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (phase === 'paused') resume(); else pause();
      return;
    }
    /**
     * Tab 是产品既定快捷键（看/收图解），所以它仍然被拦下 —— 但**只拦不带 Shift 的那个**。
     * Shift+Tab 一被挡住，焦点就永远出不去，键盘用户到不了顶栏的品牌链接和「← 返回」。
     */
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      // 字根卡没有拆解栏（它拆不出来），Tab 不做任何事，免得空点一下。
      if (!rootsMode) setHint(!hintOpen);
      focusInput();
      return;
    }
    if (rootsMode && /^[a-zA-Z]$/.test(e.key)) {
      e.preventDefault();
      answerKey(e.key);
      return;
    }
    if (e.key === 'Backspace' && elTin.value === '' && !rootsMode) {
      e.preventDefault();
      undoOne();
      return;
    }
    if (e.key.length === 1) keystrokes++;
  };
  window.addEventListener('keydown', onKeyDown);

  /** 事件目标是「真的能按」的按钮吗（浮层里那几颗）。 */
  function isEnabledButton(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    const btn = el?.closest?.('button');
    return !!btn && btn.getAttribute('aria-disabled') !== 'true';
  }

  const onClickPaper = () => focusInput();
  elPaper.addEventListener('click', onClickPaper);

  /* ---------- 练习时长（换档） ---------- */

  function markSel(min: number) {
    sOpts.querySelectorAll<HTMLElement>('.sopt').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.min) === min);
    });
  }

  /**
   * 「待生效」标记。
   *
   * 只有描边 + 一个 5px 的角点，**不加文字后缀** —— 48px 宽的按钮里塞
   * 「(下一轮生效)」会直接撑破换行。完整说法放 `title` / `aria-label`。
   */
  function markPending(min: number | null) {
    sOpts.querySelectorAll<HTMLElement>('.sopt').forEach((b) => {
      const m = Number(b.dataset.min);
      const pending = min !== null && m === min;
      b.classList.toggle('pending', pending);
      const label = pending ? `${m} 分钟 · 下一轮生效` : `${m} 分钟`;
      b.title = label;
      b.setAttribute('aria-label', label);
    });
  }

  markSel(sessionMs / 60_000);
  markPending(null);

  sOpts.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('.sopt') as HTMLElement | null;
    if (!b?.dataset.min) return;
    pickSession(Number(b.dataset.min) * 60_000);
  });

  /**
   * 所有「离开练习页」的入口都走这里：先结算，再退出。
   * 少了这一步，中途退出就等于「字白打了」。
   */
  function leave(): void {
    settleOnce();
    onExit();
  }

  q('pBack')?.addEventListener('click', leave);
  q('pBack2')?.addEventListener('click', leave);
  q('hintbar').addEventListener('click', () => { setHint(!hintOpen); focusInput(); });
  q('btnResume').addEventListener('click', () => resume());
  q('btnGiveUp').addEventListener('click', leave);
  q('btnAgain').addEventListener('click', () => restartCard());
  q('btnBack').addEventListener('click', leave);
  // 浮层上的四个按钮都先过一遍 `ovLocked`：静默期里的激活一律吞掉
  q('btnRoundAgain').addEventListener('click', () => { if (!ovLocked) roundAgain(); });
  q('btnRoundClose').addEventListener('click', () => { if (!ovLocked) closeRoundKeepGoing(); });
  q('btnRoundEnd').addEventListener('click', () => {
    // 结束本卡 = 直接回主页。这一格里已经写着「打对 / 打错 / 本卡累计 / 本次经验」，
    // 再弹一个「本卡结算」只是把同样几个数换个位置念一遍。
    // Esc / ✕ 只是关窗继续，不走这里。
    if (ovLocked) return;
    leave();
  });
  q('kbClose').addEventListener('click', () => kbDlg.close());

  const onVis = () => { if (document.hidden && phase === 'running') pause(); };
  document.addEventListener('visibilitychange', onVis);

  const onUnload = (e: BeforeUnloadEvent) => {
    if (phase === 'running') { e.preventDefault(); e.returnValue = ''; }
  };
  window.addEventListener('beforeunload', onUnload);

  /* ---------- 启动 ---------- */

  // 顶栏的 Lv 弹层与「进度」存档弹窗 —— 与主页同一套，点进卡片也还在原位
  const disposeTopbar = mountTopbar(root);

  if (rootsMode) elTypebar?.remove();
  loadItem();
  if (sRemain) sRemain.textContent = formatElapsed(sessionMs);
  setTimeout(focusInput, 30);

  function destroy() {
    // 兜底：浏览器后退、地址栏改 hash 都不经过 leave()，这里补一次结算。
    settleOnce();
    // 还没到点的浮层显示、静默期、交叉淡入都要收掉：DOM 已经要没了，
    // 留下的 setTimeout 会打在一个已卸载的盒子上。
    cancelReveal();
    cancelFade();
    cancelLock();
    // 提示块那两个定时器同理：DOM 已经要没了，别让它们打在已卸载的节点上
    window.clearTimeout(hintOffTimer);
    window.clearTimeout(codesOffTimer);
    disposeTopbar();
    window.clearInterval(hudTimer);
    window.clearTimeout(keysTimer);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('beforeunload', onUnload);
    document.removeEventListener('visibilitychange', onVis);
    elTin.removeEventListener('input', onInput);
    elTin.removeEventListener('compositionstart', onCompStart);
    elTin.removeEventListener('compositionend', onCompEnd);
    elTin.removeEventListener('paste', onPaste);
    elPaper.removeEventListener('click', onClickPaper);
    if (kbDlg.open) kbDlg.close();
  }

  return { destroy };
}
