/* PINT — アプリ本体 */
(function () {
  'use strict';

  var S = PintStore.load();

  var GSI_PALE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
  var GSI_CREDIT = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
  var RETRY_AFTER_ERROR_MS = 5 * 60 * 1000;
  var MAX_ACCURACY_M = 1000;   // これより粗い測位は記録しない

  var map, colorLayer, revealLayer, hereMarker, hereCircle, activeLayer;
  var busy = false;
  var retryAfter = 0;
  var wakeLock = null;
  var lastFix = null;

  var el = {};
  ['status-main', 'status-sub', 'btn-settings', 'btn-auto', 'btn-record', 'btn-mode',
   'btn-locate', 'btn-close', 'sheet', 'sheet-backdrop', 'legend', 'legend-scale',
   'opt-interval', 'opt-grid', 'opt-awake', 'opt-follow', 'stat-cells', 'stat-visits',
   'stat-max', 'btn-export', 'btn-export-txt', 'btn-import', 'btn-clear', 'file-import',
   'user-id', 'pending-count', 'toast'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /* ---------------- 地図 ---------------- */

  function initMap() {
    var start = [36.2, 138.25], zoom = 5;
    var cells = PintStore.cells(S.settings.gridSize);
    if (cells.length) {
      // 直近に記録したセルを起点にする
      var latest = cells.reduce(function (a, b) { return b.last > a.last ? b : a; });
      start = [(latest.south + latest.north) / 2, (latest.west + latest.east) / 2];
      zoom = 15;
    }

    map = L.map('map', {
      center: start,
      zoom: zoom,
      minZoom: 4,
      maxZoom: 18,
      zoomControl: false,
      attributionControl: true
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer(GSI_PALE, { maxZoom: 18, attribution: GSI_CREDIT }).addTo(map);

    colorLayer = PintLayers.color({ maxZoom: 18 });
    revealLayer = PintLayers.reveal({ maxZoom: 18 });
    applyMode(S.settings.mode);

    // タップしたメッシュの情報を出す
    map.on('click', function (e) {
      var size = S.settings.gridSize;
      var id = PintMesh.idOf(e.latlng.lat, e.latlng.lng, size);
      var lv = PintStore.levelOf(id, size);
      el['status-sub'].textContent =
        size + 'm  #' + id + '  ' + (lv ? 'Lv.' + lv : '未訪問');
    });

    // ユーザーが地図を動かしたら追従を切る
    map.on('dragstart', function () {
      if (S.settings.follow) {
        PintStore.set('follow', false);
        el['opt-follow'].checked = false;
      }
    });
  }

  function applyMode(mode) {
    if (activeLayer) map.removeLayer(activeLayer);
    activeLayer = (mode === 'reveal') ? revealLayer : colorLayer;
    activeLayer.addTo(map);
    el['btn-mode'].querySelector('.bar-text').textContent = (mode === 'reveal') ? '開拓' : '色塗り';
    el['btn-mode'].querySelector('.bar-icon').textContent = (mode === 'reveal') ? '🛰' : '🗺';
    el['legend'].hidden = (mode === 'reveal');
  }

  function redraw() {
    if (colorLayer) colorLayer.redraw();
    if (revealLayer) revealLayer.redraw();
  }

  function showHere(lat, lon, acc) {
    var latlng = [lat, lon];
    if (!hereMarker) {
      hereMarker = L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '<div class="pint-here"></div>', iconSize: [0, 0] }),
        interactive: false,
        zIndexOffset: 1000
      }).addTo(map);
      hereCircle = L.circle(latlng, {
        radius: acc || 0, color: '#3ea6ff', weight: 1, fillOpacity: 0.08, interactive: false
      }).addTo(map);
    } else {
      hereMarker.setLatLng(latlng);
      hereCircle.setLatLng(latlng).setRadius(acc || 0);
    }
    if (S.settings.follow) {
      map.setView(latlng, Math.max(map.getZoom(), 16), { animate: true });
    }
  }

  /* ---------------- 測位と記録 ---------------- */

  function locate(onOk) {
    if (!navigator.geolocation) {
      toast('この端末では位置情報が使えません');
      return;
    }
    busy = true;
    el['status-main'].textContent = '測位中…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      busy = false;
      lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
      showHere(lastFix.lat, lastFix.lon, lastFix.acc);
      if (onOk) onOk(lastFix);
      updateStatus();
    }, function (err) {
      busy = false;
      retryAfter = Date.now() + RETRY_AFTER_ERROR_MS;
      toast(geoErrorMessage(err));
      updateStatus();
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  function geoErrorMessage(err) {
    if (err && err.code === 1) return '位置情報の利用が許可されていません';
    if (err && err.code === 3) return '測位がタイムアウトしました';
    return '位置情報を取得できませんでした';
  }

  function record() {
    locate(function (fix) {
      if (fix.acc != null && fix.acc > MAX_ACCURACY_M) {
        retryAfter = Date.now() + RETRY_AFTER_ERROR_MS;
        toast('精度が粗すぎるため記録しませんでした（±' + Math.round(fix.acc) + 'm）');
        return;
      }
      var r = PintStore.addVisit(fix.lat, fix.lon, fix.acc, Date.now());
      redraw();
      updateStats();
      toast(r.counted
        ? '#' + r.meshId + ' を Lv.' + r.level + ' に記録しました'
        : '直前と同じメッシュのため据え置きです');
    });
  }

  /* ---------------- 表示更新 ---------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function updateStatus() {
    if (busy) return;

    if (!S.settings.autoRecord) {
      el['status-main'].textContent = '自動記録オフ';
    } else {
      var due = (S.data.lastTickAt || 0) + S.settings.intervalMin * 60000;
      var left = Math.max(0, due - Date.now());
      var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      el['status-main'].textContent = left === 0
        ? 'まもなく記録します'
        : '次の記録まで ' + pad(m) + ':' + pad(s);
    }

    if (lastFix) {
      var size = S.settings.gridSize;
      var id = PintMesh.idOf(lastFix.lat, lastFix.lon, size);
      el['status-sub'].textContent =
        size + 'm  #' + id + '  Lv.' + PintStore.levelOf(id, size) +
        '  ±' + Math.round(lastFix.acc || 0) + 'm';
    }
  }

  function updateStats() {
    var st = PintStore.stats(S.settings.gridSize);
    el['stat-cells'].textContent = st.cells;
    el['stat-visits'].textContent = st.visits;
    el['stat-max'].textContent = st.maxLevel;
    el['pending-count'].textContent = PintStore.unsyncedCount();
  }

  var toastTimer = null;
  function toast(message) {
    el['toast'].textContent = message;
    el['toast'].hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el['toast'].hidden = true; }, 2600);
  }

  function buildLegend() {
    el['legend-scale'].innerHTML = PintLayers.LEVEL_COLORS
      .map(function (c) { return '<i style="background:' + c + '"></i>'; })
      .join('');
  }

  /* ---------------- 画面の消灯抑止 ---------------- */

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* 電池残量が少ない等で失敗することがある */ });
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.settings.keepAwake && !wakeLock) {
      requestWakeLock();
    }
  });

  /* ---------------- データの入出力 ---------------- */

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  /* ---------------- UI 配線 ---------------- */

  function openSheet(open) {
    el['sheet'].hidden = !open;
    el['sheet-backdrop'].hidden = !open;
    if (open) updateStats();
  }

  function bindUI() {
    el['opt-interval'].value = String(S.settings.intervalMin);
    el['opt-grid'].value = String(S.settings.gridSize);
    el['opt-awake'].checked = !!S.settings.keepAwake;
    el['opt-follow'].checked = !!S.settings.follow;
    el['btn-auto'].setAttribute('aria-pressed', String(!!S.settings.autoRecord));
    el['user-id'].textContent = S.data.userId;

    el['btn-settings'].addEventListener('click', function () { openSheet(true); });
    el['btn-close'].addEventListener('click', function () { openSheet(false); });
    el['sheet-backdrop'].addEventListener('click', function () { openSheet(false); });

    el['btn-auto'].addEventListener('click', function () {
      PintStore.set('autoRecord', !S.settings.autoRecord);
      el['btn-auto'].setAttribute('aria-pressed', String(S.settings.autoRecord));
      toast(S.settings.autoRecord ? '自動記録をオンにしました' : '自動記録をオフにしました');
      updateStatus();
    });

    el['btn-record'].addEventListener('click', function () { record(); });

    el['btn-mode'].addEventListener('click', function () {
      PintStore.set('mode', S.settings.mode === 'color' ? 'reveal' : 'color');
      applyMode(S.settings.mode);
    });

    el['btn-locate'].addEventListener('click', function () {
      PintStore.set('follow', true);
      el['opt-follow'].checked = true;
      locate();
    });

    el['opt-interval'].addEventListener('change', function () {
      PintStore.set('intervalMin', Number(this.value));
      updateStatus();
    });

    el['opt-grid'].addEventListener('change', function () {
      PintStore.set('gridSize', Number(this.value));
      redraw();
      updateStats();
      updateStatus();
      toast('約' + S.settings.gridSize + 'm のメッシュで塗り直しました');
    });

    el['opt-awake'].addEventListener('change', function () {
      PintStore.set('keepAwake', this.checked);
      if (this.checked) {
        if (!('wakeLock' in navigator)) toast('この端末は画面消灯の抑止に未対応です');
        requestWakeLock();
      } else {
        releaseWakeLock();
      }
    });

    el['opt-follow'].addEventListener('change', function () {
      PintStore.set('follow', this.checked);
      if (this.checked && lastFix) showHere(lastFix.lat, lastFix.lon, lastFix.acc);
    });

    el['btn-export'].addEventListener('click', function () {
      download('pint-backup-' + stamp() + '.json', PintStore.exportJson(), 'application/json');
    });

    el['btn-export-txt'].addEventListener('click', function () {
      var size = S.settings.gridSize;
      download('pint-mesh-' + size + 'm-' + stamp() + '.txt',
               PintStore.toCompactText(size), 'text/plain');
    });

    el['btn-import'].addEventListener('click', function () { el['file-import'].click(); });

    el['file-import'].addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var added = PintStore.importJson(String(reader.result));
          redraw();
          updateStats();
          toast(added + ' 件の記録を取り込みました');
        } catch (e) {
          toast('読み込めませんでした: ' + e.message);
        }
      };
      reader.readAsText(file);
      this.value = '';
    });

    el['btn-clear'].addEventListener('click', function () {
      if (!confirm('記録をすべて消去します。よろしいですか？（元に戻せません）')) return;
      PintStore.clearAll();
      redraw();
      updateStats();
      updateStatus();
      toast('記録を消去しました');
    });
  }

  /* ---------------- 起動 ---------------- */

  function tick() {
    updateStatus();
    if (!S.settings.autoRecord || busy) return;
    var now = Date.now();
    if (now < retryAfter) return;
    if (now - (S.data.lastTickAt || 0) >= S.settings.intervalMin * 60000) record();
  }

  function init() {
    buildLegend();
    initMap();
    bindUI();
    updateStats();
    updateStatus();

    if (S.settings.keepAwake) requestWakeLock();

    // 画面を開いている間だけ動くタイマー。1秒ごとに残り時間を更新し、
    // 期限が来ていれば測位する（タブが再表示されたときも自然に追いつく）。
    setInterval(tick, 1000);

    if (S.settings.autoRecord) {
      tick();
    } else if (S.settings.follow) {
      locate();
    }
  }

  init();
})();
