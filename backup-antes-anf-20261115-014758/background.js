'use strict';

// ============ Config ============
const DEFAULT_CONFIG = {
  regionals: ['TRJ'],
  interval: 10,
  massivaThreshold: 5,
  massivaWindowMin: 10,
  massivaGroup: 'end',            // 'end' | 'anf' | 'cidade'
  massivaMaxDays: 10,
  notifications: true,
  notifyFallen: true,
  notifyNormalized: true,
  baseUrl: 'http://10.174.221.60/operations/analisys/painel_online_peso.php'
};

const ALARM_NAME = 'genesis-check';
const CAP = 100;
const MASSIVA_ACTIVE_MIN = 60;      // massiva continua visível por 1h
const MIN_HTML_LOGIN = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 dia — ignora quedas antigas na exibição
const MAX_LIST = 60;                // itens por seção na janela de aviso

let config = Object.assign({}, DEFAULT_CONFIG);
let globalPrevItems = [];
let monitoring = true;
let toastsEnabled = true;
let lastCheck = null;
let lastDiff = null;
let lastError = null;
let lastInfo = null;
let history = [];
let massivas = [];
let dismissedMIds = [];
let noticeWindowId = null;
let checking = false;

// ============ Ajuda ============
function storageGet(area, key) {
  return new Promise(function (res) {
    try { chrome.storage[area].get(key, function (r) { res(r || {}); }); }
    catch (e) { res({}); }
  });
}
function storageSet(area, obj) {
  return new Promise(function (res) {
    try { chrome.storage[area].set(obj, function () { res(); }); }
    catch (e) { res(); }
  });
}

function sanitizeConfig(c) {
  const out = Object.assign({}, DEFAULT_CONFIG, c || {});
  if (['end', 'anf', 'cidade'].indexOf(out.massivaGroup) < 0) out.massivaGroup = 'end';
  out.interval = Math.max(parseInt(out.interval, 10) || DEFAULT_CONFIG.interval, 1);
  out.massivaThreshold = Math.max(parseInt(out.massivaThreshold, 10) || DEFAULT_CONFIG.massivaThreshold, 2);
  out.massivaWindowMin = Math.max(parseInt(out.massivaWindowMin, 10) || DEFAULT_CONFIG.massivaWindowMin, 1);
  out.massivaMaxDays = Math.max(parseInt(out.massivaMaxDays, 10) || DEFAULT_CONFIG.massivaMaxDays, 1);
  if (!Array.isArray(out.regionals) || !out.regionals.length) out.regionals = DEFAULT_CONFIG.regionals.slice();
  return out;
}

function loadState() {
  return storageGet('sync', 'config').then(function (sync) {
    if (sync && sync.config) config = sanitizeConfig(sync.config);
    return storageGet('local', null).then(function (l) {
      if (Array.isArray(l.prevItems)) globalPrevItems = l.prevItems;
      if (typeof l.toastsEnabled === 'boolean') toastsEnabled = l.toastsEnabled;
      if (typeof l.monitoring === 'boolean') monitoring = l.monitoring;
      if (l.lastCheck) lastCheck = l.lastCheck;
      if (l.lastDiff) lastDiff = l.lastDiff;
      if (l.lastError) lastError = l.lastError;
      if (l.lastInfo) lastInfo = l.lastInfo;
      if (Array.isArray(l.history)) history = l.history;
      if (Array.isArray(l.massivas)) massivas = l.massivas;
      if (Array.isArray(l.dismissedMIds)) dismissedMIds = l.dismissedMIds;
    });
  });
}

function persistLocal() {
  return storageSet('local', {
    prevItems: globalPrevItems,
    toastsEnabled: toastsEnabled,
    monitoring: monitoring,
    lastCheck: lastCheck,
    lastDiff: lastDiff,
    lastError: lastError,
    lastInfo: lastInfo,
    history: history,
    massivas: massivas,
    dismissedMIds: dismissedMIds
  });
}

function broadcast(obj) {
  try {
    const p = chrome.runtime.sendMessage(obj, function () {});
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) { /* sem receptor — silencioso */ }
}

function errMsg(e) {
  return String((e && e.message) ? e.message : e);
}

function unique(list) {
  const seen = {};
  const out = [];
  (list || []).forEach(function (v) {
    const k = String(v == null ? '' : v);
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push(k);
  });
  return out;
}

