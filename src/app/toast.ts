/**
 * app/toast.ts — 右下角的「事后通知」：可撤销操作与失败阻断。
 *
 * 负责：把一条消息挂到右下角、跑倒计时、暂停/恢复、自动消失、最多同时 2 条。
 * 不负责：什么时候该弹（调用方决定）、页面布局。
 * 调用方：home.ts（删除卡片的撤销）、custom.ts（剪切板读不到）。
 *
 * 三条硬约束：
 *   1. **撤销窗口 8s**，与 toast 生命周期同长 —— 太短的不可延长倒计时对慢手用户
 *      等于没有（WCAG 2.2.1）。hover 与 :focus-within 都要暂停计时。
 *   2. **失败不自动消失**，`role="alert"`，必须手动关 —— 用户正低头找文件，
 *      抬头时不能已经没了。
 *   3. **`data-countdown` / `data-remain` 是可验证契约**：CSS 停不了计时器，
 *      不落成属性就没法验证「hover 暂停」有没有生效。
 */

export type ToastKind = 'ok' | 'err';

export interface ToastOpts {
  /** 主句（说发生了什么）。 */
  text: string;
  /** 第二行，说人话的原因或补充。 */
  sub?: string;
  /** ok = 可撤销/信息（青条，8s 自动消失）；err = 失败/阻断（洋红条，不自动消失）。 */
  kind?: ToastKind;
  /** 右侧那一个动作。撤销/手动粘贴都走这里。 */
  action?: { label: string; run: () => void };
  /** 自动消失的时长（毫秒）。err 忽略此值 —— 失败必须手动关。 */
  ms?: number;
}

/** 撤销窗口：8s（与 §7.15 同源）。 */
export const UNDO_MS = 8000;
/** 同时最多挂 2 条，超出时最旧的立即消失（不做队列）。 */
const MAX = 2;

let seq = 0;

/**
 * 弹一条。返回 dismiss()，调用方可以提前收掉。
 *
 * 宿主优先挂在打开着的 <dialog> 里：`showModal()` 会把对话框提到 top layer，
 * 挂在 body 上的 toast 会被背板整个盖住 —— 而「剪切板读不到」恰恰发生在对话框里。
 */
export function toast(opts: ToastOpts): () => void {
  const kind: ToastKind = opts.kind ?? 'ok';
  const host = document.querySelector<HTMLElement>('dialog[open]') ?? document.body;

  let box = host.querySelector<HTMLElement>(':scope > .toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    host.appendChild(box);
  }

  // 超出上限：先收最旧的一条，再插新的
  while (box.children.length >= MAX) box.firstElementChild?.remove();

  const total = kind === 'err' ? 0 : Math.max(1000, opts.ms ?? UNDO_MS);
  const el = document.createElement('div');
  el.className = `toast${kind === 'err' ? ' err' : ''}`;
  el.id = `toast-${++seq}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.dataset.countdown = total ? 'running' : 'stopped';
  if (total) el.dataset.remain = String(total);

  const acts = document.createElement('div');
  acts.className = 'tacts';

  if (opts.action) {
    const act = document.createElement('button');
    act.className = 'act';
    act.type = 'button';
    act.textContent = opts.action.label;
    acts.appendChild(act);
  }

  // 失败必须有手动关闭键；可撤销那条不一定要（8s 会自己走）
  if (kind === 'err') {
    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.setAttribute('aria-label', '关闭提示');
    x.textContent = '✕';
    acts.appendChild(x);
  }

  const body = document.createElement('div');
  body.className = 'tbody';
  const tx = document.createElement('div');
  tx.className = 'tx';
  // 文本节点而不是 innerHTML：卡片标题来自用户输入，这里不该有第二个转义点
  tx.textContent = opts.text;
  body.appendChild(tx);

  if (total) {
    const left = document.createElement('span');
    left.className = 'left';
    left.textContent = `${Math.round(total / 1000)}s`;
    tx.appendChild(left);
  }

  if (opts.sub) {
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = opts.sub;
    body.appendChild(sub);
  }

  el.appendChild(body);
  el.appendChild(acts);
  box.appendChild(el);

  let remain = total;
  let timer = 0;
  const stop = () => {
    window.clearInterval(timer);
    timer = 0;
  };
  const dismiss = () => {
    stop();
    el.remove();
    if (box && !box.children.length) box.remove();
  };
  const tick = () => {
    remain -= 1000;
    el.dataset.remain = String(Math.max(0, remain));
    const left = el.querySelector('.left');
    if (left) left.textContent = `${Math.max(0, Math.ceil(remain / 1000))}s`;
    if (remain <= 0) dismiss();
  };

  /**
   * 暂停 = **真的停掉 interval**，不是只停 CSS。
   * `animation-play-state: paused` 只停数字，计时器照跑 —— 这正是规格里点名的那半个实现。
   */
  const pause = () => {
    if (el.dataset.countdown !== 'running') return;
    stop();
    el.dataset.countdown = 'paused';
  };
  const resume = () => {
    if (el.dataset.countdown !== 'paused') return;
    el.dataset.countdown = 'running';
    timer = window.setInterval(tick, 1000);
  };

  if (total) timer = window.setInterval(tick, 1000);

  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', resume);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', resume);

  el.querySelector('.x')?.addEventListener('click', dismiss);
  if (opts.action) {
    el.querySelector('.act')?.addEventListener('click', () => {
      opts.action?.run();
      dismiss();
    });
  }

  return dismiss;
}
