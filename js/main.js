import { Bath } from './bath.js';
import { Synth, noteName } from './synth.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wait = ms => new Promise(r => setTimeout(r, ms));
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.documentElement;

const BATH = hex('#0d1440');

const INKS = [
  { name: 'Lapis', voice: 'pad', label: 'nappe', hex: '#3d63d6', oct: 0 },
  { name: 'Garance', voice: 'bell', label: 'cloche', hex: '#c0352b', oct: 12 },
  { name: 'Safran', voice: 'pluck', label: 'corde', hex: '#eea628', oct: 0 },
  { name: 'Malachite', voice: 'bass', label: 'basse', hex: '#1f8a68', oct: -12 },
  { name: 'Craie', voice: 'breath', label: 'souffle', hex: '#efe5cf', oct: 12 },
].map(i => ({ ...i, rgb: hex(i.hex) }));

const PATTERNS = {
  battal: { name: 'Battal', root: 62, scale: [0, 2, 3, 5, 7, 9, 10] },
  gelgit: { name: 'Gelgit', root: 57, scale: [0, 3, 5, 7, 10] },
  tarakli: { name: 'Taraklı', root: 60, scale: [0, 2, 4, 6, 7, 9, 11] },
  bulbul: { name: 'Bülbül yuvası', root: 62, scale: [0, 1, 4, 5, 7, 8, 10] },
  sal: { name: 'Şal', root: 55, scale: [0, 2, 4, 7, 9] },
};

const state = {
  ink: 0,
  pattern: 'battal',
  drops: 0,
  prints: 0,
  energy: 0,
  note: null,
  mutedByUser: false,
  lastTouch: performance.now(),
  played: false,
};

const canvas = $('#bath');
const bath = new Bath(canvas);
const glOK = bath.init();
if (glOK) bath.setPalette([BATH, ...INKS.map(i => i.rgb)]);
else root.classList.add('no-gl');

const synth = new Synth();

// ---------- Musique ----------

function degreeToMidi(d, ink) {
  const P = PATTERNS[state.pattern], n = P.scale.length;
  return P.root - 12 + 12 * Math.floor(d / n) + P.scale[((d % n) + n) % n] + ink.oct;
}

// Horizontal position picks a degree across two octaves of the current scale.
function pitchAt(u, ink) {
  const n = PATTERNS[state.pattern].scale.length, total = n * 2 + 1;
  return degreeToMidi(clamp(Math.floor(u * total), 0, total - 1), ink);
}

function bump(e) { state.energy = clamp(state.energy + e, 0, 1); }

function showNote(m) { state.note = m; }

function audioStart() {
  if (state.mutedByUser) return;
  synth.start().catch(() => {});
  synth.setRoot(PATTERNS[state.pattern].root - 12);
  setSoundUI(true);
}

function setSoundUI(on) {
  const b = $('#sound');
  b.setAttribute('aria-pressed', String(on));
  $('.sound-label', b).textContent = on ? 'Son actif' : 'Son coupé';
}

$('#sound').addEventListener('click', () => {
  if (synth.running) {
    state.mutedByUser = true;
    synth.setMuted(true);
    setSoundUI(false);
  } else {
    state.mutedByUser = false;
    audioStart();
  }
});

// ---------- Gouttes ----------

function dropAt(u, v, opts = {}) {
  if (!glOK) return;
  const ink = INKS[opts.ink ?? state.ink];
  const r = opts.r ?? rand(0.035, 0.068);
  bath.drop(u * bath.aspect, v, r, ink.rgb, opts.dur ?? (reduced ? 0.01 : 0.6), opts.delay ?? 0);
  state.drops++;
  if (opts.silent) return;
  const m = opts.degree != null ? degreeToMidi(opts.degree, ink) : pitchAt(u, ink);
  synth.note(m, ink.voice, { vel: opts.vel ?? 0.75, pan: u * 2 - 1, bright: v, at: opts.delay ?? 0 });
  if (opts.delay) setTimeout(() => showNote(m), opts.delay * 1000); else showNote(m);
  bump(opts.energy ?? 0.12);
}

