/* MoneyMGT — アプリ本体 */
(function () {
  'use strict';

  var S = MoneyStore.load();
  var U = MoneyStore.util;

  var ACCOUNT_COLORS = ['#3ea6ff', '#ff8a3d', '#4cd08a', '#c792ea', '#ffd166', '#ef476f'];
  var HORIZON_CHIPS = [
    { days: 30, label: '1ヶ月' },
    { days: 90, label: '3ヶ月' },
    { days: 180, label: '6ヶ月' },
    { days: 365, label: '1年' }
  ];

  var state = {
    view: 'overview',
    ledgerTab: 'tx',
    simHorizon: 90
  };

  /* ---------------- 初回起動：口座の下地を用意 ---------------- */
  function seedIfEmpty() {
    if (S.data.accounts.length > 0) return;
    var yucho = S.addAccount({ name: 'ゆうちょ銀行', purpose: '貯金・高額の支払い（自分のお金）', baseBalance: 0 });
    S.addAccount({ name: '十八親和銀行', purpose: '日用使い（仕送り）', baseBalance: 0 });
    S.addAccount({ name: '肥後銀行', purpose: '株式投資用（長期資金）', baseBalance: 0 });
    S.addCard({ accountId: yucho.id, name: 'クレジット1' });
    S.addCard({ accountId: yucho.id, name: 'クレジット2' });
    S.addCard({ accountId: yucho.id, name: 'クレジット3' });
    setTimeout(function () {
      toast('初期口座を3つ用意しました。残高や名前は設定から編集できます');
    }, 400);
  }

  /* ---------------- 汎用ユーティリティ ---------------- */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtYen(n) {
    var v = Math.round(n || 0);
    return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toLocaleString('ja-JP');
  }
  function fmtYenSigned(n) {
    var v = Math.round(n || 0);
    return (v > 0 ? '+' : '') + fmtYen(v);
  }
  function fmtDateShort(s) {
    if (!s) return '';
    var d = U.parseDate(s);
    var out = (d.getMonth() + 1) + '/' + d.getDate();
    if (d.getFullYear() !== new Date().getFullYear()) out = d.getFullYear() + '/' + out;
    return out;
  }
  function accountColor(id) {
    var idx = S.data.accounts.findIndex(function (a) { return a.id === id; });
    return ACCOUNT_COLORS[Math.max(0, idx) % ACCOUNT_COLORS.length];
  }
  function accountName(id) {
    var a = S.getAccount(id);
    return a ? a.name : '（削除された口座）';
  }
  function cardName(id) {
    if (!id) return '';
    var c = S.getCard(id);
    return c ? c.name : '（削除されたカード）';
  }

  /* ---------------- クラウド同期 ---------------- */

  function syncStatusText() {
    var cfg = S.syncCfg || {};
    if (!cfg.url || !cfg.token) return '未設定（下のURL・トークンを入力してください）';
    if (cfg.lastError) return 'エラー：' + cfg.lastError;
    if (cfg.lastSyncAt) return '最終同期：' + new Date(cfg.lastSyncAt).toLocaleString('ja-JP');
    return '未同期';
  }
  function refreshSyncStatusUi() {
    var el = document.getElementById('sync-status');
    if (el) el.textContent = syncStatusText();
  }

  var pushTimer = null;
  function schedulePush() {
    if (!S.syncCfg.url || !S.syncCfg.token) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      S.pushToCloud(function () { refreshSyncStatusUi(); });
    }, 1200);
  }

  /* 起動時／設定保存時：まずリモートを確認し、ローカルより新しければ取り込む。
   * preferRemote=true（この端末でこのURLに初めて紐づけたとき）はタイムスタンプに関わらず
   * リモートを優先する。そうしないと、まだ何も触っていない端末の「シードしたばかりの初期口座」
   * のタイムスタンプの方が新しく見えてしまい、既にクラウドにある本物のデータを
   * 空っぽの初期口座で上書きしてしまう事故になる。
   * リモートが無ければそこでシードして初回アップロードする。 */
  function activateSync(pushAfter, preferRemote) {
    if (!S.syncCfg.url || !S.syncCfg.token) { S.onSave = null; return; }
    S.pullFromCloud(function (err, res) {
      var applied = false;
      if (!err && res && res.data) {
        var remoteNewer = !S.data.updatedAt || (res.updatedAt && res.updatedAt > S.data.updatedAt);
        if (preferRemote || remoteNewer) {
          S.applyRemote(res.data);
          applied = true;
        }
      }
      seedIfEmpty();
      S.onSave = schedulePush;
      renderAll();
      refreshSyncStatusUi();
      if (applied) toast('クラウドの最新データを取り込みました');
      if (pushAfter || !applied) schedulePush();
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function accountOptions(selectedId, includeArchived) {
    var list = includeArchived === false ? S.activeAccounts() : S.data.accounts.slice().sort(function (a, b) { return a.order - b.order; });
    return list.map(function (a) {
      var sel = a.id === selectedId ? ' selected' : '';
      var tag = a.archived ? '（アーカイブ）' : '';
      return '<option value="' + a.id + '"' + sel + '>' + esc(a.name) + tag + '</option>';
    }).join('');
  }
  function cardOptions(selectedId, accountId) {
    var list = S.data.cards.filter(function (c) { return !accountId || c.accountId === accountId; });
    var opts = '<option value="">なし</option>';
    opts += list.map(function (c) {
      var sel = c.id === selectedId ? ' selected' : '';
      return '<option value="' + c.id + '"' + sel + '>' + esc(c.name) + '</option>';
    }).join('');
    return opts;
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
    var total = S.totalBalance(U.todayStr());
    $('status-main').textContent = fmtYen(total);
    $('status-sub').textContent = '合計残高 ・ ' + S.activeAccounts().length + '口座';
  }

  /* ---------------- 描画：概要 ---------------- */

  function renderOverview() {
    var today = U.todayStr();
    var total = S.totalBalance(today);
    $('ov-total').innerHTML =
      '<div class="label">合計残高（' + fmtDateShort(today) + ' 時点）</div>' +
      '<div class="amount">' + fmtYen(total) + '</div>';

    var accounts = S.activeAccounts();
    $('ov-accounts').innerHTML = accounts.length ? accounts.map(function (a) {
      var bal = S.accountBalance(a.id, today);
      return '<div class="account-card" data-account-id="' + a.id + '">' +
        '<span class="dot" style="background:' + accountColor(a.id) + '"></span>' +
        '<div class="info"><div class="name">' + esc(a.name) + '</div>' +
        '<div class="purpose">' + esc(a.purpose || '') + '</div></div>' +
        '<div class="balance">' + fmtYen(bal) + '</div></div>';
    }).join('') : '<div class="empty-state">口座がありません。⚙設定から追加してください</div>';

    $('ov-accounts').querySelectorAll('.account-card').forEach(function (row) {
      row.addEventListener('click', function () {
        openAccountForm(S.getAccount(row.getAttribute('data-account-id')));
      });
    });

    renderSimChips();
    renderSimulation();
  }

  function renderSimChips() {
    $('sim-chips').innerHTML = HORIZON_CHIPS.map(function (c) {
      var active = c.days === state.simHorizon ? ' active' : '';
      return '<button class="chip' + active + '" data-days="' + c.days + '">' + c.label + '</button>';
    }).join('');
    $('sim-chips').querySelectorAll('.chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.simHorizon = Number(btn.getAttribute('data-days'));
        renderSimChips();
        renderSimulation();
      });
    });
  }

  function renderSimulation() {
    var sim = S.simulate(state.simHorizon);

    $('sim-chart').innerHTML = buildChartSvg(sim.points) +
      '<div class="chart-tooltip" id="chart-tooltip" hidden></div>';
    bindChartInteraction(sim.points);

    var netClass = sim.netChange >= 0 ? 'pos' : 'neg';
    $('sim-stats').innerHTML =
      '<div><div class="stat-label">期間の増減</div><div class="stat-value ' + netClass + '">' + fmtYenSigned(sim.netChange) + '</div></div>' +
      '<div><div class="stat-label">1日あたりの貯金ペース</div><div class="stat-value">' + fmtYenSigned(Math.round(sim.dailyAverage)) + '</div></div>' +
      '<div><div class="stat-label">' + fmtDateShort(sim.horizonEnd) + ' の予測残高</div><div class="stat-value">' + fmtYen(sim.end) + '</div></div>';

    if (!$('sim-date-input').value) $('sim-date-input').value = U.addDays(U.todayStr(), 30);

    var events = sim.events;
    $('sim-events').innerHTML = events.length ? events.slice(0, 20).map(eventRowHtml).join('') :
      '<div class="empty-state">この期間に予定されている入出金はありません</div>';
  }

  var KIND_COLOR = { income: '#4cd08a', expense: '#ff6b6b', refund: '#3ea6ff', earning: '#ffd166', subscription: '#ff8a3d' };
  function eventRowHtml(ev) {
    var cls = ev.amount >= 0 ? 'amt-pos' : 'amt-neg';
    return '<div class="event-row">' +
      '<span class="kind-dot" style="background:' + (KIND_COLOR[ev.kind] || '#888') + '"></span>' +
      '<div class="ev-info"><div class="ev-title">' + esc(ev.label) + '</div>' +
      '<div class="ev-sub">' + fmtDateShort(ev.date) + ' ・ ' + esc(accountName(ev.accountId)) + '</div></div>' +
      '<div class="ev-amount ' + cls + '">' + fmtYenSigned(ev.amount) + '</div></div>';
  }

  $('sim-date-btn').addEventListener('click', function () {
    var d = $('sim-date-input').value;
    if (!d) return;
    var bal = S.balanceOnDate(d);
    $('sim-date-result').textContent = fmtDateShort(d) + ' 時点の予測残高：' + fmtYen(bal);
  });

  /* ---------------- 折れ線チャート（SVG） ---------------- */

  var CHART_W = 320, CHART_H = 150, PAD_L = 8, PAD_R = 8, PAD_T = 18, PAD_B = 24;

  function buildChartSvg(points) {
    var vals = points.map(function (p) { return p.total; });
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    if (min === max) { min -= 1; max += 1; }
    var range = max - min;
    var n = points.length;

    function x(i) { return n <= 1 ? CHART_W / 2 : PAD_L + (i / (n - 1)) * (CHART_W - PAD_L - PAD_R); }
    function y(v) { return CHART_H - PAD_B - ((v - min) / range) * (CHART_H - PAD_T - PAD_B); }

    var path = 'M ' + x(0) + ' ' + y(points[0].total);
    for (var i = 1; i < n; i++) {
      path += ' H ' + x(i) + ' V ' + y(points[i].total);
    }
    var areaPath = path + ' L ' + x(n - 1) + ' ' + (CHART_H - PAD_B) + ' L ' + x(0) + ' ' + (CHART_H - PAD_B) + ' Z';

    var zeroLine = '';
    if (min < 0 && max > 0) {
      zeroLine = '<line x1="' + PAD_L + '" y1="' + y(0) + '" x2="' + (CHART_W - PAD_R) + '" y2="' + y(0) +
        '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3,3" />';
    }

    var dots = points.map(function (p, i) {
      return '<circle class="chart-hit" data-i="' + i + '" cx="' + x(i) + '" cy="' + y(p.total) +
        '" r="9" fill="transparent" style="cursor:pointer" />' +
        '<circle cx="' + x(i) + '" cy="' + y(p.total) + '" r="3" fill="var(--accent-2)" stroke="var(--panel)" stroke-width="1.5" pointer-events="none" />';
    }).join('');

    var firstLabel = fmtDateShort(points[0].date) + '  ' + fmtYen(points[0].total);
    var lastLabel = fmtDateShort(points[n - 1].date) + '  ' + fmtYen(points[n - 1].total);

    return '<svg viewBox="0 0 ' + CHART_W + ' ' + CHART_H + '" preserveAspectRatio="xMidYMid meet">' +
      '<defs><linearGradient id="simFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#3ea6ff" stop-opacity="0.35"/>' +
      '<stop offset="100%" stop-color="#3ea6ff" stop-opacity="0"/></linearGradient></defs>' +
      zeroLine +
      '<path d="' + areaPath + '" fill="url(#simFill)" stroke="none" />' +
      '<path d="' + path + '" fill="none" stroke="var(--accent-2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />' +
      dots +
      '<text x="' + PAD_L + '" y="12" font-size="9" fill="var(--muted)">' + esc(firstLabel) + '</text>' +
      '<text x="' + (CHART_W - PAD_R) + '" y="12" font-size="9" fill="var(--muted)" text-anchor="end">' + esc(lastLabel) + '</text>' +
      '</svg>';
  }

  function bindChartInteraction(points) {
    var wrap = $('sim-chart');
    var tip = $('chart-tooltip');
    wrap.querySelectorAll('.chart-hit').forEach(function (c) {
      c.addEventListener('click', function (e) {
        e.stopPropagation();
        var i = Number(c.getAttribute('data-i'));
        var p = points[i];
        var cx = Number(c.getAttribute('cx')), cy = Number(c.getAttribute('cy'));
        tip.style.left = (cx / CHART_W * 100) + '%';
        tip.style.top = (cy / CHART_H * 100) + '%';
        tip.textContent = fmtDateShort(p.date) + '　' + fmtYen(p.total);
        tip.hidden = false;
      });
    });
    wrap.addEventListener('click', function () { tip.hidden = true; });
  }

  /* ---------------- 描画：入出（取引・払い戻し） ---------------- */

  function renderLedger() {
    $('ledger-tabs').querySelectorAll('.segment-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-ledger-tab') === state.ledgerTab);
    });
    $('ledger-tx').hidden = state.ledgerTab !== 'tx';
    $('ledger-refund').hidden = state.ledgerTab !== 'refund';

    var txs = S.transactionsSorted();
    $('tx-list').innerHTML = txs.length ? txs.map(function (t) {
      var refunded = S.data.refunds.filter(function (r) { return r.targetTransactionId === t.id; })
        .reduce(function (sum, r) { return sum + r.amount; }, 0);
      var badge = refunded > 0 ? '<span class="badge received">払戻 ' + fmtYen(refunded) + '</span>' : '';
      var cls = t.type === 'income' ? 'amt-pos' : 'amt-neg';
      var sign = t.type === 'income' ? '+' : '-';
      var sub = fmtDateShort(t.date) + ' ・ ' + esc(accountName(t.accountId)) + (t.cardId ? ' ・ ' + esc(cardName(t.cardId)) : '');
      return '<div class="entry-row" data-tx-id="' + t.id + '">' +
        '<span class="kind-dot" style="background:' + (t.type === 'income' ? KIND_COLOR.income : KIND_COLOR.expense) + '"></span>' +
        '<div class="ev-info"><div class="ev-title">' + esc(t.title || (t.type === 'income' ? '入金' : '支出')) + badge + '</div>' +
        '<div class="ev-sub">' + sub + '</div></div>' +
        '<div class="ev-amount ' + cls + '">' + sign + fmtYen(t.amount) + '</div></div>';
    }).join('') : '<div class="empty-state">取引がまだありません</div>';

    $('tx-list').querySelectorAll('.entry-row').forEach(function (row) {
      row.addEventListener('click', function () {
        openTransactionForm(S.getTransaction(row.getAttribute('data-tx-id')));
      });
    });

    var refunds = S.refundsSorted();
    $('refund-list').innerHTML = refunds.length ? refunds.map(function (r) {
      var target = r.targetTransactionId ? S.getTransaction(r.targetTransactionId) : null;
      var badge = '<span class="badge ' + (r.received ? 'received' : 'planned') + '">' + (r.received ? '受領済み' : '予定') + '</span>';
      var sub = fmtDateShort(r.date) + ' ・ ' + esc(accountName(r.accountId)) + (target ? ' ・ 対象：' + esc(target.title || '取引') : '');
      return '<div class="entry-row" data-refund-id="' + r.id + '">' +
        '<span class="kind-dot" style="background:' + KIND_COLOR.refund + '"></span>' +
        '<div class="ev-info"><div class="ev-title">' + esc(r.source || '払い戻し') + badge + '</div>' +
        '<div class="ev-sub">' + sub + '</div></div>' +
        '<div class="ev-amount amt-pos">+' + fmtYen(r.amount) + '</div></div>';
    }).join('') : '<div class="empty-state">払い戻しの記録はまだありません</div>';

    $('refund-list').querySelectorAll('.entry-row').forEach(function (row) {
      row.addEventListener('click', function () {
        openRefundForm(S.getRefund(row.getAttribute('data-refund-id')));
      });
    });
  }

  $('ledger-tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.segment-btn');
    if (!btn) return;
    state.ledgerTab = btn.getAttribute('data-ledger-tab');
    renderLedger();
  });

  /* ---------------- 描画：収入予定 ---------------- */

  function renderEarnings() {
    var list = S.earningsSorted();
    $('earnings-list').innerHTML = list.length ? list.map(function (e) {
      var badge = '<span class="badge ' + (e.status === 'received' ? 'received' : 'planned') + '">' +
        (e.status === 'received' ? '入金済み' : '予定') + '</span>';
      var sub = '稼いだ日 ' + fmtDateShort(e.earnedDate) + ' → 振込予定 ' + fmtDateShort(e.expectedPayDate) +
        (e.status === 'received' && e.actualPayDate ? '（実際：' + fmtDateShort(e.actualPayDate) + '）' : '') +
        ' ・ ' + esc(accountName(e.accountId));
      return '<div class="entry-row" data-earning-id="' + e.id + '">' +
        '<span class="kind-dot" style="background:' + KIND_COLOR.earning + '"></span>' +
        '<div class="ev-info"><div class="ev-title">' + esc(e.title || '収入') + badge + '</div>' +
        '<div class="ev-sub">' + sub + '</div></div>' +
        '<div class="ev-amount amt-pos">+' + fmtYen(e.amount) + '</div></div>';
    }).join('') : '<div class="empty-state">収入予定はまだありません</div>';

    $('earnings-list').querySelectorAll('.entry-row').forEach(function (row) {
      row.addEventListener('click', function () {
        openEarningForm(S.getEarning(row.getAttribute('data-earning-id')));
      });
    });
  }

  /* ---------------- 描画：サブスク ---------------- */

  function renderSubs() {
    $('subs-total').innerHTML = '<div class="label">月々の合計（有効分）</div>' +
      '<div class="amount small">' + fmtYen(S.monthlySubscriptionTotal()) + '</div>';

    var list = S.subscriptionsSorted();
    $('subs-list').innerHTML = list.length ? list.map(function (s) {
      var badge = s.active ? '' : '<span class="badge inactive">停止中</span>';
      var sub = '毎月' + s.billingDay + '日 ・ ' + esc(accountName(s.accountId)) + (s.cardId ? ' ・ ' + esc(cardName(s.cardId)) : '');
      return '<div class="entry-row" data-sub-id="' + s.id + '">' +
        '<span class="kind-dot" style="background:' + KIND_COLOR.subscription + '"></span>' +
        '<div class="ev-info"><div class="ev-title">' + esc(s.name) + badge + '</div>' +
        '<div class="ev-sub">' + sub + '</div></div>' +
        '<div class="ev-amount amt-neg">-' + fmtYen(s.amount) + '</div></div>';
    }).join('') : '<div class="empty-state">サブスクはまだありません</div>';

    $('subs-list').querySelectorAll('.entry-row').forEach(function (row) {
      row.addEventListener('click', function () {
        openSubscriptionForm(S.getSubscription(row.getAttribute('data-sub-id')));
      });
    });
  }

  /* ---------------- 描画まとめ ---------------- */

  function renderAll() {
    renderTopbar();
    renderOverview();
    renderLedger();
    renderEarnings();
    renderSubs();
  }

  /* ---------------- ビュー切り替え ---------------- */

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

  /* ---------------- FAB：現在のビューに応じて追加フォームを開く ---------------- */

  $('btn-fab').addEventListener('click', function () {
    if (state.view === 'overview') {
      openQuickAddChooser();
    } else if (state.view === 'ledger') {
      if (state.ledgerTab === 'refund') openRefundForm(null);
      else openTransactionForm(null);
    } else if (state.view === 'earnings') {
      openEarningForm(null);
    } else if (state.view === 'subs') {
      openSubscriptionForm(null);
    }
  });

  function openQuickAddChooser() {
    var html = '<div class="list-mini">' +
      '<div class="mini-row"><span>取引（支出・収入）を追加</span><div class="mini-actions"><button data-act="tx">開く</button></div></div>' +
      '<div class="mini-row"><span>払い戻しを追加</span><div class="mini-actions"><button data-act="refund">開く</button></div></div>' +
      '<div class="mini-row"><span>収入予定を追加</span><div class="mini-actions"><button data-act="earning">開く</button></div></div>' +
      '<div class="mini-row"><span>サブスクを追加</span><div class="mini-actions"><button data-act="sub">開く</button></div></div>' +
      '<div class="mini-row"><span>口座を追加</span><div class="mini-actions"><button data-act="account">開く</button></div></div>' +
      '</div>';
    openSheet('何を追加しますか？', html, function (body) {
      body.querySelectorAll('button[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var act = btn.getAttribute('data-act');
          closeSheet();
          setTimeout(function () {
            if (act === 'tx') openTransactionForm(null);
            else if (act === 'refund') openRefundForm(null);
            else if (act === 'earning') openEarningForm(null);
            else if (act === 'sub') openSubscriptionForm(null);
            else if (act === 'account') openAccountForm(null);
          }, 120);
        });
      });
    });
  }

  /* ---------------- フォーム：口座 ---------------- */

  function openAccountForm(existing) {
    var a = existing || { name: '', purpose: '', baseBalance: 0, baseDate: U.todayStr(), archived: false };
    var html =
      '<div class="field"><label>口座名</label><input type="text" id="f-name" value="' + esc(a.name) + '" placeholder="例：ゆうちょ銀行" /></div>' +
      '<div class="field"><label>用途メモ</label><input type="text" id="f-purpose" value="' + esc(a.purpose) + '" placeholder="例：貯金・高額の支払い" /></div>' +
      '<div class="field-row">' +
      '<div class="field"><label>基準残高</label><input type="number" id="f-balance" value="' + a.baseBalance + '" /></div>' +
      '<div class="field"><label>基準日</label><input type="date" id="f-date" value="' + a.baseDate + '" /></div>' +
      '</div>' +
      '<p class="note">基準日時点での実際の残高を入力してください。それ以降の入出金は自動で加減算されます。</p>' +
      (existing ? '<div class="checkbox-row"><input type="checkbox" id="f-archived"' + (a.archived ? ' checked' : '') + ' /><label for="f-archived">アーカイブする（使わなくなった口座を一覧から隠す。データは残ります）</label></div>' : '') +
      '<div class="sheet-actions">' +
      '<button class="btn primary" id="f-save">保存</button>' +
      (existing ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '</div>';

    openSheet(existing ? '口座を編集' : '口座を追加', html, function (body) {
      body.querySelector('#f-save').addEventListener('click', function () {
        var fields = {
          name: body.querySelector('#f-name').value.trim() || '無題の口座',
          purpose: body.querySelector('#f-purpose').value.trim(),
          baseBalance: Number(body.querySelector('#f-balance').value) || 0,
          baseDate: body.querySelector('#f-date').value || U.todayStr()
        };
        if (existing) {
          fields.archived = !!body.querySelector('#f-archived').checked;
          S.updateAccount(existing.id, fields);
        } else {
          S.addAccount(fields);
        }
        closeSheet();
        renderAll();
        toast('口座を保存しました');
      });
      var del = body.querySelector('#f-delete');
      if (del) {
        del.addEventListener('click', function () {
          if (S.referencesAccount(existing.id)) {
            toast('この口座はカードや取引から参照されているため削除できません。アーカイブを使ってください');
            return;
          }
          if (!confirm('この口座を完全に削除しますか？')) return;
          S.removeAccount(existing.id);
          closeSheet();
          renderAll();
          toast('口座を削除しました');
        });
      }
    });
  }

  /* ---------------- フォーム：カード ---------------- */

  function openCardForm(existing) {
    var c = existing || { name: '', accountId: (S.activeAccounts()[0] || {}).id || '', note: '' };
    var html =
      '<div class="field"><label>カード名</label><input type="text" id="f-name" value="' + esc(c.name) + '" placeholder="例：クレジット1" /></div>' +
      '<div class="field"><label>紐づく口座</label><select id="f-account">' + accountOptions(c.accountId) + '</select></div>' +
      '<div class="field"><label>メモ</label><input type="text" id="f-note" value="' + esc(c.note) + '" /></div>' +
      '<div class="sheet-actions">' +
      '<button class="btn primary" id="f-save">保存</button>' +
      (existing ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '</div>';
    openSheet(existing ? 'カードを編集' : 'カードを追加', html, function (body) {
      body.querySelector('#f-save').addEventListener('click', function () {
        var fields = {
          name: body.querySelector('#f-name').value.trim() || '無題のカード',
          accountId: body.querySelector('#f-account').value,
          note: body.querySelector('#f-note').value.trim()
        };
        if (existing) S.updateCard(existing.id, fields); else S.addCard(fields);
        closeSheet();
        renderSettingsAfterChange();
        renderAll();
        toast('カードを保存しました');
      });
      var del = body.querySelector('#f-delete');
      if (del) {
        del.addEventListener('click', function () {
          if (!S.removeCard(existing.id)) {
            toast('このカードは取引やサブスクから参照されているため削除できません');
            return;
          }
          closeSheet();
          renderSettingsAfterChange();
          renderAll();
          toast('カードを削除しました');
        });
      }
    });
  }

  /* ---------------- フォーム：取引（支出・収入） ---------------- */

  function openTransactionForm(existing) {
    var t = existing || {
      type: 'expense', date: U.todayStr(), settleDate: U.todayStr(),
      accountId: (S.activeAccounts()[0] || {}).id || '', cardId: null, amount: '', title: '', note: ''
    };
    var type = t.type;

    function fieldsHtml() {
      return '<div class="toggle-row" id="f-type">' +
        '<button type="button" data-type="expense" class="' + (type === 'expense' ? 'active' : '') + '">支出</button>' +
        '<button type="button" data-type="income" class="' + (type === 'income' ? 'active' : '') + '">収入</button>' +
        '</div>' +
        '<div class="field"><label>内容（何に対して／何の入金か）</label><input type="text" id="f-title" value="' + esc(t.title) + '" placeholder="例：教科書代 / アルバイト代" /></div>' +
        '<div class="field"><label>金額</label><input type="number" id="f-amount" value="' + t.amount + '" /></div>' +
        '<div class="field-row">' +
        '<div class="field"><label>日付（購入日／入金日）</label><input type="date" id="f-date" value="' + t.date + '" /></div>' +
        '<div class="field"><label>口座反映日（空欄可）</label><input type="date" id="f-settle" value="' + t.settleDate + '" /></div>' +
        '</div>' +
        '<div class="field"><label>口座</label><select id="f-account">' + accountOptions(t.accountId) + '</select></div>' +
        (type === 'expense' ? '<div class="field"><label>クレジットカード（任意）</label><select id="f-card">' + cardOptions(t.cardId) + '</select></div>' : '') +
        '<div class="field"><label>メモ</label><textarea id="f-note">' + esc(t.note) + '</textarea></div>';
    }

    var html = '<div id="fields-wrap">' + fieldsHtml() + '</div>' +
      '<div class="sheet-actions">' +
      '<button class="btn primary" id="f-save">保存</button>' +
      (existing ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '</div>';

    openSheet(existing ? '取引を編集' : '取引を追加', html, function (body) {
      function bindTypeToggle() {
        body.querySelectorAll('#f-type button').forEach(function (btn) {
          btn.addEventListener('click', function () {
            type = btn.getAttribute('data-type');
            t.title = body.querySelector('#f-title').value;
            t.amount = body.querySelector('#f-amount').value;
            t.date = body.querySelector('#f-date').value;
            t.settleDate = body.querySelector('#f-settle').value;
            t.accountId = body.querySelector('#f-account').value;
            body.querySelector('#fields-wrap').innerHTML = fieldsHtml();
            bindTypeToggle();
          });
        });
      }
      bindTypeToggle();

      body.querySelector('#f-save').addEventListener('click', function () {
        var date = body.querySelector('#f-date').value || U.todayStr();
        var settle = body.querySelector('#f-settle').value || date;
        var fields = {
          type: type,
          title: body.querySelector('#f-title').value.trim(),
          amount: Number(body.querySelector('#f-amount').value) || 0,
          date: date,
          settleDate: settle,
          accountId: body.querySelector('#f-account').value,
          cardId: type === 'expense' ? (body.querySelector('#f-card') ? body.querySelector('#f-card').value || null : null) : null,
          note: body.querySelector('#f-note').value.trim()
        };
        if (existing) S.updateTransaction(existing.id, fields); else S.addTransaction(fields);
        closeSheet();
        renderAll();
        toast('取引を保存しました');
      });
      var del = body.querySelector('#f-delete');
      if (del) {
        del.addEventListener('click', function () {
          if (!confirm('この取引を削除しますか？（紐づく払い戻しの参照も外れます）')) return;
          S.removeTransaction(existing.id);
          closeSheet();
          renderAll();
          toast('取引を削除しました');
        });
      }
    });
  }

  /* ---------------- フォーム：払い戻し ---------------- */

  function openRefundForm(existing) {
    var expenseTx = S.transactionsSorted().filter(function (t) { return t.type === 'expense'; });
    var r = existing || {
      date: U.todayStr(), amount: '', source: '', targetTransactionId: expenseTx[0] ? expenseTx[0].id : null,
      accountId: (S.activeAccounts()[0] || {}).id || '', received: false, note: ''
    };
    var txOptions = '<option value="">（対象取引を選ばない）</option>' + expenseTx.map(function (t) {
      var sel = t.id === r.targetTransactionId ? ' selected' : '';
      return '<option value="' + t.id + '"' + sel + '>' + fmtDateShort(t.date) + ' ' + esc(t.title || '支出') + ' ' + fmtYen(t.amount) + '</option>';
    }).join('');

    var html =
      '<div class="field"><label>対象の取引</label><select id="f-target">' + txOptions + '</select></div>' +
      '<div class="field"><label>払い戻し元（どこから）</label><input type="text" id="f-source" value="' + esc(r.source) + '" placeholder="例：大学" /></div>' +
      '<div class="field-row">' +
      '<div class="field"><label>金額</label><input type="number" id="f-amount" value="' + r.amount + '" /></div>' +
      '<div class="field"><label>日付（予定／受領日）</label><input type="date" id="f-date" value="' + r.date + '" /></div>' +
      '</div>' +
      '<div class="field"><label>入金先口座</label><select id="f-account">' + accountOptions(r.accountId) + '</select></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="f-received"' + (r.received ? ' checked' : '') + ' /><label for="f-received">すでに受け取った</label></div>' +
      '<div class="field"><label>メモ</label><textarea id="f-note">' + esc(r.note) + '</textarea></div>' +
      '<div class="sheet-actions">' +
      '<button class="btn primary" id="f-save">保存</button>' +
      (existing ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '</div>';

    openSheet(existing ? '払い戻しを編集' : '払い戻しを追加', html, function (body) {
      body.querySelector('#f-target').addEventListener('change', function () {
        var tx = S.getTransaction(this.value);
        if (tx && !body.querySelector('#f-amount').value) body.querySelector('#f-amount').value = tx.amount;
        if (tx) body.querySelector('#f-account').value = tx.accountId;
      });
      body.querySelector('#f-save').addEventListener('click', function () {
        var fields = {
          targetTransactionId: body.querySelector('#f-target').value || null,
          source: body.querySelector('#f-source').value.trim(),
          amount: Number(body.querySelector('#f-amount').value) || 0,
          date: body.querySelector('#f-date').value || U.todayStr(),
          accountId: body.querySelector('#f-account').value,
          received: !!body.querySelector('#f-received').checked,
          note: body.querySelector('#f-note').value.trim()
        };
        if (existing) S.updateRefund(existing.id, fields); else S.addRefund(fields);
        closeSheet();
        renderAll();
        toast('払い戻しを保存しました');
      });
      var del = body.querySelector('#f-delete');
      if (del) {
        del.addEventListener('click', function () {
          if (!confirm('この払い戻しを削除しますか？')) return;
          S.removeRefund(existing.id);
          closeSheet();
          renderAll();
          toast('払い戻しを削除しました');
        });
      }
    });
  }

  /* ---------------- フォーム：収入予定 ---------------- */

  function openEarningForm(existing) {
    var e = existing || {
      title: '', amount: '', earnedDate: U.todayStr(), expectedPayDate: U.todayStr(),
      actualPayDate: null, accountId: (S.activeAccounts()[0] || {}).id || '', status: 'planned', note: ''
    };
    var status = e.status;

    function fieldsHtml() {
      return '<div class="toggle-row" id="f-status">' +
        '<button type="button" data-status="planned" class="' + (status === 'planned' ? 'active' : '') + '">予定</button>' +
        '<button type="button" data-status="received" class="' + (status === 'received' ? 'active' : '') + '">入金済み</button>' +
        '</div>' +
        '<div class="field"><label>内容</label><input type="text" id="f-title" value="' + esc(e.title) + '" placeholder="例：家庭教師のバイト代" /></div>' +
        '<div class="field"><label>金額</label><input type="number" id="f-amount" value="' + e.amount + '" /></div>' +
        '<div class="field-row">' +
        '<div class="field"><label>稼いだ日</label><input type="date" id="f-earned" value="' + e.earnedDate + '" /></div>' +
        '<div class="field"><label>振込予定日</label><input type="date" id="f-expected" value="' + e.expectedPayDate + '" /></div>' +
        '</div>' +
        (status === 'received' ? '<div class="field"><label>実際の入金日</label><input type="date" id="f-actual" value="' + (e.actualPayDate || U.todayStr()) + '" /></div>' : '') +
        '<div class="field"><label>入金先口座</label><select id="f-account">' + accountOptions(e.accountId) + '</select></div>' +
        '<div class="field"><label>メモ</label><textarea id="f-note">' + esc(e.note) + '</textarea></div>';
    }

    var html = '<div id="fields-wrap">' + fieldsHtml() + '</div>' +
      '<div class="sheet-actions">' +
      '<button class="btn primary" id="f-save">保存</button>' +
      (existing ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '</div>';

    openSheet(existing ? '収入予定を編集' : '収入予定を追加', html, function (body) {
      function bindToggle() {
        body.querySelectorAll('#f-status button').forEach(function (btn) {
          btn.addEventListener('click', function () {
            status = btn.getAttribute('data-status');
            e.title = body.querySelector('#f-title').value;
            e.amount = body.querySelector('#f-amount').value;
            e.earnedDate = body.querySelector('#f-earned').value;
            e.expectedPayDate = body.querySelector('#f-expected').value;
            e.accountId = body.querySelector('#f-account').value;
            body.querySelector('#fields-wrap').innerHTML = fieldsHtml();
            bindToggle();
          });
        });
      }
      bindToggle();

      body.querySelector('#f-save').addEventListener('click', function () {
        var actualEl = body.querySelector('#f-actual');
        var fields = {
          title: body.querySelector('#f-title').value.trim(),
          amount: Number(body.querySelector('#f-amount').value) || 0,
          earnedDate: body.querySelector('#f-earned').value || U.todayStr(),
          expectedPayDate: body.querySelector('#f-expected').value || U.todayStr(),
          accountId: body.querySelector('#f-account').value,
          status: status,
          actualPayDate: status === 'received' ? (actualEl ? actualEl.value : U.todayStr()) : null,
          note: body.querySelector('#f-note').value.trim()
        };
        if (existing) S.updateEarning(existing.id, fields); else S.addEarning(fields);
        closeSheet();
        renderAll();
        toast('収入予定を保存しました');
      });
      var del = body.querySelector('#f-delete');
      if (del) {
        del.addEventListener('click', function () {
          if (!confirm('この収入予定を削除しますか？')) return;
          S.removeEarning(existing.id);
          closeSheet();
          renderAll();
          toast('収入予定を削除しました');
        });
      }
    });
  }

  /* ---------------- フォーム：サブスク ---------------- */

  function openSubscriptionForm(existing) {
    var s = existing || {
      name: '', amount: '', billingDay: 1, startDate: U.todayStr(),
      accountId: (S.activeAccounts()[0] || {}).id || '', cardId: null, active: true, note: ''
    };
    var html =
      '<div class="field"><label>サブスク名</label><input type="text" id="f-name" value="' + esc(s.name) + '" placeholder="例：Netflix" /></div>' +
      '<div class="field-row">' +
      '<div class="field"><label>金額（毎月）</label><input type="number" id="f-amount" value="' + s.amount + '" /></div>' +
      '<div class="field"><label>請求日（毎月◯日）</label><input type="number" id="f-day" min="1" max="31" value="' + s.billingDay + '" /></div>' +
      '</div>' +
      '<div class="field"><label>口座</label><select id="f-account">' + accountOptions(s.accountId) + '</select></div>' +
      '<div class="field"><label>クレジットカード（任意）</label><select id="f-card">' + cardOptions(s.cardId, s.accountId) + '</select></div>' +
      '<div class="field"><label>開始日</label><input type="date" id="f-start" value="' + s.startDate + '" /></div>' +
      '<div class="toggle-row" id="f-active">' +
      '<button type="button" data-active="1" class="' + (s.active ? 'active' : '') + '">有効</button>' +
      '<button type="button" data-active="0" class="' + (!s.active ? 'active' : '') + '">停止</button>' +
      '</div>' +
      '<div class="field"><label>メモ</label><textarea id="f-note">' + esc(s.note) + '</textarea></div>' +
      '<div class="sheet-actions">' +
      '<button class="btn primary" id="f-save">保存</button>' +
      (existing ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '</div>';

    openSheet(existing ? 'サブスクを編集' : 'サブスクを追加', html, function (body) {
      var active = s.active;
      body.querySelectorAll('#f-active button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          active = btn.getAttribute('data-active') === '1';
          body.querySelectorAll('#f-active button').forEach(function (b) { b.classList.toggle('active', b === btn); });
        });
      });
      body.querySelector('#f-account').addEventListener('change', function () {
        body.querySelector('#f-card').innerHTML = cardOptions(null, this.value);
      });

      body.querySelector('#f-save').addEventListener('click', function () {
        var fields = {
          name: body.querySelector('#f-name').value.trim() || '無題のサブスク',
          amount: Number(body.querySelector('#f-amount').value) || 0,
          billingDay: Math.min(31, Math.max(1, Number(body.querySelector('#f-day').value) || 1)),
          accountId: body.querySelector('#f-account').value,
          cardId: body.querySelector('#f-card').value || null,
          startDate: body.querySelector('#f-start').value || U.todayStr(),
          active: active,
          note: body.querySelector('#f-note').value.trim()
        };
        if (existing) S.updateSubscription(existing.id, fields); else S.addSubscription(fields);
        closeSheet();
        renderAll();
        toast('サブスクを保存しました');
      });
      var del = body.querySelector('#f-delete');
      if (del) {
        del.addEventListener('click', function () {
          if (!confirm('このサブスクを削除しますか？')) return;
          S.removeSubscription(existing.id);
          closeSheet();
          renderAll();
          toast('サブスクを削除しました');
        });
      }
    });
  }

  /* ---------------- 設定シート（口座・カード管理／データ） ---------------- */

  function settingsBodyHtml() {
    var accHtml = S.data.accounts.slice().sort(function (a, b) { return a.order - b.order; }).map(function (a) {
      return '<div class="mini-row"><span>' + esc(a.name) + (a.archived ? ' <span class="badge">アーカイブ</span>' : '') + '</span>' +
        '<div class="mini-actions"><button data-edit-account="' + a.id + '">編集</button></div></div>';
    }).join('') || '<div class="empty-state">口座がありません</div>';

    var cardHtml = S.data.cards.map(function (c) {
      return '<div class="mini-row"><span>' + esc(c.name) + ' ・ ' + esc(accountName(c.accountId)) + '</span>' +
        '<div class="mini-actions"><button data-edit-card="' + c.id + '">編集</button></div></div>';
    }).join('') || '<div class="empty-state">カードがありません</div>';

    return '' +
      '<section class="panel">' +
      '<div class="panel-head"><h2>口座</h2><button class="btn small" id="add-account">口座を追加</button></div>' +
      '<div class="list-mini">' + accHtml + '</div>' +
      '</section>' +
      '<section class="panel">' +
      '<div class="panel-head"><h2>クレジットカード</h2><button class="btn small" id="add-card">カードを追加</button></div>' +
      '<div class="list-mini">' + cardHtml + '</div>' +
      '</section>' +
      '<section class="panel">' +
      '<h2>クラウド同期（GAS）</h2>' +
      '<div class="field"><label>ウェブアプリURL</label><input type="text" id="sync-url" value="' + esc(S.syncCfg.url) + '" placeholder="https://script.google.com/macros/s/xxxx/exec" /></div>' +
      '<div class="field"><label>トークン</label><input type="password" id="sync-token" value="' + esc(S.syncCfg.token) + '" /></div>' +
      '<div class="field"><label>同期ID</label><input type="text" id="sync-id" value="' + esc(S.syncCfg.syncId || 'me') + '" /></div>' +
      '<p class="note">他の端末にも同じURL・トークン・同期IDを設定すると同じデータを共有できます。この設定はこの端末のブラウザ内だけに保存され、バックアップJSONやGitHubのソースには含まれません。</p>' +
      '<div class="btn-row">' +
      '<button class="btn" id="sync-save">設定を保存</button>' +
      '<button class="btn" id="sync-push">今すぐアップロード</button>' +
      '<button class="btn" id="sync-pull">今すぐダウンロード</button>' +
      '</div>' +
      '<p class="note" id="sync-status">' + esc(syncStatusText()) + '</p>' +
      '</section>' +
      '<section class="panel">' +
      '<h2>データ</h2>' +
      '<div class="btn-row">' +
      '<button class="btn" id="btn-export">バックアップ (JSON)</button>' +
      '<button class="btn" id="btn-import">読み込み</button>' +
      '<button class="btn danger full" id="btn-clear">全消去</button>' +
      '</div>' +
      '<input type="file" id="file-import" accept="application/json,.json" hidden />' +
      '<p class="note">データはこの端末のブラウザ内（localStorage）に保存されています。機種変更や履歴の削除で消えるので、ときどきバックアップしてください。<br />' +
      'ユーザーID: <code>' + esc(S.data.userId) + '</code>（バックアップファイルの識別用。クラウド同期は上の「同期ID」を使います）</p>' +
      '</section>';
  }

  function bindSettingsEvents(body) {
    body.querySelectorAll('[data-edit-account]').forEach(function (btn) {
      btn.addEventListener('click', function () { openAccountForm(S.getAccount(btn.getAttribute('data-edit-account'))); });
    });
    body.querySelectorAll('[data-edit-card]').forEach(function (btn) {
      btn.addEventListener('click', function () { openCardForm(S.getCard(btn.getAttribute('data-edit-card'))); });
    });
    body.querySelector('#add-account').addEventListener('click', function () { openAccountForm(null); });
    body.querySelector('#add-card').addEventListener('click', function () { openCardForm(null); });

    body.querySelector('#sync-save').addEventListener('click', function () {
      var wasLinked = !!(S.syncCfg.url && S.syncCfg.token);
      S.saveSyncCfg({
        url: body.querySelector('#sync-url').value.trim(),
        token: body.querySelector('#sync-token').value.trim(),
        syncId: body.querySelector('#sync-id').value.trim() || 'me'
      });
      toast('同期設定を保存しました。クラウドを確認しています…');
      activateSync(true, !wasLinked);
    });
    body.querySelector('#sync-push').addEventListener('click', function () {
      S.pushToCloud(function (err) {
        refreshSyncStatusUi();
        toast(err ? 'アップロード失敗：' + err : 'アップロードしました');
      });
    });
    body.querySelector('#sync-pull').addEventListener('click', function () {
      if (!confirm('クラウドの最新データでこの端末のデータを上書きします。よろしいですか？')) return;
      S.pullFromCloud(function (err, res) {
        if (err) { toast('ダウンロード失敗：' + err); return; }
        S.applyRemote(res.data);
        closeSheet();
        renderAll();
        toast('クラウドのデータを取り込みました');
      });
    });

    body.querySelector('#btn-export').addEventListener('click', function () {
      var blob = new Blob([S.exportJson()], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'moneymgt-backup-' + U.todayStr() + '.json';
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

  function renderSettingsAfterChange() {
    if ($('sheet-title').textContent === '設定') {
      $('sheet-body').innerHTML = settingsBodyHtml();
      bindSettingsEvents($('sheet-body'));
    }
  }

  $('btn-settings').addEventListener('click', function () {
    openSheet('設定', settingsBodyHtml(), bindSettingsEvents);
  });

  /* ---------------- 起動 ---------------- */

  S.loadSync();
  setView('overview');
  if (S.syncCfg.url && S.syncCfg.token) {
    renderAll(); // クラウド確認中も一旦ローカルの内容を表示しておく
    activateSync(false);
  } else {
    seedIfEmpty();
    renderAll();
  }
})();
