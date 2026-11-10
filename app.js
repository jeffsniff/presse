'use strict';
/* Agrégateur de presse — PWA. Données stockées localement (localStorage). */

const DOMS = { politique: 'Politique', economie: 'Économie', 'relations-internationales': 'Relations int.', technologie: 'Technologie' };
const USAGES = { rejeter: 'Rejeter', archiver: 'Archiver', 'these-a-approfondir': 'Thèse à approfondir', 'these-retenue': 'Thèse retenue' };
const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url=';
const VERSION = '1.0';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { alert('Stockage plein ou indisponible : ' + e.message); return false; } }

let panel = null, cfg = null, arts = {}, tri = {}, fstat = {};
let view = 'trier', domFilter = null, usageFilter = 'non-rejetes', shown = 100, busy = false, cur = null;

/* ---------- Utilitaires purs ---------- */
function hash(s) {
  let a = 5381, b = 2166136261;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = ((a << 5) + a + c) | 0; b = Math.imul(b ^ c, 16777619); }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|#^\[\]\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim(); }
function ymd(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
function fmtDate(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function tsOf(a) { return Date.parse(a.date || a.fetched) || 0; }

function thesesList(t) { return t.theses ? t.theses.split(';').map(safeName).filter(Boolean) : []; }

function toMd(t) {
  const y = v => JSON.stringify(v ?? '');
  const th = thesesList(t);
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
    `tri: ${ymd(t.at)}`,
    'tags: [source/presse]',
    '---',
    ''
  ];
  const body = [
    `# ${t.title}`,
    '',
    `> ${t.source}${t.rubrique ? ' — ' + t.rubrique : ''}, ${ymd(t.date || t.fetched)} · [Lire l'article](${t.link})`,
    '',
    '## Résumé',
    '',
    t.resume || '_À compléter._',
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

/* ---------- Lecture des flux ---------- */
function strip(html) {
  if (!html) return '';
  const d = new DOMParser().parseFromString(html, 'text/html');
  return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
}
function decode(buf) {
  const head = new TextDecoder('ascii').decode(buf.slice(0, 300));
  const m = /encoding=["']([\w-]+)["']/i.exec(head);
  try { return new TextDecoder(m ? m[1].toLowerCase() : 'utf-8').decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
}
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
    const ex = strip(txt(it, 'description') || txt(it, 'summary') || txt(it, 'content:encoded') || txt(it, 'content'));
    return { title: strip(txt(it, 'title')) || '(sans titre)', link, date: d && !isNaN(d) ? d.toISOString() : null, excerpt: ex.slice(0, 400) };
  }).filter(x => /^https?:\/\//.test(x.link));
}

async function fetchFeed(f) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(cfg.proxy + encodeURIComponent(f.url), { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return parseFeed(decode(await r.arrayBuffer()));
  } finally { clearTimeout(t); }
}

function allFeeds() { return [...(panel ? panel.flux : []), ...cfg.custom]; }
function activeFeeds() { return allFeeds().filter(f => cfg.feedsOn[f.id] && f.domaines.some(d => cfg.domains.includes(d))); }
function setStatus(s) { $('#status').textContent = s; }

async function refresh() {
  if (busy) return;
  const feeds = activeFeeds();
  if (!feeds.length) { setStatus('Aucun flux actif pour les domaines choisis.'); return; }
  if (!cfg.proxy) { setStatus('Proxy non configuré (onglet Réglages).'); return; }
  busy = true; $('#btn-refresh').disabled = true;
  let done = 0, added = 0, errs = 0;
  const limit = Date.now() - cfg.keepDays * 864e5;
  const kw = cfg.exclude.map(k => k.toLowerCase()).filter(Boolean);
  const queue = [...feeds];
  setStatus(`Actualisation 0/${feeds.length}…`);
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      try {
        const items = await fetchFeed(f);
        for (const it of items) {
          const id = hash(it.link);
          if (arts[id] || tri[id]) continue;
          if (it.date && Date.parse(it.date) < limit) continue;
          const hay = (it.title + ' ' + it.excerpt).toLowerCase();
          if (kw.some(k => hay.includes(k))) continue;
          arts[id] = { id, ...it, feedId: f.id, source: f.source, rubrique: f.rubrique, domaines: [...f.domaines], fetched: new Date().toISOString() };
          added++;
        }
        fstat[f.id] = { ok: true, n: items.length, at: Date.now() };
      } catch (e) {
        errs++;
        fstat[f.id] = { ok: false, err: e.name === 'AbortError' ? 'délai dépassé' : e.message, at: Date.now() };
      }
      done++;
      setStatus(`Actualisation ${done}/${feeds.length}…`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, feeds.length) }, worker));
  prune();
  save('arts', arts); save('fstat', fstat);
  setStatus(`${added} nouvel(s) article(s) · ${feeds.length - errs}/${feeds.length} flux OK${errs ? ` · ${errs} en erreur (détail dans Réglages)` : ''}`);
  busy = false; $('#btn-refresh').disabled = false;
  render();
}

