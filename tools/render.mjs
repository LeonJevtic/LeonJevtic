// Renders the profile images from the live site, so this profile follows jevtic.dev by itself.
// The site is shortened on the way through a local proxy, then recorded layer by layer and put back
// together as animated SVGs. Runs in mcr.microsoft.com/playwright:v1.49.1-noble, see .github/workflows.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = process.env.SITE ?? 'https://jevtic.dev';
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const FORCE = process.env.FORCE === 'true';
// On the site, but not here. It would need the repo, which is private.
const LEAVE_OUT = ['Advent of Code'];
const MAX_TEXT = 180;
const PORT = 8098;

const profileCss = `
.about { display: none; }
.projects { margin-top: 3.6rem; }
.projects li { margin-top: 2.1rem; }
.notes, .contact { margin-top: 3.8rem; }
.underground { padding-bottom: 3rem; }
/* Inside a picture nothing can be clicked, so nothing may look like a link. The strip with the mail address is its own link. */
.notes a { text-decoration: none; }

@media (min-aspect-ratio: 23/25) {
  .underground { font-size: 19px; }
  .lead, .projects, .notes, .contact { max-width: 66%; }
  .lead p { font-size: 30px; }
  .projects h2, .contact h2 { font-size: 62px; }
  .projects h3 { font-size: 32px; }
  .contact .mail { font-size: 38px; }
}

html[data-layer]:not([data-layer="base"]),
html[data-layer]:not([data-layer="base"]) body,
html[data-layer]:not([data-layer="base"]) .hero,
html[data-layer]:not([data-layer="base"]) .scene,
html[data-layer]:not([data-layer="base"]) .underground { background: none !important; }

html[data-layer="base"] #tree, html[data-layer="base"] #sway, html[data-layer="base"] #petals,
html[data-layer="base"] .name, html[data-layer="base"] .roots > :not(.stones),
html[data-layer="base"] .lead, html[data-layer="base"] .projects, html[data-layer="base"] .notes, html[data-layer="base"] .contact { visibility: hidden !important; }

html[data-layer="text"] body *:not(.lead, .lead *, .projects, .projects *, .notes, .notes *, .contact, .contact *) { visibility: hidden !important; }
html[data-layer="text"] :is(.lead, .projects, .notes, .contact), html[data-layer="text"] :is(.lead, .projects, .notes, .contact) * { visibility: visible !important; }

html[data-layer="tree"] body *:not(#tree):not(#sway),
html[data-layer="roots"] body *:not(.roots, .roots *),
html[data-layer="roots"] .stones,
html[data-layer="name"] body *:not(.name, .name *),
html[data-layer="petals"] body *:not(#petals) { visibility: hidden !important; }
html[data-layer="roots"] .roots, html[data-layer="roots"] .roots *:not(.stones) { visibility: visible !important; }
html[data-layer="name"] .name, html[data-layer="name"] .name * { visibility: visible !important; }
html[data-layer="petals"] #petals { visibility: visible !important; }
`;

function shorten(text) {
  const sentences = text.split(/(?<=[.?!])\s+/);
  let kept = sentences[0];
  for (const next of sentences.slice(1)) {
    if (kept.length + next.length + 1 > MAX_TEXT) break;
    kept += ` ${next}`;
  }
  return kept;
}

function rewrite(html) {
  let page = html
    .replace('</head>', '<link rel="stylesheet" href="/profile.css"></head>')
    .replace(/<footer>[\s\S]*?<\/footer>/, '')
    .replace(/<p>Or have a look at[\s\S]*?<\/p>/, '')
    .replace(/(<h3 data-root>.*?<\/h3><p>)(.*?)(<\/p>)/g, (_, open, text, close) => open + shorten(text) + close);
  for (const title of LEAVE_OUT) {
    page = page.replace(new RegExp(`<p><strong>(?:(?!</p>)[\\s\\S])*?${title}(?:(?!</p>)[\\s\\S])*?</p>\\n?`), '');
  }
  return page;
}

