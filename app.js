'use strict';
/* Agrégateur de presse — PWA.
   Réglages et tri : localStorage. Texte des articles : IndexedDB. */

const DOMS = { politique: 'Politique', economie: 'Économie', 'relations-internationales': 'Relations int.', technologie: 'Technologie' };
const USAGES = { rejeter: 'Rejeter', archiver: 'Archiver', 'these-a-approfondir': 'Thèse à approfondir', 'these-retenue': 'Thèse retenue' };
const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url=';
const VERSION = '2.1';
const SHORT_TEXT = 2500;
const LOADING = '<p class="muted"><span class="ms spin" style="vertical-align:-4px;color:var(--cyan)">autorenew</span> Chargement du texte…</p>';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { alert('Stockage plein ou indisponible : ' + e.message); return false; } }

/* ---------- IndexedDB (texte des articles) ---------- */
const idb = (() => {
  const mem = new Map();
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('IndexedDB indisponible'));
      const r = indexedDB.open('agregateur-presse', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('contents');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function op(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction('contents', mode);
      const req = fn(tx.objectStore('contents'));
      tx.oncomplete = () => res(req ? req.result : undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  return {
    async get(k) { try { return await op('readonly', s => s.get(k)); } catch (e) { return mem.get(k); } },
    async set(k, v) { try { await op('readwrite', s => s.put(v, k)); } catch (e) { mem.set(k, v); } },
    async del(k) { try { await op('readwrite', s => s.delete(k)); } catch (e) { mem.delete(k); } }
  };
})();

let panel = null, cfg = null, arts = {}, tri = {}, fstat = {}, hl = {};
let view = 'trier', mediaFilter = null, usageFilter = 'non-rejetes', domFilter = null, shown = 100, busy = false, cur = null;
let reader = null; // { id, rec }

/* ---------- Utilitaires purs ---------- */
function hash(s) {
  let a = 5381, b = 2166136261;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = ((a << 5) + a + c) | 0; b = Math.imul(b ^ c, 16777619); }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|#^\[\]\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim(); }
function ymd(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
function rel(iso) {
  const t = Date.parse(iso); if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'À l\'instant';
  if (m < 60) return `Il y a ${m} min`;
  if (m < 1440) return `Il y a ${Math.floor(m / 60)} h`;
  return new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}
function initials(s) { return String(s || '').split(/[\s'’-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase(); }
function fmtDate(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function tsOf(a) { return Date.parse(a.date || a.fetched) || 0; }
function thesesList(t) { return t.theses ? t.theses.split(';').map(safeName).filter(Boolean) : []; }

function toMd(t) {
  const y = v => JSON.stringify(v ?? '');
  const th = thesesList(t);
  const passages = (t.passages || []).filter(p => p.text);
  const fm = [
    '---',
    'type: source',
    `titre: ${y(t.title)}`,
    `media: ${y(t.source)}`,
    `rubrique: ${y(t.rubrique)}`,
    `date: ${ymd(t.date || t.fetched)}`,
    `url: ${y(t.link)}`,
    `domaines: [${(t.domaines || []).join(', ')}]`,
    `orientation: ${t.orientation || 'neutre'}`,
    `sens: ${y(t.sens)}`,
    `usage: ${t.usage}`,
    `theses: [${th.map(x => y('[[' + x + ']]')).join(', ')}]`,
    `passages: ${passages.length}`,
    `tri: ${ymd(t.at)}`,
    'tags: [source/presse]',
    '---',
    ''
  ];
  const body = [
    `# ${t.title}`,
    '',
    `> ${t.source}${t.rubrique ? ' — ' + t.rubrique : ''}, ${ymd(t.date || t.fetched)} · [Article](${t.link})`,
    '',
    '## Résumé',
    '',
    t.resume || '_À compléter._',
    '',
    '## Passages surlignés',
    '',
    passages.length ? passages.map(p => p.text.split('\n').map(l => '> ' + l.trim()).join('\n>\n')).join('\n\n') : '_Aucun._',
    '',
    '## Thèses et scénarios',
    '',
    th.length ? th.map(x => `- [[${x}]]`).join('\n') : '_Aucune._',
    ''
  ];
  return fm.concat(body).join('\n');
}

function buildFiles(list) {
  const used = new Set();
  return list.map(t => {
    const base = `${ymd(t.date || t.fetched)} ${safeName(t.title)}`.slice(0, 100).trim();
    let name = base + '.md', i = 2;
    while (used.has(name)) name = `${base} (${i++}).md`;
    used.add(name);
    return { name, text: toMd(t) };
  });
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/* ZIP sans compression (méthode « store »), noms en UTF-8 */
function zipParts(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, off, true);
    central.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return [...parts, ...central, end];
}

/* ---------- Réseau ---------- */
function strip(html) {
  if (!html) return '';
  const d = new DOMParser().parseFromString(html, 'text/html');
  return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
}
function decode(buf) {
  const head = new TextDecoder('ascii').decode(buf.slice(0, 2048));
  const m = /(?:encoding|charset)\s*=\s*["']?\s*([\w:.-]+)/i.exec(head);
  try { return new TextDecoder(m ? m[1].toLowerCase() : 'utf-8').decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
}
async function fetchText(url, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(cfg.proxy + encodeURIComponent(url), { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return decode(await r.arrayBuffer());
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('délai dépassé') : e;
  } finally { clearTimeout(t); }
}

/* ---------- Flux ---------- */
function txt(el, tag) { const e = el.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ''; }
function parseFeed(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML invalide');
  const nodes = [...doc.getElementsByTagName('item'), ...doc.getElementsByTagName('entry')];
  return nodes.map(it => {
    let link = '';
    for (const l of it.getElementsByTagName('link')) {
      const href = l.getAttribute('href'), rel = l.getAttribute('rel');
      if (href && (!rel || rel === 'alternate')) { link = href; break; }
      if (!href && l.textContent.trim()) { link = l.textContent.trim(); break; }
    }
    if (!link) { const g = txt(it, 'guid'); if (/^https?:/.test(g)) link = g; }
    const ds = txt(it, 'pubDate') || txt(it, 'dc:date') || txt(it, 'published') || txt(it, 'updated');
    const d = ds ? new Date(ds) : null;
    const rawDesc = txt(it, 'description') || txt(it, 'summary') || txt(it, 'content:encoded') || txt(it, 'content');
    const ex = strip(rawDesc);
    // Vignette : media:content / media:thumbnail, puis enclosure image, puis première image du résumé
    const MRSS = 'http://search.yahoo.com/mrss/';
    let img = '';
    const mc = [...it.getElementsByTagNameNS(MRSS, 'thumbnail'), ...it.getElementsByTagNameNS(MRSS, 'content')].find(e => {
      const u = e.getAttribute('url'), ty = (e.getAttribute('type') || '') + (e.getAttribute('medium') || '');
      return u && (e.localName === 'thumbnail' || /image/.test(ty) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u));
    });
    if (mc) img = mc.getAttribute('url');
    if (!img) { const enc = [...it.getElementsByTagName('enclosure')].find(e => /^image\//.test(e.getAttribute('type') || '')); if (enc) img = enc.getAttribute('url'); }
    if (!img) { const m = /<img[^>]+src=["']([^"']+)["']/i.exec(rawDesc || txt(it, 'content:encoded')); if (m) img = m[1]; }
    img = absUrl(img, link) || '';
    return { title: strip(txt(it, 'title')) || '(sans titre)', link, date: d && !isNaN(d) ? d.toISOString() : null, excerpt: ex.slice(0, 400), img };
  }).filter(x => /^https?:\/\//.test(x.link));
}

function allFeeds() { return [...(panel ? panel.flux : []), ...cfg.custom]; }
function mediaList() { const s = []; allFeeds().forEach(f => { if (!s.includes(f.source)) s.push(f.source); }); return s; }
function activeFeeds() { return allFeeds().filter(f => cfg.mediaOn[f.source]); }
let statusText = '';
function setStatus(s) { statusText = s; const el = $('#status'); if (el) el.textContent = s; }
function defaultStatus() {
  const lr = load('lastRefresh', null);
  return lr ? `Actualisé ${rel(new Date(lr.at).toISOString()).toLowerCase()} · ${lr.ok}/${lr.total} flux lus` : 'Pas encore actualisé';
}

async function refresh() {
  if (busy) return;
  const feeds = activeFeeds();
  if (!feeds.length) { setStatus('Aucun média sélectionné (onglet Réglages).'); return; }
  if (!cfg.proxy) { setStatus('Proxy non configuré (onglet Réglages).'); return; }
  busy = true; setRefreshUi();
  let done = 0, added = 0, errs = 0;
  const limit = Date.now() - cfg.keepDays * 864e5;
  const kw = cfg.exclude.map(k => k.toLowerCase()).filter(Boolean);
  const queue = [...feeds];
  setStatus(`Actualisation 0/${feeds.length} flux…`);
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      try {
        const items = parseFeed(await fetchText(f.url));
        for (const it of items) {
          const id = hash(it.link);
          if (tri[id]) continue;
          if (arts[id]) { (f.domaines || []).forEach(d => { if (!arts[id].domaines.includes(d)) arts[id].domaines.push(d); }); continue; }
          if (it.date && Date.parse(it.date) < limit) continue;
          const hay = (it.title + ' ' + it.excerpt).toLowerCase();
          if (kw.some(k => hay.includes(k))) continue;
          arts[id] = { id, ...it, feedId: f.id, source: f.source, rubrique: f.rubrique, domaines: [...(f.domaines || [])], fetched: new Date().toISOString() };
          added++;
        }
        fstat[f.id] = { ok: true, n: items.length, at: Date.now() };
      } catch (e) {
        errs++;
        fstat[f.id] = { ok: false, err: e.message, at: Date.now() };
      }
      done++;
      setStatus(`Actualisation ${done}/${feeds.length} flux…`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, feeds.length) }, worker));
  prune();
  save('arts', arts); save('fstat', fstat);
  save('lastRefresh', { at: Date.now(), ok: feeds.length - errs, total: feeds.length, added });
  busy = false;
  render();
  setStatus(`${added} nouvel(s) article(s) · ${feeds.length - errs}/${feeds.length} flux lus${errs ? ` · ${errs} en erreur (Réglages)` : ''}`);
  toast(`${feeds.length - errs}/${feeds.length} flux lus · ${added} nouvel(s) article(s)`, 'done_all');
}

function forget(id) { delete hl[id]; idb.del(id); }
function prune() {
  const limit = Date.now() - cfg.keepDays * 864e5;
  for (const id in arts) if (tsOf(arts[id]) < limit) { delete arts[id]; forget(id); }
  save('hl', hl);
}
function persist() { save('arts', arts); save('tri', tri); save('hl', hl); }

/* ---------- Extraction du texte d'un article ---------- */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'FORM', 'BUTTON', 'SVG', 'NAV', 'ASIDE', 'FOOTER', 'HEADER', 'INPUT', 'SELECT', 'TEXTAREA', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'CANVAS', 'TEMPLATE', 'DIALOG', 'LINK', 'META', 'PICTURE_SOURCE', 'SOURCE', 'MATH']);
const KEEP = new Set(['P', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'EM', 'I', 'STRONG', 'B', 'A', 'IMG', 'FIGURE', 'FIGCAPTION', 'BR', 'MARK', 'SUP', 'SUB', 'PRE', 'CODE', 'HR']);
const INLINE = new Set(['EM', 'I', 'STRONG', 'B', 'A', 'MARK', 'SUP', 'SUB', 'CODE', 'BR', 'IMG']);
const BLOCKISH = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'DL', 'DT', 'DD', 'PICTURE']);
const JUNK = /(^|[\s_-])(share|sharing|social|newsletter|related|recommend\w*|comments?|promo|advert\w*|ads?|outbrain|taboola|breadcrumbs?|subscribe|cookie|consent|modal|popup|read-?also|lire-?aussi|sidebar)([\s_-]|$)/i;

function absUrl(u, base) {
  if (!u) return null;
  try { const x = new URL(u.trim(), base); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch (e) { return null; }
}

/* Reconstruit un fragment sûr à partir d'un nœud HTML étranger : liste blanche de balises,
   attributs limités à href / src / alt / data-h. Aucun script ni style n'est conservé. */
function sanitize(src, base) {
  const frag = document.createDocumentFragment();
  let loose = null;
  function put(out, node) {
    if (out === frag) {
      if (!loose) { loose = document.createElement('p'); frag.appendChild(loose); }
      loose.appendChild(node);
    } else out.appendChild(node);
  }
  function walk(node, out) {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) { if (out !== frag || ch.nodeValue.trim()) put(out, document.createTextNode(ch.nodeValue)); continue; }
      if (ch.nodeType !== 1) continue;
      let tag = ch.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      if (tag === 'H1') tag = 'H2';
      if (KEEP.has(tag)) {
        let el;
        if (tag === 'IMG') {
          const cands = [ch.getAttribute('data-src'), ch.getAttribute('data-lazy-src'), ch.getAttribute('data-original'), ch.getAttribute('src'),
            (ch.getAttribute('srcset') || ch.getAttribute('data-srcset') || '').split(',')[0].trim().split(/\s+/)[0]];
          const s = cands.map(c => absUrl(c, base)).find(Boolean);
          if (!s) continue;
          el = document.createElement('img');
          el.src = s; el.loading = 'lazy'; el.alt = ch.getAttribute('alt') || ''; el.referrerPolicy = 'no-referrer';
        } else if (tag === 'MARK') {
          const h = ch.getAttribute('data-h');
          if (!h || !/^[a-z0-9]{1,24}$/.test(h)) { walk(ch, out); continue; }
          el = document.createElement('mark'); el.setAttribute('data-h', h);
        } else {
          el = document.createElement(tag.toLowerCase());
          if (tag === 'A') { const h = absUrl(ch.getAttribute('href'), base); if (h) { el.href = h; el.target = '_blank'; el.rel = 'noopener noreferrer'; } }
        }
        if (INLINE.has(tag)) put(out, el);
        else { if (out === frag) loose = null; out.appendChild(el); }
        if (tag !== 'IMG' && tag !== 'BR' && tag !== 'HR') walk(ch, el);
      } else {
        const block = BLOCKISH.has(tag);
        if (block && out === frag) loose = null;
        walk(ch, out);
        if (block && out === frag) loose = null;
      }
    }
  }
  walk(src, frag);
  const box = document.createElement('div');
  box.appendChild(frag);
  box.querySelectorAll('p,li,figure,figcaption,blockquote,h2,h3,h4,h5,h6,ul,ol').forEach(e => {
    if (!e.textContent.trim() && !e.querySelector('img')) e.remove();
  });
  return box;
}

function extractArticle(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let ld = '';
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    const find = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(find); return; }
      if (typeof o.articleBody === 'string' && o.articleBody.length > ld.length) ld = o.articleBody;
      if (o['@graph']) find(o['@graph']);
      if (o.mainEntity) find(o.mainEntity);
    };
    try { find(JSON.parse(s.textContent)); } catch (e) { /* JSON-LD invalide : ignoré */ }
  });
  const meta = n => { const m = doc.querySelector(`meta[property="${n}"],meta[name="${n}"]`); return m ? (m.getAttribute('content') || '').trim() : ''; };
  const lead = meta('og:description') || meta('description');

  doc.querySelectorAll([...SKIP].map(t => t.toLowerCase()).join(',')).forEach(e => e.remove());
  const plen = p => p.textContent.replace(/\s+/g, ' ').trim().length;
  if (doc.body) doc.body.querySelectorAll('[class],[id]').forEach(e => {
    if (!e.isConnected) return;
    if (JUNK.test((e.getAttribute('class') || '') + ' ' + (e.getAttribute('id') || ''))) {
      const longP = [...e.querySelectorAll('p')].filter(p => plen(p) > 80).length;
      if (longP < 3) e.remove();
    }
  });

  const scores = new Map();
  doc.querySelectorAll('p').forEach(p => {
    const l = plen(p);
    if (l < 30) return;
    const a = p.parentElement; if (!a) return;
    scores.set(a, (scores.get(a) || 0) + l);
    const b = a.parentElement; if (b) scores.set(b, (scores.get(b) || 0) + l / 2);
  });
  let best = null, bs = 0;
  scores.forEach((s, el) => { if (s > bs) { bs = s; best = el; } });
  if (!best || bs < 200) best = doc.querySelector('article') || doc.querySelector('main') || doc.body;

  let box = best ? sanitize(best, url) : document.createElement('div');
  let text = box.textContent.replace(/\s+/g, ' ').trim();
  if (ld && strip(ld).length > text.length * 1.2) {
    box = document.createElement('div');
    ld.split(/\n+/).map(s => strip(s)).filter(Boolean).forEach(s => { const p = document.createElement('p'); p.textContent = s; box.appendChild(p); });
    text = box.textContent.replace(/\s+/g, ' ').trim();
  }
  return { html: box.innerHTML, length: text.length, lead: lead && !text.includes(lead.slice(0, 60)) ? lead : '' };
}