// Horário do painel é "dd/mm HH:MM" sem ano. Usa o ano que deixa a data mais
// próxima de agora (evita "29/12" virar 11 meses no futuro na virada de ano).
function parseHorario(s) {
  if (!s) return null;
  const m = String(s).trim().match(/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const now = new Date();
  const d = new Date(now.getFullYear(), parseInt(m[2], 10) - 1, parseInt(m[1], 10), parseInt(m[3], 10), parseInt(m[4], 10));
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() - now.getTime() > 86400000) d.setFullYear(d.getFullYear() - 1);
  return d;
}

// ============ Parser (sem DOMParser — roda no service worker) ============
const RE_TIME = /^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/;
const RE_END_ID = /^[A-Z0-9][A-Z0-9_\-.]{4,}$/i;
const RE_TECH = /^(2G|3G|4G|5G)$/i;
const UFS = /^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/;
const RE_CIDADE = /^([A-ZÁ-Ú0-9][A-ZÁ-Ú0-9 .\-'’]*)\s*\/\s*([A-Z]{2})$/;

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  acirc: 'â', ecirc: 'ê', ocirc: 'ô', agrave: 'à', atilde: 'ã', otilde: 'õ', ccedil: 'ç',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', Agrave: 'À', Atilde: 'Ã', Otilde: 'Õ', Ccedil: 'Ç',
  ordf: 'º', deg: '°', ntilde: 'ñ'
};

function decodeEnt(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, function (m, name) {
    if (name.charAt(0) === '#') {
      const n = name.charAt(1).toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return (n > 0 && n < 65536) ? String.fromCharCode(n) : m;
    }
    if (Object.prototype.hasOwnProperty.call(ENT, name)) return ENT[name];
    const low = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENT, low) ? ENT[low] : m;
  });
}

