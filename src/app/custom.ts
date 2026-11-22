/**
 * app/custom.ts — 「新建单字卡」弹层。
 *
 * 负责：粘贴文本 / 读剪切板 → 取出里面的汉字（去重、按字频截断）→ 存成一张卡。
 * 不负责：练习本身（存进 store 后由 practice.ts 当普通卡片跑）。
 * 调用方：home.ts 单字练习组里的虚线卡。
 *
 * **只有单字一种**：自定义卡的用法就是「我的生字本」—— 一段文本里出现了哪些字，
 * 就练哪些字。词组已经由三张内置卡覆盖（二字 / 三字 / 四字各 1000 条），
 * 再让用户自己粘词表，是给一个已经解决的问题再造一个入口。
 *
 * 剪切板 API 在 `file://` 下一定失败、在 http 下需要用户手势，所以
 * **粘贴框是主路径，读剪切板是加速键**。
 */

import { CUSTOM_ITEM_CAP, addCustom, type CustomCard } from './store';
import { charByKey } from './data';
import { toast } from './toast';

const CJK = /[\u3007\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;

export interface OpenOpts {
  onSaved: () => void;
}

const TEXT = {
  title: '新建单字卡',
  unit: '个',
  hint: '粘贴文本，只取单字',
  note: '整段文本都行：只认汉字，重复的去掉。',
} as const;
const CAP = CUSTOM_ITEM_CAP;

function countEffective(text: string): number {
  let n = 0;
  for (const ch of text) if (CJK.test(ch)) n += 1;
  return n;
}

/** 去掉空行、首尾空白；段首缩进一律剔除（练习时不需要用户打空格）。 */
function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''))
    .filter((line, i, arr) => line.length > 0 || (i > 0 && i < arr.length - 1))
    .join('\n')
    .trim();
}

/** 取字：整段文本里的汉字，逐个成题，重复的只留第一次出现的。 */
function pickChars(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) if (CJK.test(ch)) out.push(ch);
  return [...new Set(out)];
}

/**
 * 单字按字频排序：上限截断时该截掉的是生僻字，不是用户最想练的字。
 * 3000 字表里没有的字（生僻字/繁体）排在最后，仍然收得进来。
 */
