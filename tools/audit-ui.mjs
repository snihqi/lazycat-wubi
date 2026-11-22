#!/usr/bin/env node
/**
 * 懒猫五笔 · UI 体验验收闸 / tools/audit-ui.mjs
 * ---------------------------------------------------------------------------
 * 零依赖。只用 Node 内置模块 + 本机已有的 Chromium（CDP over WebSocket）。
 *
 *   node tools/audit-ui.mjs                     # 默认 1440×900，四个页面
 *   node tools/audit-ui.mjs --mobile            # 记 390×844
 *   node tools/audit-ui.mjs --pages=home,states # 只跑几页
 *   node tools/audit-ui.mjs --only=focus        # focus | contrast | border
 *   node tools/audit-ui.mjs --vite              # 打 dist（npx vite preview）
 *
 * 退出码：0 全通过 / 1 有 FAIL / 2 崩溃。WARN 不影响退出码（见 KNOWN）。
 *
 * 已知的能力边界（都是实测出来的，不是推测）：
 *   · 390 下默认不判焦点。headless 的软件合成器在长文档 + 3× 光栅化时会停止重绘，
 *     截图前后完全一致 —— 无法区分"环没画"和"没重绘"。宁可 SKIP，不放假红灯。
 *     人工在真机上按一遍 Tab 比这个脚本可靠。
 *   · `opacity: 0` 的可聚焦元素（主页文章卡的删除键）会被跳过：它靠 `.card:focus-within`
 *     才显现，而 CSS.forcePseudoState 模拟不了 focus-within。标在 skipped 里，不算通过。
 *   · 众数占比 < 12% 的文字矩形（压在渐变/发光上）只报 WARN：像素法在那里不可靠。
 *
 * 三条检查（对应 Phase 2 校准结论）：
 *   ① focus     键盘焦点可见性 —— 与“元素自身默认态”比，不只与背景比。
 *               这是抓「青环落在青光晕里」的关键：对 .btn.primary 而言
 *               背景对比度够（青对光晕合成底 5.8:1），缺的是与默认态的
 *               可区分性。WCAG 2.4.11 的要求本就是「与默认态可区分」。
 *   ② contrast  文字对比度 —— 对文字行的矩形取**众数色**当底色。
 *               不取单点、不取均值、不取 p99.5：后两者会被字形抗锯齿边缘
 *               与 1px 受光边污染。
 *   ③ border    控件边界 —— 1.4.11 要求可操作控件的视觉边界 ≥3:1；
 *               唯一的法定例外是 inactive 组件（禁用态）。
 *
 * 两条实现约束（来自踩坑记录）：
 *   · 每轮导航前先 about:blank 中转，避开浏览器/vite 对 CSS 的缓存。
 *   · 存档只用 Page.addScriptToEvaluateOnNewDocument 注入。本脚本只读存档、
 *     从不写入，因此不做注入 —— 「Runtime.evaluate 写 localStorage 再 reload」
 *     会让 store.load() 的「业余一段」兜底把档标脏，pagehide 再把空档写回。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW = join(ROOT, 'preview');
const SHOTS = join(ROOT, '.audit-shots');
const PORT = 5199;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};

const PAGES = opt('pages', 'home,practice,practice-item,states').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = opt('only', 'focus,contrast,border').split(',').map((s) => s.trim());
const MOBILE = flag('mobile');
const QUIET = flag('quiet');
const USE_VITE = flag('vite');
const TARGET = opt('target', 'app');                 // app | preview（preview 目录已删除）
const ROUTES = opt('routes', '#/,#/q,#/p/roots').split(',').map((r) => r.trim()).filter(Boolean);
const USE_TAB = flag('tab');
const VW = MOBILE ? 390 : 1440;
const VH = MOBILE ? 844 : 900;

/* ═══════════════════════════════════════════════════════════════════════════
   1. 颜色与对比度（WCAG 2.x 相对亮度）
   ═══════════════════════════════════════════════════════════════════════════ */

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const relLum = ([r, g, b]) =>
  0.2126 * srgbToLin(r / 255) + 0.7152 * srgbToLin(g / 255) + 0.0722 * srgbToLin(b / 255);
const ratio = (a, b) => {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const parseRGB = (s) => {
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return { rgb: [p[0] || 0, p[1] || 0, p[2] || 0], a: p.length > 3 ? p[3] : 1 };
};
const over = (fg, a, bg) => fg.map((v, i) => v * a + bg[i] * (1 - a));

/* ═══════════════════════════════════════════════════════════════════════════
   2. PNG 解码（Chrome 截图：8bit、非隔行，ctype 6/2/0）
   ═══════════════════════════════════════════════════════════════════════════ */

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8, w = 0, h = 0, depth = 8, ctype = 6, idat = [];
  while (pos < buf.length - 8) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9];
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('bit depth ' + depth + ' unsupported');
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= ch && prev ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

/** 矩形内众数色 = 底色（文字像素是少数）。量化到 16 灰阶再取众数，避免抗锯齿打散。 */
function modeColor(img, rx, ry, rw, rh) {
  const { w, h, ch, data } = img;
  const x0 = Math.max(0, Math.round(rx)), y0 = Math.max(0, Math.round(ry));
  const x1 = Math.min(w, Math.round(rx + rw)), y1 = Math.min(h, Math.round(ry + rh));
  const bins = new Map();
  let total = 0;
  const step = (x1 - x0) * (y1 - y0) > 40000 ? 2 : 1;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      const e = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      bins.set(k, e);
      total++;
    }
  }
  if (!total) return null;
  let best = null;
  for (const e of bins.values()) if (!best || e.n > best.n) best = e;
  return { rgb: [best.r / best.n, best.g / best.n, best.b / best.n], share: best.n / total };
}