function cellText(html) {
  return decodeEnt(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// O painel emite "<td ...>4G<td ...>4G-RJSZ43</td>" (célula não fechada).
// O navegador auto-fecha em duas células; dividir em cada <td> reproduz isso.
function rowCells(rowHtml) {
  const parts = String(rowHtml || '').split(/<td\b[^>]*>/i);
  parts.shift();
  const cells = [];
  for (let i = 0; i < parts.length; i++) {
    cells.push(cellText(parts[i].split(/<\/td>/i)[0]));
  }
  return cells;
}

function rowsFromHtml(html) {
  const out = [];
  const rows = String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cells = rowCells(row);
    if (cells.length < 10) continue;
    const input = (row.match(/<input\b[^>]*checkbox[^>]*>/i) || [''])[0];
    const nameM = input.match(/\bname\s*=\s*['"]([^'"]+)['"]/i);
    const ng = row.match(/\bngnis\(\s*['"]([^'"]+)['"]\s*\)/i);
    out.push({ cells: cells, chk: nameM ? nameM[1] : '', end: ng ? ng[1] : '' });
  }
  return out;
}

// Converte uma linha crua em item. O End_Id vem do onClick=ngnis('...') e o
// nome do site do name do checkbox — ambos imunes a deslocamento de colunas.
function mapRow(row) {
  const cells = (row && row.cells) || [];
  if (!cells.length) return null;

  let hIdx = -1;
  for (let i = 0; i < cells.length; i++) {
    if (RE_TIME.test(cells[i])) { hIdx = i; break; }
  }
  if (hIdx < 0) return null;

  let endId = String((row && row.end) || '').trim();
  if (endId && !RE_END_ID.test(endId)) endId = '';
  if (!endId) {
    const techIdx = cells.findIndex(function (c, i) { return i > hIdx && RE_TECH.test(c); });
    const candidate = techIdx >= 0 ? cells[techIdx + 2] : '';
    if (candidate && RE_END_ID.test(candidate)) endId = candidate;
  }
  if (!endId) {
    const lim = Math.min(cells.length, hIdx + 10);
    for (let i = hIdx + 5; i < lim; i++) {
      const c = cells[i];
      if (!c || !RE_END_ID.test(c) || /^\d+$/.test(c) || /^(EVE|TSK)/i.test(c)) continue;
      endId = c;
      break;
    }
  }
  if (!endId) return null;

  let endIdx = cells.indexOf(endId);
  if (endIdx < 0) endIdx = hIdx + 7;

  // Colunas: ... | Tech (2G/3G/4G/5G) | Site | End_Id | ANF | Cidade/UF | ...
  let tech = '';
  const techCell = cells[endIdx - 2] || '';
  if (RE_TECH.test(techCell)) tech = techCell.toUpperCase();

  let site = String((row && row.chk) || '').trim();
  if (!site) site = cells[endIdx - 1] || '';
  if (!site || RE_TECH.test(site)) site = cells[hIdx + 6] || '';

  const anf = cells[endIdx + 1] || '';

  let cidade = '';
  let uf = '';
  let cidadeIdx = -1;
  for (let i = endIdx + 1; i < cells.length; i++) {
    const m = RE_CIDADE.exec(cells[i] || '');
    if (m && UFS.test(m[2])) { cidade = m[1].trim(); uf = m[2]; cidadeIdx = i; break; }
  }
  if (cidadeIdx < 0) {
    const fb = cells[endIdx + 2] || '';
    const parts = fb.split('/');
    cidade = (parts[0] || '').trim();
    uf = (parts[1] || '').trim();
  }

  let previsao = '';
  let seenTime = 0;
  for (let i = hIdx + 1; i < cells.length; i++) {
    if (RE_TIME.test(cells[i] || '')) { seenTime++; if (seenTime === 2) { previsao = cells[i]; break; } }
  }

  let causa = '';
  let status = '';
  const from = cidadeIdx >= 0 ? cidadeIdx + 1 : endIdx + 3;
  for (let i = from; i < cells.length; i++) {
    const c = cells[i] || '';
    if (!c || RE_TIME.test(c)) continue;
    if (!causa && c.length <= 90 && /[a-zá-ú]/.test(c) && /\s\/\s/.test(c)) { causa = c; continue; }
    if (!status && /^[A-Za-z0-9]+\s-\s/.test(c)) status = c;
  }

  return {
    site: site,
    tech: tech,
    end_id: endId,
    anf: anf,
    cidade: cidade,
    uf: uf,
    horario: cells[hIdx],
    causa: causa,
    previsao: previsao,
    status: status,
    regional: ''
  };
}

function parseRows(rows) {
  const items = [];
  (rows || []).forEach(function (r) {
    const it = mapRow(r);
    if (it) items.push(it);
  });
  return items;
}

// ============ Fetch + fallback aba ============
function fetchRegional(regional) {
  let target = config.baseUrl || DEFAULT_CONFIG.baseUrl;
  if (/\bregional=/.test(target)) {
    target = target.replace(/regional=[^&]*/, 'regional=' + encodeURIComponent(regional));
  } else {
    target += (target.indexOf('?') >= 0 ? '&' : '?') + 's=1&regional=' + encodeURIComponent(regional);
  }
  return fetch(target, { credentials: 'include', cache: 'no-store' }).then(function (resp) {
    if (!resp.ok) { const e = new Error('HTTP ' + resp.status + ' ' + resp.statusText); e.isHttp = true; throw e; }
    return resp.text();
  }).then(function (html) {
    if (!html || html.length < MIN_HTML_LOGIN) {
      const e = new Error('Login/sessão (HTML curto, ' + (html ? html.length : 0) + ' bytes)'); e.isLogin = true; throw e;
    }
    return { html: html, len: html.length };
  });
}

function getRowsFromTab(tabId) {
  return new Promise(function (resolve) {
    function injectAndAsk() {
      try {
        chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] }, function () {
          if (chrome.runtime.lastError) return resolve(null);
          try {
            chrome.tabs.sendMessage(tabId, { type: 'GET_ROWS' }, function (resp2) {
              if (chrome.runtime.lastError || !resp2 || !resp2.ok) return resolve(null);
              resolve(resp2);
            });
          } catch (e2) { resolve(null); }
        });
      } catch (e3) { resolve(null); }
    }
    try {
      chrome.tabs.sendMessage(tabId, { type: 'GET_ROWS' }, function (resp) {
        if (chrome.runtime.lastError) return injectAndAsk();
        if (resp && resp.ok && resp.rows) return resolve(resp);
        injectAndAsk();
      });
    } catch (e) { injectAndAsk(); }
  });
}