function touched() {
  state.lastTouch = performance.now();
  if (!state.played) {
    state.played = true;
    root.classList.add('played');
  }
}

// ---------- Le titre, posé à l'encre ----------

const fontsReady = Promise.race([
  document.fonts ? document.fonts.load('900 extra-expanded 120px Anybody') : Promise.resolve(),
  wait(2200),
]).catch(() => {});

function titleMask() {
  const [W, H] = bath.dyeSize;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const font = s => {
    g.font = `900 extra-expanded ${s}px Anybody, "Arial Black", sans-serif`;
    if ('fontStretch' in g) g.fontStretch = 'extra-expanded';
    if ('letterSpacing' in g) g.letterSpacing = `${-s * 0.012}px`;
  };
  let size = H * 0.3;
  font(size);
  size *= (W * (W / H < 1 ? 0.88 : 0.72)) / g.measureText('HOULE').width;
  size = Math.min(size, H * 0.36);
  font(size);
  const m = g.measureText('HOULE');
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText('HOULE', W / 2, H * 0.34 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  return c;
}

const INTRO_ORDER = [0, 1, 2, 3, 0, 2, 1, 3, 4];

async function intro() {
  if (!glOK) return;
  const t0 = performance.now();
  bath.clearOps();
  bath.fill(BATH);
  const A = bath.aspect, small = innerWidth < 700;
  const n = small ? 16 : 28;
  const step = reduced ? 0 : 0.075;
  for (let i = 0; i < n; i++) {
    const ink = INKS[INTRO_ORDER[i % INTRO_ORDER.length]];
    const r = rand(0.04, 0.115) * (small ? 0.8 : 1) * (i < 5 ? 1.35 : 1);
    bath.drop(rand(0.03, 0.97) * A, rand(0.05, 0.95), r, ink.rgb, reduced ? 0.01 : 0.75, 0.25 + i * step);
  }
  state.drops += n;
  await fontsReady;
  const late = (performance.now() - t0) / 1000;
  const tStamp = Math.max(0, (reduced ? 0 : 0.5 + n * step) - late);
  bath.stamp(titleMask(), INKS[4].rgb, reduced ? 0.01 : 0.9, tStamp);
  if (!reduced) {
    bath.tine({ origin: [0, 0.16], dir: [1, 0], amount: 0.26, lambda: 0.035, width: 0.28, dur: 2.4, delay: tStamp + 0.8 });
    bath.tine({ origin: [0, 0.88], dir: [-1, 0], amount: 0.2, lambda: 0.03, width: 0.28, dur: 2.4, delay: tStamp + 1.3 });
  }
}

// ---------- Motifs ----------

function arp(degrees, start, stepT, voice, vel, inkIdx = state.ink) {
  const ink = INKS[inkIdx];
  degrees.forEach((d, i) => {
    const m = degreeToMidi(d, ink);
    synth.note(m, voice ?? ink.voice, { vel, pan: Math.sin(i * 0.9) * 0.6, bright: 0.6, at: start + i * stepT });
    setTimeout(() => showNote(m), (start + i * stepT) * 1000);
  });
}

const range = (a, b) => (a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : Array.from({ length: a - b + 1 }, (_, i) => a - i));

function runPattern(id) {
  state.pattern = id;
  const P = PATTERNS[id];
  synth.setRoot(P.root - 12);
  $$('[data-pattern]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pattern === id)));
  $('#hud-pattern').textContent = P.name;
  if (!glOK) return;
  touched();
  const A = bath.aspect;
  const D = reduced ? 0.01 : 1;

  switch (id) {
    case 'battal': {
      for (let i = 0; i < 22; i++) {
        const u = rand(0.04, 0.96);
        dropAt(u, rand(0.06, 0.94), { ink: (state.ink + (i % 4)) % 5, r: rand(0.025, 0.07), delay: i * 0.09 * D, vel: 0.32, energy: 0.03 });
      }
      break;
    }
    case 'gelgit': {
      bath.tine({ origin: [0, 0.5], dir: [1, 0], spacing: 0.15, amount: 0.15, lambda: 0.02, width: 0.2, dur: 1.4 * D });
      bath.tine({ origin: [0, 0.575], dir: [-1, 0], spacing: 0.15, amount: 0.15, lambda: 0.02, width: 0.2, dur: 1.4 * D, delay: 1.2 * D });
      arp(range(0, 9), 0, 0.13 * D, 'pluck', 0.4);
      arp(range(10, 1), 1.25 * D, 0.13 * D, 'pluck', 0.4);
      break;
    }
    case 'tarakli': {
      bath.tine({ origin: [0, 0], dir: [0, 1], spacing: 0.18, amount: 0.14, lambda: 0.02, width: 0.22, dur: 1.2 * D });
      bath.tine({ origin: [0.09, 0], dir: [0, -1], spacing: 0.18, amount: 0.14, lambda: 0.02, width: 0.22, dur: 1.2 * D, delay: 1 * D });
      bath.tine({ origin: [0, 0.02], dir: [1, 0], spacing: 0.045, amount: 0.05, lambda: 0.008, width: 0.25, dur: 1.6 * D, delay: 2.1 * D });
      arp(range(0, 7), 0, 0.14 * D, 'bell', 0.32);
      arp(range(14, 0), 2.1 * D, 0.1 * D, 'pluck', 0.3);
      break;
    }
    case 'bulbul': {
      bath.tine({ origin: [0, 0.5], dir: [1, 0], spacing: 0.16, amount: 0.14, lambda: 0.02, width: 0.2, dur: 1.1 * D });
      const cols = Math.max(2, Math.round(A / 0.24)), rows = 4;
      let k = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = (c + 0.5) * A / cols + (r % 2 ? A / cols / 2 : 0), y = (r + 0.5) / rows;
          const delay = (1 + k * 0.07) * D;
          bath.vortex({ center: [x, y], angle: (r + c) % 2 ? 6.5 : -6.5, sigma: 0.075, dur: 1.1 * D, delay });
          k++;
        }
      }
      arp([0, 1, 4, 5, 7, 8, 7, 5, 4, 1, 0, -2, 0], 0.9 * D, 0.16 * D, 'bell', 0.34);
      break;
    }
    case 'sal': {
      bath.wave({ dir: [1, 0], amount: 0.06, freq: Math.PI * 2 / 0.24, dur: 1.6 * D });
      bath.wave({ dir: [0, 1], amount: 0.035, freq: Math.PI * 2 / 0.3, phase: 1, dur: 1.4 * D, delay: 1.2 * D });
      bath.tine({ origin: [0, 0], dir: [0, 1], spacing: 0.05, amount: 0.04, lambda: 0.008, width: 0.25, dur: 1.5 * D, delay: 2.4 * D });
      [0, 2, 4].forEach((d, i) => synth.note(degreeToMidi(d, INKS[0]), 'pad', { vel: 0.5, pan: i - 1, at: i * 0.05 }));
      arp(range(0, 10), 2.4 * D, 0.12 * D, 'breath', 0.35);
      break;
    }
  }
  bump(0.55);
  announce(`Motif ${P.name}`);
}