function prune() {
  const limit = Date.now() - cfg.keepDays * 864e5;
  for (const id in arts) if (tsOf(arts[id]) < limit) delete arts[id];
}
function persist() { save('arts', arts); save('tri', tri); }

/* ---------- Vues ---------- */
function card(a) {
  const t = tri[a.id];
  const doms = (t ? t.domaines : a.domaines).map(d => `<span class="tag">${esc(DOMS[d] || d)}</span>`).join('');
  return `<div class="card" data-id="${a.id}">
  <div class="meta"><span>${esc(a.source)}</span><span>·</span><span>${fmtDate(a.date || a.fetched)}</span>${doms}${t ? `<span class="tag">${USAGES[t.usage]}</span>` : ''}${t && t.orientation === 'oriente' ? `<span class="tag">orienté${t.sens ? ' : ' + esc(t.sens) : ''}</span>` : ''}${t && t.exported ? '<span class="tag">exporté</span>' : ''}</div>
  <div class="title">${esc(a.title)}</div>
  ${a.excerpt ? `<div class="ex">${esc(a.excerpt)}</div>` : ''}
  <div class="actions">${t ? '' : '<button class="danger" data-act="reject">Rejeter</button>'}<button class="primary" data-act="open">${t ? 'Modifier' : 'Trier'}</button><a href="${esc(a.link)}" target="_blank" rel="noopener" style="margin-left:auto">Lire ↗</a></div>
</div>`;
}

function vTrier() {
  let list = Object.values(arts).filter(a => !domFilter || a.domaines.includes(domFilter)).sort((x, y) => tsOf(y) - tsOf(x));
  const total = list.length;
  list = list.slice(0, shown);
  return `<p class="muted">${total} article(s) à trier${domFilter ? ' · ' + DOMS[domFilter] : ''}.</p>` +
    (total ? '' : '<p class="muted">Touchez « Actualiser » pour charger les flux.</p>') +
    list.map(card).join('') +
    (total > shown ? `<button data-act="more" style="width:100%">Afficher plus (${total - shown})</button>` : '');
}

function vClasses() {
  const opts = { 'non-rejetes': 'Tous retenus', ...USAGES };
  let list = Object.values(tri)
    .filter(t => usageFilter === 'non-rejetes' ? t.usage !== 'rejeter' : t.usage === usageFilter)
    .filter(t => !domFilter || t.domaines.includes(domFilter))
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  const total = list.length;
  list = list.slice(0, shown);
  return `<div class="seg">${Object.entries(opts).map(([k, v]) => `<button data-u="${k}" class="${usageFilter === k ? 'on' : ''}">${v}</button>`).join('')}</div>
  <p class="muted">${total} article(s).</p>` + list.map(card).join('') +
    (total > shown ? `<button data-act="more" style="width:100%">Afficher plus (${total - shown})</button>` : '');
}

function toExport(all) { return Object.values(tri).filter(t => t.usage !== 'rejeter' && (all || !t.exported)); }

