// Drives a local headless Chrome over the DevTools protocol. Test tooling only, not part of the project.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, flags = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const gpu = process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : [];
  const chrome = spawn(process.env.CHROME ?? 'C:\\chrome-win64\\chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', ...gpu, ...flags, 'about:blank',
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const problems = [];
  const requests = [];
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) problems.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    socket.send(JSON.stringify({ id: n, method, params }));
  });
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await send(`${d}.enable`);

  const page = {
    send, problems, requests,
    async size(width, height, scale = 1, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    },
    async go(url) {
      requests.length = 0;
      await send('Page.navigate', { url });
      await sleep(200);
      for (let i = 0; i < 100; i++) {
        if ((await page.js('document.readyState')) === 'complete') return;
        await sleep(100);
      }
    },
    async js(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async stats() { return page.js('window.__scene ? window.__scene.stats() : null'); },
    async waitGrown(ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const s = await page.stats(); if (s?.grown) return s; await sleep(150); }
      throw new Error('tree never finished growing');
    },
    async shot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, Buffer.from(data, 'base64'));
    },
    // Real frame rate from requestAnimationFrame, in this page.
    async fps(ms = 2500) {
      return page.js(`new Promise((res) => { let n = 0; const t0 = performance.now(); const tick = (t) => { n++; if (t - t0 < ${ms}) requestAnimationFrame(tick); else res(Math.round(n / ((t - t0) / 1000))); }; requestAnimationFrame(tick); })`);
    },
    close() { socket.close(); chrome.kill(); setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 800); },
  };
  return page;
}
