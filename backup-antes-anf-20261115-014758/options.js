(function () {
  'use strict';

  function sendToBg(msg, cb) {
    try {
      const p = chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) {
          chrome.runtime.lastError = null;
          if (cb) cb(undefined);
          return;
        }
        if (cb) cb(resp);
      });
      if (p && typeof p.catch === 'function') p.catch(function () {});
      return p;
    } catch (e) {
      if (cb) setTimeout(function () { cb(undefined); }, 0);
    }
  }

  const DEFAULT_BASE = 'http://10.174.221.60/operations/analisys/painel_online_peso.php';
  const $ = function (s) { return document.querySelector(s); };

  function load() {
    chrome.storage.sync.get('config', function (d) {
      const c = d.config || {};
      $('#regionals').value = (c.regionals && c.regionals.length) ? c.regionals.join(',') : 'TRJ';
      $('#interval').value = c.interval != null ? c.interval : 10;
      $('#mThreshold').value = c.massivaThreshold != null ? c.massivaThreshold : 5;
      $('#mWindow').value = c.massivaWindowMin != null ? c.massivaWindowMin : 10;
      $('#mGroup').value = ['end', 'anf', 'cidade'].indexOf(c.massivaGroup) >= 0 ? c.massivaGroup : 'end';
      $('#mMaxDays').value = c.massivaMaxDays != null ? c.massivaMaxDays : 10;
      $('#notifications').checked = c.notifications !== false;
      $('#notifyFallen').checked = c.notifyFallen !== false;
      $('#notifyNormalized').checked = c.notifyNormalized !== false;
      $('#baseUrl').value = c.baseUrl || DEFAULT_BASE;
    });
  }

  function save() {
    const config = {
      regionals: $('#regionals').value.split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean),
      interval: parseInt($('#interval').value, 10) || 10,
      massivaThreshold: parseInt($('#mThreshold').value, 10) || 5,
      massivaWindowMin: parseInt($('#mWindow').value, 10) || 10,
      massivaGroup: $('#mGroup').value,
      massivaMaxDays: parseInt($('#mMaxDays').value, 10) || 10,
      notifications: $('#notifications').checked,
      notifyFallen: $('#notifyFallen').checked,
      notifyNormalized: $('#notifyNormalized').checked,
      baseUrl: $('#baseUrl').value.trim() || DEFAULT_BASE
    };
    chrome.storage.sync.set({ config: config }, function () {
      sendToBg({ type: 'UPDATE_SETTINGS' }, function () {});
      const s = $('#saved');
      s.classList.remove('hidden');
      setTimeout(function () { s.classList.add('hidden'); }, 1500);
    });
  }

  $('#save').addEventListener('click', save);
  load();
})();