function vExport() {
  const n = toExport(false).length, N = toExport(true).length;
  return `<h2>Notes Obsidian</h2>
  <p class="muted">${n} note(s) non encore exportée(s) · ${N} au total. Les articles rejetés ne sont jamais exportés.</p>
  <label style="display:flex;gap:8px;align-items:center;color:var(--fg)"><input type="checkbox" id="exp-all" style="width:20px;height:20px"> Réexporter aussi les notes déjà exportées</label>
  <div class="actions wrap"><button class="primary" data-act="share">Partager les fichiers .md</button><button data-act="zip">Archive ZIP</button></div>
  <p class="muted">Sur iPhone : « Partager », puis « Enregistrer dans Fichiers », puis le dossier de votre coffre Obsidian (Sur mon iPhone › Obsidian › nom du coffre, ou iCloud Drive › Obsidian). Une note modifiée après export repasse en « non exportée » ; Fichiers propose alors de remplacer l'ancienne.</p>
  <h2>Sauvegarde</h2>
  <p class="muted">Les articles et le tri sont stockés uniquement dans l'application. Exportez une sauvegarde régulièrement.</p>
  <div class="actions wrap"><button data-act="backup">Exporter la sauvegarde (.json)</button><button data-act="restore">Restaurer</button><input type="file" id="restore-file" accept="application/json,.json" hidden></div>`;
}

function vReglages() {
  const feeds = allFeeds(), bySrc = {};
  feeds.forEach(f => (bySrc[f.source] = bySrc[f.source] || []).push(f));
  const on = feeds.filter(f => cfg.feedsOn[f.id]).length;
  const feedHtml = Object.entries(bySrc).map(([s, fs]) => `<h3>${esc(s)}</h3>` + fs.map(f => {
    const st = fstat[f.id];
    return `<div class="feed"><input type="checkbox" data-feed="${f.id}" ${cfg.feedsOn[f.id] ? 'checked' : ''}>
    <div style="flex:1;min-width:0"><div>${esc(f.rubrique)} ${f.statut === 'a_confirmer' ? '<span class="tag warnc">à confirmer</span>' : ''}${f.custom ? '<span class="tag">perso</span>' : ''}</div>
    <div class="meta">${f.domaines.map(d => esc(DOMS[d] || d)).join(' · ')}${st ? ` · <span class="${st.ok ? 'okc' : 'err'}">${st.ok ? st.n + ' articles' : 'erreur : ' + esc(st.err)}</span>` : ''}</div>
    <div class="meta url">${esc(f.url)}</div>
    ${f.custom ? `<button class="danger" data-act="del-feed" data-id="${f.id}" style="margin-top:6px">Supprimer</button>` : ''}</div></div>`;
  }).join('')).join('');
  return `<h2>Proxy</h2>
  <p class="muted">Un navigateur ne peut pas lire directement la plupart des flux RSS (restriction CORS). L'application passe par un proxy : l'adresse du flux, encodée, est ajoutée à la fin de l'URL ci-dessous. Voir README pour héberger le vôtre.</p>
  <input type="url" id="proxy" value="${esc(cfg.proxy)}" placeholder="https://…workers.dev/?url=">
  <div class="actions"><button class="primary" data-act="save-proxy">Enregistrer</button><button data-act="test-proxy">Tester</button></div>
  <div class="status" id="proxy-status"></div>
  <h2>Domaines actifs</h2>
  <div class="seg">${Object.entries(DOMS).map(([k, v]) => `<button data-dom="${k}" class="${cfg.domains.includes(k) ? 'on' : ''}">${v}</button>`).join('')}</div>
  <p class="muted">Seuls les flux rattachés à au moins un domaine actif sont actualisés.</p>
  <h2>Préfiltrage</h2>
  <label>Mots-clés exclus (séparés par des virgules)</label>
  <input type="text" id="exclude" value="${esc(cfg.exclude.join(', '))}">
  <label>Conservation des articles non triés (jours)</label>
  <input type="number" id="keep" min="1" max="365" value="${cfg.keepDays}">
  <div class="actions"><button class="primary" data-act="save-filters">Enregistrer</button></div>
  <h2>Flux (${on}/${feeds.length} activés)</h2>
  <div class="actions wrap"><button data-act="feeds-verified">Vérifiés seulement</button><button data-act="feeds-all">Tout activer</button><button data-act="feeds-none">Tout désactiver</button></div>
  ${feedHtml}
  <h2>Ajouter un flux</h2>
  <label>Source</label><input type="text" id="nf-src">
  <label>Rubrique</label><input type="text" id="nf-rub">
  <label>Adresse du flux</label><input type="url" id="nf-url" placeholder="https://…">
  <label>Domaines</label>
  <div class="seg" id="nf-dom">${Object.entries(DOMS).map(([k, v]) => `<button data-nd="${k}">${v}</button>`).join('')}</div>
  <div class="actions"><button class="primary" data-act="add-feed">Ajouter</button></div>
  <h2>Données</h2>
  <div class="actions wrap"><button class="danger" data-act="clear-inbox">Vider « À trier »</button></div>
  <p class="muted">Version ${VERSION}</p>`;
}

