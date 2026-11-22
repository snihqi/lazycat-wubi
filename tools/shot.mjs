#!/usr/bin/env node
/**
 * tools/shot.mjs — 单页截图（调试用，不进产物）
 *
 *   node tools/shot.mjs --url=http://127.0.0.1:5173/#/ --out=.shot/home.png
 *   node tools/shot.mjs --url=... --w=1440 --h=900 --full=1 --wait=900
 *   node tools/shot.mjs --url=... --click=.cadd --click2='[data-grp=char] .card'
 *
 * 零依赖：只用 Node 内置模块 + 本机 Chromium（CDP over WebSocket）。
 * 存档可用 --seed=file.json 注入（Page.addScriptToEvaluateOnNewDocument，
 * 不走 evaluate，避免 store.load() 的兜底把档标脏）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const arg = (name, dflt = '') => {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : dflt;
};

function findChromium() {
  const cands = [
    process.env.AUDIT_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
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
  throw new Error('找不到 Chromium');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) for (const l of this.listeners) l(m);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws fail ' + url)), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(findChromium(), [
  // --no-sandbox 不能省：这台机器上不带它，渲染进程会 Inspector.targetCrashed，
  // 之后所有 Page/Runtime 命令静默超时（跟 audit-ui.mjs 同一套参数）。
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--mute-audio', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--remote-debugging-port=${port}`, '--window-size=1440,900',
  '--user-data-dir=/tmp/shot-profile-' + port, 'about:blank',
], { stdio: 'ignore' });

/* 连的是**页面级** WS。不要 Target.createTarget + flatten：本环境下新建 target 的
   渲染进程会崩，随后所有 Page/Runtime 命令超时。 */
let wsUrl = '';
for (let i = 0; i < 100 && !wsUrl; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pg = list.find((t) => t.type === 'page');
    if (pg?.webSocketDebuggerUrl) wsUrl = pg.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await sleep(120);
}
if (!wsUrl) { chrome.kill(); throw new Error('chromium 没起来'); }

const cdp = await CDP.connect(wsUrl);

const W = Number(arg('w', '1440'));
const H = Number(arg('h', '900'));
const url = arg('url', 'http://127.0.0.1:5173/#/');
const out = resolve(arg('out', '.shot/shot.png'));
const wait = Number(arg('wait', '900'));

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 2, mobile: false,
});

const seed = arg('seed');
if (seed && existsSync(seed)) {
  const json = readFileSync(seed, 'utf8').trim();
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('lazycat-wubi/v1', ${JSON.stringify(json)});}catch(e){}`,
  });
}

await cdp.send('Page.navigate', { url });
await sleep(wait);

for (const key of ['click', 'click2', 'click3']) {
  const sel = arg(key);
  if (!sel) continue;
  await cdp.send('Runtime.evaluate', {
    expression: `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e)e.click();return !!e})()`,
  });
  await sleep(500);
}

const evalJS = arg('eval');
if (evalJS) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: evalJS, returnByValue: true, awaitPromise: true,
  });
  console.log(JSON.stringify(r, null, 2).slice(0,1200));
  await sleep(300);
}

const full = arg('full', '0') === '1';
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  ...(full ? { captureBeyondViewport: true } : {}),
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);

cdp.close();
chrome.kill();