$$('[data-pattern]').forEach(b => b.addEventListener('click', () => {
  audioStart();
  runPattern(b.dataset.pattern);
}));

// ---------- Encres ----------

function setInk(i) {
  state.ink = i;
  const ink = INKS[i];
  $$('.pot').forEach(p => p.setAttribute('aria-checked', String(+p.dataset.ink === i)));
  $('#dock-ink').innerHTML = `${ink.name}<small>${ink.label}</small>`;
  $('#stylus').style.setProperty('--cur', ink.hex);
  $$('.band').forEach(b => b.classList.toggle('active', +b.dataset.ink === i));
  $$('[data-choose]').forEach(b => { b.textContent = +b.dataset.choose === i ? 'Encre en main' : 'Prendre cette encre'; });
}

$$('.pot').forEach(p => p.addEventListener('click', () => setInk(+p.dataset.ink)));
$$('[data-choose]').forEach(b => b.addEventListener('click', () => {
  setInk(+b.dataset.choose);
  announce(`Encre ${INKS[state.ink].name} choisie`);
}));
$$('[data-listen]').forEach(b => b.addEventListener('click', () => {
  audioStart();
  const i = +b.dataset.listen;
  arp([0, 2, 4, 7], 0.02, 0.22, INKS[i].voice, 0.6, i);
}));

