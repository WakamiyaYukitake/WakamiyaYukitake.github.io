/* MovingFurniture — アプリ本体
 *
 * 考え方はシンプルに1つ：持ち物が1件ずつあり、それぞれに
 *   ・行き先/予定（destination）＝ 東京へ持っていく／実家に置く／売る／捨てる／不明／買い足すもの／未定
 *   ・対応済みか（done）
 *   ・予定日 or 時期メモ
 * を持たせているだけ。「残っているもの」は done=false の持ち物を指すだけで、
 * 別カテゴリではない（タブは 概要／持ち物／予定 の3つだけ）。
 */
(function () {
  'use strict';

  var S = MovingStore.load();
  var U = MovingStore.util;

  var APP_VERSION = 'v2.0.0';

  var DEST_LABELS = {
    '': '未定', tokyo: '東京へ持っていく', home: '実家に置く', sell: '売る',
    discard: '捨てる', unsure: '不明', buy: '買い足すもの'
  };
  var DEST_SHORT = {
    '': '未定', tokyo: '東京', home: '実家', sell: '売る', discard: '捨てる', unsure: '不明', buy: '買い足す'
  };
  var DEST_ORDER = ['', 'tokyo', 'home', 'sell', 'discard', 'unsure', 'buy'];

  var state = { view: 'overview', itemFilter: 'pending' };
  var todayD = new Date();
  var cal = { year: todayD.getFullYear(), month: todayD.getMonth() + 1, selected: U.todayStr() };

  /* ---------------- 初回起動：長崎の部屋の家具を用意 ---------------- */
  function seedIfEmpty() {
    if (MovingStore.seedIfEmpty(S)) {
      setTimeout(function () {
        toast('長崎の部屋にある持ち物を初期登録しました。内容は自由に編集できます');
      }, 400);
    }
  }

  /* ---------------- 汎用ユーティリティ ---------------- */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtPrice(n) {
    if (n === null || n === undefined || n === '') return '';
    return '¥' + Math.round(n).toLocaleString('ja-JP');
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------------- シート（モーダルフォーム） ---------------- */

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

  /* ---------------- 描画：トップバー ---------------- */

  function renderTopbar() {
    var items = S.data.items;
    var done = items.filter(function (i) { return i.done; }).length;
    $('status-main').textContent = done + ' / ' + items.length + ' 件 完了';
    $('status-sub').textContent = '残り ' + (items.length - done) + '件';
    $('app-version').textContent = APP_VERSION;
  }

  /* ---------------- 描画：概要 ---------------- */

  function renderOverview() {
    var items = S.data.items;
    var done = items.filter(function (i) { return i.done; }).length;
    var pct = items.length ? Math.round(done / items.length * 100) : 0;

    $('ov-progress').innerHTML =
      '<div class="label">引っ越しの進み具合</div>' +
      '<div class="amount">' + done + ' <span class="n2">/ ' + items.length + ' 件対応済み（' + pct + '%）</span></div>' +
      '<div class="progress-bar"><div style="width:' + pct + '%"></div></div>';

    $('ov-dest-stats').innerHTML = DEST_ORDER.map(function (d) {
      var n = items.filter(function (i) { return i.destination === d; }).length;
      return '<div class="stat-card" data-goto-dest="' + d + '">' +
        '<div class="n" style="color:var(--c-' + (d || 'none') + ')">' + n + '</div>' +
        '<div class="l">' + DEST_SHORT[d] + '</div></div>';
    }).join('');
    $('ov-dest-stats').querySelectorAll('[data-goto-dest]').forEach(function (el) {
      el.addEventListener('click', function () { setView('items'); });
    });

    var upcoming = items.filter(function (i) { return i.moveDate && !i.done; })
      .sort(function (a, b) { return U.cmpDate(a.moveDate, b.moveDate); })
      .slice(0, 6);
    $('ov-upcoming').innerHTML = upcoming.length ? upcoming.map(function (i) { return itemRowHtml(i, true); }).join('') :
      '<div class="empty-state">日付が決まっている予定はまだありません</div>';
    bindItemRows($('ov-upcoming'));
  }

  /* ---------------- 共通：アイテム行 ---------------- */

  function destDot(d) {
    return '<span class="g-dot" style="background:var(--c-' + (d || 'none') + ')"></span>';
  }

  function itemRowHtml(it, showDest) {
    var sub = '';
    if (showDest) sub += '<span class="tag dest-' + (it.destination || 'none') + '">' + DEST_SHORT[it.destination] + '</span>';
    if (it.moveDate) sub += '<span class="tag time">' + U.fmtDateShort(it.moveDate) + '</span>';
    else if (it.moveTiming) sub += '<span class="tag time">' + esc(it.moveTiming) + '</span>';
    var price = fmtPrice(it.price);
    return '<div class="item-row' + (it.done ? ' done' : '') + '" data-id="' + it.id + '">' +
      '<button class="item-check' + (it.done ? ' checked' : '') + '">' + (it.done ? '✓' : '') + '</button>' +
      '<div class="item-info" data-open="' + it.id + '">' +
      '<div class="item-name">' + esc(it.name || '（名称未設定）') + '</div>' +
      (sub ? '<div class="item-sub">' + sub + '</div>' : '') +
      '</div>' +
      (price ? '<div class="item-price">' + price + '</div>' : '') +
      '</div>';
  }

  function bindItemRows(container) {
    container.querySelectorAll('.item-row').forEach(function (row) {
      var id = row.getAttribute('data-id');
      row.querySelector('.item-check').addEventListener('click', function (e) {
        e.stopPropagation();
        var it = S.getItem(id);
        if (!it) return;
        S.updateItem(id, { done: !it.done });
        renderAll();
      });
      row.querySelector('.item-info').addEventListener('click', function () {
        openItemForm(S.getItem(id));
      });
    });
  }

  /* ---------------- 描画：持ち物一覧（行き先ごと） ---------------- */

  function renderItems() {
    $('item-filter').querySelectorAll('.segment-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-filter') === state.itemFilter);
    });

    var items = S.data.items;
    var html = '';
    DEST_ORDER.forEach(function (d) {
      var list = items.filter(function (i) { return i.destination === d; });
      if (!list.length) return;
      var doneCount = list.filter(function (i) { return i.done; }).length;
      var shown = state.itemFilter === 'pending' ? list.filter(function (i) { return !i.done; }) : list;
      if (!shown.length) return;
      html += '<div class="group-header">' + destDot(d) + '<span>' + DEST_LABELS[d] + '</span><span class="g-count">' + doneCount + '/' + list.length + '</span></div>';
      html += '<div class="entry-list">' + shown.map(function (i) { return itemRowHtml(i, false); }).join('') + '</div>';
    });
    html += '<div class="btn-row"><button class="btn full" id="btn-add-buy">＋ 買い足すものを追加</button></div>';
    $('item-list').innerHTML = html || '<div class="empty-state">対象の持ち物がありません</div>';
    bindItemRows($('item-list'));
    var addBuyBtn = $('item-list').querySelector('#btn-add-buy');
    if (addBuyBtn) addBuyBtn.addEventListener('click', function () { openItemForm(null, { destination: 'buy' }); });
  }

  $('item-filter').addEventListener('click', function (e) {
    var btn = e.target.closest('.segment-btn');
    if (!btn) return;
    state.itemFilter = btn.getAttribute('data-filter');
    renderItems();
  });

  /* ---------------- 描画：予定（カレンダー） ---------------- */

  function renderSchedule() {
    var y = cal.year, m = cal.month;
    $('cal-title').textContent = y + '年' + m + '月';

    var items = S.data.items;
    var byDate = {};
    items.forEach(function (it) {
      if (!it.moveDate) return;
      (byDate[it.moveDate] = byDate[it.moveDate] || []).push(it);
    });

    var firstWeekday = new Date(y, m - 1, 1).getDay();
    var lastDay = new Date(y, m, 0).getDate();
    var today = U.todayStr();

    var cells = '';
    for (var i = 0; i < firstWeekday; i++) cells += '<div class="cal-day pad"></div>';
    for (var d = 1; d <= lastDay; d++) {
      var dateStr = y + '-' + U.pad2(m) + '-' + U.pad2(d);
      var dayItems = byDate[dateStr] || [];
      var cls = 'cal-day';
      if (dateStr === today) cls += ' today';
      if (dateStr === cal.selected) cls += ' selected';
      cells += '<div class="' + cls + '" data-date="' + dateStr + '"><div class="cal-daynum">' + d + '</div>' +
        (dayItems.length ? '<div class="cal-dot"></div>' : '') + '</div>';
    }
    $('cal-grid').innerHTML = cells;
    $('cal-grid').querySelectorAll('.cal-day:not(.pad)').forEach(function (cell) {
      cell.addEventListener('click', function () {
        cal.selected = cell.getAttribute('data-date');
        renderSchedule();
      });
    });

    renderCalDetail(byDate[cal.selected] || []);

    var undated = items.filter(function (i) { return !i.moveDate && i.moveTiming && !i.done; });
    $('sched-undated').innerHTML = undated.length ? undated.map(function (i) { return itemRowHtml(i, true); }).join('') :
      '<div class="empty-state">日付未定のメモ付き予定はありません</div>';
    bindItemRows($('sched-undated'));
  }

  function renderCalDetail(dayItems) {
    var dateStr = cal.selected;
    var head = '<div class="cal-detail-head">' + U.fmtDateShort(dateStr) + 'の予定</div>';
    var body = dayItems.length ? '<div class="entry-list">' + dayItems.map(function (i) { return itemRowHtml(i, true); }).join('') + '</div>' :
      '<div class="empty-state">この日の予定はありません</div>';

    var candidates = S.data.items.filter(function (i) { return !i.moveDate && !i.done; });
    var pickHtml = candidates.length ?
      '<div class="field"><label>この日に予定を追加</label><select id="cal-add-select"><option value="">持ち物を選ぶ…</option>' +
      candidates.map(function (i) { return '<option value="' + i.id + '">' + esc(i.name) + '</option>'; }).join('') +
      '</select></div>' : '';

    $('cal-detail').innerHTML = head + body + pickHtml;
    bindItemRows($('cal-detail'));
    var sel = $('cal-detail').querySelector('#cal-add-select');
    if (sel) {
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        S.updateItem(sel.value, { moveDate: dateStr });
        renderAll();
        toast('予定日を設定しました');
      });
    }
  }

  $('cal-prev').addEventListener('click', function () { shiftCalMonth(-1); });
  $('cal-next').addEventListener('click', function () { shiftCalMonth(1); });
  function shiftCalMonth(delta) {
    var m = cal.month + delta;
    var y = cal.year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    cal.year = y;
    cal.month = m;
    renderSchedule();
  }

  /* ---------------- アイテム追加・編集フォーム ---------------- */

  function itemFormHtml(it) {
    return '' +
      '<div class="field"><label>品名</label><input type="text" id="f-name" value="' + esc(it.name || '') + '" placeholder="例）食器類" /></div>' +
      '<div class="field"><label>行き先・予定</label><select id="f-dest">' +
      DEST_ORDER.map(function (d) {
        return '<option value="' + d + '"' + (it.destination === d ? ' selected' : '') + '>' + DEST_LABELS[d] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="f-done"' + (it.done ? ' checked' : '') + ' /><label for="f-done" id="f-done-label">' + (it.destination === 'buy' ? '購入済み' : '対応済み（移動・処分などが完了）') + '</label></div>' +
      '<div class="field-row">' +
      '<div class="field"><label>予定日</label><input type="date" id="f-date" value="' + esc(it.moveDate || '') + '" /></div>' +
      '<div class="field"><label>時期メモ</label><input type="text" id="f-timing" value="' + esc(it.moveTiming || '') + '" placeholder="例）シルバーウィーク中" /></div>' +
      '</div>' +
      '<div class="field"><label>金額の目安（円・任意）</label><input type="number" id="f-price" value="' + (it.price != null ? it.price : '') + '" placeholder="売却額や購入予算など" /></div>' +
      '<div class="field"><label>メモ</label><textarea id="f-notes">' + esc(it.notes || '') + '</textarea></div>' +
      '<div class="sheet-actions">' +
      (it.id ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '<button class="btn primary" id="f-save">保存</button>' +
      '</div>';
  }

  function openItemForm(existing, defaults) {
    var it = existing || Object.assign({ destination: '', price: null }, defaults || {});
    openSheet(existing ? '持ち物を編集' : '持ち物を追加', itemFormHtml(it), function (body) {
      bindItemForm(body, it);
    });
  }

  function bindItemForm(body, it) {
    body.querySelector('#f-dest').addEventListener('change', function () {
      body.querySelector('#f-done-label').textContent = body.querySelector('#f-dest').value === 'buy' ? '購入済み' : '対応済み（移動・処分などが完了）';
    });

    body.querySelector('#f-save').addEventListener('click', function () {
      var name = body.querySelector('#f-name').value.trim();
      if (!name) { toast('品名を入力してください'); return; }
      var patch = {
        name: name,
        destination: body.querySelector('#f-dest').value,
        done: body.querySelector('#f-done').checked,
        moveDate: body.querySelector('#f-date').value,
        moveTiming: body.querySelector('#f-timing').value.trim(),
        price: body.querySelector('#f-price').value === '' ? null : Number(body.querySelector('#f-price').value),
        notes: body.querySelector('#f-notes').value.trim()
      };
      if (it.id) S.updateItem(it.id, patch);
      else S.addItem(patch);
      closeSheet();
      renderAll();
      toast('保存しました');
    });

    var delBtn = body.querySelector('#f-delete');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        if (!confirm('「' + it.name + '」を削除しますか？')) return;
        S.deleteItem(it.id);
        closeSheet();
        renderAll();
        toast('削除しました');
      });
    }
  }

  /* ---------------- 設定 ---------------- */

  function settingsBodyHtml() {
    return '' +
      '<section class="panel">' +
      '<h2>データ</h2>' +
      '<div class="btn-row">' +
      '<button class="btn" id="btn-export">バックアップ (JSON)</button>' +
      '<button class="btn" id="btn-import">読み込み</button>' +
      '<button class="btn danger full" id="btn-clear">全消去</button>' +
      '</div>' +
      '<input type="file" id="file-import" accept="application/json,.json" hidden />' +
      '<p class="note">データはこの端末のブラウザ内に保存されています。機種変更などに備えて、ときどきバックアップしておくと安心です。</p>' +
      '</section>';
  }

  function bindSettingsEvents(body) {
    body.querySelector('#btn-export').addEventListener('click', function () {
      var blob = new Blob([S.exportJson()], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'movingfurniture-backup-' + U.todayStr() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
    body.querySelector('#btn-import').addEventListener('click', function () {
      body.querySelector('#file-import').click();
    });
    body.querySelector('#file-import').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          S.importJson(reader.result);
          closeSheet();
          renderAll();
          toast('バックアップを読み込みました');
        } catch (err) {
          toast('読み込みに失敗しました：' + err.message);
        }
      };
      reader.readAsText(file);
    });
    body.querySelector('#btn-clear').addEventListener('click', function () {
      if (!confirm('すべてのデータを消去します。よろしいですか？（この操作は取り消せません）')) return;
      S.clearAll();
      closeSheet();
      renderAll();
      toast('すべてのデータを消去しました');
    });
  }

  $('btn-settings').addEventListener('click', function () {
    openSheet('設定', settingsBodyHtml(), bindSettingsEvents);
  });

  /* ---------------- ビュー切り替え・FAB ---------------- */

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + view; });
    document.querySelectorAll('.bar-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
  }
  $('bottombar').addEventListener('click', function (e) {
    var btn = e.target.closest('.bar-btn');
    if (!btn) return;
    setView(btn.getAttribute('data-view'));
  });

  $('btn-fab').addEventListener('click', function () { openItemForm(null); });

  /* ---------------- 描画まとめ ---------------- */

  function renderAll() {
    renderTopbar();
    renderOverview();
    renderItems();
    renderSchedule();
  }

  /* ---------------- 起動 ---------------- */

  seedIfEmpty();
  setView('overview');
  renderAll();
})();