function rowsFromTabs(regional) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.query({}, function (tabs) {
        let cands = (tabs || []).filter(function (t) { return t && t.url && t.url.indexOf('painel_online_peso.php') >= 0; });
        if (!cands.length) return resolve(null);
        if (regional && cands.length > 1) {
          const exact = cands.filter(function (t) {
            return t.url.indexOf('regional=' + encodeURIComponent(regional)) >= 0 || t.url.indexOf('regional=' + regional) >= 0;
          });
          if (exact.length) cands = exact;
        }
        const tryNext = function (i) {
          if (i >= cands.length) return resolve(null);
          getRowsFromTab(cands[i].id).then(function (resp) {
            if (resp && resp.rows && resp.rows.length) resolve(resp);
            else tryNext(i + 1);
          });
        };
        tryNext(0);
      });
    } catch (e) { resolve(null); }
  });
}

async function checkRegional(regional) {
  let httpLen = 0;
  function tag(items) {
    (items || []).forEach(function (it) { it.regional = regional; });
    return items || [];
  }
  try {
    const r = await fetchRegional(regional);
    httpLen = r.len;
    const items = tag(parseRows(rowsFromHtml(r.html)));
    if (items.length) return { items: items, source: 'fetch', httpLen: httpLen, error: null };
    const tab = await rowsFromTabs(regional);
    if (tab && tab.rows && tab.rows.length) {
      const titems = tag(parseRows(tab.rows));
      if (titems.length) return { items: titems, source: 'tab', httpLen: httpLen, error: null, note: 'fetch 0 linhas' };
    }
    return { items: [], source: 'fetch', httpLen: httpLen, error: 'fetch retornou 0 linhas e nenhuma aba do painel respondeu' };
  } catch (e) {
    const tab = await rowsFromTabs(regional);
    if (tab && tab.rows && tab.rows.length) {
      const titems = tag(parseRows(tab.rows));
      if (titems.length) return { items: titems, source: 'tab', httpLen: httpLen, error: null, note: errMsg(e) };
    }
    return { items: [], source: 'fetch', httpLen: httpLen, error: errMsg(e) };
  }
}

// ============ Agregação por End_Id ============
// Uma queda de site = end_id. O painel traz uma linha por tecnologia do mesmo
// end_id (ex.: 4G-RJSZ43 e 3G-RJSZ43), então todas são unidas numa entrada.
function endKey(it) {
  return (it.end_id || '') + '|' + (it.regional || '');
}

function groupEnds(items) {
  const map = {};
  (items || []).forEach(function (it) {
    if (!it || !it.end_id) return;
    const k = endKey(it);
    let g = map[k];
    if (!g) {
      g = map[k] = {
        key: k,
        end_id: it.end_id,
        regional: it.regional || '',
        anf: it.anf || '',
        cidade: it.cidade || '',
        uf: it.uf || '',
        horario: it.horario || '',
        causa: it.causa || '',
        previsao: it.previsao || '',
        status: it.status || '',
        techs: [],
        sites: [],
        linhas: 0
      };
    }
    g.linhas++;
    if (it.tech && g.techs.indexOf(it.tech) < 0) g.techs.push(it.tech);
    if (it.site && g.sites.indexOf(it.site) < 0) g.sites.push(it.site);
    if (!g.anf && it.anf) g.anf = it.anf;
    if (!g.cidade && it.cidade) g.cidade = it.cidade;
    if (!g.causa && it.causa) g.causa = it.causa;
    if (!g.previsao && it.previsao) g.previsao = it.previsao;
    const a = parseHorario(g.horario);
    const b = parseHorario(it.horario);
    if (b && (!a || b < a)) g.horario = it.horario; // início mais antigo da queda
  });
  Object.keys(map).forEach(function (k) {
    map[k].techs.sort();
    map[k].sites.sort();
  });
  return map;
}

function sortByHorario(list) {
  return list.sort(function (a, b) {
    const ta = parseHorario(a.horario);
    const tb = parseHorario(b.horario);
    return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
  });
}

function detectChanges(prevItems, currItems) {
  const prevEnds = groupEnds(prevItems);
  const currEnds = groupEnds(currItems);
  const fallen = [];
  const normalized = [];
  Object.keys(currEnds).forEach(function (k) {
    if (!prevEnds[k]) fallen.push(currEnds[k]);
  });
  Object.keys(prevEnds).forEach(function (k) {
    if (!currEnds[k]) normalized.push(prevEnds[k]);
  });
  return { fallen: sortByHorario(fallen), normalized: sortByHorario(normalized) };
}

