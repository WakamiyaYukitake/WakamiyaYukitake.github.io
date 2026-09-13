/* MMoVie — アプリ本体
 *
 * 全体の流れ：
 *   プロジェクト一覧 → 基本情報（タイトル・日付） → 写真/動画を選ぶ
 *   → 日程外レビュー（あれば） → 全体マップ → 1枚ずつポップ確認・編集
 *   → 集計 → 動画書き出し
 *
 * 写真・動画のファイル本体は保存しない。保存するのは各アイテムの
 * タイトル・日時・位置・非表示・切り抜き/モザイクだけ（store.js参照）。
 * そのためプロジェクトを開き直すたびに、同じ写真をもう一度選んでもらう。
 */
(function () {
  'use strict';

  var S = MMovieStore.load();
  var Media = MMovieMedia;
  var Geocode = MMovieGeocode;
  var MapUI = MMovieMap;
  var Ex = MMovieExport;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtDateShort(s) {
    if (!s) return '';
    var p = s.split('-').map(Number);
    return p[1] + '/' + p[2];
  }
  function toDatetimeLocal(d) {
    if (!(d instanceof Date) || isNaN(d)) d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------------- シート（モーダル） ---------------- */
  function openSheet(title, bodyHtml, afterMount) {
    $('sheet-title').textContent = title;
    $('sheet-body').innerHTML = bodyHtml;
    $('sheet').hidden = false;
    $('sheet-backdrop').hidden = false;
    if (afterMount) afterMount($('sheet-body'));
  }
  function closeSheet() {
    $('sheet').hidden = true;
    $('sheet-backdrop').hidden = true;
    $('sheet-body').innerHTML = '';
  }
  $('btn-sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);

  $('btn-help').addEventListener('click', function () {
    openSheet('MMoVieについて',
      '<p class="note">写真や動画のファイル自体はこの端末に保存しません。保存するのはタイトルや日時、' +
      '切り抜き・モザイクなどの軽い編集情報だけです。そのため、プロジェクトを開き直すたびに同じ写真・動画を' +
      'もう一度選んでください（指紋が一致すれば編集内容は自動で復元されます）。</p>' +
      '<p class="note">地名の自動判定にはOpenStreetMap（Nominatim）を利用しています。</p>' +
      '<p class="note">動画の書き出しは、実際に再生しながら録画する方式のため、動画の長さぶんだけ時間がかかります。</p>');
  });

  /* ---------------- 状態 ---------------- */

  var state = { view: 'projects', project: null, setupMode: 'create' };
  var viewHistory = [];
  var STEP_LABELS = {
    projects: '', setup: 'タイトルと日付', import: '写真・動画を選ぶ', mismatch: '日程の確認',
    map: '全体マップ', pop: '1枚ずつ確認', summary: '集計', export: '動画を書き出し'
  };

  var session = null;
  function newSession() {
    return {
      files: {}, urls: {},
      mismatch: [],
      order: null, popIndex: 0,
      overviewMap: null,
      pinPicker: null, pinItemId: null,
      exportRunning: false
    };
  }

  function setView(view, opts) {
    opts = opts || {};
    var prevView = state.view;
    if (prevView === 'map' && view !== 'map' && session && session.overviewMap) {
      session.overviewMap.map.remove();
      session.overviewMap = null;
    }
    if (prevView === 'pop' && view !== 'pop' && session && session.pinPicker) {
      session.pinPicker.destroy();
      session.pinPicker = null; session.pinItemId = null;
    }
    if (!opts.isBack && prevView !== view) viewHistory.push(prevView);
    if (view === 'projects') viewHistory = [];
    state.view = view;
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + view; });
    $('btn-back').hidden = (view === 'projects');
    $('step-label').textContent = STEP_LABELS[view] || '';
    onEnterView(view);
  }
  function goBack() {
    var prev = viewHistory.pop();
    setView(prev || 'projects', { isBack: true });
  }
  $('btn-back').addEventListener('click', goBack);

  function onEnterView(view) {
    if (view === 'projects') renderProjects();
    else if (view === 'setup') renderSetup();
    else if (view === 'import') renderImport();
    else if (view === 'mismatch') renderMismatch();
    else if (view === 'map') renderMap();
    else if (view === 'pop') renderPop();
    else if (view === 'summary') renderSummary();
  }

  /* ================= プロジェクト一覧 ================= */

  function renderProjects() {
    var list = S.listProjects();
    if (!list.length) {
      $('project-list').innerHTML = '<div class="empty-state">まだ作っていません。下のボタンから始めましょう</div>';
      return;
    }
    $('project-list').innerHTML = list.map(function (p) {
      var visible = p.items.filter(function (it) { return !it.hidden; }).length;
      return '<div class="project-row" data-id="' + p.id + '">' +
        '<div class="p-info">' +
        '<div class="p-title">' + esc(p.title || '（無題）') + '</div>' +
        '<div class="p-sub">' + esc(fmtRangeShort(p.dateFrom, p.dateTo)) + ' ・ ' + visible + '件</div>' +
        '</div>' +
        '<button class="icon-btn small p-edit" data-edit="' + p.id + '" aria-label="編集">✎</button>' +
        '<button class="icon-btn small p-del" data-del="' + p.id + '" aria-label="削除">🗑</button>' +
        '</div>';
    }).join('');

    $('project-list').querySelectorAll('.project-row').forEach(function (row) {
      row.querySelector('.p-info').addEventListener('click', function () { openProjectForContinue(row.getAttribute('data-id')); });
    });
    $('project-list').querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        state.project = S.getProject(btn.getAttribute('data-edit'));
        state.setupMode = 'editMeta';
        setView('setup');
      });
    });
    $('project-list').querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var p = S.getProject(btn.getAttribute('data-del'));
        if (!p) return;
        if (!confirm('「' + (p.title || '無題') + '」を削除しますか？（保存された編集情報も消えます）')) return;
        S.deleteProject(p.id);
        renderProjects();
        toast('削除しました');
      });
    });
  }

  function fmtRangeShort(from, to) {
    if (!from) return '日付未設定';
    if (!to || to === from) return fmtDateShort(from);
    return fmtDateShort(from) + '〜' + fmtDateShort(to);
  }

  function openProjectForContinue(id) {
    state.project = S.getProject(id);
    if (!state.project) return;
    session = newSession();
    setView('import');
  }

  $('btn-new-project').addEventListener('click', function () {
    state.project = null;
    state.setupMode = 'create';
    setView('setup');
  });

  /* ================= 基本情報 ================= */

  function renderSetup() {
    var p = state.project;
    $('setup-title').value = p ? p.title : '';
    $('setup-from').value = p ? p.dateFrom : todayStr();
    $('setup-to').value = p ? p.dateTo : todayStr();
  }

  $('btn-setup-next').addEventListener('click', function () {
    var title = $('setup-title').value.trim();
    var from = $('setup-from').value;
    var to = $('setup-to').value || from;
    if (!title) { toast('タイトルを入力してください'); return; }
    if (!from) { toast('開始日を選んでください'); return; }
    if (to < from) to = from;

    if (state.setupMode === 'editMeta' && state.project) {
      S.updateProject(state.project.id, { title: title, dateFrom: from, dateTo: to });
      toast('更新しました');
      goBack();
      return;
    }
    state.project = S.createProject({ title: title, dateFrom: from, dateTo: to });
    session = newSession();
    setView('import');
  });

  /* ================= 写真・動画の取り込み ================= */

  function renderImport() {
    var p = state.project;
    $('import-range').textContent = fmtRangeShort(p.dateFrom, p.dateTo);
    $('import-intro').hidden = false;
    $('import-progress').hidden = true;
    $('btn-pick-files').textContent = p.items.length ? '同じ写真・動画をもう一度選択' : '写真・動画を選択';
  }

  $('btn-pick-files').addEventListener('click', function () { $('file-input').click(); });

  $('file-input').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;
    processFiles(files);
    e.target.value = '';
  });

  function processFiles(files) {
    var project = state.project;
    $('import-intro').hidden = true;
    $('import-progress').hidden = false;
    var done = 0;
    var total = files.length;
    updateImportProgress(done, total, '読み込み中…');

    var newMismatch = [];
    var chain = Promise.resolve();

    files.forEach(function (file) {
      chain = chain.then(function () {
        var fp = Media.fingerprint(file);
        var existing = S.findItemByFp(project, fp);
        if (existing) {
          session.files[fp] = file;
          session.urls[fp] = URL.createObjectURL(file);
          done++; updateImportProgress(done, total, '読み込み中…');
          return;
        }
        if (S.isExcluded(project, fp)) {
          done++; updateImportProgress(done, total, '読み込み中…');
          return;
        }
        var kind = Media.isVideo(file) ? 'video' : (Media.isImage(file) ? 'photo' : null);
        if (!kind) { done++; updateImportProgress(done, total, '読み込み中…'); return; }

        return Media.extractMeta(file).then(function (meta) {
          session.files[fp] = file;
          session.urls[fp] = URL.createObjectURL(file);
          var inRange = isInRange(meta.takenAt, project);
          if (inRange) {
            S.upsertItem(project, {
              fp: fp, kind: kind,
              takenAt: meta.takenAt.toISOString(),
              lat: meta.lat, lng: meta.lng
            });
          } else {
            newMismatch.push({
              fp: fp, kind: kind, file: file,
              takenAt: meta.takenAt, lat: meta.lat, lng: meta.lng,
              decision: 'pending', fixValue: toDatetimeLocal(meta.takenAt)
            });
          }
          done++; updateImportProgress(done, total, '読み込み中…');
        });
      });
    });

    chain.then(function () {
      session.mismatch = newMismatch;
      if (newMismatch.length) {
        setView('mismatch');
      } else {
        finalizeImportAndShowMap();
      }
    });
  }

  function isInRange(takenAt, project) {
    if (!project.dateFrom) return true;
    var from = new Date(project.dateFrom + 'T00:00:00');
    var to = new Date((project.dateTo || project.dateFrom) + 'T23:59:59');
    return takenAt >= from && takenAt <= to;
  }

  function updateImportProgress(done, total, label) {
    var pct = total ? Math.round(done / total * 100) : 0;
    $('import-bar').style.width = pct + '%';
    $('import-progress-label').textContent = label + '（' + done + ' / ' + total + '）';
  }

  /* ================= 日程外レビュー ================= */

  function renderMismatch() {
    var list = session.mismatch;
    if (!list.length) { finalizeImportAndShowMap(); return; }
    $('mismatch-list').innerHTML = list.map(function (m, idx) {
      var mediaHtml = m.kind === 'video'
        ? '<video src="' + session.urls[m.fp] + '" muted playsinline></video>'
        : '<img src="' + session.urls[m.fp] + '" />';
      var statusHtml = m.decision === 'exclude' ? '<span class="m-status" style="color:var(--bad)">除外します</span>' :
        (m.decision === 'include-extend' ? '<span class="m-status">日程に含めます</span>' :
          (m.decision === 'include-fixed' ? '<span class="m-status">日時を修正して含めます</span>' : ''));
      return '<div class="mismatch-row" data-idx="' + idx + '">' +
        '<div class="m-head">' + mediaHtml +
        '<div class="m-info"><div class="m-date">' + Ex.fmtDateTime(m.takenAt) + '</div>' + statusHtml + '</div>' +
        '</div>' +
        '<div class="m-actions">' +
        '<button class="btn" data-act="exclude">除外する</button>' +
        '<button class="btn" data-act="include">含める</button>' +
        '</div>' +
        '<div class="m-sub-actions" hidden data-sub>' +
        '<button class="btn" data-act="extend">日程をこの日付に合わせる</button>' +
        '<button class="btn" data-act="fix">日時を修正する</button>' +
        '</div>' +
        '<div hidden data-fix-row>' +
        '<input type="datetime-local" data-fix-input value="' + m.fixValue + '" />' +
        '<button class="btn primary full" data-act="apply-fix" style="margin-top:6px">この日時で確定</button>' +
        '</div>' +
        '</div>';
    }).join('');

    $('mismatch-list').querySelectorAll('.mismatch-row').forEach(function (row) {
      var idx = Number(row.getAttribute('data-idx'));
      var m = list[idx];
      row.querySelector('[data-act="exclude"]').addEventListener('click', function () {
        m.decision = 'exclude'; renderMismatch();
      });
      row.querySelector('[data-act="include"]').addEventListener('click', function () {
        row.querySelector('[data-sub]').hidden = false;
      });
      row.querySelector('[data-act="extend"]').addEventListener('click', function () {
        m.decision = 'include-extend';
        var project = state.project;
        var patch = {};
        var dstr = m.takenAt.getFullYear() + '-' + pad2(m.takenAt.getMonth() + 1) + '-' + pad2(m.takenAt.getDate());
        if (!project.dateFrom || dstr < project.dateFrom) patch.dateFrom = dstr;
        if (!project.dateTo || dstr > project.dateTo) patch.dateTo = dstr;
        if (Object.keys(patch).length) S.updateProject(project.id, patch);
        renderMismatch();
      });
      row.querySelector('[data-act="fix"]').addEventListener('click', function () {
        row.querySelector('[data-fix-row]').hidden = false;
      });
      row.querySelector('[data-act="apply-fix"]').addEventListener('click', function () {
        var v = row.querySelector('[data-fix-input]').value;
        if (!v) { toast('日時を入力してください'); return; }
        m.fixValue = v;
        m.decision = 'include-fixed';
        renderMismatch();
      });
    });
  }

  $('btn-mismatch-continue').addEventListener('click', function () {
    var pending = session.mismatch.filter(function (m) { return m.decision === 'pending'; });
    if (pending.length) { toast(pending.length + '件、まだ選んでいないものがあります'); return; }
    var project = state.project;
    session.mismatch.forEach(function (m) {
      if (m.decision === 'exclude') {
        S.addExcluded(project, m.fp);
        delete session.files[m.fp];
        delete session.urls[m.fp];
      } else {
        var takenAt = m.decision === 'include-fixed' ? new Date(m.fixValue) : m.takenAt;
        S.upsertItem(project, { fp: m.fp, kind: m.kind, takenAt: takenAt.toISOString(), lat: m.lat, lng: m.lng });
      }
    });
    session.mismatch = [];
    finalizeImportAndShowMap();
  });

  function finalizeImportAndShowMap() {
    setView('map');
  }

  /* ================= マップ全体表示 ================= */

  function getVisibleItems() {
    var project = state.project;
    return project.items.filter(function (it) {
      return session.files[it.fp] && !it.hidden;
    }).sort(function (a, b) { return new Date(a.takenAt) - new Date(b.takenAt); });
  }

  function renderMap() {
    var items = getVisibleItems();
    if (session.overviewMap) { session.overviewMap.map.remove(); session.overviewMap = null; }
    session.overviewMap = MapUI.createOverviewMap('overview-map', items);
    var withLoc = items.filter(function (it) { return it.lat != null && it.lng != null; }).length;
    var without = items.length - withLoc;
    $('map-note').textContent = items.length ?
      (without ? withLoc + '件の位置を表示中（位置情報のないものが' + without + '件あります。次の画面で場所を指定できます）' : withLoc + '件の位置を表示中') :
      '表示できる写真・動画がありません';
    var hiddenCount = state.project.items.filter(function (it) { return it.hidden; }).length;
    $('btn-show-hidden').textContent = '非表示にした項目を見る（' + hiddenCount + '件）';
  }

  $('btn-map-next').addEventListener('click', function () {
    var items = getVisibleItems();
    if (!items.length) { toast('表示できる写真・動画がありません'); return; }
    session.order = items.map(function (it) { return it.id; });
    session.popIndex = 0;
    setView('pop');
  });

  $('btn-show-hidden').addEventListener('click', function () {
    renderHiddenSheet();
  });

  function renderHiddenSheet() {
    var project = state.project;
    var hidden = project.items.filter(function (it) { return it.hidden; });
    var html = hidden.length ? hidden.map(function (it) {
      var hasFile = !!session.files[it.fp];
      return '<div class="mismatch-row" data-id="' + it.id + '">' +
        '<div class="m-head">' +
        (hasFile ? (it.kind === 'video' ? '<video src="' + session.urls[it.fp] + '" muted playsinline></video>' : '<img src="' + session.urls[it.fp] + '" />') : '<div style="width:56px;height:56px;background:#ddd;border-radius:8px"></div>') +
        '<div class="m-info"><div class="m-date">' + esc(it.placeName || '（タイトル未設定）') + '</div><div class="sub">' + Ex.fmtDateTime(new Date(it.takenAt)) + '</div></div>' +
        '</div>' +
        '<button class="btn primary full" data-restore="' + it.id + '">表示に戻す</button>' +
        '</div>';
    }).join('') : '<div class="empty-state">非表示にした項目はありません</div>';

    openSheet('非表示にした項目', html, function (body) {
      body.querySelectorAll('[data-restore]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          S.updateItem(project, btn.getAttribute('data-restore'), { hidden: false });
          closeSheet();
          renderMap();
          toast('表示に戻しました');
        });
      });
    });
  }

  /* ================= ポップ順次確認 ================= */

  function currentPopItem() {
    if (!session.order || !session.order.length) return null;
    var id = session.order[session.popIndex];
    return state.project.items.find(function (it) { return it.id === id; }) || null;
  }

  function renderPop() {
    var it = currentPopItem();
    if (!it) { setView('summary'); return; }

    $('pop-counter').textContent = (session.popIndex + 1) + ' / ' + session.order.length;
    $('pop-progress-bar').style.width = Math.round((session.popIndex + 1) / session.order.length * 100) + '%';

    var url = session.urls[it.fp];
    $('pop-media-wrap').innerHTML = it.kind === 'video'
      ? '<video src="' + url + '" controls playsinline muted></video>'
      : '<img src="' + url + '" />';

    $('pop-title').value = it.placeName || '';
    $('pop-datetime').value = toDatetimeLocal(new Date(it.takenAt));

    if (!it.placeName && it.placeNameAuto && it.lat != null && it.lng != null) {
      var fp = it.fp;
      Geocode.reverseGeocode(it.lat, it.lng).then(function (name) {
        var still = currentPopItem();
        if (!still || still.fp !== fp || !name) return;
        if ($('pop-title').value) return;
        S.updateItem(state.project, it.id, { placeName: name, placeNameAuto: true });
        $('pop-title').value = name;
      });
    }

    if (session.pinPicker) { session.pinPicker.destroy(); session.pinPicker = null; }
    session.pinItemId = it.id;
    session.pinPicker = MapUI.createPinPicker('pop-pin-map', it.lat, it.lng, function (lat, lng) {
      if (session.pinItemId !== it.id) return;
      S.updateItem(state.project, it.id, { lat: lat, lng: lng, placeName: '', placeNameAuto: true });
      $('pop-title').value = '';
      Geocode.reverseGeocode(lat, lng).then(function (name) {
        if (session.pinItemId !== it.id || !name) return;
        if ($('pop-title').value) return;
        S.updateItem(state.project, it.id, { placeName: name });
        $('pop-title').value = name;
      });
    });

    $('btn-pop-prev').disabled = session.popIndex === 0;
  }

  $('pop-title').addEventListener('change', function () {
    var it = currentPopItem();
    if (!it) return;
    S.updateItem(state.project, it.id, { placeName: $('pop-title').value.trim(), placeNameAuto: false });
  });
  $('pop-datetime').addEventListener('change', function () {
    var it = currentPopItem();
    if (!it) return;
    var v = $('pop-datetime').value;
    if (!v) return;
    S.updateItem(state.project, it.id, { takenAt: new Date(v).toISOString() });
  });

  $('btn-pop-next').addEventListener('click', function () {
    session.popIndex++;
    if (session.popIndex >= session.order.length) setView('summary');
    else renderPop();
  });
  $('btn-pop-prev').addEventListener('click', function () {
    if (session.popIndex > 0) { session.popIndex--; renderPop(); }
  });
  $('btn-pop-hide').addEventListener('click', function () {
    var it = currentPopItem();
    if (!it) return;
    S.updateItem(state.project, it.id, { hidden: true });
    session.order.splice(session.popIndex, 1);
    if (session.popIndex >= session.order.length) setView('summary');
    else renderPop();
  });

  /* ---------------- 画像編集（切り抜き・モザイク） ---------------- */

  var ed = null;
  var AR = Ex.W / Ex.H;

  $('btn-pop-edit').addEventListener('click', function () {
    var it = currentPopItem();
    if (!it) return;
    openEditor(it);
  });

  function openEditor(item) {
    var url = session.urls[item.fp];
    $('editor-overlay').hidden = false;
    setEditorMode('crop');

    function withSource(sourceEl, iw, ih) {
      ed = {
        item: item, source: sourceEl, iw: iw, ih: ih,
        mode: 'crop',
        crop: item.crop ? clone(item.crop) : defaultCrop(iw, ih),
        mosaics: (item.mosaics || []).map(clone),
        drag: null
      };
      $('editor-zoom').value = zoomFromCrop(ed.crop, iw, ih);
      layoutEditorCanvas();
      drawEditor();
    }

    if (item.kind === 'photo') {
      var img = new Image();
      img.onload = function () { withSource(img, img.naturalWidth, img.naturalHeight); };
      img.src = url;
    } else {
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.src = url;
      v.addEventListener('loadeddata', function () {
        try { v.currentTime = Math.min(0.15, (v.duration || 1) / 2); } catch (e) { onSeeked(); }
      });
      v.addEventListener('seeked', onSeeked);
      function onSeeked() {
        var c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        withSource(c, c.width, c.height);
      }
    }
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function computeMaxCrop(iw, ih) {
    var maxW, maxH;
    if (iw / ih > AR) { maxH = ih; maxW = ih * AR; } else { maxW = iw; maxH = iw / AR; }
    return { maxW: maxW, maxH: maxH };
  }
  function defaultCrop(iw, ih) {
    var m = computeMaxCrop(iw, ih);
    return { x: (iw - m.maxW) / 2 / iw, y: (ih - m.maxH) / 2 / ih, w: m.maxW / iw, h: m.maxH / ih };
  }
  function zoomFromCrop(crop, iw, ih) {
    var m = computeMaxCrop(iw, ih);
    var minScale = 0.35;
    var scale = (crop.w * iw) / m.maxW;
    var z = (1 - scale) / (1 - minScale) * 100;
    return Math.max(0, Math.min(100, Math.round(z)));
  }
  function cropSizeFromZoom(zoomPct, iw, ih) {
    var m = computeMaxCrop(iw, ih);
    var minScale = 0.35;
    var scale = 1 - (1 - minScale) * (zoomPct / 100);
    return { w: m.maxW * scale, h: m.maxH * scale };
  }

  function layoutEditorCanvas() {
    var canvas = $('editor-canvas');
    var wrap = document.querySelector('.editor-canvas-wrap');
    var maxW = wrap.clientWidth - 20, maxH = wrap.clientHeight - 20;
    var scale = Math.min(maxW / ed.iw, maxH / ed.ih, 1);
    canvas.width = Math.round(ed.iw * scale);
    canvas.height = Math.round(ed.ih * scale);
  }

  function drawEditor() {
    var canvas = $('editor-canvas');
    var ctx = canvas.getContext('2d');
    var scale = canvas.width / ed.iw;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(ed.source, 0, 0, canvas.width, canvas.height);

    if (ed.mode === 'crop') {
      var cx = ed.crop.x * ed.iw * scale, cy = ed.crop.y * ed.ih * scale;
      var cw = ed.crop.w * ed.iw * scale, ch = ed.crop.h * ed.ih * scale;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, canvas.width, cy);
      ctx.fillRect(0, cy + ch, canvas.width, canvas.height - cy - ch);
      ctx.fillRect(0, cy, cx, ch);
      ctx.fillRect(cx + cw, cy, canvas.width - cx - cw, ch);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx, cy, cw, ch);
    } else {
      ed.mosaics.forEach(function (m) {
        var mx = m.x * ed.iw * scale, my = m.y * ed.ih * scale, mw = m.w * ed.iw * scale, mh = m.h * ed.ih * scale;
        ctx.save();
        ctx.beginPath(); ctx.rect(mx, my, mw, mh); ctx.clip();
        var block = 10;
        var tw = Math.max(1, Math.floor(mw / block)), th = Math.max(1, Math.floor(mh / block));
        var tmp = document.createElement('canvas'); tmp.width = tw; tmp.height = th;
        tmp.getContext('2d').drawImage(canvas, mx, my, mw, mh, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tw, th, mx, my, mw, mh);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.strokeRect(mx, my, mw, mh);
      });
      if (ed.drag && ed.drag.rect) {
        var r = ed.drag.rect;
        ctx.strokeStyle = '#0f9d8e'; ctx.lineWidth = 2;
        ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      }
    }
  }

  function setEditorMode(mode) {
    ed && (ed.mode = mode);
    document.querySelectorAll('#editor-mode .segment-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
    $('editor-controls-crop').hidden = mode !== 'crop';
    $('editor-controls-mosaic').hidden = mode !== 'mosaic';
    if (ed) { renderMosaicChips(); drawEditor(); }
  }
  $('editor-mode').addEventListener('click', function (e) {
    var btn = e.target.closest('.segment-btn');
    if (btn) setEditorMode(btn.getAttribute('data-mode'));
  });

  $('editor-zoom').addEventListener('input', function () {
    if (!ed) return;
    var size = cropSizeFromZoom(Number($('editor-zoom').value), ed.iw, ed.ih);
    var cxCenter = ed.crop.x * ed.iw + (ed.crop.w * ed.iw) / 2;
    var cyCenter = ed.crop.y * ed.ih + (ed.crop.h * ed.ih) / 2;
    var nx = clamp(cxCenter - size.w / 2, 0, ed.iw - size.w);
    var ny = clamp(cyCenter - size.h / 2, 0, ed.ih - size.h);
    ed.crop = { x: nx / ed.iw, y: ny / ed.ih, w: size.w / ed.iw, h: size.h / ed.ih };
    drawEditor();
  });

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function canvasPoint(evt) {
    var canvas = $('editor-canvas');
    var rect = canvas.getBoundingClientRect();
    var cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
    var cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top;
    return { x: cx * (canvas.width / rect.width), y: cy * (canvas.height / rect.height) };
  }

  $('editor-canvas').addEventListener('pointerdown', function (e) {
    if (!ed) return;
    $('editor-canvas').setPointerCapture(e.pointerId);
    var p = canvasPoint(e);
    var scale = $('editor-canvas').width / ed.iw;
    if (ed.mode === 'crop') {
      ed.drag = { startPx: p, startCrop: clone(ed.crop) };
    } else {
      ed.drag = { start: { x: p.x / scale, y: p.y / scale }, rect: { x: p.x / scale, y: p.y / scale, w: 0, h: 0 } };
    }
  });
  $('editor-canvas').addEventListener('pointermove', function (e) {
    if (!ed || !ed.drag) return;
    var p = canvasPoint(e);
    var scale = $('editor-canvas').width / ed.iw;
    if (ed.mode === 'crop') {
      var dxNat = (p.x - ed.drag.startPx.x) / scale;
      var dyNat = (p.y - ed.drag.startPx.y) / scale;
      var cw = ed.drag.startCrop.w * ed.iw, ch = ed.drag.startCrop.h * ed.ih;
      var nx = clamp(ed.drag.startCrop.x * ed.iw - dxNat, 0, ed.iw - cw);
      var ny = clamp(ed.drag.startCrop.y * ed.ih - dyNat, 0, ed.ih - ch);
      ed.crop = { x: nx / ed.iw, y: ny / ed.ih, w: cw / ed.iw, h: ch / ed.ih };
    } else {
      var sx = ed.drag.start.x, sy = ed.drag.start.y;
      var cx = p.x / scale, cy = p.y / scale;
      ed.drag.rect = { x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) };
    }
    drawEditor();
  });
  ['pointerup', 'pointercancel'].forEach(function (evt) {
    $('editor-canvas').addEventListener(evt, function () {
      if (!ed || !ed.drag) return;
      if (ed.mode === 'mosaic' && ed.drag.rect && ed.drag.rect.w > 8 && ed.drag.rect.h > 8) {
        var r = ed.drag.rect;
        ed.mosaics.push({ x: r.x / ed.iw, y: r.y / ed.ih, w: r.w / ed.iw, h: r.h / ed.ih });
        renderMosaicChips();
      }
      ed.drag = null;
      drawEditor();
    });
  });

  function renderMosaicChips() {
    if (!ed) return;
    $('mosaic-list').innerHTML = ed.mosaics.map(function (m, i) {
      return '<span class="mosaic-chip">モザイク ' + (i + 1) + '<button data-rm="' + i + '">×</button></span>';
    }).join('');
    $('mosaic-list').querySelectorAll('[data-rm]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        ed.mosaics.splice(Number(btn.getAttribute('data-rm')), 1);
        renderMosaicChips();
        drawEditor();
      });
    });
  }

  $('btn-editor-close').addEventListener('click', function () { $('editor-overlay').hidden = true; ed = null; });
  $('btn-editor-done').addEventListener('click', function () {
    if (ed) {
      S.updateItem(state.project, ed.item.id, { crop: ed.crop, mosaics: ed.mosaics });
      renderPop();
    }
    $('editor-overlay').hidden = true;
    ed = null;
  });

  /* ================= 集計 ================= */

  function renderSummary() {
    var project = state.project;
    var items = getVisibleItems();
    var photos = items.filter(function (it) { return it.kind === 'photo'; }).length;
    var videos = items.filter(function (it) { return it.kind === 'video'; }).length;
    $('summary-title').textContent = project.title;
    $('summary-range').textContent = fmtRangeShort(project.dateFrom, project.dateTo);
    $('summary-stats').innerHTML =
      '<div class="stat-card"><div class="n">' + photos + '</div><div class="l">写真</div></div>' +
      '<div class="stat-card"><div class="n">' + videos + '</div><div class="l">動画</div></div>';
  }

  $('btn-back-to-pop').addEventListener('click', function () {
    if (session.popIndex >= session.order.length) session.popIndex = Math.max(0, session.order.length - 1);
    setView('pop');
  });

  $('btn-go-export').addEventListener('click', function () {
    if (session.exportRunning) return;
    setView('export');
    startExport();
  });

  /* ================= 動画書き出し ================= */

  var TITLE_S = 2.2, MAP_STEP_S = 0.35, MAP_HOLD_S = 1.2, PHOTO_S = 3.0, VIDEO_MAX_S = 6, SUMMARY_S = 3.0;

  function pickMimeType() {
    var candidates = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function loadPhotoEl(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(img); };
      img.src = url;
    });
  }
  function loadVideoEl(url) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      v.addEventListener('loadedmetadata', function () { resolve(v); }, { once: true });
    });
  }

  function startExport() {
    session.exportRunning = true;
    $('export-result').hidden = true;
    $('export-status').textContent = '準備しています…';
    $('export-bar').style.width = '0%';

    var project = state.project;
    var items = getVisibleItems();
    var canvas = $('export-canvas');
    canvas.width = Ex.W; canvas.height = Ex.H;
    var ctx = canvas.getContext('2d');

    var mediaLoads = items.map(function (it) {
      var url = session.urls[it.fp];
      return (it.kind === 'video' ? loadVideoEl(url) : loadPhotoEl(url)).then(function (el) {
        return { item: it, el: el };
      });
    });

    Promise.all(mediaLoads).then(function (loaded) {
      var pts = items.filter(function (it) { return it.lat != null && it.lng != null; });

      var segments = [{ type: 'title', dur: TITLE_S }];
      pts.forEach(function (it, i) { segments.push({ type: 'map', dur: MAP_STEP_S, revealCount: i + 1 }); });
      if (pts.length) segments.push({ type: 'map-hold', dur: MAP_HOLD_S, revealCount: pts.length });
      loaded.forEach(function (lm) {
        if (lm.item.kind === 'video') {
          var dur = Math.min(lm.el.duration || VIDEO_MAX_S, VIDEO_MAX_S);
          segments.push({ type: 'video', dur: dur, item: lm.item, el: lm.el });
        } else {
          segments.push({ type: 'photo', dur: PHOTO_S, item: lm.item, el: lm.el });
        }
      });
      segments.push({ type: 'summary', dur: SUMMARY_S });

      var totalDur = segments.reduce(function (s, seg) { return s + seg.dur; }, 0);
      var stats = {
        photos: items.filter(function (it) { return it.kind === 'photo'; }).length,
        videos: items.filter(function (it) { return it.kind === 'video'; }).length
      };

      var mimeType = pickMimeType();
      var stream = canvas.captureStream(30);
      var recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
      var chunks = [];
      recorder.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = function () {
        var blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        onExportDone(blob, mimeType);
      };

      recorder.start();
      $('export-status').textContent = '書き出し中…';

      var segIdx = 0, segStart = performance.now(), elapsedBefore = 0;

      function enterSegment(seg) {
        if (seg.type === 'video') { try { seg.el.currentTime = 0; seg.el.play(); } catch (e) {} }
      }
      enterSegment(segments[0]);

      function frame(now) {
        var seg = segments[segIdx];
        var elapsedInSeg = (now - segStart) / 1000;
        var segDone = elapsedInSeg >= seg.dur || (seg.type === 'video' && seg.el.ended);

        drawSegment(ctx, seg, project, pts, stats);

        var totalElapsed = elapsedBefore + Math.min(elapsedInSeg, seg.dur);
        $('export-bar').style.width = Math.min(100, Math.round(totalElapsed / totalDur * 100)) + '%';

        if (segDone) {
          if (seg.type === 'video') { try { seg.el.pause(); } catch (e) {} }
          elapsedBefore += seg.dur;
          segIdx++;
          if (segIdx >= segments.length) {
            $('export-bar').style.width = '100%';
            recorder.stop();
            return;
          }
          segStart = now;
          enterSegment(segments[segIdx]);
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  function drawSegment(ctx, seg, project, pts, stats) {
    if (seg.type === 'title') { Ex.drawTitleCard(ctx, project); return; }
    if (seg.type === 'map' || seg.type === 'map-hold') { Ex.drawMapFrame(ctx, pts, seg.revealCount, project.title); return; }
    if (seg.type === 'summary') { Ex.drawSummaryCard(ctx, project, stats); return; }
    var it = seg.item, el = seg.el;
    var iw = seg.type === 'video' ? el.videoWidth : el.naturalWidth;
    var ih = seg.type === 'video' ? el.videoHeight : el.naturalHeight;
    if (!iw || !ih) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, Ex.W, Ex.H); return; }
    var xform = Ex.drawCover(ctx, el, iw, ih, it.crop);
    Ex.drawMosaics(ctx, el, iw, ih, it.mosaics, xform);
    Ex.drawCaption(ctx, it.placeName, Ex.fmtDateTime(new Date(it.takenAt)));
  }

  function onExportDone(blob, mimeType) {
    session.exportRunning = false;
    $('export-status').textContent = '書き出しが完了しました';
    var ext = mimeType.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    var url = URL.createObjectURL(blob);
    $('export-result').hidden = false;
    var btn = $('btn-export-save');
    var fileName = (state.project.title || 'mmovie').replace(/[\\/:*?"<>|]/g, '') + '.' + ext;
    btn.onclick = function () {
      var file;
      try { file = new File([blob], fileName, { type: blob.type }); } catch (e) { file = null; }
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: state.project.title }).catch(function () {});
      } else {
        var a = document.createElement('a');
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }
    };
  }

  /* ---------------- 起動 ---------------- */

  setView('projects');
})();