/** 两张同尺寸截图的差异比例（任一通道差 > tol 记为变化像素）。 */
function diffRatio(a, b, tol = 12) {
  const n = Math.min(a.w * a.h, b.w * b.h);
  let changed = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const p = i * a.ch, q = i * b.ch;
    const d = Math.max(
      Math.abs(a.data[p] - b.data[q]),
      Math.abs(a.data[p + 1] - b.data[q + 1]),
      Math.abs(a.data[p + 2] - b.data[q + 2]),
    );
    if (d > tol) changed++;
    sum += d;
  }
  return { changed: changed / n, mean: sum / n };
}


/**
 * 焦点指示测量 —— 不依赖任何几何。
 * ---------------------------------------------------------------------------
 * 为什么把「按 rect 算环带」整个换掉：rect 是小数（390 下卡片 y=129.1875），
 * 而 F（dsf × clip.scale）可以到 9，1 CSS px 的取整误差 = 9 设备像素 = 整个环带偏出去。
 * 实测同一份代码在 390 上时通时不通，就是这个取整在掷骰子。
 *
 * 改成从像素差本身出发：焦点指示 = 那一圈「变化了的像素」，它在哪就在哪。
 *   ring   = |Δ| > tol 的像素（焦点带来的全部视觉变化）
 *   adj    = 以 ring 为中心向外/向内扩 R 像素、但不在 ring 里的邻居
 * 判据仍是 WCAG 2.4.11：指示自身的颜色 vs 它的**相邻色** ≥3:1。
 * 相邻色可能正是元素自己的 box-shadow 光晕 —— 这正是霓虹体系特有的坑。
 */
function focusMeasure(before, after, tol = 12, adjRadius = 4) {
  const { w, h, ch } = after;
  const mask = new Uint8Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  let sr = 0, sg = 0, sb = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const d = Math.max(
        Math.abs(after.data[i] - before.data[i]),
        Math.abs(after.data[i + 1] - before.data[i + 1]),
        Math.abs(after.data[i + 2] - before.data[i + 2]),
      );
      if (d > tol) {
        mask[y * w + x] = 1; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        sr += after.data[i]; sg += after.data[i + 1]; sb += after.data[i + 2];
      }
    }
  }
  if (!n) return { n: 0, ring: null, adj: null, box: null };
  const ring = [sr / n, sg / n, sb / n];

  // 只在 ring 的包围盒外扩后工作（避免对整张 3M 像素图做膨胀）
  const ax0 = Math.max(0, x0 - adjRadius - 1), ay0 = Math.max(0, y0 - adjRadius - 1);
  const ax1 = Math.min(w - 1, x1 + adjRadius + 1), ay1 = Math.min(h - 1, y1 + adjRadius + 1);
  const W = ax1 - ax0 + 1, H = ay1 - ay0 + 1;
  // BFS 膨胀 adjRadius 层，收集「邻居」（不含 ring 本身）
  const dist = new Int16Array(W * H).fill(-1);
  const qx = [], qy = [];
  for (let y = ay0; y <= ay1; y++) {
    for (let x = ax0; x <= ax1; x++) {
      if (mask[y * w + x]) {
        const k = (y - ay0) * W + (x - ax0);
        dist[k] = 0; qx.push(x); qy.push(y);
      }
    }
  }
  let head = 0, ar = 0, ag = 0, ab = 0, an = 0;
  while (head < qx.length) {
    const cx = qx[head], cy = qy[head]; head++;
    const k = (cy - ay0) * W + (cx - ax0);
    const dd = dist[k];
    if (dd >= adjRadius) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < ax0 || nx > ax1 || ny < ay0 || ny > ay1) continue;
      const nk = (ny - ay0) * W + (nx - ax0);
      if (dist[nk] !== -1) continue;
      dist[nk] = dd + 1;
      qx.push(nx); qy.push(ny);
      const i = (ny * w + nx) * ch;
      ar += after.data[i]; ag += after.data[i + 1]; ab += after.data[i + 2]; an++;
    }
  }
  return {
    n,
    ring,
    adj: an ? [ar / an, ag / an, ab / an] : null,
    box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
  };
}

const hueOf = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return { h: 0, s: 0 };
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d / mx };
};
/** 从 box-shadow 里取“元素自身发光”的色相（跳过 inset 与 spread-only 的描边层）。 */
function glowHue(shadow) {
  if (!shadow || shadow === 'none') return null;
  const parts = shadow.split(/,(?![^(]*\))/);
  for (const p of parts) {
    if (/inset/.test(p)) continue;
    const c = p.match(/rgba?\(([^)]+)\)/);
    if (!c) continue;
    const nums = c[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if ((nums.length > 3 ? nums[3] : 1) < 0.05) continue;
    const rest = p.slice(p.indexOf(')') + 1).trim().split(/\s+/).map(parseFloat).filter((n) => !isNaN(n));
    if (rest.length >= 3 && rest[2] > 0) {
      const h = hueOf(nums.slice(0, 3));
      h.blur = rest[2];
      return h;
    }
  }
  return null;
}

const hueGap = (a, b) => {
  const x = Math.abs(a - b) % 360;
  return x > 180 ? 360 - x : x;
};

/* ═══════════════════════════════════════════════════════════════════════════
   3. 静态服务器（--vite 打 dist）
   ═══════════════════════════════════════════════════════════════════════════ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
};

function serve() {
  return new Promise((res) => {
    const srv = createServer(async (req, rq) => {
      const u = decodeURIComponent((req.url || '/').split('?')[0]);
      const f = join(PREVIEW, u === '/' ? 'home.html' : u);
      if (!f.startsWith(PREVIEW)) { rq.writeHead(403).end(); return; }
      try {
        const buf = await readFile(f);
        rq.writeHead(200, {
          'content-type': MIME[extname(f)] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        rq.end(buf);
      } catch {
        rq.writeHead(404, { 'cache-control': 'no-store' }).end('404');
      }
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. CDP 客户端（浏览器级 WS + flatten session）
   ═══════════════════════════════════════════════════════════════════════════ */