// Long ink names are narrowed along Anybody's width axis until they fit their band on one line.
function fitBands() {
  for (const h of $$('.band h3')) {
    const avail = h.clientWidth;
    const range = document.createRange();
    range.selectNodeContents(h);
    h.style.transition = 'none';
    let lo = 50, hi = 150;
    h.style.setProperty('--fit', hi);
    if (range.getBoundingClientRect().width > avail) {
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        h.style.setProperty('--fit', mid);
        if (range.getBoundingClientRect().width > avail) hi = mid; else lo = mid;
      }
      h.style.setProperty('--fit', lo.toFixed(1));
    }
    void h.offsetWidth;
    h.style.transition = '';
  }
}
(document.fonts ? document.fonts.ready : Promise.resolve()).then(fitBands);
let fitTimer = 0;
addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitBands, 150); });

// ---------- Le stylet : souris, doigt, clavier ----------

const stylus = $('#stylus');
const ptr = { down: false, id: null, type: 'mouse', u: 0, v: 0, x: 0, y: 0, t: 0, moved: 0, bowing: false };

const uvOf = e => [e.clientX / innerWidth, 1 - e.clientY / innerHeight];
const onBath = t => !!t.closest?.('[data-bath]') && !t.closest('a, button, .panel, .nav, .dock');

addEventListener('pointerdown', e => {
  if (!glOK || e.button > 0 || !onBath(e.target)) return;
  ptr.down = true;
  ptr.id = e.pointerId;
  ptr.type = e.pointerType;
  ptr.moved = 0;
  ptr.bowing = false;
  [ptr.u, ptr.v] = uvOf(e);
  ptr.x = e.clientX;
  ptr.y = e.clientY;
  ptr.t = performance.now();
  audioStart();
  if (e.pointerType === 'mouse') {
    e.preventDefault();
    dropAt(ptr.u, ptr.v);
  }
  stylus.classList.add('down');
  touched();
});

addEventListener('pointermove', e => {
  const [u, v] = uvOf(e);
  if (glOK) bath.setLight(u, v);
  if (e.pointerType === 'mouse') {
    stylus.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
    stylus.classList.toggle('on', onBath(e.target));
  }
  if (!ptr.down || e.pointerId !== ptr.id) return;
  ptr.moved += Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y);
  ptr.x = e.clientX;
  ptr.y = e.clientY;
  if (ptr.moved > 6) {
    let du = u - ptr.u, dv = v - ptr.v;
    if (bath.aspect < 1) du *= bath.aspect;
    bath.splat(u, v, du * 6000, dv * 6000);
    const now = performance.now(), dt = Math.max(8, now - ptr.t) / 1000;
    ptr.t = now;
    const speed = clamp(Math.hypot(du * bath.aspect, dv) / dt / 2, 0, 1);
    const m = pitchAt(u, INKS[state.ink]);
    if (!ptr.bowing) { synth.bowStart(m); ptr.bowing = true; }
    synth.bowMove(m, speed, u * 2 - 1);
    showNote(m);
    bump(speed * 0.05);
    state.lastTouch = performance.now();
  }
  ptr.u = u;
  ptr.v = v;
});