function renderChips() {
  const el = $('#dom-chips');
  if (view === 'reglages' || view === 'export') { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = `<button class="chip ${domFilter === null ? 'on' : ''}" data-d="">Tous</button>` +
    Object.entries(DOMS).map(([k, v]) => `<button class="chip ${domFilter === k ? 'on' : ''}" data-d="${k}">${v}</button>`).join('');
}

function render() {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  $('#h-title').textContent = { trier: 'À trier', classes: 'Classés', export: 'Export', reglages: 'Réglages' }[view];
  $('#btn-refresh').style.display = view === 'trier' ? '' : 'none';
  renderChips();
  $('#main').innerHTML = { trier: vTrier, classes: vClasses, export: vExport, reglages: vReglages }[view]();
}

/* ---------- Fiche de tri ---------- */
function openSheet(id) {
  const a = tri[id] || arts[id];
  if (!a) return;
  cur = { id, domaines: [...a.domaines], orientation: a.orientation || 'neutre', usage: a.usage || '' };
  $('#sheet').innerHTML = `<div class="meta">${esc(a.source)}${a.rubrique ? ' · ' + esc(a.rubrique) : ''} · ${fmtDate(a.date || a.fetched)}</div>
  <div class="title" style="font-size:18px">${esc(a.title)}</div>
  ${a.excerpt ? `<p class="muted">${esc(a.excerpt)}</p>` : ''}
  <a href="${esc(a.link)}" target="_blank" rel="noopener">Lire l'article ↗</a>
  <label>Domaines</label>
  <div class="seg" id="s-dom">${Object.entries(DOMS).map(([k, v]) => `<button data-sd="${k}" class="${cur.domaines.includes(k) ? 'on' : ''}">${v}</button>`).join('')}</div>
  <label>Orientation</label>
  <div class="seg" id="s-or"><button data-so="neutre" class="${cur.orientation === 'neutre' ? 'on' : ''}">Neutre</button><button data-so="oriente" class="${cur.orientation === 'oriente' ? 'on' : ''}">Orienté</button></div>
  <div id="s-sens-w" style="${cur.orientation === 'oriente' ? '' : 'display:none'}"><label>Sens de l'orientation (facultatif)</label><input type="text" id="s-sens" value="${esc(a.sens || '')}"></div>
  <label>Usage</label>
  <div class="seg" id="s-us">${Object.entries(USAGES).map(([k, v]) => `<button data-su="${k}" class="${cur.usage === k ? 'on' : ''}">${v}</button>`).join('')}</div>
  <label>Résumé (dans vos mots)</label>
  <textarea id="s-res">${esc(a.resume || '')}</textarea>
  <label>Thèse(s) ou scénario(s), séparés par « ; »</label>
  <input type="text" id="s-th" value="${esc(a.theses || '')}">
  <div class="actions"><button data-act="close">Annuler</button><button class="primary" data-act="save" style="flex:1">Enregistrer</button></div>
  ${tri[id] ? '<div class="actions"><button class="danger" data-act="untri">Remettre dans « À trier »</button></div>' : ''}`;
  $('#sheet-bg').classList.add('open');
  $('#sheet').classList.add('open');
  $('#sheet').scrollTop = 0;
}
function closeSheet() { $('#sheet-bg').classList.remove('open'); $('#sheet').classList.remove('open'); cur = null; }

function saveTri() {
  if (!cur.usage) { alert('Choisissez un usage.'); return; }
  if (!cur.domaines.length) { alert('Choisissez au moins un domaine.'); return; }
  const base = tri[cur.id] || arts[cur.id];
  tri[cur.id] = {
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
  delete arts[cur.id];
  persist(); closeSheet(); render();
}

function quickReject(id) {
  const a = arts[id]; if (!a) return;
  tri[id] = { ...a, usage: 'rejeter', orientation: '', sens: '', resume: '', theses: '', at: new Date().toISOString(), exported: false };
  delete arts[id];
  persist(); render();
}

function untri(id) {
  const a = { ...tri[id] };
  ['orientation', 'sens', 'usage', 'resume', 'theses', 'at', 'exported'].forEach(k => delete a[k]);
  arts[id] = a; delete tri[id];
  persist(); closeSheet(); render();
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
  const data = JSON.stringify({ app: 'agregateur-presse', v: 1, date: new Date().toISOString(), cfg, arts, tri });
  shareOrDownload(new Blob([data], { type: 'application/json' }), `sauvegarde-presse-${new Date().toISOString().slice(0, 10)}.json`);
}
async function restore(file) {
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'agregateur-presse' || !d.cfg || !d.tri) throw new Error('fichier non reconnu');
    if (!confirm('Remplacer toutes les données actuelles par cette sauvegarde ?')) return;
    cfg = d.cfg; arts = d.arts || {}; tri = d.tri;
    defaults(); persist(); setStatus('Sauvegarde restaurée.'); render();
  } catch (e) { alert('Restauration impossible : ' + e.message); }
}