// ============ Massiva ============
// Agrupa todas as quedas atuais por uma dimensão (end => todas juntas) e procura a
// maior janela de `massivaWindowMin` minutos com pelo menos `massivaThreshold`
// end_ids distintos.
function findMassivas(fallenEnds) {
  const win = Math.max(parseInt(config.massivaWindowMin, 10) || DEFAULT_CONFIG.massivaWindowMin, 1) * 60000;
  const maxMs = Math.max(parseInt(config.massivaMaxDays, 10) || DEFAULT_CONFIG.massivaMaxDays, 1) * 86400000;
  const threshold = Math.max(parseInt(config.massivaThreshold, 10) || DEFAULT_CONFIG.massivaThreshold, 2);
  const now = Date.now();

  const fresh = (fallenEnds || []).filter(function (e) {
    const t = parseHorario(e.horario);
    return t && (now - t.getTime()) <= maxMs;
  });

  const groups = {};
  fresh.forEach(function (e) {
    let gk = 'TODOS';
    if (config.massivaGroup === 'anf') gk = e.anf || '?';
    else if (config.massivaGroup === 'cidade') gk = e.cidade || '?';
    (groups[gk] = groups[gk] || []).push(e);
  });

  const out = [];
  Object.keys(groups).forEach(function (gk) {
    const list = groups[gk].map(function (e) {
      const t = parseHorario(e.horario);
      return { e: e, t: t ? t.getTime() : 0 };
    }).filter(function (x) { return x.t; }).sort(function (a, b) { return a.t - b.t; });

    for (let offset = 0; offset < list.length;) {
    let best = null;
    for (let i = offset; i < list.length; i++) {
      let j = i;
      while (j + 1 < list.length && list[j + 1].t - list[i].t <= win) j++;
      const len = j - i + 1;
      if (len >= threshold) { best = { start: i, len: len }; break; }
    }
    if (!best) break;

    const sel = list.slice(best.start, best.start + best.len).map(function (x) { return x.e; });
    const t0 = list[best.start].t;
    const m = {
      id: gk + '_' + t0,
      group: gk,
      groupBy: config.massivaGroup,
      count: sel.length,
      time: new Date(t0).toISOString(),
      windowMin: Math.round(win / 60000),
      endList: sel.map(function (e) { return e.end_id; }),
      neList: unique(sel.reduce(function (acc, e) { return acc.concat(e.sites || []); }, [])).sort(),
      anfs: unique(sel.map(function (e) { return e.anf; })),
      cidades: unique(sel.map(function (e) { return e.cidade; })),
      primeiraCausa: (sel[0] && sel[0].causa) ? sel[0].causa : '',
      items: sel,
      dismissed: dismissedMIds.indexOf(gk + '_' + t0) >= 0
    };
    out.push(m);
    // Continua após o grupo encontrado para incluir outros incidentes.
    offset = best.start + best.len;
    }
  });
  return out;
}

function mergeMassivas(prev, news) {
  const now = Date.now();
  const byId = {};
  (prev || []).forEach(function (m) {
    const t = new Date(m.time).getTime();
    if (isFinite(t) && now - t <= MASSIVA_ACTIVE_MIN * 60000) byId[m.id] = m;
  });
  (news || []).forEach(function (m) { byId[m.id] = m; });
  return Object.keys(byId).map(function (k) {
    const m = byId[k];
    m.dismissed = dismissedMIds.indexOf(m.id) >= 0;
    return m;
  }).sort(function (a, b) { return new Date(b.time) - new Date(a.time); }).slice(0, 20);
}

// ============ Badge ============
function updateBadge() {
  const active = (massivas || []).filter(function (m) { return dismissedMIds.indexOf(m.id) < 0; }).length;
  chrome.action.setBadgeText({ text: active ? String(Math.min(active, 99)) : '' }, function () {});
  chrome.action.setBadgeBackgroundColor({ color: '#d32f2f' }, function () {});
  try { chrome.action.setBadgeTextColor({ color: '#ffffff' }); } catch (e) { /* versão antiga */ }
}