/* ---------- Lecteur ---------- */
let savedRange = null, clearTimer = null;
const rBody = () => $('#r-body');

async function openReader(id) {
  const a = tri[id] || arts[id];
  if (!a) return;
  reader = { id, rec: null };
  $('#r-src').textContent = a.source;
  $('#r-ini').textContent = initials(a.source);
  $('#r-title').textContent = a.title;
  $('#r-meta').textContent = `${a.rubrique || ''}${a.rubrique ? ' · ' : ''}${fmtDate(a.date || a.fetched)}`;
  $('#r-lead').textContent = '';
  $('#r-note').innerHTML = '';
  rBody().innerHTML = LOADING;
  updateHlCount();
  $('#reader').classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#r-scroll').scrollTop = 0;
  await loadReaderContent(id, false);
}

async function loadReaderContent(id, force) {
  const a = tri[id] || arts[id];
  let rec = force ? null : await idb.get(id);
  if (!rec) {
    try {
      const ex = extractArticle(await fetchText(a.link, 25000), a.link);
      if (ex.length < 200) throw new Error('texte de l\'article non trouvé dans la page');
      rec = { html: ex.html, length: ex.length, lead: ex.lead, at: Date.now() };
      await idb.set(id, rec);
    } catch (e) {
      if (!reader || reader.id !== id) return;
      rBody().innerHTML = `<p class="err">Texte non récupéré : ${esc(e.message)}.</p>${a.excerpt ? `<p>${esc(a.excerpt)}</p>` : ''}
        <p><button class="btn tonal" data-act="r-retry"><span class="ms">refresh</span><span>RÉESSAYER</span></button></p><p class="muted">Dernier recours : <a href="${esc(a.link)}" target="_blank" rel="noopener">ouvrir sur le site</a> (le surlignage n'y est pas disponible).</p>`;
      return;
    }
  }
  if (!reader || reader.id !== id) return;
  reader.rec = rec;
  const parsed = new DOMParser().parseFromString('<div>' + rec.html + '</div>', 'text/html').body.firstElementChild;
  const clean = sanitize(parsed, a.link);
  rBody().innerHTML = '';
  while (clean.firstChild) rBody().appendChild(clean.firstChild);
  $('#r-lead').textContent = rec.lead || '';
  $('#r-note').innerHTML = (rec.length < SHORT_TEXT ? `<p class="note">Texte court (${rec.length} caractères) : l'article est peut-être réservé aux abonnés ou l'extraction est incomplète.</p>` : '') +
    `<p class="foot">Texte récupéré le ${new Date(rec.at).toLocaleDateString('fr-FR')} · <a href="${esc(a.link)}" target="_blank" rel="noopener">source</a> · <button class="linkbtn" data-act="r-reload">Recharger depuis le site</button></p>`;
  // Les passages enregistrés restent la référence s'ils existent ; on les recalcule depuis le texte.
  if (rBody().querySelector('mark[data-h]')) { hl[id] = collectHl(); save('hl', hl); }
  updateHlCount();
}