async function testProxy() {
  const p = $('#proxy').value.trim(), out = $('#proxy-status');
  const f = activeFeeds()[0] || allFeeds()[0];
  if (!p || !f) { out.textContent = 'Proxy ou flux manquant.'; return; }
  out.textContent = 'Test sur ' + f.source + ' – ' + f.rubrique + '…';
  const saved = cfg.proxy; cfg.proxy = p;
  try { const items = await fetchFeed(f); out.innerHTML = `<span class="okc">OK : ${items.length} articles lus.</span>`; }
  catch (e) { out.innerHTML = `<span class="err">Échec : ${esc(e.name === 'AbortError' ? 'délai dépassé' : e.message)}</span>`; }
  finally { cfg.proxy = saved; }
}

function addFeed() {
  const url = $('#nf-url').value.trim(), src = $('#nf-src').value.trim(), rub = $('#nf-rub').value.trim();
  const doms = [...document.querySelectorAll('#nf-dom button.on')].map(b => b.dataset.nd);
  if (!/^https?:\/\//.test(url) || !src || !doms.length) { alert('Renseignez la source, une adresse http(s) et au moins un domaine.'); return; }
  const id = 'perso-' + hash(url);
  if (allFeeds().some(f => f.id === id || f.url === url)) { alert('Ce flux est déjà présent.'); return; }
  cfg.custom.push({ id, source: src, rubrique: rub || '—', url, langue: '', domaines: doms, statut: 'perso', custom: true });
  cfg.feedsOn[id] = true;
  save('cfg', cfg); render();
}

function setFeeds(mode) {
  allFeeds().forEach(f => { cfg.feedsOn[f.id] = mode === 'all' ? true : mode === 'none' ? false : (f.statut === 'verifie' || !!f.custom); });
  save('cfg', cfg); render();
}

/* ---------- Démarrage ---------- */
function defaults() {
  cfg = Object.assign({ proxy: DEFAULT_PROXY, domains: Object.keys(DOMS), feedsOn: {}, custom: [], exclude: [], keepDays: 30, concurrency: 5 }, cfg || {});
  if (panel) panel.flux.forEach(f => { if (!(f.id in cfg.feedsOn)) cfg.feedsOn[f.id] = f.statut === 'verifie'; });
  save('cfg', cfg);
}

async function loadPanel() {
  try {
    const r = await fetch('panel-rss.json', { cache: 'no-cache' });
    if (r.ok) { panel = await r.json(); save('panel', panel); }
  } catch (e) { /* hors ligne : on garde la copie locale */ }
  if (!panel) panel = load('panel', null);
}

function bind() {
  $('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; view = b.dataset.v; shown = 100; render(); window.scrollTo(0, 0); });
  $('#dom-chips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; domFilter = b.dataset.d || null; shown = 100; render(); });
  $('#btn-refresh').addEventListener('click', refresh);
  $('#sheet-bg').addEventListener('click', closeSheet);

  $('#sheet').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !cur) return;
    if (b.dataset.sd) { const d = b.dataset.sd, i = cur.domaines.indexOf(d); i < 0 ? cur.domaines.push(d) : cur.domaines.splice(i, 1); b.classList.toggle('on'); }
    else if (b.dataset.so) { cur.orientation = b.dataset.so; $('#s-or').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); $('#s-sens-w').style.display = cur.orientation === 'oriente' ? '' : 'none'; }
    else if (b.dataset.su) { cur.usage = b.dataset.su; $('#s-us').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }
    else if (b.dataset.act === 'close') closeSheet();
    else if (b.dataset.act === 'save') saveTri();
    else if (b.dataset.act === 'untri') untri(cur.id);
  });

  $('#main').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) { const t = e.target.closest('.card .title'); if (t) openSheet(t.closest('.card').dataset.id); return; }
    const act = b.dataset.act, c = b.closest('.card'), id = c && c.dataset.id;
    if (act === 'reject') quickReject(id);
    else if (act === 'open') openSheet(id);
    else if (act === 'more') { shown += 100; render(); }
    else if (b.dataset.u) { usageFilter = b.dataset.u; shown = 100; render(); }
    else if (act === 'share') doShare();
    else if (act === 'zip') doZip();
    else if (act === 'backup') backup();
    else if (act === 'restore') $('#restore-file').click();
    else if (act === 'save-proxy') { cfg.proxy = $('#proxy').value.trim(); save('cfg', cfg); $('#proxy-status').textContent = 'Proxy enregistré.'; }
    else if (act === 'test-proxy') testProxy();
    else if (b.dataset.dom) { const d = b.dataset.dom, i = cfg.domains.indexOf(d); i < 0 ? cfg.domains.push(d) : cfg.domains.splice(i, 1); save('cfg', cfg); render(); }
    else if (act === 'save-filters') {
      cfg.exclude = $('#exclude').value.split(',').map(s => s.trim()).filter(Boolean);
      const k = parseInt($('#keep').value, 10); if (k > 0) cfg.keepDays = k;
      save('cfg', cfg); setStatus('Préfiltrage enregistré.');
    }
    else if (b.dataset.nd) b.classList.toggle('on');
    else if (act === 'add-feed') addFeed();
    else if (act === 'del-feed') { cfg.custom = cfg.custom.filter(f => f.id !== b.dataset.id); delete cfg.feedsOn[b.dataset.id]; save('cfg', cfg); render(); }
    else if (act === 'feeds-verified') setFeeds('verified');
    else if (act === 'feeds-all') setFeeds('all');
    else if (act === 'feeds-none') setFeeds('none');
    else if (act === 'clear-inbox') { if (confirm('Supprimer tous les articles non triés ?')) { arts = {}; persist(); render(); } }
  });

  $('#main').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.feed) { cfg.feedsOn[t.dataset.feed] = t.checked; save('cfg', cfg); }
    else if (t.id === 'restore-file') restore(t.files[0]);
  });
}

async function boot() {
  cfg = load('cfg', null); arts = load('arts', {}); tri = load('tri', {}); fstat = load('fstat', {});
  await loadPanel();
  defaults();
  bind();
  render();
  if (!panel) setStatus('Panel de flux introuvable (panel-rss.json).');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (typeof document !== 'undefined') boot();
if (typeof module !== 'undefined') module.exports = { toMd, buildFiles, zipParts, crc32, hash, safeName };