// ============ Janela de aviso ============
function openNoticeWindow(diff) {
  if (noticeWindowId !== null) {
    chrome.windows.get(noticeWindowId, function (w) {
      if (w && w.id) { try { chrome.windows.remove(w.id); } catch (e) {} }
    });
    noticeWindowId = null;
  }
  const payload = {
    diff: diff.diff,
    massivas: diff.massivas,
    fonte: diff.fonte,
    time: diff.time,
    baseUrl: config.baseUrl,
    dismissedMIds: dismissedMIds.slice()
  };
  const url = chrome.runtime.getURL('notice.html') + '?data=' + encodeURIComponent(JSON.stringify(payload));
  chrome.windows.create({ url: url, type: 'popup', width: 440, height: 620, focused: true }, function (w) {
    if (w && w.id) noticeWindowId = w.id;
    else noticeWindowId = null;
  });
}

// ============ Notificações nativas ============
function fmtDur(ms) {
  if (!isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'min';
  return m + 'min';
}

function notifId(prefix, stamp, i) {
  return 'genesis_' + prefix + '_' + stamp + '_' + i;
}

function fireNotifications(unDismissedMassivas, fallen, normalized, stamp) {
  try {
    if (config.notifications === false) return;

    if (unDismissedMassivas.length) {
      unDismissedMassivas.slice(0, 3).forEach(function (m, i) {
        const onde = m.groupBy === 'anf' ? 'ANF ' + m.group
          : (m.groupBy === 'cidade' ? m.group : m.endList.length + ' end_ids');
        chrome.notifications.create(notifId('m', stamp, i), {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: '⚠️ MASSIVA · ' + m.count + ' end_ids',
          message: onde + ' em ' + m.windowMin + ' min: ' + m.endList.slice(0, 5).join(', ') +
            (m.endList.length > 5 ? ' +' + (m.endList.length - 5) : '') +
            (m.primeiraCausa ? ' · ' + m.primeiraCausa : ''),
          priority: 2
        }, function () {});
      });
      return;
    }

    if (fallen.length && config.notifyFallen !== false) {
      const top = fallen.slice(0, 5).map(function (e) {
        return e.end_id + (e.cidade ? ' (' + e.cidade + ')' : '');
      });
      chrome.notifications.create(notifId('q', stamp, 0), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '🔴 ' + fallen.length + ' site(s) fora',
        message: top.join(', ') + (fallen.length > 5 ? ' +' + (fallen.length - 5) : '') +
          (fallen[0].causa ? ' · ' + fallen[0].causa : ''),
        priority: 2
      }, function () {});
    }

    if (normalized.length && config.notifyNormalized !== false) {
      const now = Date.now();
      const top = normalized.slice(0, 5).map(function (e) {
        const t = parseHorario(e.horario);
        const d = t ? fmtDur(now - t.getTime()) : '';
        return e.end_id + (d ? ' (' + d + ')' : '');
      });
      chrome.notifications.create(notifId('n', stamp, 0), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '🟢 ' + normalized.length + ' site(s) normalizado(s)',
        message: top.join(', ') + (normalized.length > 5 ? ' +' + (normalized.length - 5) : ''),
        priority: 1
      }, function () {});
    }
  } catch (e) { /* sem notificação */ }
}

// ============ Alarme ============
function setupAlarm() {
  try { chrome.alarms.clear(ALARM_NAME, function () {}); } catch (e) {}
  if (monitoring) {
    const mins = Math.max(parseInt(config.interval, 10) || DEFAULT_CONFIG.interval, 1);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: mins, delayInMinutes: mins }, function () {});
  }
}

// ============ Resumos ============
function anfSummary(ends) {
  const by = {};
  (ends || []).forEach(function (e) {
    const a = e.anf || '?';
    if (!by[a]) by[a] = { anf: a, ends: 0 };
    by[a].ends++;
  });
  return Object.keys(by).sort().map(function (a) {
    return { anf: a, ends: by[a].ends, nes: by[a].ends };
  });
}

function horarioRange(items) {
  let min = null;
  let max = null;
  (items || []).forEach(function (it) {
    const t = parseHorario(it.horario);
    if (!t) return;
    if (!min || t < min) min = t;
    if (!max || t > max) max = t;
  });
  const fmt = function (d) {
    if (!d) return null;
    const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  };
  return { min: fmt(min), max: fmt(max) };
}

function recentItems(items) {
  const now = Date.now();
  return (items || []).filter(function (it) {
    const t = parseHorario(it.horario);
    if (!t) return true;
    return (now - t.getTime()) <= MAX_AGE_MS;
  });
}

