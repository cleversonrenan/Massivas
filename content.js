(function () {
  'use strict';

  // Injetado pelo manifest e também via chrome.scripting — não duplica listeners.
  if (window.__genesisContentLoaded) return;
  window.__genesisContentLoaded = true;

  // Devolve linhas cruas (texto das células + checkbox + onClick do End_Id).
  // A interpretação das colunas fica toda no background (mesmo parser do fetch).
  function serializeRows() {
    const out = [];
    const trs = document.querySelectorAll('tr');
    for (let t = 0; t < trs.length; t++) {
      const tr = trs[t];
      const tds = tr.querySelectorAll('td');
      if (tds.length < 10) continue;

      const cells = [];
      for (let i = 0; i < tds.length; i++) {
        cells.push((tds[i].textContent || '').replace(/\s+/g, ' ').trim());
      }

      let end = '';
      for (let i = 0; i < tds.length; i++) {
        const oc = tds[i].getAttribute('onclick') || '';
        const m = oc.match(/ngnis\(\s*['"]([^'"]+)['"]\s*\)/i);
        if (m) { end = m[1]; break; }
      }

      const cb = tr.querySelector('input[type=checkbox]');
      out.push({ cells: cells, chk: cb ? (cb.name || '') : '', end: end });
    }
    return out;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'GET_DOMUS_DATA') {
      const url = new URL('/domus/genesis/online/ajax_get_dados_painel_online', location.origin);
      url.search = new URLSearchParams({regional: msg.regional, agrupar: '0', ordenar: '0'}).toString();
      fetch(url.href, {credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(20000)})
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) { sendResponse({ok: true, data: data}); }, function(e) { sendResponse({ok: false, error: String(e)}); });
      return true;
    }
    if (!msg || msg.type !== 'GET_ROWS') return false;
    try {
      const rows = serializeRows();
      sendResponse({ ok: true, rows: rows, count: rows.length });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) ? e.message : e) });
    }
    return true;
  });

  // Marca o checkbox "Flag 1" automaticamente (múltiplos métodos de busca)
  function findFlag1() {
    const inputs = Array.prototype.slice.call(document.querySelectorAll('input[type=checkbox]'));
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      let txt = [inp.title, inp.name, inp.id, inp.value,
        inp.getAttribute('data-label') || '', inp.getAttribute('label') || ''].join(' ').toLowerCase();
      if (inp.closest) {
        const lb = inp.closest('label');
        if (lb) txt += ' ' + (lb.textContent || '').toLowerCase();
        if (inp.parentElement) txt += ' ' + (inp.parentElement.textContent || '').toLowerCase();
      }
      if (txt.indexOf('flag 1') >= 0) return inp;
    }
    return null;
  }

  function tryFlag1() {
    const target = findFlag1();
    if (target && !target.checked) {
      try { target.click(); } catch (e) {}
    }
  }

  let retries = 12;
  const timer = setInterval(function () {
    tryFlag1();
    if (--retries <= 0) clearInterval(timer);
  }, 800);
  setTimeout(function () { clearInterval(timer); }, 15000);
  tryFlag1();
})();