function closeReader() {
  $('#reader').classList.remove('open');
  document.body.style.overflow = '';
  reader = null; savedRange = null;
  render();
}

function selectionInBody() {
  const s = getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return null;
  const r = s.getRangeAt(0);
  return rBody().contains(r.commonAncestorContainer) ? r : null;
}

function wrapRange(range, hid) {
  const root = rBody();
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (w.nextNode()) {
    const n = w.currentNode;
    if (range.intersectsNode(n) && n.nodeValue.trim() && !n.parentElement.closest('mark')) nodes.push(n);
  }
  let count = 0;
  nodes.forEach(n => {
    const s = n === range.startContainer ? range.startOffset : 0;
    const e = n === range.endContainer ? range.endOffset : n.nodeValue.length;
    if (s >= e) return;
    let t = n;
    if (e < t.nodeValue.length) t.splitText(e);
    if (s > 0) t = t.splitText(s);
    if (!t.nodeValue.trim()) return;
    const m = document.createElement('mark');
    m.setAttribute('data-h', hid);
    t.parentNode.insertBefore(m, t);
    m.appendChild(t);
    count++;
  });
  return count;
}

function collectHl() {
  const list = [], map = new Map();
  rBody().querySelectorAll('mark[data-h]').forEach(m => {
    const h = m.getAttribute('data-h');
    const block = m.closest('p,li,h2,h3,h4,h5,h6,blockquote,figcaption,pre') || rBody();
    let e = map.get(h);
    if (!e) { e = { h, text: '', block: null }; map.set(h, e); list.push(e); }
    e.text += (e.block && e.block !== block ? '\n' : '') + m.textContent;
    e.block = block;
  });
  return list.map(e => ({ h: e.h, text: e.text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n') })).filter(x => x.text);
}

async function persistReader() {
  const id = reader.id;
  hl[id] = collectHl();
  if (!hl[id].length) delete hl[id];
  save('hl', hl);
  if (tri[id]) { tri[id].exported = false; save('tri', tri); }
  if (reader.rec) { reader.rec = { ...reader.rec, html: rBody().innerHTML }; await idb.set(id, reader.rec); }
  updateHlCount();
}

function updateHlCount() {
  const n = reader && hl[reader.id] ? hl[reader.id].length : 0;
  $('#r-count').textContent = n ? `${n} surlign.` : '';
}

function toast(msg, icon = 'check') {
  $('#toast-text').textContent = msg;
  $('#toast-icon').textContent = icon;
  const t = $('#toast');
  t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

function doHighlight() {
  if (!reader || !reader.rec) return;
  const r = selectionInBody() || savedRange;
  if (!r || !r.toString().trim()) { toast('Sélectionnez d\'abord un passage du texte.', 'touch_app'); return; }
  const hid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const n = wrapRange(r, hid);
  const s = getSelection(); if (s) s.removeAllRanges();
  savedRange = null; $('#btn-hl').classList.remove('ready');
  if (!n) { toast('Passage déjà surligné.'); return; }
  persistReader();
  toast('Passage surligné', 'ink_highlighter');
}

function removeHighlight(h) {
  rBody().querySelectorAll(`mark[data-h="${h}"]`).forEach(m => {
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  });
  rBody().normalize();
  persistReader();
}

/* ---------- Vues ---------- */
const ICONS = { rejeter: 'block', archiver: 'archive', 'these-a-approfondir': 'troubleshoot', 'these-retenue': 'verified' };

function card(a, i) {
  const t = tri[a.id];
  const n = hl[a.id] ? hl[a.id].length : 0;
  const amber = i % 3 === 1;
  const tags = [];
  if (t) {
    tags.push(`<span class="tag lbl-sm ${t.usage === 'rejeter' ? 'err' : ''}"><span class="ms" style="font-size:13px">${ICONS[t.usage]}</span>${USAGES[t.usage]}</span>`);
    t.domaines.forEach(d => tags.push(`<span class="tag lbl-sm muted">${esc(DOMS[d] || d)}</span>`));
    if (t.orientation === 'oriente') tags.push(`<span class="tag lbl-sm amber">Orienté${t.sens ? ' : ' + esc(t.sens) : ''}</span>`);
    if (t.exported) tags.push('<span class="tag lbl-sm muted">Exporté</span>');
  }
  if (n) tags.push(`<span class="tag lbl-sm amber"><span class="ms" style="font-size:13px">ink_highlighter</span>${n} passage${n > 1 ? 's' : ''}</span>`);
  return `<article class="card${amber ? ' amber' : ''}" data-id="${a.id}">
  <span class="hud"></span>
  <div class="c-meta">
    <div class="c-src"><span class="ini">${esc(initials(a.source))}</span><span class="src-name lbl">${esc(a.source)}</span><span class="sep">•</span><span class="time">${rel(a.date || a.fetched)}</span></div>
    ${a.rubrique ? `<span class="tag lbl-sm${amber ? ' amber' : ''}">${esc(a.rubrique)}</span>` : ''}
  </div>
  <div class="c-main">
    <div class="c-text"><h2 class="c-title" data-act="read">${esc(a.title)}</h2>${a.excerpt ? `<p class="c-ex">${esc(a.excerpt)}</p>` : ''}</div>
    ${a.img ? `<div class="thumb"><img src="${esc(a.img)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : ''}
  </div>
  ${tags.length ? `<div class="c-tags">${tags.join('')}</div>` : ''}
  <div class="c-actions">
    ${t ? '<span></span>' : '<button class="btn ghost danger" data-act="reject"><span class="ms">block</span><span>REJETER</span></button>'}
    <div class="r">
      <button class="btn tonal" data-act="read"><span class="ms">menu_book</span><span>LIRE</span></button>
      <button class="btn ${amber ? 'amber' : 'primary'}" data-act="open"><span class="ms fill">${t ? 'edit' : 'check_circle'}</span><span>${t ? 'MODIFIER' : 'CLASSER'}</span></button>
    </div>
  </div>
</article>`;
}

function pills(names) {
  if (!names.length) return '';
  if (mediaFilter && !names.includes(mediaFilter)) mediaFilter = null;
  return `<div class="pills" role="tablist" aria-label="Filtre par média">
    <button class="pill-btn lbl ${mediaFilter === null ? 'on' : ''}" data-m="" role="tab">Tous</button>
    ${names.map(m => `<button class="pill-btn lbl ${mediaFilter === m ? 'on' : ''}" data-m="${esc(m)}" role="tab">${esc(m)}</button>`).join('')}
  </div>`;
}

function head(title, count, sub, extra = '') {
  return `<section class="page-head"><div style="min-width:0">
    <div class="title-row"><h1>${title}</h1>${count ? `<span class="count-pill lbl-sm">${count}</span>` : ''}</div>
    ${sub ? `<p class="sub"><span class="d"></span><span id="status">${esc(sub)}</span></p>` : ''}
  </div>${extra}</section>`;
}

function more(total) { return total > shown ? `<button class="btn tonal more" data-act="more">AFFICHER PLUS (${total - shown})</button>` : ''; }

function vTrier() {
  const total = Object.keys(arts).length;
  const refreshBtn = `<button class="refresh lbl" id="btn-refresh" data-act="refresh" ${busy ? 'disabled' : ''}><span class="ms ${busy ? 'spin' : ''}" id="refresh-icon">autorenew</span><span>Actualiser</span><span class="u"></span></button>`;
  let h = head('À trier', total ? `${total} en attente` : '', statusText || defaultStatus(), refreshBtn);
  if (!activeFeeds().length) {
    return h + `<div class="empty"><div class="ic"><span class="ms">newspaper</span></div><h3>Aucun média sélectionné</h3><p>Choisissez les médias à suivre dans les réglages.</p>
      <button class="btn primary" data-act="goto-reglages"><span class="ms">tune</span><span>CHOISIR LES MÉDIAS</span></button></div>`;
  }
  h += pills(mediaList().filter(m => cfg.mediaOn[m]));
  const today = ymd(new Date().toISOString());
  const doneToday = Object.values(tri).filter(t => ymd(t.at) === today).length;
  const all = doneToday + total;
  h += `<div class="panel"><div class="prog-head"><div class="l"><span class="ms">bolt</span><span class="lbl-sm">File de tri • aujourd'hui</span></div><span class="r">${doneToday} / ${all} traités</span></div>
    <div class="bar"><div style="width:${all ? Math.round(doneToday / all * 100) : 0}%"></div></div></div>`;
  let list = Object.values(arts).filter(a => !mediaFilter || a.source === mediaFilter).sort((x, y) => tsOf(y) - tsOf(x));
  const n = list.length;
  if (!n) {
    return h + `<div class="empty"><div class="ic"><span class="ms">task_alt</span></div><h3>Boîte de tri vide</h3><p>${total ? 'Aucun article pour ce média.' : 'Tous les articles chargés ont été triés.'}</p>
      <button class="refresh lbl" data-act="refresh"><span class="ms">refresh</span><span>Recharger les sources</span><span class="u"></span></button></div>`;
  }
  return h + `<div class="list">${list.slice(0, shown).map(card).join('')}</div>` + more(n);
}

function vClasses() {
  const opts = { 'non-rejetes': 'Tous retenus', ...USAGES };
  let list = Object.values(tri)
    .filter(t => usageFilter === 'non-rejetes' ? t.usage !== 'rejeter' : t.usage === usageFilter)
    .filter(t => !mediaFilter || t.source === mediaFilter)
    .filter(t => !domFilter || t.domaines.includes(domFilter))
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  const n = list.length;
  return head('Classés', `${n} article${n > 1 ? 's' : ''}`, '') +
    pills([...new Set(Object.values(tri).map(t => t.source))]) +
    `<div class="pills wrap">${Object.entries(opts).map(([k, v]) => `<button class="pill-btn lbl ${usageFilter === k ? 'on' : ''}" data-u="${k}">${v}</button>`).join('')}</div>
    <div class="pills wrap"><button class="pill-btn lbl ${domFilter ? '' : 'on'}" data-df="">Tous domaines</button>${Object.entries(DOMS).map(([k, v]) => `<button class="pill-btn lbl ${domFilter === k ? 'on' : ''}" data-df="${k}">${v}</button>`).join('')}</div>` +
    (n ? `<div class="list">${list.slice(0, shown).map(card).join('')}</div>` + more(n)
       : `<div class="empty"><div class="ic"><span class="ms">inventory_2</span></div><h3>Aucun article</h3><p>Aucun article classé ne correspond à ces filtres.</p></div>`);
}

function toExport(all) { return Object.values(tri).filter(t => t.usage !== 'rejeter' && (all || !t.exported)).map(t => ({ ...t, passages: hl[t.id] || [] })); }

function vExport() {
  const n = toExport(false).length, N = toExport(true).length;
  return head('Export', n ? `${n} à exporter` : '', '') + `
  <div class="panel">
    <div class="prog-head"><div class="l"><span class="ms">description</span><span class="lbl-sm">Notes Obsidian</span></div><span class="r">${n} / ${N} non exportées</span></div>
    <p class="muted">Une note par article retenu : résumé, passages surlignés, thèses. Les articles rejetés ne sont jamais exportés.</p>
    <label class="check" style="margin-top:12px"><input type="checkbox" id="exp-all"> Réexporter aussi les notes déjà exportées</label>
    <div class="row-actions"><button class="btn primary" data-act="share"><span class="ms">ios_share</span><span>PARTAGER LES .MD</span></button><button class="btn tonal" data-act="zip"><span class="ms">folder_zip</span><span>ARCHIVE ZIP</span></button></div>
    <p class="muted" style="margin-top:12px">Sur iPhone : « Partager », « Enregistrer dans Fichiers », puis le dossier du coffre Obsidian. Une note modifiée après export (classement ou surlignage) repasse en « non exportée ».</p>
  </div>
  <div class="panel">
    <div class="prog-head"><div class="l"><span class="ms">backup</span><span class="lbl-sm">Sauvegarde</span></div></div>
    <p class="muted">Réglages, classement et passages surlignés. Le texte complet des articles n'y figure pas (il peut être rechargé depuis le site).</p>
    <div class="row-actions"><button class="btn tonal" data-act="backup"><span class="ms">download</span><span>EXPORTER (.JSON)</span></button><button class="btn tonal" data-act="restore"><span class="ms">upload</span><span>RESTAURER</span></button><input type="file" id="restore-file" accept="application/json,.json" hidden></div>
  </div>`;
}

function vReglages() {
  const medias = mediaList();
  const on = medias.filter(m => cfg.mediaOn[m]).length;
  const rows = medias.map(m => {
    const fs = allFeeds().filter(f => f.source === m);
    const st = fs.map(f => fstat[f.id]).filter(Boolean);
    const ok = st.filter(s => s.ok).length;
    const lang = [...new Set(fs.map(f => f.langue).filter(Boolean))].join('/');
    const errs = fs.filter(f => fstat[f.id] && !fstat[f.id].ok).map(f => `${esc(f.rubrique)} : ${esc(fstat[f.id].err)}`);
    return `<label class="mrow"><input type="checkbox" data-media="${esc(m)}" ${cfg.mediaOn[m] ? 'checked' : ''}>
      <span class="ini">${esc(initials(m))}</span>
      <div class="t"><div class="n">${esc(m)}${lang ? `<span class="tag lbl-sm muted">${esc(lang)}</span>` : ''}</div>
      <div class="s">${fs.length} flux${st.length ? ` · <span class="${ok === st.length ? 'ok' : ok ? 'warn' : 'err'}">${ok}/${st.length} lus au dernier chargement</span>` : ''}</div>
      ${errs.length ? `<details><summary>Erreurs</summary><div class="s">${errs.join('<br>')}</div></details>` : ''}</div></label>`;
  }).join('');
  const custom = cfg.custom.map(f => `<div class="mrow"><div class="t"><div class="n">${esc(f.source)}</div><div class="url">${esc(f.url)}</div></div><button class="btn danger-solid" data-act="del-feed" data-id="${f.id}"><span class="ms">delete</span></button></div>`).join('');
  return head('Réglages', '', '') + `
  <div class="panel">
    <div class="prog-head"><div class="l"><span class="ms">newspaper</span><span class="lbl-sm">Médias</span></div><span class="r">${on} / ${medias.length} sélectionnés</span></div>
    <p class="muted">Tous les flux d'un média sélectionné sont lus ; un article présent dans plusieurs rubriques n'apparaît qu'une fois.</p>
    <div class="row-actions"><button class="btn tonal" data-act="media-all">TOUT SÉLECTIONNER</button><button class="btn tonal" data-act="media-none">TOUT DÉSÉLECTIONNER</button></div>
    <div style="margin-top:8px">${rows}</div>
  </div>
  <div class="panel">
    <div class="prog-head"><div class="l"><span class="ms">add_link</span><span class="lbl-sm">Ajouter un flux</span></div></div>
    <span class="field-lbl lbl-sm">Média (existant ou nouveau)</span><input type="text" id="nf-src" list="media-names"><datalist id="media-names">${medias.map(m => `<option value="${esc(m)}">`).join('')}</datalist>
    <span class="field-lbl lbl-sm">Adresse du flux RSS</span><input type="url" id="nf-url" placeholder="https://…">
    <div class="row-actions"><button class="btn primary" data-act="add-feed"><span class="ms">add</span><span>AJOUTER</span></button></div>
    ${custom ? `<div style="margin-top:8px">${custom}</div>` : ''}
  </div>
  <div class="panel">
    <div class="prog-head"><div class="l"><span class="ms">router</span><span class="lbl-sm">Proxy</span></div></div>
    <p class="muted">Un navigateur ne peut pas lire directement la plupart des flux et des pages d'articles (restriction CORS). L'adresse visée, encodée, est ajoutée à la fin de l'URL ci-dessous. Voir README.</p>
    <input type="url" id="proxy" value="${esc(cfg.proxy)}" placeholder="https://…workers.dev/?url=" style="margin-top:12px">
    <div class="row-actions"><button class="btn primary" data-act="save-proxy">ENREGISTRER</button><button class="btn tonal" data-act="test-proxy"><span class="ms">network_check</span><span>TESTER</span></button></div>
    <div class="statusline" id="proxy-status"></div>
  </div>
  <div class="panel">
    <div class="prog-head"><div class="l"><span class="ms">filter_alt</span><span class="lbl-sm">Préfiltrage</span></div></div>
    <span class="field-lbl lbl-sm">Mots-clés exclus (séparés par des virgules)</span><input type="text" id="exclude" value="${esc(cfg.exclude.join(', '))}">
    <span class="field-lbl lbl-sm">Conservation des articles non triés (jours)</span><input type="number" id="keep" min="1" max="365" value="${cfg.keepDays}">
    <div class="row-actions"><button class="btn primary" data-act="save-filters">ENREGISTRER</button></div>
  </div>
  <div class="panel">
    <div class="prog-head"><div class="l"><span class="ms">database</span><span class="lbl-sm">Données</span></div><span class="r">v${VERSION}</span></div>
    <div class="row-actions"><button class="btn danger-solid" data-act="clear-inbox"><span class="ms">delete_sweep</span><span>VIDER « À TRIER »</span></button></div>
  </div>`;
}

function setRefreshUi() {
  const b = $('#btn-refresh'), i = $('#refresh-icon');
  if (b) b.disabled = busy;
  if (i) i.classList.toggle('spin', busy);
}

function render() {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  const n = Object.keys(arts).length;
  $('#badge').textContent = n ? (n > 99 ? '99+' : String(n)) : '';
  $('#main').innerHTML = { trier: vTrier, classes: vClasses, export: vExport, reglages: vReglages }[view]();
}

function animateOut(id, dir) {
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (!el) return Promise.resolve();
  el.style.transform = `translateX(${dir * 100}px)`;
  el.style.opacity = '0';
  return new Promise(r => setTimeout(r, 350));
}

/* ---------- Fiche de classement ---------- */
function openSheet(id) {
  const a = tri[id] || arts[id];
  if (!a) return;
  cur = { id, domaines: [...(a.domaines || [])], orientation: a.orientation || 'neutre', usage: a.usage || '' };
  const n = hl[id] ? hl[id].length : 0;
  const seg = (attr, entries, sel) => `<div class="pills wrap">${entries.map(([k, v]) => `<button class="pill-btn lbl ${sel(k) ? 'on' : ''}" data-${attr}="${k}">${v}</button>`).join('')}</div>`;
  $('#sheet').innerHTML = `<div class="grab"></div>
  <div class="c-src"><span class="ini">${esc(initials(a.source))}</span><span class="src-name lbl">${esc(a.source)}</span><span class="sep">•</span><span class="time">${esc(a.rubrique || '')}</span></div>
  <div class="s-title">${esc(a.title)}</div>
  <p class="muted"><span class="ms" style="font-size:15px;vertical-align:-3px;color:var(--amber)">ink_highlighter</span> ${n ? `${n} passage(s) surligné(s), exporté(s) dans la note.` : 'Aucun passage surligné.'}</p>
  <span class="field-lbl lbl-sm">Domaines</span>
  ${seg('sd', Object.entries(DOMS), k => cur.domaines.includes(k))}
  <span class="field-lbl lbl-sm">Orientation</span>
  <div id="s-or">${seg('so', [['neutre', 'Neutre'], ['oriente', 'Orienté']], k => cur.orientation === k)}</div>
  <div id="s-sens-w" style="${cur.orientation === 'oriente' ? '' : 'display:none'}"><span class="field-lbl lbl-sm">Sens de l'orientation (facultatif)</span><input type="text" id="s-sens" value="${esc(a.sens || '')}"></div>
  <span class="field-lbl lbl-sm">Usage</span>
  <div id="s-us">${seg('su', Object.entries(USAGES), k => cur.usage === k)}</div>
  <span class="field-lbl lbl-sm">Résumé (dans vos mots)</span>
  <textarea id="s-res">${esc(a.resume || '')}</textarea>
  <span class="field-lbl lbl-sm">Thèse(s) ou scénario(s), séparés par « ; »</span>
  <input type="text" id="s-th" value="${esc(a.theses || '')}">
  <div class="row-actions" style="margin-top:18px"><button class="btn tonal" data-act="close">ANNULER</button><button class="btn primary" data-act="save" style="flex:1"><span class="ms fill">check_circle</span><span>ENREGISTRER</span></button></div>
  ${tri[id] ? '<div class="row-actions"><button class="btn ghost" data-act="untri"><span class="ms">undo</span><span>REMETTRE DANS « À TRIER »</span></button></div>' : ''}`;
  $('#sheet-bg').classList.add('open');
  $('#sheet').classList.add('open');
  $('#sheet').scrollTop = 0;
}
function closeSheet() { $('#sheet-bg').classList.remove('open'); $('#sheet').classList.remove('open'); cur = null; }

async function saveTri() {
  if (!cur.usage) { toast('Choisissez un usage.', 'error'); return; }
  if (cur.usage !== 'rejeter' && !cur.domaines.length) { toast('Choisissez au moins un domaine.', 'error'); return; }
  const id = cur.id, base = tri[id] || arts[id], wasNew = !tri[id];
  tri[id] = {
    ...base,
    domaines: cur.domaines,
    orientation: cur.orientation,
    sens: cur.orientation === 'oriente' ? $('#s-sens').value.trim() : '',
    usage: cur.usage,
    resume: $('#s-res').value.trim(),
    theses: $('#s-th').value.trim(),
    at: new Date().toISOString(),
    exported: false
  };
  delete arts[id];
  if (cur.usage === 'rejeter') forget(id);
  persist(); closeSheet();
  if (reader) closeReader();
  else { if (wasNew) await animateOut(id, 1); render(); }
  const rej = tri[id].usage === 'rejeter';
  toast(rej ? 'Article rejeté' : 'Article classé', rej ? 'block' : 'check_circle');
}

async function quickReject(id) {
  const a = arts[id]; if (!a) return;
  await animateOut(id, -1);
  tri[id] = { ...a, usage: 'rejeter', orientation: '', sens: '', resume: '', theses: '', at: new Date().toISOString(), exported: false };
  delete arts[id];
  forget(id);
  persist(); render();
  toast('Article rejeté', 'block');
}

function untri(id) {
  const a = { ...tri[id] };
  ['orientation', 'sens', 'usage', 'resume', 'theses', 'at', 'exported'].forEach(k => delete a[k]);
  arts[id] = a; delete tri[id];
  persist(); closeSheet(); render();
  toast('Remis dans « À trier »', 'undo');
}

/* ---------- Export, sauvegarde ---------- */
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return true;
}
function markExported(list) { list.forEach(t => { if (tri[t.id]) tri[t.id].exported = true; }); persist(); render(); }

async function doShare() {
  const list = toExport($('#exp-all') && $('#exp-all').checked);
  if (!list.length) { alert('Rien à exporter.'); return; }
  const files = buildFiles(list).map(f => new File([f.text], f.name, { type: 'text/plain' }));
  if (!(navigator.canShare && navigator.canShare({ files }))) { alert('Le partage de fichiers n\'est pas disponible ici. Utilisez « Archive ZIP ».'); return; }
  try { await navigator.share({ files }); markExported(list); }
  catch (e) { if (e.name !== 'AbortError') alert('Partage impossible : ' + e.message); }
}
async function doZip() {
  const list = toExport($('#exp-all') && $('#exp-all').checked);
  if (!list.length) { alert('Rien à exporter.'); return; }
  const blob = new Blob(zipParts(buildFiles(list)), { type: 'application/zip' });
  if (await shareOrDownload(blob, `notes-presse-${new Date().toISOString().slice(0, 10)}.zip`)) markExported(list);
}
function backup() {
  const data = JSON.stringify({ app: 'agregateur-presse', v: 2, date: new Date().toISOString(), cfg, arts, tri, hl });
  shareOrDownload(new Blob([data], { type: 'application/json' }), `sauvegarde-presse-${new Date().toISOString().slice(0, 10)}.json`);
}
async function restore(file) {
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'agregateur-presse' || !d.cfg || !d.tri) throw new Error('fichier non reconnu');
    if (!confirm('Remplacer toutes les données actuelles par cette sauvegarde ?')) return;
    cfg = d.cfg; arts = d.arts || {}; tri = d.tri; hl = d.hl || {};
    defaults(); persist(); setStatus('Sauvegarde restaurée.'); render();
  } catch (e) { alert('Restauration impossible : ' + e.message); }
}

async function testProxy() {
  const p = $('#proxy').value.trim(), out = $('#proxy-status');
  const f = activeFeeds()[0] || allFeeds()[0];
  if (!p || !f) { out.textContent = 'Proxy ou flux manquant.'; return; }
  out.textContent = 'Test sur ' + f.source + ' – ' + f.rubrique + '…';
  const saved = cfg.proxy; cfg.proxy = p;
  try { const items = parseFeed(await fetchText(f.url)); out.innerHTML = `<span class="okc">OK : ${items.length} articles lus.</span>`; }
  catch (e) { out.innerHTML = `<span class="err">Échec : ${esc(e.message)}</span>`; }
  finally { cfg.proxy = saved; }
}

function addFeed() {
  const url = $('#nf-url').value.trim(), src = $('#nf-src').value.trim();
  if (!/^https?:\/\//.test(url) || !src) { alert('Renseignez le média et une adresse http(s).'); return; }
  const id = 'perso-' + hash(url);
  if (allFeeds().some(f => f.id === id || f.url === url)) { alert('Ce flux est déjà présent.'); return; }
  cfg.custom.push({ id, source: src, rubrique: 'Flux ajouté', url, langue: '', domaines: [], statut: 'perso', custom: true });
  cfg.mediaOn[src] = true;
  save('cfg', cfg); render();
}

function setMedia(v) { mediaList().forEach(m => { cfg.mediaOn[m] = v; }); save('cfg', cfg); render(); }

/* ---------- Démarrage ---------- */
function defaults() {
  cfg = Object.assign({ proxy: DEFAULT_PROXY, mediaOn: null, custom: [], exclude: [], keepDays: 30, concurrency: 6 }, cfg || {});
  if (!cfg.mediaOn) {
    cfg.mediaOn = {};
    if (cfg.feedsOn) allFeeds().forEach(f => { if (cfg.feedsOn[f.id]) cfg.mediaOn[f.source] = true; }); // migration v1
  }
  delete cfg.feedsOn; delete cfg.domains;
  save('cfg', cfg);
}

async function loadPanel() {
  try {
    const r = await fetch('panel-rss.json', { cache: 'no-cache' });
    if (r.ok) { panel = await r.json(); save('panel', panel); }
  } catch (e) { /* hors ligne : copie locale */ }
  if (!panel) panel = load('panel', null);
}

function setNet() {
  const on = navigator.onLine;
  $('#net').classList.toggle('off', !on);
  $('#net-t').textContent = on ? 'En ligne' : 'Hors ligne';
}

function bind() {
  $('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; view = b.dataset.v; shown = 100; mediaFilter = null; render(); window.scrollTo(0, 0); });
  $('#btn-settings').addEventListener('click', () => { view = 'reglages'; render(); window.scrollTo(0, 0); });
  $('#sheet-bg').addEventListener('click', closeSheet);
  window.addEventListener('online', setNet); window.addEventListener('offline', setNet);
  // Vignette introuvable : on retire le cadre
  $('#main').addEventListener('error', e => { if (e.target.tagName === 'IMG') { const t = e.target.closest('.thumb'); if (t) t.remove(); } }, true);

  $('#sheet').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !cur) return;
    if (b.dataset.sd) { const d = b.dataset.sd, i = cur.domaines.indexOf(d); i < 0 ? cur.domaines.push(d) : cur.domaines.splice(i, 1); b.classList.toggle('on'); }
    else if (b.dataset.so) { cur.orientation = b.dataset.so; $('#s-or').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); $('#s-sens-w').style.display = cur.orientation === 'oriente' ? '' : 'none'; }
    else if (b.dataset.su) { cur.usage = b.dataset.su; $('#s-us').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }
    else if (b.dataset.act === 'close') closeSheet();
    else if (b.dataset.act === 'save') saveTri();
    else if (b.dataset.act === 'untri') untri(cur.id);
  });

  // Lecteur
  $('#r-back').addEventListener('click', closeReader);
  $('#r-classer').addEventListener('click', () => { if (reader) openSheet(reader.id); });
  const hlBtn = $('#btn-hl');
  hlBtn.addEventListener('pointerdown', e => { e.preventDefault(); doHighlight(); });
  hlBtn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doHighlight(); } });
  document.addEventListener('selectionchange', () => {
    if (!reader) return;
    const r = selectionInBody();
    clearTimeout(clearTimer);
    if (r) { savedRange = r.cloneRange(); hlBtn.classList.add('ready'); }
    else clearTimer = setTimeout(() => { savedRange = null; hlBtn.classList.remove('ready'); }, 800);
  });
  $('#r-scroll').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (b && b.dataset.act === 'r-retry') { rBody().innerHTML = LOADING; await loadReaderContent(reader.id, true); return; }
    if (b && b.dataset.act === 'r-reload') {
      const n = hl[reader.id] ? hl[reader.id].length : 0;
      if (n && !confirm(`Recharger le texte supprime les ${n} surlignage(s) de cet article. Continuer ?`)) return;
      delete hl[reader.id]; save('hl', hl);
      rBody().innerHTML = LOADING;
      await loadReaderContent(reader.id, true); return;
    }
    const m = e.target.closest('mark[data-h]');
    if (m && !selectionInBody()) { if (confirm('Retirer ce surlignage ?')) removeHighlight(m.getAttribute('data-h')); }
  });

  $('#main').addEventListener('click', e => {
    const b = e.target.closest('button,[data-act]');
    if (!b) return;
    const act = b.dataset.act, c = b.closest('.card'), id = c && c.dataset.id;
    if (act === 'read') openReader(id);
    else if (act === 'reject') quickReject(id);
    else if (act === 'open') openSheet(id);
    else if (act === 'refresh') refresh();
    else if (act === 'more') { shown += 100; render(); }
    else if (b.dataset.m !== undefined) { mediaFilter = b.dataset.m || null; shown = 100; render(); }
    else if (b.dataset.u) { usageFilter = b.dataset.u; shown = 100; render(); }
    else if (b.dataset.df !== undefined) { domFilter = b.dataset.df || null; shown = 100; render(); }
    else if (act === 'goto-reglages') { view = 'reglages'; render(); }
    else if (act === 'share') doShare();
    else if (act === 'zip') doZip();
    else if (act === 'backup') backup();
    else if (act === 'restore') $('#restore-file').click();
    else if (act === 'save-proxy') { cfg.proxy = $('#proxy').value.trim(); save('cfg', cfg); toast('Proxy enregistré'); }
    else if (act === 'test-proxy') testProxy();
    else if (act === 'save-filters') {
      cfg.exclude = $('#exclude').value.split(',').map(s => s.trim()).filter(Boolean);
      const k = parseInt($('#keep').value, 10); if (k > 0) cfg.keepDays = k;
      save('cfg', cfg); toast('Préfiltrage enregistré', 'filter_alt');
    }
    else if (act === 'add-feed') addFeed();
    else if (act === 'del-feed') {
      const f = cfg.custom.find(x => x.id === b.dataset.id);
      cfg.custom = cfg.custom.filter(x => x.id !== b.dataset.id);
      if (f && !allFeeds().some(x => x.source === f.source)) delete cfg.mediaOn[f.source];
      save('cfg', cfg); render();
    }
    else if (act === 'media-all') setMedia(true);
    else if (act === 'media-none') setMedia(false);
    else if (act === 'clear-inbox') { if (confirm('Supprimer tous les articles non triés ?')) { Object.keys(arts).forEach(forget); arts = {}; persist(); render(); } }
  });

  $('#main').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.media !== undefined) { cfg.mediaOn[t.dataset.media] = t.checked; save('cfg', cfg); }
    else if (t.id === 'restore-file') restore(t.files[0]);
  });
}

async function boot() {
  cfg = load('cfg', null); arts = load('arts', {}); tri = load('tri', {}); fstat = load('fstat', {}); hl = load('hl', {});
  await loadPanel();
  defaults();
  bind();
  setNet();
  // Icônes : masquées tant que la police n'est pas chargée (évite d'afficher leur nom en texte)
  if (document.fonts && document.fonts.load) {
    document.fonts.load('18px "Material Symbols Outlined"', 'check').then(f => { if (f.length) document.documentElement.classList.add('icons-ready'); }).catch(() => {});
  }
  render();
  if (!panel) setStatus('Panel de flux introuvable (panel-rss.json).');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (typeof document !== 'undefined') boot();
if (typeof module !== 'undefined') module.exports = { toMd, buildFiles, zipParts, crc32, hash, safeName };