function summarizePerRegional(results) {
  return (results || []).filter(function (r) { return r.items && r.items.length; }).map(function (r) {
    const its = recentItems(r.items);
    const ends = groupEnds(its);
    const list = Object.keys(ends).map(function (k) { return ends[k]; });
    return {
      regional: r.regional,
      sites: its.length,
      ends: list.length,
      ne: list.length,
      fonte: r.source || 'fetch',
      anfs: anfSummary(list),
      horario: horarioRange(list)
    };
  });
}

// ============ Check principal ============
async function performCheck() {
  if (checking) return { status: 'busy' };
  checking = true;
  lastError = null;
  try {
    const regionals = config.regionals.length ? config.regionals : DEFAULT_CONFIG.regionals;
    const results = [];
    let anyOk = false;
    for (let r = 0; r < regionals.length; r++) {
      const regional = regionals[r];
      const res = await checkRegional(regional);
      results.push({ regional: regional, items: res.items, source: res.source, error: res.error, note: res.note || null });
      if (res.items && res.items.length) anyOk = true;
    }

    if (!anyOk) {
      const parts = results.map(function (r) {
        const num = r.items ? r.items.length : 0;
        return r.regional + ':' + (r.error || (num + ' linhas'));
      }).join(' | ');
      lastError = 'Falha ao obter dados [' + parts + ']. Abra o painel no navegador (logado) e tente de novo.';
      lastInfo = null;
      await persistLocal();
      updateBadge();
      broadcast({ type: 'CHECK_COMPLETE', lastError: lastError, lastInfo: null });
      return { status: 'error', error: lastError };
    }

    const currentItems = [];
    results.forEach(function (r) {
      if (r.items && r.items.length) currentItems.push.apply(currentItems, r.items);
    });

    const currEnds = groupEnds(currentItems);
    const diagEnds = groupEnds(recentItems(currentItems));
    const diagList = Object.keys(diagEnds).map(function (k) { return diagEnds[k]; });

    let diff = { fallen: [], normalized: [] };
    if (globalPrevItems && globalPrevItems.length) diff = detectChanges(globalPrevItems, currentItems);

    const detectedMassivas = findMassivas(Object.keys(currEnds).map(function (k) { return currEnds[k]; }));
    const newMassivas = detectedMassivas.filter(function (m) {
      return !massivas.some(function (old) {
        return old.id === m.id && m.endList.every(function (id) { return old.endList.indexOf(id) >= 0; });
      });
    });
    massivas = mergeMassivas(massivas, detectedMassivas);

    const fonte = results.map(function (r) { return r.regional + ':' + r.source; }).join(', ');
    const lines = results.map(function (r) { return r.regional + '=' + (r.items ? r.items.length : 0); }).join(' | ');
    const exemplo = currentItems.length ? (currentItems[0].end_id + ' · ' + (currentItems[0].site || '?')) : '—';

    lastCheck = new Date().toISOString();
    lastDiff = diff;
    lastInfo = {
      time: lastCheck,
      regionals: regionals.join(','),
      totalSites: diagList.length,          // end_ids distintos na tela
      endsFora: diagList.length,
      neFora: diagList.length,              // compatibilidade
      linhas: recentItems(currentItems).length,
      anfs: anfSummary(diagList),
      horario: horarioRange(diagList),
      lines: lines,
      exemplo: exemplo,
      fonte: fonte,
      porRegional: summarizePerRegional(results)
    };

    const totalFallen = diff.fallen.length;
    const totalNorm = diff.normalized.length;

    if (totalFallen || totalNorm || newMassivas.length) {
      history.unshift({
        time: lastCheck,
        fallen: totalFallen,
        normalized: totalNorm,
        massivas: newMassivas.length,
        fonte: fonte,
        regional: regionals.join(',')
      });
      history = history.slice(0, CAP);
    }

    const stamp = String(Date.now());
    if ((totalFallen || totalNorm || newMassivas.length) && toastsEnabled) {
      const unDismissed = newMassivas.filter(function (m) { return dismissedMIds.indexOf(m.id) < 0; });
      fireNotifications(unDismissed, diff.fallen, diff.normalized, stamp);
      openNoticeWindow({ diff: diff, massivas: unDismissed, fonte: fonte, time: lastCheck });
    }

    globalPrevItems = currentItems;
    await persistLocal();
    updateBadge();
    broadcast({ type: 'CHECK_COMPLETE', lastDiff: diff, lastInfo: lastInfo, lastError: null, massivas: massivas });

    return {
      status: 'ok',
      total: currentItems.length,
      ne: Object.keys(currEnds).length,
      end: Object.keys(currEnds).length,
      fallen: totalFallen,
      normalized: totalNorm,
      massivas: newMassivas.length,
      fonte: fonte,
      prev: globalPrevItems.length
    };
  } catch (e) {
    lastError = errMsg(e);
    lastInfo = null;
    await persistLocal();
    updateBadge();
    broadcast({ type: 'CHECK_COMPLETE', lastError: lastError, lastInfo: null });
    return { status: 'error', error: lastError };
  } finally {
    checking = false;
  }
}