function findChromium() {
  const cands = [
    process.env.AUDIT_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(base)) {
    for (const d of readdirSync(base)) {
      if (!d.startsWith('chromium-')) continue;
      const p = join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(p)) return p;
    }
  }
  throw new Error('找不到 Chromium。用 AUDIT_CHROME=/path/to/chrome 指定。');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        for (const l of this.listeners) l(m);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws connect failed: ' + url)), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); }
      }, 30000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchJSON = async (u) => (await fetch(u)).json();

/* ═══════════════════════════════════════════════════════════════════════════
   5. 页面探针
   ═══════════════════════════════════════════════════════════════════════════ */

const PROBE = String.raw`
(() => {
  const out = { textRects: [], controls: [], focusables: [], docH: 0 };
  const cs = (e) => getComputedStyle(e);
  const txt = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14);
  const sel = (e) => {
    if (!e || e === document.body) return 'body';
    let s = e.tagName.toLowerCase();
    if (e.id) s += '#' + e.id;
    const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    if (e.hasAttribute('aria-disabled')) s += '[aria-disabled]';
    if (e.hasAttribute('aria-busy')) s += '[aria-busy]';
    return s;
  };
  const visible = (e) => {
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity) < 0.06) return false;
      if (n.classList && n.classList.contains('sr-only')) return false;
      if (s.clip === 'rect(0px, 0px, 0px, 0px)') return false;
    }
    return true;
  };
  // 按 CSS 逐层叠加算出的「有效底色」：像素取不到底（如 96px 单字填满矩形）时的回退
  const effBg = (e) => {
    const stack = [];
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const c = cs(n).backgroundColor;
      if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') continue;
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const q = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      const a = q.length > 3 ? q[3] : 1;
      stack.push({ rgb: [q[0], q[1], q[2]], a });
      if (a >= 0.999) break;
    }
    let base = [4, 6, 13];
    for (let i = stack.length - 1; i >= 0; i--) {
      const { rgb, a } = stack[i];
      base = [rgb[0] * a + base[0] * (1 - a), rgb[1] * a + base[1] * (1 - a), rgb[2] * a + base[2] * (1 - a)];
    }
    return base;
  };

  // ── ② 文字行矩形 ────────────────────────────────────────────────────
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node, guard = 0;
  while ((node = walker.nextNode()) && guard < 5000) {
    guard++;
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const p = node.parentElement;
    if (!p || !visible(p)) continue;
    const s = cs(p);
    if (s.color === 'rgba(0, 0, 0, 0)' || s.webkitTextFillColor === 'rgba(0, 0, 0, 0)') continue;
    const rg = document.createRange();
    rg.selectNodeContents(node);
    const rects = [...rg.getClientRects()].filter((r) => r.width > 2 && r.height > 2);
    const fs = parseFloat(s.fontSize), fw = parseInt(s.fontWeight, 10) || 400;
    for (const r of rects) {
      out.textRects.push({
        x: Math.round(r.left), y: Math.round(r.top + scrollY),
        w: Math.round(r.width), h: Math.round(r.height),
        color: s.color, fs, fw, sel: sel(p), text: txt(p), bgDom: effBg(p),
        large: fs >= 24 || (fs >= 18.66 && fw >= 700),
      });
    }
  }

  // ── ③ 控件边界 ──────────────────────────────────────────────────────
  const CTL = 'button, a[href], input, textarea, select, summary, [role="button"], [role="tab"], [role="link"]';
  for (const e of document.querySelectorAll(CTL)) {
    if (!visible(e)) continue;
    const s = cs(e);
    const bw = parseFloat(s.borderTopWidth) || 0;
    if (!bw) { out.controls.push({ sel: sel(e), bw: 0, text: txt(e) }); continue; }
    out.controls.push({
      sel: sel(e), bw, text: txt(e), borderColor: s.borderTopColor, bg: effBg(e),
      isPrimary: s.backgroundColor === 'rgb(34, 232, 255)',
      ariaDisabled: e.getAttribute('aria-disabled') === 'true',
      busy: e.classList.contains('busy') || e.getAttribute('aria-busy') === 'true',
      card: e.classList.contains('card'),
    });
  }

  // ── ① 可聚焦元素（供 focus 检查交叉核对）─────────────────────────────
  for (const e of document.querySelectorAll('a[href], button, input, textarea, select, summary, [tabindex]')) {
    if (!visible(e)) continue;
    const ti = e.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) < 0) continue;
    if (e.disabled) continue;
    out.focusables.push({ sel: sel(e) });
  }

  out.docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  return out;
})()
`;

/* ═══════════════════════════════════════════════════════════════════════════
   6. 检查
   ═══════════════════════════════════════════════════════════════════════════ */