function release(e) {
  if (!ptr.down || e.pointerId !== ptr.id) return;
  ptr.down = false;
  stylus.classList.remove('down');
  if (ptr.bowing) synth.bowEnd();
  else if (ptr.type !== 'mouse' && e.type === 'pointerup' && ptr.moved < 12) {
    audioStart();
    dropAt(ptr.u, ptr.v);
  }
}
addEventListener('pointerup', release);
addEventListener('pointercancel', release);
document.addEventListener('pointerleave', () => stylus.classList.remove('on'));

// The home row plays the scale: Q S D F G H J K L M on AZERTY, A…; on QWERTY.
const ROW = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
const INK_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];

addEventListener('keydown', e => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const i = ROW.indexOf(e.code);
  if (i >= 0 && glOK && bathVisible) {
    audioStart();
    dropAt((i + 0.5) / ROW.length, rand(0.2, 0.8), { degree: i, r: rand(0.03, 0.06) });
    touched();
    return;
  }
  const k = INK_KEYS.indexOf(e.code);
  if (k >= 0) setInk(k);
});

navigator.keyboard?.getLayoutMap?.().then(map => {
  const a = map.get('KeyA'), z = map.get('Semicolon');
  if (a) $$('.kbd-first').forEach(el => { el.textContent = a.toUpperCase(); });
  if (z) $$('.kbd-last').forEach(el => { el.textContent = z.toUpperCase(); });
}).catch(() => {});

// ---------- La houle : le défilement fait tanguer le bain ----------

let lastScroll = scrollY;
addEventListener('scroll', () => {
  const dy = scrollY - lastScroll;
  lastScroll = scrollY;
  stylus.classList.remove('on');
  if (!glOK || !bathVisible || reduced || Math.abs(dy) < 1) return;
  const f = clamp(dy * 0.9, -90, 90);
  for (let i = 0; i < 2; i++) bath.splat(rand(0.15, 0.85), rand(0.2, 0.8), rand(-0.3, 0.3) * f, f, 0.03);
  bump(Math.min(0.06, Math.abs(dy) * 0.0007));
}, { passive: true });

// ---------- Visibilité du bain ----------

let bathVisible = true;
const visibleBaths = new Set();
const bathObserver = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (en.isIntersecting) visibleBaths.add(en.target); else visibleBaths.delete(en.target);
  }
  bathVisible = visibleBaths.size > 0;
  document.body.classList.toggle('bath-on', bathVisible);
}, { threshold: 0.18 });
$$('[data-bath]').forEach(el => bathObserver.observe(el));

const revealObserver = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (en.isIntersecting) { en.target.classList.add('in'); revealObserver.unobserve(en.target); }
  }
}, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
$$('.reveal').forEach(el => revealObserver.observe(el));

const sectionLinks = $$('.links a');
const navObserver = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    sectionLinks.forEach(a => a.classList.toggle('here', a.getAttribute('href') === `#${en.target.id}`));
  }
}, { rootMargin: '-45% 0px -50% 0px' });
['bac', 'gestes', 'motifs', 'encres', 'fiche', 'epreuves'].forEach(id => navObserver.observe(document.getElementById(id)));

// ---------- Épreuves ----------

let pulling = false;

async function pullPrint() {
  if (!glOK || pulling) return;
  pulling = true;
  touched();
  try {
    if (!bathVisible) {
      $('#bac').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
      await wait(reduced ? 50 : 900);
    }
    audioStart();
    const shot = await bath.snapshot(src => {
      const W = 1400, H = Math.round(W * src.height / src.width);
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.translate(W, 0);
      g.scale(-1, 1);
      g.drawImage(src, 0, 0, W, H);
      return c;
    });
    const url = await new Promise(r => shot.toBlob(b => r(URL.createObjectURL(b)), 'image/jpeg', 0.9));
    const ar = `${shot.width} / ${shot.height}`;
    await sheetAnimation(url, ar);
    addPrint(url, ar);
  } finally {
    pulling = false;
  }
}