// ============ Init ============
const stateReady = loadState().then(function () {
  setupAlarm();
  updateBadge();
});

function handleInstall() {
  stateReady.then(function () {
    if (!globalPrevItems || !globalPrevItems.length) {
      performCheck().catch(function (e) { console.warn('[Genesis] check inicial: ' + e); });
    }
  });
}

chrome.runtime.onInstalled.addListener(handleInstall);
chrome.runtime.onStartup.addListener(handleInstall);

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === ALARM_NAME && monitoring) {
    performCheck().catch(function (e) { console.warn('[Genesis] alarm check: ' + e); });
  }
});

// ============ Mensagens ============
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;
  const t = msg.type;

  // Seguro: só responde se o canal ainda estiver aberto, e "checa" o
  // chrome.runtime.lastError para não lançar "Unchecked runtime.lastError".
  let answered = false;
  const respond = function (payload) {
    if (answered) return;
    answered = true;
    try {
      sendResponse(payload);
      if (chrome.runtime.lastError) chrome.runtime.lastError = null;
    } catch (e) { /* canal fechado antes da resposta — sem erros */ }
  };

  if (t === 'GET_STATUS') {
    stateReady.then(function () {
      const prevEnds = groupEnds(globalPrevItems);
      respond({
        monitoring: monitoring,
        toastsEnabled: toastsEnabled,
        lastCheck: lastCheck,
        lastDiff: lastDiff,
        lastError: lastError,
        lastInfo: lastInfo,
        config: config,
        massivas: massivas,
        dismissedMIds: dismissedMIds,
        history: history.slice(0, 20),
        globalPrevItemsCount: globalPrevItems.length,
        prevEndsCount: Object.keys(prevEnds).length
      });
    });
    return true;
  }

  if (t === 'TOGGLE_MONITORING') {
    stateReady.then(function () {
      monitoring = !monitoring;
      return persistLocal().then(setupAlarm);
    }).then(function () { respond({ monitoring: monitoring }); });
    return true;
  }

  if (t === 'FORCE_CHECK') {
    stateReady.then(function () { return performCheck(); }).then(function (r) {
      respond(r);
    }, function (e) { respond({ status: 'error', error: String(e) }); });
    return true;
  }

  if (t === 'CLEAR_HISTORY') {
    stateReady.then(function () {
      history = [];
      return persistLocal();
    }).then(function () { respond({ ok: true }); });
    return true;
  }

  if (t === 'CLEAR_EVENTS') {
    stateReady.then(function () {
      massivas = [];
      dismissedMIds = [];
      lastDiff = null;
      history = [];
      return persistLocal();
    }).then(function () { updateBadge(); respond({ ok: true }); });
    return true;
  }

  if (t === 'DISMISS_MASSIVA') {
    stateReady.then(function () {
      if (msg.id && dismissedMIds.indexOf(msg.id) < 0) dismissedMIds.push(msg.id);
      massivas.forEach(function (m) { if (m.id === msg.id) m.dismissed = true; });
      dismissedMIds = dismissedMIds.slice(-200);
      return persistLocal();
    }).then(function () { updateBadge(); respond({ ok: true }); });
    return true;
  }

  if (t === 'TOGGLE_TOAST') {
    stateReady.then(function () {
      toastsEnabled = !toastsEnabled;
      return persistLocal();
    }).then(function () { respond({ toastsEnabled: toastsEnabled }); });
    return true;
  }

  if (t === 'UPDATE_SETTINGS') {
    stateReady.then(function () {
      return loadState();
    }).then(function () {
      setupAlarm();
      updateBadge();
      respond({ ok: true });
    });
    return true;
  }

  return false;
});