function byFreq(list: string[]): string[] {
  const rank = (ch: string) => charByKey.get(`char:${ch}`)?.freqRank ?? Number.MAX_SAFE_INTEGER;
  return list
    .map((ch, i) => ({ ch, i, r: rank(ch) }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
    .map((x) => x.ch);
}

export function openCustomDialog(opts: OpenOpts): void {
  const text = TEXT;
  const cap = CAP;

  const dlg = document.createElement('dialog');
  dlg.className = 'kbdialog custdlg';
  dlg.innerHTML = `
    <div class="kbhead">
      <span>${text.title}</span>
      <button class="ghost" id="cuClose" type="button" aria-label="关闭">✕</button>
    </div>
    <div class="custbody">
      <label class="curow">
        <span class="culabel">卡片名</span>
        <input id="cuTitle" class="qinput custitle" type="text" maxlength="24"
          placeholder="比如：我的生字本">
      </label>

      <label class="curow col">
        <span class="culabel">内容<span id="cuPick" class="culink">读剪切板</span></span>
        <textarea id="cuText" class="cutext" rows="9" spellcheck="false"
          placeholder="${text.note}&#10;单卡最多 ${cap.toLocaleString('zh-CN')} ${text.unit}。"></textarea>
      </label>

      <div class="cumeta" id="cuMeta">还没有内容</div>
      <div class="cumsg" id="cuMsg" hidden role="status"></div>
    </div>
    <div class="ovrow custfoot">
      <button class="btn primary" id="cuSave" type="button" disabled>保存并开始</button>
      <button class="btn" id="cuCancel" type="button">取消</button>
    </div>`;

  document.body.appendChild(dlg);
  dlg.showModal();

  const q = <T extends HTMLElement>(id: string) => dlg.querySelector(`#${id}`) as T;
  const elTitle = q('cuTitle') as unknown as HTMLInputElement;
  const elText = q('cuText') as unknown as HTMLTextAreaElement;
  const elMeta = q('cuMeta');
  const elMsg = q('cuMsg');
  const btnSave = q('cuSave') as HTMLButtonElement;

  /**
   * 当前输入会切出什么 —— 保存和提示共用这一份。
   *
   * `over` = 去重后的真实条目数（截断前），`items` = 实际会存进去的那一段。
   * **超限不静默截断**：`over > cap` 时界面上必须写清「粘了多少、只取多少」。
   */
  function plan() {
    const raw = clean(elText.value);
    if (!raw) return { raw, all: [] as string[], items: [] as string[], chars: 0, over: 0 };
    const all = byFreq(pickChars(raw));
    const items = all.slice(0, cap);
    const chars = items.reduce((s, t) => s + countEffective(t), 0);
    return { raw, all, items, chars, over: all.length };
  }

  function refresh() {
    const p = plan();
    const empty = p.raw.length === 0 || p.items.length === 0;
    btnSave.disabled = empty;

    if (empty) {
      elMeta.textContent = '还没有内容';
      elMsg.hidden = true;
      btnSave.textContent = '保存并开始';
      return;
    }

    elMeta.innerHTML = `单字 · <b>${p.items.length.toLocaleString('zh-CN')}</b> ${text.unit} · ${p.chars.toLocaleString('zh-CN')} 字`;

    if (p.over > cap) {
      elMsg.hidden = false;
      elMsg.className = 'cumsg';
      elMsg.textContent = `粘贴了 ${p.over.toLocaleString('zh-CN')} 个不重复单字，单卡上限 ${cap.toLocaleString('zh-CN')}。只取最常用的前 ${cap.toLocaleString('zh-CN')} 个（按字频），剩下的可以另建一张。`;
      btnSave.textContent = `只取前 ${cap.toLocaleString('zh-CN')}`;
    } else {
      elMsg.hidden = true;
      btnSave.textContent = '保存并开始';
    }
  }

  function msg(t: string, bad = false) {
    elMsg.hidden = false;
    elMsg.textContent = t;
    elMsg.className = `cumsg${bad ? ' bad' : ''}`;
  }

  /* 事件 */

  elText.addEventListener('input', refresh);

  q('cuPick').addEventListener('click', async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) { msg('剪切板是空的', true); return; }
      elText.value = clip;
      refresh();
    } catch {
      /**
       * 读剪切板在 file:// 下**必然失败**（不是偶发），所以这是「失败阻断」而不是提示：
       * 不自动消失、role=alert、给一个「手动粘贴」把焦点送到该去的框里。
       */
      msg('浏览器不给读剪切板，请点上面的框按 ⌘V / Ctrl+V 粘贴', true);
      elText.focus();
      toast({
        kind: 'err',
        text: '读不到剪切板',
        sub: '浏览器只在 HTTPS 或 localhost 下允许读取，当前是本地文件。',
        action: { label: '手动粘贴', run: () => elText.focus() },
      });
    }
  });

  const close = () => { dlg.close(); dlg.remove(); };
  q('cuClose').addEventListener('click', close);
  q('cuCancel').addEventListener('click', close);
  dlg.addEventListener('close', () => dlg.remove());

  btnSave.addEventListener('click', () => {
    const p = plan();
    if (!p.raw || p.items.length === 0) return;
    const title = (elTitle.value.trim() || defaultTitle(p)).slice(0, 24);
    const card: CustomCard = {
      id: `custom:${Date.now().toString(36)}`,
      title,
      mode: 'item',
      kind: 'char',
      raw: p.raw,
      items: p.items,
      charCount: p.chars,
      createdAt: Date.now(),
    };
    addCustom(card);
    close();
    opts.onSaved();
    /**
     * 按钮写的是「保存并开始」，那就真的开始：存完直接进练习，
     * 不让用户回到主页再自己找那张卡。
     */
    location.hash = `#/p/${encodeURIComponent(card.id)}`;
  });

  setTimeout(() => elText.focus(), 50);

  function defaultTitle(p: ReturnType<typeof plan>): string {
    return `自选单字 ${p.items.length.toLocaleString('zh-CN')} 个`;
  }
}