async function sheetAnimation(url, ar) {
  const fx = $('#sheet-fx'), sheet = $('#sheet'), ink = $('#sheet-ink');
  sheet.style.setProperty('--ar', ar);
  ink.style.backgroundImage = `url("${url}")`;
  ink.style.opacity = '0';
  fx.classList.add('on');
  if (reduced) {
    await sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' }).finished;
    ink.style.opacity = '.95';
    await wait(500);
    fx.classList.remove('on');
    return;
  }
  synth.swish({ dur: 0.7, from: 5000, to: 600, vel: 0.22 });
  await sheet.animate([
    { opacity: 0, transform: 'translateY(-14vh) rotateX(28deg) rotateZ(-2deg) scale(1.12)' },
    { opacity: 1, transform: 'translateY(0) rotateX(0deg) rotateZ(0deg) scale(1)' },
  ], { duration: 720, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' }).finished;
  await ink.animate([
    { opacity: 0, filter: 'blur(6px) saturate(.4)' },
    { opacity: 0.96, filter: 'blur(0) saturate(1.05)' },
  ], { duration: 900, easing: 'ease-out', fill: 'forwards' }).finished;
  await wait(260);
  const target = (innerWidth > 860 ? $('#nav-prints') : $('#sound')).getBoundingClientRect();
  const box = sheet.getBoundingClientRect();
  const dx = target.left + target.width / 2 - (box.left + box.width / 2);
  const dy = target.top + target.height / 2 - (box.top + box.height / 2);
  synth.swish({ dur: 0.6, from: 700, to: 4200, vel: 0.18 });
  await sheet.animate([
    { transform: 'translate(0,0) rotateX(0deg) scale(1)', opacity: 1 },
    { transform: `translate(${dx * 0.1}px, ${dy * 0.1 - 40}px) rotateX(-24deg) rotateZ(3deg) scale(.82)`, opacity: 1, offset: 0.35 },
    { transform: `translate(${dx}px, ${dy}px) rotateX(-10deg) rotateZ(8deg) scale(.04)`, opacity: 0.2 },
  ], { duration: 950, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }).finished;
  fx.classList.remove('on');
  sheet.getAnimations().forEach(a => a.cancel());
  ink.getAnimations().forEach(a => a.cancel());
}

function addPrint(url, ar) {
  state.prints++;
  const n = state.prints;
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  $('#print-empty')?.remove();
  const fig = document.createElement('figure');
  fig.className = 'print fresh';
  fig.style.setProperty('--r', `${rand(-2.4, 2.4).toFixed(2)}deg`);
  fig.style.setProperty('--ar', ar);
  const img = document.createElement('img');
  img.src = url;
  img.alt = `Épreuve n°${n}, motif ${PATTERNS[state.pattern].name}, tirée en miroir du bain`;
  const cap = document.createElement('figcaption');
  cap.innerHTML = `<div><b>Épreuve n°${n}</b><br><span>${PATTERNS[state.pattern].name} · ${state.drops} gouttes · ${time}</span></div>`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `houle-epreuve-${String(n).padStart(2, '0')}.jpg`;
  a.textContent = 'Télécharger';
  cap.append(a);
  fig.append(img, cap);
  $('#prints').prepend(fig);
  const count = $('#print-count');
  count.textContent = String(n);
  count.classList.remove('bump');
  void count.offsetWidth;
  count.classList.add('bump');
  announce(`Épreuve n°${n} ajoutée à vos épreuves`);
  synth.note(degreeToMidi(7, INKS[1]), 'bell', { vel: 0.4 });
}

function clearBath() {
  if (!glOK) return;
  touched();
  synth.swish({ dur: 1.1, from: 300, to: 3000, vel: 0.24 });
  intro();
  bump(0.3);
}

document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'print') pullPrint();
  if (act === 'clear') clearBath();
});

