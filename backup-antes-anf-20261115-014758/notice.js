(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function copyText(text, btn) {
    const done = function () {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = 'Copiado ✓';
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    const fallback = function () {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) { /* sem clipboard */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function neText(m) {
    const ne = (m && m.neList) ? m.neList.slice() : [];
    if (!ne.length && m && m.items) {
      m.items.forEach(function (e) {
        (e.sites || []).forEach(function (s) { if (ne.indexOf(s) < 0) ne.push(s); });
      });
    }
    if (!ne.length && m && m.endList) return m.endList.join('\n');
    return ne.sort().join('\n');
  }

  function isRecent(it) {
    const m = String(it.horario || '').trim().match(/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (!m) return true;
    const now = new Date();
    const d = new Date(now.getFullYear(), parseInt(m[2], 10) - 1, parseInt(m[1], 10), parseInt(m[3], 10), parseInt(m[4], 10));
    if (isNaN(d.getTime())) return true;
    if (d.getTime() - now.getTime() > 86400000) d.setFullYear(d.getFullYear() - 1);
    return (Date.now() - d.getTime()) <= 86400000;
  }

  function section(cls, title, ends) {
    const sec = document.createElement('section');
    sec.className = 'sec';
    const h = document.createElement('h2');
    h.className = cls;
    h.textContent = title;
    sec.appendChild(h);
    ends.slice(0, 60).forEach(function (e) {
      const div = document.createElement('div');
      div.className = 'row';
      const tech = (e.techs && e.techs.length) ? ' <i style="color:#8b96ab">[' + esc(e.techs.join('/')) + ']</i>' : '';
      div.innerHTML = '<b>' + esc(e.end_id) + '</b>' + tech +
        '<div class="meta">ANF ' + esc(e.anf || '?') + ' · ' + esc(e.horario || '') +
        ' · ' + esc(e.cidade || '') + (e.uf ? '/' + esc(e.uf) : '') +
        (e.causa ? ' · ' + esc(e.causa) : '') + '</div>';
      sec.appendChild(div);
    });
    return sec;
  }

  const $ = function (id) { return document.getElementById(id); };
  const g = new URLSearchParams(location.search);
  let payload = null;
  try { payload = JSON.parse(decodeURIComponent(g.get('data') || '')); } catch (e) { payload = null; }

  if (!payload) {
    const main = $('sections');
    main.innerHTML = '<div style="color:#7f8aa0">Sem dados recebidos.</div>';
    $('auto-close').textContent = '';
    $('btn-close').addEventListener('click', function () { window.close(); });
    return;
  }

  const diff = payload.diff || {};
  const massivas = payload.massivas || [];
  const dismissed = payload.dismissedMIds || [];
  const f = (diff.fallen || []).filter(isRecent);
  const n = (diff.normalized || []).filter(isRecent);

  $('counts').innerHTML =
    '<span class="f">🔴 CAÍRAM: ' + f.length + '</span> &nbsp; ' +
    '<span class="n">🟢 NORMALIZARAM: ' + n.length + '</span>' +
    (payload.fonte ? ' <span style="color:#7f8aa0">· ' + esc(payload.fonte) + '</span>' : '');

  const main = $('sections');
  const unDismissed = massivas.filter(function (m) { return dismissed.indexOf(m.id) < 0; });
  if (unDismissed.length) {
    let mb = '';
    unDismissed.forEach(function (m, i) {
      const dt = new Date(m.time).toLocaleString();
      const onde = m.groupBy === 'anf' ? 'ANF ' + m.group
        : (m.groupBy === 'cidade' ? m.group : (m.neList ? m.neList.length : m.count) + ' NE_IDs');
      mb += '<div class="massiva-banner">' +
        '<b>⚠️ MASSIVA — ' + esc(onde) + '</b> · ' + m.count + ' sites em ' + (m.windowMin || '?') + ' min · ' + esc(dt) +
        (m.primeiraCausa ? '<div style="font-size:11px;opacity:.8;margin-top:2px">' + esc(m.primeiraCausa) + '</div>' : '') +
        '<div class="ne">' + esc((m.neList || m.endList || []).join(', ')) + '</div>' +
        '<button class="btn copy" data-copy="' + i + '">📋 Copiar ' + ((m.neList || []).length || m.count) + ' NE_IDs</button>' +
        '</div>';
    });
    main.insertAdjacentHTML('afterbegin', mb);
  }

  if (f.length) main.appendChild(section('f', '🔴 CAÍRAM (' + f.length + ' site(s))', f));
  if (n.length) main.appendChild(section('n', '🟢 NORMALIZARAM (' + n.length + ' site(s))', n));

  main.addEventListener('click', function (e) {
    const b = e.target.closest('button[data-copy]');
    if (!b) return;
    const m = unDismissed[parseInt(b.dataset.copy, 10)];
    if (m) copyText(neText(m), b);
  });

  $('btn-close').addEventListener('click', function () { window.close(); });
  $('btn-open').addEventListener('click', function () {
    chrome.tabs.create({ url: payload.baseUrl || 'http://10.174.221.60/operations/analisys/painel_online_peso.php' });
  });

  let remaining = 20;
  const counter = $('auto-close');
  let iv = null;
  function stopAuto() {
    if (iv) { clearInterval(iv); iv = null; }
    counter.textContent = 'Fechamento automático pausado';
  }
  counter.textContent = 'Fecha em ' + remaining + 's';
  iv = setInterval(function () {
    remaining--;
    if (remaining <= 0) { clearInterval(iv); iv = null; window.close(); return; }
    counter.textContent = 'Fecha em ' + remaining + 's';
  }, 1000);
  // Não fecha enquanto o usuário estiver lendo/copiando.
  document.addEventListener('mouseover', stopAuto);
  document.addEventListener('focusin', stopAuto);
})();