const response = await fetch(`${ORIGIN}/en/`);
if (!response.ok) throw new Error(`${ORIGIN}/en/ answered ${response.status}`);
const page = rewrite(await response.text());
if (!page.includes('class="name"')) throw new Error('The site no longer looks like expected: no name found.');

// The page names its asset folder by a hash of everything in it, so this covers text, code, styles and fonts.
const source = createHash('sha256').update(page).digest('hex');
const sourceFile = join(ASSETS, 'source.sha');
if (!FORCE && existsSync(sourceFile) && readFileSync(sourceFile, 'utf8').trim() === source) {
  console.log('The site has not changed, nothing to do.');
  process.exit(0);
}

const proxy = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/en/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
    return;
  }
  if (path === '/profile.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' }).end(profileCss);
    return;
  }
  const upstream = await fetch(ORIGIN + path);
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}).listen(PORT, '127.0.0.1');

process.env.CHROME ??= join('/ms-playwright', readdirSync('/ms-playwright').find((d) => d.startsWith('chromium-')), 'chrome-linux/chrome');
const { launch, sleep } = await import('./cdp.mjs');
const browser = await launch({ port: 9347, flags: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

async function record(device) {
  const { width, height, scale, mobile } = device;
  await browser.size(width, height, scale, mobile);
  const background = (color) => browser.send('Emulation.setDefaultBackgroundColorOverride', { color });
  await background({ r: 0, g: 0, b: 0, a: 0 });
  await browser.go('about:blank');
  await browser.go(`http://127.0.0.1:${PORT}/en/#debug`);
  await browser.waitGrown(240000);
  await sleep(3000);
  await browser.js(`document.documentElement.style.scrollBehavior = 'auto'; scrollTo(0, 0)`);

  const m = await browser.js(`(() => {
    const top = (s) => document.querySelector(s).getBoundingClientRect().top + scrollY;
    const box = document.querySelector('.name').getBoundingClientRect();
    return { ground: top('.underground'), contact: top('.contact'), page: document.documentElement.scrollHeight, name: { x: box.left, w: box.width } };
  })()`);
  const cut = Math.round(m.contact - 34);
  const take = async (format, y, h, quality) => (await browser.send('Page.captureScreenshot', {
    format, quality, captureBeyondViewport: true, clip: { x: 0, y, width, height: h, scale: 1 },
  })).data;
  const layer = async (name) => {
    await browser.js(name ? `document.documentElement.dataset.layer = ${JSON.stringify(name)}` : `delete document.documentElement.dataset.layer`);
    await sleep(400);
  };

  await layer(null);
  await background({ r: 3, g: 4, b: 10, a: 1 });
  const full = await take('jpeg', 0, cut, 86);
  const contact = await take('jpeg', cut, m.page - cut, 88);
  await layer('base');
  const base = await take('webp', 0, cut, 88);
  await background({ r: 0, g: 0, b: 0, a: 0 });
  await layer('tree');
  const tree = await take('webp', 0, Math.round(m.ground + 2), 86);
  await layer('roots');
  const roots = await take('webp', 0, cut, 84);
  // Its own layer, because on the site the text lies above the roots. Only below ground, so less has to be redrawn.
  const soilTop = Math.round(m.ground);
  await layer('text');
  const text = await take('webp', soilTop, cut - soilTop, 90);
  await layer('name');
  const name = await take('webp', 0, Math.round(m.ground), 92);
  await layer('petals');
  const fallen = await take('webp', 0, Math.round(m.ground + 2), 86);
  await layer(null);

  // Where petals can rest on the letters and where the trunk stands, read from the layers themselves.
  const scan = await browser.js(`(async () => {
    const load = async (b64) => { const img = new Image(); img.src = 'data:image/webp;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0); return x; };
    const n = await load(${JSON.stringify(name)});
    const rests = [];
    for (let i = 0; i < 14; i++) {
      const px = Math.round((${m.name.x} + ${m.name.w} * (i + 0.5) / 14) * ${scale});
      const col = n.getImageData(px, 0, 1, n.canvas.height).data;
      for (let y = 0; y < n.canvas.height; y++) if (col[y * 4 + 3] > 150) { rests.push([px, y]); break; }
    }
    const t = await load(${JSON.stringify(tree)});
    const row = Math.round(${m.ground} * ${scale}) - 8;
    const line = t.getImageData(0, row, t.canvas.width, 1).data;
    let best = [0, 0], start = -1;
    for (let x = 0; x <= t.canvas.width; x++) {
      const on = x < t.canvas.width && line[x * 4 + 3] > 150;
      if (on && start < 0) start = x;
      if (!on && start >= 0) { if (x - start > best[1] - best[0]) best = [start, x]; start = -1; }
    }
    return { rests, trunk: [(best[0] + best[1]) / 2, row], trunkWidth: best[1] - best[0], treeSize: [t.canvas.width, t.canvas.height] };
  })()`);
  if (scan.rests.length < 3 || scan.trunkWidth < 20) throw new Error(`${device.name}: layers look wrong: ${JSON.stringify(scan)}`);

  return {
    ...scan, full, contact, base, tree, roots, text, name, fallen,
    W: Math.round(width * scale), H: Math.round(cut * scale), ground: Math.round(m.ground * scale),
    textY: Math.round(soilTop * scale), textH: Math.round((cut - soilTop) * scale),
    stripH: Math.round((m.page - cut) * scale),
  };
}

// ---------- Putting it back together ----------

const ALT = 'Leon Jevtić. A cherry tree in bloom at night, with roots in the soil that lead to my introduction and my projects.';
const PETAL = 'M0 0C13.5-8.36 14.7-31.16 3-37.24Q0-31.92-3-37.24C-14.7-31.16-13.5-8.36 0 0Z';
const TREE_DONE = 4.2;
const ROOTS_DONE = 6.6;
const webp = (b64) => `data:image/webp;base64,${b64}`;
const jpeg = (b64) => `data:image/jpeg;base64,${b64}`;

function randomFrom(seed) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { uniform: (min, max) => min + (max - min) * next(), pick: (list) => list[Math.floor(next() * list.length)] };
}

function petals(art, count, sizes, xs) {
  const rng = randomFrom(11);
  // Only on the low letters of the first line. A petal on the L or next to the ć would read as an accent in the name.
  const top = art.rests[0][1];
  const rests = art.rests.filter((r) => r[1] > top + 30 && r[1] < top + 95).slice(0, 5);
  const css = [];
  const groups = [];
  for (let i = 0; i < count + rests.length; i++) {
    const rest = i >= count ? rests[i - count] : null;
    const x0 = rest ? rest[0] + rng.uniform(40, 150) : rng.uniform(...xs);
    const y0 = rng.uniform(0.14, 0.46) * art.ground;
    const x1 = rest ? rest[0] : x0 + rng.uniform(-170, 70);
    const y1 = rest ? rest[1] - 3 : art.ground - rng.uniform(0, 8);
    const sway = rng.uniform(14, 34);
    const waves = rng.pick([1, 2]);
    const fall = (y1 - y0) / rng.uniform(46, 64);
    const size = rng.uniform(...sizes).toFixed(2);
    const alpha = rng.uniform(0.82, 1).toFixed(2);
    const duration = rest ? fall / 0.6 : fall;
    const delay = rest ? TREE_DONE + rng.uniform(0, 16) : TREE_DONE - 1 + rng.uniform(0, duration);
    const stops = rest ? [0, 5, 20, 40, 60] : [0, 6, 25, 50, 75, 94, 100];
    const span = rest ? 60 : 100;
    const steps = stops.map((percent) => {
      const t = percent / span;
      const swing = rest && percent === span ? 0 : sway * Math.sin(t * waves * Math.PI * 2);
      const seen = percent === 0 || (!rest && percent === 100) ? 0 : alpha;
      return `${percent}%{transform:translate(${(x0 + (x1 - x0) * t + swing).toFixed(1)}px,${(y0 + (y1 - y0) * t).toFixed(1)}px);opacity:${seen}}`;
    });
    if (rest) {
      const at = `translate(${x1.toFixed(1)}px,${y1.toFixed(1)}px)`;
      steps.push(`92%{transform:${at};opacity:${alpha}}100%{transform:${at};opacity:0}`);
    }
    css.push(`@keyframes f${i}{${steps.join('')}}`);
    let inner;
    if (rest) {
      const turns = [0, 12, 24, 36, 48].map((percent, k) => `${percent}%{transform:rotate(${k % 2 ? 58 : -38}deg) scale(${k % 2 ? 0.42 : 1},1)}`);
      css.push(`@keyframes r${i}{${turns.join('')}60%,100%{transform:rotate(90deg) scale(.5,1)}}`);
      inner = `animation:r${i} ${duration.toFixed(1)}s ease-in-out ${delay.toFixed(1)}s infinite both`;
    } else {
      const tumble = rng.uniform(2.2, 4.2);
      inner = `animation:t ${tumble.toFixed(1)}s ease-in-out ${(-rng.uniform(0, tumble)).toFixed(1)}s infinite alternate`;
    }
    groups.push(`<g class="f" style="animation:f${i} ${duration.toFixed(1)}s linear ${delay.toFixed(1)}s infinite both"><g style="${inner}"><use href="#p" transform="scale(${size}) translate(0 19)"/></g></g>`);
  }
  return { css: css.join(''), groups: groups.join('') };
}

function animatedSvg(art, count, sizes, xs, wipeRoots) {
  const { W, H, ground } = art;
  const [tx, ty] = art.trunk;
  const [treeW, treeH] = art.treeSize;
  const reach = Math.round(Math.hypot(Math.max(tx, W - tx), ty) * 1.3);
  const { css, groups } = petals(art, count, sizes, xs);
  const rootsLayer = wipeRoots
    ? `<g class="once" style="animation-duration:${ROOTS_DONE}s" mask="url(#mr)"><use href="#imgRoots"/></g><g class="after" style="animation-delay:${ROOTS_DONE}s"><use href="#imgRoots"/></g>`
    : '<g class="rootsIn"><use href="#imgRoots"/></g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${ALT}">
<title>Leon Jevtić</title>
<style>
.grow{transform-origin:${tx}px ${ty}px;animation:grow ${TREE_DONE - 0.3}s cubic-bezier(.3,.55,.35,1) .1s both}
@keyframes grow{from{transform:scale(.02)}to{transform:scale(1)}}
.wipe{animation:wipe 3.8s cubic-bezier(.35,.2,.45,1) 2.5s both}
@keyframes wipe{from{transform:translateY(${ground}px)}to{transform:translateY(${H + 500}px)}}
.once{opacity:0;animation:once steps(1,end) both}
@keyframes once{0%{opacity:1}100%{opacity:0}}
.after{animation:after .01s linear both}
@keyframes after{from{opacity:0}to{opacity:1}}
.rootsIn{animation:fade 1.6s ease-out 1.8s both}
.sway{transform-origin:${tx}px ${ty}px;animation:sway 11s ease-in-out ${TREE_DONE}s infinite}
@keyframes sway{0%,100%{transform:skewX(0)}25%{transform:skewX(.42deg)}75%{transform:skewX(-.32deg)}}
.name{animation:rise 1.5s cubic-bezier(.2,.7,.3,1) 1.3s both}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.land{animation:fade 5s ease-in 5s both}
@keyframes fade{from{opacity:0}to{opacity:1}}
.f{opacity:0}
@keyframes t{from{transform:rotate(-38deg) scale(1,1)}to{transform:rotate(58deg) scale(.42,1)}}
${css}
</style>
<defs>
<clipPath id="c"><path d="M0 12a12 12 0 0 1 12-12H${W - 12}a12 12 0 0 1 12 12V${H}H0Z"/></clipPath>
<radialGradient id="s"><stop offset=".8" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
<linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="${(1 - 420 / (H + 500)).toFixed(4)}" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
<mask id="mg" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${treeH}"><rect width="${W}" height="${treeH}" fill="#000"/><circle class="grow" cx="${tx}" cy="${ty}" r="${reach}" fill="url(#s)"/></mask>
<mask id="mr" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000"/><rect class="wipe" y="${-(H + 500)}" width="${W}" height="${H + 500}" fill="url(#w)"/></mask>
<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="-38"><stop offset="0" stop-color="#ee4680"/><stop offset=".36" stop-color="#ffcee0"/><stop offset="1" stop-color="#fff0f6"/></linearGradient>
<path id="p" fill="url(#g)" d="${PETAL}"/>
<image id="imgTree" width="${treeW}" height="${treeH}" href="${webp(art.tree)}"/>
<image id="imgRoots" width="${W}" height="${H}" href="${webp(art.roots)}"/>
</defs>
<g clip-path="url(#c)">
<image width="${W}" height="${H}" href="${webp(art.base)}"/>
${rootsLayer}
<image y="${art.textY}" width="${W}" height="${art.textH}" href="${webp(art.text)}"/>
<g class="once" style="animation-duration:${TREE_DONE}s" mask="url(#mg)"><use href="#imgTree"/></g>
<g class="after" style="animation-delay:${TREE_DONE}s"><g class="sway"><use href="#imgTree"/></g></g>
<image class="name" width="${W}" height="${ground}" href="${webp(art.name)}"/>
<image class="land" width="${treeW}" height="${treeH}" href="${webp(art.fallen)}"/>
${groups}
</g>
</svg>
`;
}

// The strip with the mail address is a link of its own, so it only rounds its lower corners.
const contactSvg = ({ W, stripH, contact }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${stripH}" width="${W}" height="${stripH}" role="img" aria-label="Write to me: leon@jevtic.dev">
<title>Write to me: leon@jevtic.dev</title>
<clipPath id="c"><path d="M0 0H${W}V${stripH - 12}a12 12 0 0 1-12 12H12a12 12 0 0 1-12-12Z"/></clipPath>
<image clip-path="url(#c)" width="${W}" height="${stripH}" href="${jpeg(contact)}"/>
</svg>
`;

// ---------- Writing, only once everything has worked ----------

const work = mkdtempSync(join(tmpdir(), 'profile-'));
const write = (name, content) => writeFileSync(join(work, name), content);
const wide = await record({ name: 'wide', width: 1000, height: 540, scale: 1.66, mobile: false });
write('wide.svg', animatedSvg(wide, 14, [0.36, 0.56], [30, 1480], true));
write('wide.jpg', Buffer.from(wide.full, 'base64'));
write('contact-wide.svg', contactSvg(wide));
const phone = await record({ name: 'phone', width: 390, height: 760, scale: 2, mobile: true });
write('phone.svg', animatedSvg(phone, 10, [0.42, 0.62], [30, 700], false));
write('phone.jpg', Buffer.from(phone.full, 'base64'));
write('contact-phone.svg', contactSvg(phone));
write('source.sha', `${source}\n`);
browser.close();
proxy.close();

mkdirSync(ASSETS, { recursive: true });
for (const file of readdirSync(work)) {
  if (file !== 'source.sha' && statSync(join(work, file)).size < 5000) throw new Error(`${file} is suspiciously small`);
}
for (const file of readdirSync(work)) {
  copyFileSync(join(work, file), join(ASSETS, file));
  console.log(file, Math.round(statSync(join(work, file)).size / 1024), 'KB');
}
rmSync(work, { recursive: true, force: true });
await sleep(800);
process.exit(0);