/** 只停“动”，不动颜色与布局。焦点环的 outline 不参与过渡，冻结后仍是瞬时出现。 */
const FREEZE = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`;

async function evalIn(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  }
  return r.result.value;
}

async function shot(cdp, clip, scale = 1) {
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: Math.max(0, clip.x), y: Math.max(0, clip.y),
      width: Math.max(1, clip.w), height: Math.max(1, clip.h), scale,
    },
    captureBeyondViewport: false,
  });
  return decodePNG(Buffer.from(r.data, 'base64'));
}

/**
 * 等滚动真正停住：连续 2 帧 scrollY 不变才返回。
 * 这一条是 390 全部假 FAIL 的根因 —— scrollIntoView 之后只等 2 帧 rAF 不够，
 * `before` 可能拍在"滚动前"的帧上，`after` 拍在"滚动后"，于是整张图整体位移：
 * 变化像素 = 100%、"环"均值退化成整块底色（实测把纯青算成 #1990A3）。
 */
async function scrollSettle(cdp, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const stable = await evalIn(cdp, `new Promise((r) => {
      let n = 0, last = scrollY;
      const t = setInterval(() => {
        if (scrollY === last) { if (++n >= 2) { clearInterval(t); r(true); } }
        else { last = scrollY; n = 0; }
      }, 16);
      setTimeout(() => { clearInterval(t); r(false); }, 400);
    })`, true);
    if (stable) return true;
  }
  return false;
}

async function settle(cdp) {
  await evalIn(cdp, 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))', true);
  await sleep(50);
}

/* ── ① 焦点可见性 ──────────────────────────────────────────────────────
 * 为什么不用 el.focus() 后截图：
 *   ① headless 里文档常常「没有焦点」，`:focus` / `:focus-visible` 根本不匹配；
 *   ② 程序化 focus() 在非文本元素上也不保证命中 :focus-visible（实测 Chrome 156
 *      的 focus({focusVisible:true}) 不生效，matches(':focus-visible') 返回 false）。
 * 所以改用 CDP 的 CSS.forcePseudoState('focus-visible') 强制伪类 —— 它走的是
 * **页面里真实的 :focus-visible 规则**，只是绕过了启发式，结果可重复、可对账。
 * 严格说它测的是“样式规则”，不是“键盘路径”；所以 --tab 保留为补充走查。
 */

const FOCUS_SEL = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]),'
  + ' select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const FOCUS_DPR = 3;   // 2px 的环在 1× 下只有 2 个像素，环带统计会被抗锯齿糊平

async function checkFocus(cdp) {
  const fails = [], warns = [], skipped = [], unmeasured = [];
  let steps = 0;
  // 环只有 2px，1× 光栅化下「环/内邻/外邻」三段都只覆盖 1–2 像素，
  // 均值色会把环与底色平均成一个中间色，对比度被系统性低估（实测把
  // 纯青 #22E8FF 算成 #1BA6BA，误差 20%+）。所以焦点检查单独用 3× 光栅化。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: FOCUS_DPR, mobile: false,
  });
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  // 每个元素都重新取一次 document 与 nodeId。
  // 缓存 nodeIds 会在第 7–8 个元素之后失效 —— CSS.forcePseudoState 会静默不生效，
  // 截图前后完全一致，表现为「环带 0% 变化」的假 FAIL（390 上必现，1440 上偶发）。
  const freshNodes = async () => {
    const d = await cdp.send('DOM.getDocument', { depth: 0 });
    const r = await cdp.send('DOM.querySelectorAll', { nodeId: d.root.nodeId, selector: FOCUS_SEL });
    return r.nodeIds;
  };
  const total = (await freshNodes()).length;

  const callOn = async (objectId, fn) => {
    const r = await cdp.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fn, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  for (let idx = 0; idx < total; idx++) {
    let nodeId = (await freshNodes())[idx];
    if (nodeId === undefined) break;
    let objectId;
    try {
      ({ object: { objectId } } = await cdp.send('DOM.resolveNode', { nodeId }));
    } catch { continue; }

    // 滚动到视口内 + 拿几何 + 拿「是否真的可感知」
    const meta = await callOn(objectId, `function(){
      this.scrollIntoView({ block: 'center', inline: 'nearest' });
      const c = getComputedStyle(this);
      let op = 1;
      for (let n = this; n && n.nodeType === 1; n = n.parentElement) op = Math.min(op, parseFloat(getComputedStyle(n).opacity));
      const cls = (typeof this.className === 'string' ? this.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
      return JSON.stringify({
        label: this.tagName.toLowerCase() + (this.id ? '#' + this.id : '') + (cls.length ? '.' + cls.join('.') : ''),
        op, outline: c.outlineWidth + ' ' + c.outlineStyle + ' ' + c.outlineColor,
        offset: c.outlineOffset, shadow: c.boxShadow.slice(0, 44),
      });
    }`);
    const m = JSON.parse(meta);
    await scrollSettle(cdp);
    await settle(cdp);
    const rect = await callOn(objectId, `function(){
      const r = this.getBoundingClientRect();
      return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
    }`);
    const b = JSON.parse(rect);
    if (b.w < 4 || b.h < 4) { skipped.push(m.label + '（尺寸为 0）'); continue; }
    if (m.op < 0.06) { skipped.push(m.label + `（opacity ${m.op}，需人工确认 :focus-within 是否让其可见）`); continue; }

    const pad = 30;
    const cx = Math.max(0, b.x - pad), cy = Math.max(0, b.y - pad);
    const cw = Math.min(VW - cx, b.w + pad * 2), chh = Math.min(VH - cy, b.h + pad * 2);
    if (cw < 8 || chh < 8) { skipped.push(m.label + '（视口外）'); continue; }

    const clip = { x: cx, y: cy, w: cw, h: chh };
    const before = await shot(cdp, clip, FOCUS_DPR);
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] });
    await settle(cdp);
    const after = await shot(cdp, clip, FOCUS_DPR);
    const styles = JSON.parse(await callOn(objectId, `function(){
      const c = getComputedStyle(this);
      const effBg = (el) => {
        const stack = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
          const m = bg.match(/rgba?\(([^)]+)\)/);
          if (!m) continue;
          const q = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
          stack.push({ rgb: [q[0], q[1], q[2]], a: q.length > 3 ? q[3] : 1 });
          if (stack[stack.length - 1].a >= 0.999) break;
        }
        let base = [4, 6, 13];
        for (let i = stack.length - 1; i >= 0; i--) {
          const { rgb, a } = stack[i];
          base = [rgb[0] * a + base[0] * (1 - a), rgb[1] * a + base[1] * (1 - a), rgb[2] * a + base[2] * (1 - a)];
        }
        return base;
      };
      // outline-offset > 0 时，环画在元素**外面**，相邻色是父级的面，不是元素自己的填充色
      const b = effBg((parseFloat(c.outlineOffset) || 0) > 0 ? this.parentElement || this : this);
      return JSON.stringify({
        outline: c.outlineWidth + ' ' + c.outlineStyle + ' ' + c.outlineColor,
        width: parseFloat(c.outlineWidth) || 0,
        offset: parseFloat(c.outlineOffset) || 0,
        style: c.outlineStyle,
        radius: c.borderTopLeftRadius,
        shadow: c.boxShadow,
        color: c.outlineColor,
        bgUnder: 'rgb(' + b.map((v) => Math.round(v)).join(',') + ')',
      });
    }`));
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    steps++;

    // 期望的环面积（设备像素）：周长 × 线宽，容忍圆角与抗锯齿后取 35%
    const Fpix = before.w / cw;
    const expectRing = 2 * ((b.w + b.h) * Fpix) * (styles.width * Fpix) * 0.35;
    const fm = focusMeasure(before, after, 12, Math.max(3, Math.round(styles.width * Fpix + 2)));
    const coverage = expectRing > 0 ? Math.min(1, fm.n / expectRing) : 0;
    const item = {
      label: m.label, coverage, ring: fm.ring && hex(fm.ring), adj: fm.adj && hex(fm.adj),
      px: fm.n, outline: styles.outline, offset: styles.offset, shadow: styles.shadow.slice(0, 44), clip,
    };
    if (process.env.AUDIT_DEBUG) console.error('[dbg]', m.label, JSON.stringify({ rect: b, clip, cw, chh, n: fm.n, exp: Math.round(expectRing), Fpix, img: [before.w, before.h], op: m.op }));
    const styleOk = !(styles.style === 'none' || styles.width === 0);
    const adjC = fm.ring && fm.adj ? ratio(fm.ring, fm.adj) : 0;

    if (!styleOk) {
      if (coverage < 0.30) {
        fails.push({ ...item, note: '完全没有焦点指示：:focus-visible 下 outline 为 none，整片区域也没有像素变化' });
        continue;
      }
      warns.push({ ...item, note: '焦点由 box-shadow 承担（无 outline）。Windows 高对比模式会丢弃 box-shadow → 焦点将完全消失' });
      continue;
    }
    if (fm.n === 0) {
      // headless 偶尔不重绘：做一次「不改布局、只让合成器失效」的轻推再拍一次
      await evalIn(cdp, `(() => { document.documentElement.style.transform = 'translateZ(0)'; return 1 })()`);
      await settle(cdp);
      const retry = await shot(cdp, clip, FOCUS_DPR);
      await evalIn(cdp, `(() => { document.documentElement.style.transform = ''; return 1 })()`);
      const fm2 = focusMeasure(before, retry, 12, Math.max(3, Math.round(styles.width * Fpix + 2)));
      if (fm2.n > 0) { Object.assign(fm, fm2); }
    }
    if (fm.n === 0) {
      // 关键区分：像素没变，可能是「环没画」，也可能是「headless 没重绘」。
      // 只有后者才允许降级为「不可判定」——否则会把真实缺陷洗成灰。
      // 判据：forced 状态下 outline 若已有宽度却零像素变化 → 是没重绘。
      if (!(styles.style === 'none' || styles.width === 0)) {
        unmeasured.push({ ...item, note: '截图未重绘（outline 已生效但像素零变化）—— headless 抖动，需人工确认' });
      } else {
        fails.push({ ...item, note: '完全没有焦点指示：:focus-visible 下 outline 为 none，且无任何像素变化' });
      }
      continue;
    }
    if (coverage < 0.30) {
      fails.push({ ...item, note: `只检出 ${fm.n} 个变化像素（期望环面积 ${Math.round(expectRing)}），焦点指示未成形（可能被 overflow 裁掉或被同色覆盖）` });
      continue;
    }
    // 环的**存在性**由像素证明；环与相邻色的**对比**用计算色解析，
    // 因为 focus 样式往往同时改 box-shadow，像素均值会把环和光晕糊成一个中间色
    // （实测把纯青 #22E8FF 的环 + 光晕平均成 #1990A3，得出 2.87:1 的假失败）。
    const oc = parseRGB(styles.color);
    if (oc) {
      const bgUnder = parseRGB(styles.bgUnder) || { rgb: [11, 15, 30], a: 1 };
      const cSelf = ratio(oc.rgb, bgUnder.rgb);
      if (cSelf < 3) {
        fails.push({ ...item, note: `环色 ${hex(oc.rgb)} 对元素底色 ${hex(bgUnder.rgb)} 仅 ${cSelf.toFixed(2)}:1 < 3:1 —— WCAG 2.4.11` });
        continue;
      }
    }
    // 环与「元素自身发光」同色相：对比度达标（不是违规），但会被读成“它更亮了”，
    // 而不是“焦点在这”。这是本方案特有的坑：青环 + 青光晕。
    const g = glowHue(styles.shadow);
    const hRing = hueOf(fm.ring);
    // 只有 ≥17px 的扩散光（md/lg）才会在环这一圈形成“整块在发亮”的错觉；
    // 收到 sm（9px）之后光晕退到环外，环重新读作一条独立的线 —— 此时不再告警。
    // 这样「按建议收光」就能让这条 WARN 真的熄掉，门禁不会永远亮着一盏旧灯。
    if (g && g.s > 0.25 && g.blur >= 17 && hueGap(hRing.h, g.h) < 22) {
      warns.push({ ...item, note: `环与元素自身发光同色相（ΔH ${hueGap(hRing.h, g.h).toFixed(0)}°，环对相邻色 ${adjC.toFixed(2)}:1 合规）→ 建议 :focus-visible 时把发光收一档（lg→sm），否则读起来只是“它更亮了”` });
      continue;
    }
  }
  // 注意：这里 mobile 一律 false。mobile:true 会打开 meta-viewport 的视觉视口缩放，
  // 390 下 `getBoundingClientRect` 与截图裁剪像素不再 1:1，环带统计会整体落空
  // （实测 390 全页焦点覆盖率变成 0%，是假 FAIL）。审计要的是「390 CSS px 宽的布局」，
  // 不是移动端 UA 行为。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: 1, mobile: false,
  });
  return { fails, warns, skipped, unmeasured, steps };
}

/* ── ② 对比度 ───────────────────────────────────────────────────────── */

async function checkContrast(cdp) {
  await evalIn(cdp, 'window.scrollTo(0,0)');
  await settle(cdp);
  const probe = await evalIn(cdp, PROBE);
  const rects = probe.textRects.slice(0, 400);
  const fails = [], warns = [];
  let checked = 0;

  const band = Math.max(240, VH - 60);
  const chunks = new Map();
  for (const r of rects) {
    const k = Math.floor(r.y / band);
    if (!chunks.has(k)) chunks.set(k, []);
    chunks.get(k).push(r);
  }

  for (const [, list] of [...chunks.entries()].sort((a, b) => a[0] - b[0])) {
    const top = Math.min(...list.map((r) => r.y));
    const y = Math.max(0, Math.min(top - 40, Math.max(0, probe.docH - VH)));
    await evalIn(cdp, `window.scrollTo(0, ${y})`);
    await settle(cdp);
    const img = await shot(cdp, { x: 0, y: 0, w: VW, h: VH });
    for (const r of list) {
      const cx = r.x, cy = r.y - y;
      if (cy < 0 || cy + r.h > VH || cx < 0 || cx + r.w > VW) continue;
      const fg0 = parseRGB(r.color);
      if (!fg0) continue;
      let mc = modeColor(img, cx, cy, r.w, r.h);
      if (!mc) continue;
      let source = 'pixel';
      // 大字（96px 单字）会把文字矩形填满，众数就是字形本身的颜色 → 回退到 DOM 底色
      if (ratio(fg0.rgb, mc.rgb) < 1.25 && r.bgDom) {
        mc = { rgb: r.bgDom, share: 1 };
        source = 'dom';
      }
      const fg = fg0;
      const eff = fg.a >= 0.999 ? fg.rgb : over(fg.rgb, fg.a, mc.rgb);
      const cr = ratio(eff, mc.rgb);
      // 纯符号字形（· ✕ ✓ 分隔符/图标）按「非文字图形」判 3:1，不按文字 4.5 判：
      // 它不承载阅读内容，1.4.11 的非文字阈值才是对的口径。判完仍以 WARN 报出，
      // 这样它既不会变成新的噪音源，也不会被悄悄放过。
      const symbolOnly = /^[\s·•×✕✗✓★☆▲▼◀▶→←↑↓+\-–—/|:.,]+$/.test(r.text || '');
      const need = symbolOnly ? 3.0 : r.large ? 3.0 : 4.5;
      checked++;
      if (cr >= need) continue;
      const item = {
        sel: r.sel, text: r.text, cr: +cr.toFixed(2), need,
        bg: hex(mc.rgb), fg: hex(eff), fs: r.fs, share: +mc.share.toFixed(2),
        approx: mc.share < 0.12, near: need - cr < 0.15, source, symbolOnly,
      };
      // 众数占比过低 = 这个矩形里没有稳定的面（压在渐变/发光上）→ 降级 WARN
      // preview 对照页自身的标注（.lbl）不是产品 UI → 降级 WARN
      (item.approx || item.symbolOnly || /\.lbl$/.test(item.sel) ? warns : fails).push(item);
    }
  }
  return { fails, warns, checked, total: rects.length };
}

/* ── ③ 控件边界 ──────────────────────────────────────────────────────── */

/** 已知且已拍板的例外。只降级为 WARN，不拦构建 —— 但每条都必须写明理由。 */
const KNOWN = [
  {
    match: (c) => c.card,
    why: 'E-07：卡片边界 1.27:1 是有意不够。由 1px 描边划界 + 顶边受光条说明“这是一块面” + 卡面比卡间缝暗一档，三重冗余承担；WCAG 1.4.11「可由其他方式识别」豁免',
  },
];

async function checkBorder(cdp) {
  const probe = await evalIn(cdp, PROBE);
  const fails = [], warns = [];
  let ok = 0;
  for (const c of probe.controls) {
    if (!c.bw) { ok++; continue; }
    const bc = parseRGB(c.borderColor);
    if (!bc) continue;
    const eff = bc.a >= 0.999 ? bc.rgb : over(bc.rgb, bc.a, c.bg);
    const cr = ratio(eff, c.bg);
    const item = { sel: c.sel, text: c.text, bw: c.bw, border: hex(eff), bg: hex(c.bg), cr: +cr.toFixed(2) };
    if (c.isPrimary) { ok++; continue; }
    if (c.ariaDisabled) { ok++; continue; }   // 1.4.11 豁免 inactive 组件
    if (c.busy) { ok++; continue; }           // 另有文字 + 条纹双信号
    if (cr >= 3) { ok++; continue; }
    const k = KNOWN.find((x) => x.match(c));
    if (k) { warns.push({ ...item, note: k.why }); continue; }
    fails.push({ ...item, note: `控件边界 ${cr.toFixed(2)}:1 < 3:1（WCAG 1.4.11 非文字对比）` });
  }
  return { fails, warns, ok };
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. 主流程
   ═══════════════════════════════════════════════════════════════════════════ */

// 无 TTY / NO_COLOR / --no-color 时关掉颜色：CI 日志里的转义序列会被各种
// 查看器截断成 "mPASS" 这种残片，读起来像 bug。
const NO_COLOR = !process.stdout.isTTY || process.env.NO_COLOR || argv.includes('--no-color');
const C = NO_COLOR
  ? { r: '', d: '', b: '', red: '', yel: '', grn: '' }
  : { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m' };
const say = (...a) => { if (!QUIET) console.log(...a); };

async function main() {
  const t0 = Date.now();
  let srv, vite, chrome, cdp, UD = '';

  if (USE_VITE) {
    // --host 127.0.0.1 必须加：vite preview 默认只绑 [::1]，
    // 而脚本全程用 IPv4 —— 不加会连不上，CDP 拿到的是一张 Chrome 错误页，
    // 于是"审计通过"的其实是一张报错页（比没测更糟）。
    vite = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await sleep(250); }
    }
    say(`${C.d}服务：npx vite preview → dist${C.r}`);
  } else if (existsSync(PREVIEW)) {
    srv = await serve();
    say(`${C.d}服务：内置静态服务器 → preview/  （审计对象是 preview/*.html；要打 dist 用 --vite）${C.r}`);
  } else {
    // 没有设计对照页，直接打 dist：
    // 不要让工具在「找不到目录」上摔一跤。
    say(`${C.d}preview/ 已删除 → 自动改用 --vite 打 dist${C.r}`);
    vite = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await sleep(250); }
    }
  }

  const bin = findChromium();
  UD = await mkdtemp(join(tmpdir(), 'audit-ui-'));
  chrome = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--user-data-dir=${UD}`, '--remote-debugging-port=0',
    `--window-size=${VW},${VH}`, 'about:blank',
  ], { stdio: 'ignore' });

  let port = 0;
  for (let i = 0; i < 100; i++) {
    try {
      const t = (await readFile(join(UD, 'DevToolsActivePort'), 'utf8')).split('\n');
      if (t[0] && t[1]) { port = +t[0]; break; }
    } catch {}
    await sleep(150);
  }
  if (!port) throw new Error('Chromium 未就绪（DevToolsActivePort 未出现）');

  // 连页面级 WS（不要 Target.createTarget + flatten：本环境下新建 target 的
  // 渲染进程会崩，Inspector.targetCrashed，随后所有 Page/Runtime 命令超时）
  const ver = await fetchJSON(`http://127.0.0.1:${port}/json/version`);
  void ver;
  let pageWs = '';
  for (let i = 0; i < 40 && !pageWs; i++) {
    const list = await fetchJSON(`http://127.0.0.1:${port}/json/list`);
    const pg = list.find((t) => t.type === 'page');
    if (pg?.webSocketDebuggerUrl) pageWs = pg.webSocketDebuggerUrl;
    else await sleep(120);
  }
  if (!pageWs) throw new Error('找不到可用的 page target');
  cdp = await CDP.connect(pageWs);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 注意：这里 mobile 一律 false。mobile:true 会打开 meta-viewport 的视觉视口缩放，
  // 390 下 `getBoundingClientRect` 与截图裁剪像素不再 1:1，环带统计会整体落空
  // （实测 390 全页焦点覆盖率变成 0%，是假 FAIL）。审计要的是「390 CSS px 宽的布局」，
  // 不是移动端 UA 行为。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: 1, mobile: false,
  });

  await mkdir(SHOTS, { recursive: true });

  const report = { viewport: `${VW}×${VH}`, pages: {} };
  let totalFail = 0, totalWarn = 0;

  const targets = TARGET === 'app'
    ? ROUTES.map((r) => ({ name: 'app' + r, url: `http://127.0.0.1:${PORT}/index.html${r}` }))
    : PAGES.map((p) => ({ name: p, url: `http://127.0.0.1:${PORT}/${p}.html` }));

  for (const t of targets) {
    const p = t.name;
    say(`\n${C.b}━━ ${p}${C.r} ${C.d}${t.url}${C.r}`);
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(80);
    const loaded = new Promise((res) => {
      const h = (m) => {
        if (m.method === 'Page.loadEventFired') res();
      };
      cdp.on(h);
      setTimeout(res, 8000);
    });
    await cdp.send('Page.navigate', { url: t.url });
    await loaded;
    await sleep(280);
    if (TARGET === 'app') {
      // SPA 是异步挂载的：load 事件早于 mount。等 DOM 里真的长出可交互元素再测，
      // 否则会审到一张空壳页 —— 那是"全绿"的另一种假象。
      for (let i = 0; i < 60; i++) {
        const n = await evalIn(cdp, `document.querySelectorAll('a[href],button,input,summary').length`).catch(() => 0);
        if (n >= 5) break;
        await sleep(120);
      }
    }
    await evalIn(cdp, `(() => {
      const st = document.createElement('style');
      st.textContent = ${JSON.stringify(FREEZE)};
      document.head.appendChild(st);
      return 1;
    })()`);
    await settle(cdp);

    const out = {};

    if (ONLY.includes('contrast')) {
      out.contrast = await checkContrast(cdp);
      totalFail += out.contrast.fails.length;
      totalWarn += out.contrast.warns.length;
      const f = out.contrast.fails;
      say(`  ② 对比度    ${f.length ? `${C.red}FAIL ${f.length}${C.r}` : `${C.grn}PASS${C.r}`}  ${C.d}（检查 ${out.contrast.checked}/${out.contrast.total} 行）${C.r}`);
      for (const x of f.slice(0, 40)) {
        say(`     ${C.red}✗${C.r} ${x.cr}:1 < ${x.need}  ${C.d}${x.sel}${C.r} 「${x.text}」 ${C.d}${x.fs}px 字${x.fg} 底${x.bg}${C.r}`);
      }
      for (const x of out.contrast.warns.slice(0, 12)) {
        const why = x.symbolOnly ? '符号字形按非文字 3:1 判' : x.approx ? `众数占比 ${x.share}（近似）` : '对照页脚手架';
        say(`     ${C.yel}!${C.r} ${x.cr}:1 < ${x.need}  ${C.d}${x.sel} 「${x.text}」 —— ${why}${C.r}`);
      }
    }

    if (ONLY.includes('border')) {
      out.border = await checkBorder(cdp);
      totalFail += out.border.fails.length;
      totalWarn += out.border.warns.length;
      const f = out.border.fails;
      say(`  ③ 控件边界  ${f.length ? `${C.red}FAIL ${f.length}${C.r}` : `${C.grn}PASS${C.r}`}  ${C.d}（合规 ${out.border.ok}，已知例外 ${out.border.warns.length}）${C.r}`);
      for (const x of f) say(`     ${C.red}✗${C.r} ${x.cr}:1  ${C.d}${x.sel}${C.r} 「${x.text}」 描边${x.border} 底${x.bg}`);
      for (const x of out.border.warns.slice(0, 8)) say(`     ${C.yel}!${C.r} ${x.cr}:1  ${C.d}${x.sel} —— 已知：E-07${C.r}`);
    }

    if (ONLY.includes('focus') && MOBILE && !flag('mobile-focus')) {
      say(`  ① 焦点可见  ${C.yel}SKIP${C.r}  ${C.d}（390 下 headless 软件合成器会停止重绘，像素判定不可信；需要时加 --mobile-focus）${C.r}`);
    } else if (ONLY.includes('focus')) {
      out.focus = await checkFocus(cdp);
      totalFail += out.focus.fails.length;
      totalWarn += out.focus.warns.length;
      const f = out.focus.fails;
      const un = out.focus.unmeasured.length;
      say(`  ① 焦点可见  ${f.length ? `${C.red}FAIL ${f.length}${C.r}` : `${C.grn}PASS${C.r}`}  ${C.d}（${out.focus.steps - un} 个元素已判定，跳过 ${out.focus.skipped.length}，不可判定 ${un}）${C.r}`);
      for (const x of out.focus.unmeasured.slice(0, 6)) {
        say(`     ${C.yel}?${C.r} ${C.d}${x.label} —— ${x.note}${C.r}`);
      }
      for (const x of f) {
        say(`     ${C.red}✗${C.r} ${C.d}${x.label}${C.r}  ${C.d}覆盖 ${(x.coverage * 100).toFixed(0)}% 环${x.ring || '-'} 邻${x.adj || '-'}${C.r}`);
        say(`        ${C.d}${x.note}${C.r}`);
      }
      for (const x of out.focus.warns.slice(0, 10)) {
        say(`     ${C.yel}!${C.r} ${C.d}${x.label}${C.r} 环${x.ring}  ${C.d}${x.note}${C.r}`);
      }
    }

    report.pages[p] = out;
  }

  // ── 根因聚合：同一个令牌/同一个字号桶的失败合并，避免 45 行同源噪音
  const groupFail = [];
  for (const [pg, out] of Object.entries(report.pages)) {
    for (const k of ['contrast', 'border', 'focus']) {
      const f = out[k]?.fails || [];
      for (const x of f) {
        const key = k === 'contrast'
          ? `${k}|${x.fg}|${x.need}|${x.fs}`
          : `${k}|${k === 'border' ? x.border : x.outline}`;
        let g = groupFail.find((y) => y.key === key);
        if (!g) { g = { key, k, n: 0, sample: x, pages: new Set() }; groupFail.push(g); }
        g.n++; g.pages.add(pg);
      }
    }
  }
  groupFail.sort((a, b) => b.n - a.n);
  say(`\n${C.b}════ 根因聚合${C.r}  ${C.d}（同一令牌/同一字号桶合并）${C.r}`);
  for (const g of groupFail) {
    const x = g.sample;
    const head = g.k === 'contrast'
      ? `文字 ${x.fg} @${x.fs}px 需 ${x.need}:1`
      : g.k === 'border' ? `控件描边 ${x.border}` : `焦点环 ${x.outline}`;
    say(`   ${C.red}×${String(g.n).padStart(2)}${C.r}  ${head}   ${C.d}${[...g.pages].join(',')} · 例 ${x.sel}${C.r}`);
  }

  report.groups = groupFail.map((g) => ({ n: g.n, kind: g.k, head: g.sample.fg || g.sample.border || g.sample.outline, pages: [...g.pages] }));
  report.ms = Date.now() - t0;
  await writeFile(join(SHOTS, 'report.json'), JSON.stringify(report, null, 2));

  say(`\n${C.b}════ 汇总${C.r}  ${report.viewport}  ${(report.ms / 1000).toFixed(1)}s`);
  const nGroup = (report.groups || []).length;
  const topGroup = (report.groups || [])[0];
  say(`   FAIL ${totalFail ? `${C.red}${totalFail}${C.r}` : `${C.grn}0${C.r}`}   WARN ${totalWarn ? `${C.yel}${totalWarn}${C.r}` : '0'}   ${C.d}根因 ${nGroup} 类${topGroup ? `（最大一类 ×${topGroup.n}）` : ''}${C.r}`);
  say(`   ${C.d}明细 → ${join(SHOTS, 'report.json')}${C.r}`);
  console.log(totalFail ? `${C.red}验收未通过${C.r}` : `${C.grn}验收通过${C.r}`);

  try { cdp?.close(); } catch {}
  try { chrome?.kill('SIGKILL'); } catch {}
  try { vite?.kill('SIGKILL'); } catch {}
  try { srv?.close(); } catch {}
  if (!flag('keep')) { try { await rm(UD, { recursive: true, force: true }); } catch {} }
  process.exit(totalFail ? 1 : 0);
}

main().catch((e) => {
  console.error(`${C.red}${C.b}audit 崩溃${C.r}: ${e.message}\n${e.stack}`);
  process.exit(2);
});