$('#play').addEventListener('click', () => {
  state.mutedByUser = false;
  audioStart();
  touched();
  if (!glOK) return;
  [3, 5, 7, 9, 11].forEach((d, i) => dropAt((i + 0.5) / 5 * 0.7 + 0.15, 0.5 + Math.sin(i * 1.7) * 0.12, {
    degree: d, ink: (state.ink + i) % 5, r: rand(0.04, 0.06), delay: i * 0.16, vel: 0.55,
  }));
});

// ---------- Annonces & HUD ----------

const announcer = $('#announce');
function announce(msg) { announcer.textContent = msg; }

const hud = {
  note: $('#hud-note'), voices: $('#hud-voices'), energy: $('#hud-energy'),
  spec: Object.fromEntries($$('[data-spec]').map(el => [el.dataset.spec, el])),
};
const brandWord = $('#brand-word');

if (glOK) {
  const [sw, sh] = bath.simSize, [dw, dh] = bath.dyeSize;
  hud.spec.sim.textContent = `${sw} × ${sh}`;
  hud.spec.dye.textContent = `${dw} × ${dh}`;
  hud.spec.iters.textContent = String(bath.cfg.pressureIters);
}

let fps = 60, frames = 0, fpsClock = 0, uiClock = 0, idleClock = 0, last = performance.now();

function updateUI() {
  hud.note.textContent = state.note != null ? noteName(state.note) : '—';
  const voices = synth.activeVoices;
  hud.voices.textContent = String(voices);
  hud.energy.style.setProperty('--e', state.energy.toFixed(3));
  brandWord.style.setProperty('--bw', (96 + state.energy * 54).toFixed(1));
  hud.spec.fps.textContent = String(Math.round(fps));
  hud.spec.voices.textContent = String(voices);
  hud.spec.drops.textContent = String(state.drops);
  const info = synth.info;
  if (info) hud.spec.audio.textContent = `Web Audio, ${info.rate} Hz, latence ≈ ${info.latency} ms`;
  if (glOK) {
    const [sw, sh] = bath.simSize, [dw, dh] = bath.dyeSize;
    hud.spec.sim.textContent = `${sw} × ${sh}`;
    hud.spec.dye.textContent = `${dw} × ${dh}`;
  }
}

function loop(now) {
  const wall = Math.min(0.25, (now - last) / 1000);
  const dt = Math.min(0.033, wall);
  last = now;
  state.energy *= Math.exp(-wall * 0.85);

  if (glOK && bathVisible) {
    bath.frame(dt, wall);
    frames++;
  }
  fpsClock += wall;
  if (fpsClock >= 0.5) {
    if (frames) fps = frames / fpsClock;
    frames = 0;
    fpsClock = 0;
  }

  uiClock += wall;
  if (uiClock > 0.1) {
    uiClock = 0;
    synth.setEnergy(state.energy);
    updateUI();
  }

  // When nobody plays, the bath keeps itself alive with a slow rain of small drops.
  idleClock += wall;
  if (glOK && bathVisible && !reduced && now - state.lastTouch > 9000 && idleClock > 3.2 && !document.hidden) {
    idleClock = 0;
    const top = Math.random() < 0.5;
    dropAt(rand(0.06, 0.94), top ? rand(0.8, 0.93) : rand(0.08, 0.2), {
      ink: Math.floor(rand(0, 4)), r: rand(0.02, 0.04), vel: 0.3, energy: 0.04,
    });
  }

  requestAnimationFrame(loop);
}

// ---------- Redimensionnement ----------

// The canvas is sized in lvh, so mobile toolbars sliding in and out do not resize it.
let resizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!glOK || !canvas.clientWidth || !canvas.clientHeight) return;
    bath.resize();
  }, 120);
}).observe(canvas);

document.addEventListener('visibilitychange', () => {
  if (!synth.ctx) return;
  if (document.hidden) synth.ctx.suspend();
  else if (!state.mutedByUser) synth.ctx.resume();
});

canvas.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  root.classList.add('no-gl');
});

// ---------- Départ ----------

setInk(0);
if (glOK) intro();
requestAnimationFrame(loop);
