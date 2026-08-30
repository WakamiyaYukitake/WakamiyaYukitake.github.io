/* MoneyMGT — アプリ本体 */
(function () {
  'use strict';

  var S = MoneyStore.load();
  var U = MoneyStore.util;

  var APP_VERSION = 'v1.3.0';
  var ACCOUNT_COLORS = ['#3ea6ff', '#ff8a3d', '#4cd08a', '#c792ea', '#ffd166', '#ef476f'];
  /* 外貨サブスク用の概算レート（1通貨あたり円）。ユーザーが選んだときの初期値で、後から自由に編集できる。 */
  var FX_PRESETS = { JPY: 1, USD: 150, EUR: 160, GBP: 190, KRW: 0.11, CNY: 21, AUD: 100 };
  var PAYMENT_OFFSET_LABELS = ['当月', '翌月', '翌々月', '3ヶ月後'];

  var todayD = new Date();
  var state = {
    view: 'overview',
    ledgerTab: 'tx',
    calYear: todayD.getFullYear(),
    calMonth: todayD.getMonth() + 1, // 1-12
    calSelected: U.todayStr(),
    cardTotalsMode: 'confirmed'
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
  function cardCycleLabel(c) {
    if (!c) return '';
    if (c.cardType === 'debit') return 'デビット（翌日引き落とし）';
    var closing = c.closingDay >= 31 ? '月末' : c.closingDay + '日';
    var payment = c.paymentDay >= 31 ? '月末' : c.paymentDay + '日';
    var offsetLabel = PAYMENT_OFFSET_LABELS[c.paymentMonthOffset] || (c.paymentMonthOffset + 'ヶ月後');
    return closing + '締め ・ ' + offsetLabel + payment + '払い';
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
    $('app-version').textContent = APP_VERSION;
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

    renderCalendar();
    renderCardTotals();
  }

  var KIND_COLOR = { income: '#4cd08a', expense: '#ff6b6b', refund: '#3ea6ff', earning: '#ffd166', subscription: '#ff8a3d' };
  function eventRowHtml(ev) {
    var cls = ev.amount >= 0 ? 'amt-pos' : 'amt-neg';
    var badge = ev.pending ? '<span class="badge planned">予定</span>' : '';
    return '<div class="event-row">' +
      '<span class="kind-dot" style="background:' + (KIND_COLOR[ev.kind] || '#888') + '"></span>' +
      '<div class="ev-info"><div class="ev-title">' + esc(ev.label) + badge + '</div>' +
      '<div class="ev-sub">' + fmtDateShort(ev.date) + ' ・ ' + esc(accountName(ev.accountId)) + '</div></div>' +
      '<div class="ev-amount ' + cls + '">' + fmtYenSigned(ev.amount) + '</div></div>';
  }

  /* ---------------- カレンダー ---------------- */

  function renderCalendar() {
    var y = state.calYear, m = state.calMonth;
    $('cal-title').textContent = y + '年' + m + '月';

    var events = S.monthEvents(y, m);
    var byDate = {};
    events.forEach(function (ev) {
      (byDate[ev.date] = byDate[ev.date] || []).push(ev);
    });

    var firstWeekday = new Date(y, m - 1, 1).getDay();
    var lastDay = new Date(y, m, 0).getDate();
    var today = U.todayStr();

    var cells = '';
    for (var i = 0; i < firstWeekday; i++) cells += '<div class="cal-day pad"></div>';
    for (var d = 1; d <= lastDay; d++) {
      var dateStr = y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
      var dayEvents = byDate[dateStr] || [];
      var net = dayEvents.reduce(function (sum, ev) { return sum + ev.amount; }, 0);
      var cls = 'cal-day';
      if (dateStr === today) cls += ' today';
      if (dateStr === state.calSelected) cls += ' selected';
      var amtHtml = '';
      if (net !== 0) {
        amtHtml = '<div class="cal-amt ' + (net > 0 ? 'amt-pos' : 'amt-neg') + '">' + fmtYenSigned(Math.round(net)).replace('¥', '') + '</div>';
      }
      cells += '<div class="' + cls + '" data-date="' + dateStr + '"><div class="cal-daynum">' + d + '</div>' + amtHtml + '</div>';
    }

    $('cal-grid').innerHTML = cells;
    $('cal-grid').querySelectorAll('.cal-day:not(.pad)').forEach(function (cell) {
      cell.addEventListener('click', function () {
        state.calSelected = cell.getAttribute('data-date');
        renderCalendar();
      });
    });

    renderCalDetail(byDate[state.calSelected] || []);
  }

  function renderCalDetail(dayEvents) {
    var dateStr = state.calSelected;
    var accounts = S.activeAccounts();
    var balHtml = accounts.map(function (a) {
      var bal = S.accountBalanceOnDate(a.id, dateStr);
      return '<div class="cal-bal-row">' +
        '<span class="dot" style="background:' + accountColor(a.id) + '"></span>' +
        '<span class="cal-bal-name">' + esc(a.name) + '</span>' +
        '<span class="cal-bal-amt">' + fmtYen(bal) + '</span></div>';
    }).join('');

    var income = dayEvents.filter(function (e) { return e.amount > 0; }).reduce(function (s, e) { return s + e.amount; }, 0);
    var expense = dayEvents.filter(function (e) { return e.amount < 0; }).reduce(function (s, e) { return s + e.amount; }, 0);
    var isFuture = U.cmpDate(dateStr, U.todayStr()) > 0;

    var head = '<div class="cal-detail-head">' + fmtDateShort(dateStr) + (isFuture ? ' 時点の予測残高' : ' 時点の残高') + '</div>' +
      '<div class="cal-bal-list">' + balHtml + '</div>' +
      '<div class="stat-row">' +
      '<div><div class="stat-label">この日の収入</div><div class="stat-value pos">' + fmtYen(income) + '</div></div>' +
      '<div><div class="stat-label">この日の支出</div><div class="stat-value neg">' + fmtYen(Math.abs(expense)) + '</div></div>' +
      '</div>';
    var listHead = '<div class="cal-detail-head">内訳</div>';
    var body = dayEvents.length ? dayEvents.map(eventRowHtml).join('') :
      '<div class="empty-state">この日の入出金はありません</div>';
    $('cal-detail').innerHTML = head + listHead + body;
  }

  $('cal-prev').addEventListener('click', function () { shiftCalMonth(-1); });
  $('cal-next').addEventListener('click', function () { shiftCalMonth(1); });
  function shiftCalMonth(delta) {
    var m = state.calMonth + delta;
    var y = state.calYear;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    state.calYear = y;
    state.calMonth = m;
    renderCalendar();
    renderCardTotals();
  }

  /* ---------------- カード別の月間支払い ---------------- */

  function renderCardTotals() {
    var totals = S.cardMonthlyTotals(state.calYear, state.calMonth);
    $('card-totals-mode').querySelectorAll('.segment-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === state.cardTotalsMode);
    });
    $('card-totals-list').innerHTML = totals.length ? totals.map(function (t) {
      var amt = state.cardTotalsMode === 'withPlanned' ? t.withPlanned : t.confirmed;
      return '<div class="mini-row"><span>' + esc(t.name) + '</span><span>' + fmtYen(amt) + '</span></div>';
    }).join('') : '<div class="empty-state">カードがありません</div>';
  }

  $('card-totals-mode').addEventListener('click', function (e) {
    var btn = e.target.closest('.segment-btn');
    if (!btn) return;
    state.cardTotalsMode = btn.getAttribute('data-mode');
    renderCardTotals();
  });

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
      var badges = (refunded > 0 ? '<span class="badge received">払戻 ' + fmtYen(refunded) + '</span>' : '') +
        (t.status === 'planned' ? '<span class="badge planned">予定</span>' : '');
      var cls = t.type === 'income' ? 'amt-pos' : 'amt-neg';
      var sign = t.type === 'income' ? '+' : '-';
      var sub = fmtDateShort(t.date) + ' ・ ' + esc(accountName(t.accountId)) + (t.cardId ? ' ・ ' + esc(cardName(t.cardId)) : '') +
        (t.settleDate !== t.date ? '（引落 ' + fmtDateShort(t.settleDate) + '）' : '');
      var confirmBtn = t.status === 'planned' ? '<button class="btn small" data-confirm-tx="' + t.id + '">確定にする</button>' : '';
      return '<div class="entry-row" data-tx-id="' + t.id + '">' +
        '<span class="kind-dot" style="background:' + (t.type === 'income' ? KIND_COLOR.income : KIND_COLOR.expense) + '"></span>' +
        '<div class="ev-info"><div class="ev-title">' + esc(t.title || (t.type === 'income' ? '入金' : '支出')) + badges + '</div>' +
        '<div class="ev-sub">' + sub + '</div></div>' +
        confirmBtn +
        '<div class="ev-amount ' + cls + '">' + sign + fmtYen(t.amount) + '</div></div>';
    }).join('') : '<div class="empty-state">取引がまだありません</div>';

    $('tx-list').querySelectorAll('.entry-row').forEach(function (row) {
      row.addEventListener('click', function () {
        openTransactionForm(S.getTransaction(row.getAttribute('data-tx-id')));
      });
    });
    $('tx-list').querySelectorAll('[data-confirm-tx]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        S.updateTransaction(btn.getAttribute('data-confirm-tx'), { status: 'confirmed' });
        renderAll();
        toast('確定にしました');
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
      var fx = s.currency && s.currency !== 'JPY' ?
        ' ・ ' + s.foreignAmount + ' ' + s.currency + '（概算）' : '';
      var sub = '毎月' + s.billingDay + '日にカード計上 ・ ' + esc(accountName(s.accountId)) + (s.cardId ? ' ・ ' + esc(cardName(s.cardId)) : '') + esc(fx);
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
    var c = existing || {
      name: '', accountId: (S.activeAccounts()[0] || {}).id || '', note: '',
      cardType: 'credit', closingDay: 31, paymentDay: 27, paymentMonthOffset: 1
    };
    var cardType = c.cardType || 'credit';
    var offsetOptions = PAYMENT_OFFSET_LABELS.map(function (label, i) {
      return '<option value="' + i + '"' + (i === c.paymentMonthOffset ? ' selected' : '') + '>' + label + '</option>';
    }).join('');

    function cycleFieldsHtml() {
      if (cardType === 'debit') {
        return '<p class="note">デビットカードは支払った翌日に口座から引き落とされるものとして計算します。</p>';
      }
      return '<div class="field-row">' +
        '<div class="field"><label>締め日（毎月）</label><input type="number" id="f-closing" min="1" max="31" value="' + c.closingDay + '" /></div>' +
        '<div class="field"><label>支払日（毎月）</label><input type="number" id="f-payday" min="1" max="31" value="' + c.paymentDay + '" /></div>' +
        '</div>' +
        '<div class="field"><label>支払月</label><select id="f-offset">' + offsetOptions + '</select></div>' +
        '<p class="note">日にちは31にすると「月末」の意味になります。例えば「15日締め・翌月10日払い」なら締め日15、支払月「翌月」、支払日10。この情報から、このカードで払った日→実際に口座から引き落とされる日を自動計算します。</p>';
    }

    var html =
      '<div class="field"><label>カード名</label><input type="text" id="f-name" value="' + esc(c.name) + '" placeholder="例：クレジット1" /></div>' +
      '<div class="toggle-row" id="f-cardtype">' +
      '<button type="button" data-cardtype="credit" class="' + (cardType === 'credit' ? 'active' : '') + '">クレジット</button>' +
      '<button type="button" data-cardtype="debit" class="' + (cardType === 'debit' ? 'active' : '') + '">デビット</button>' +
      '</div>' +
      '<div class="field"><label>紐づく口座</label><select id="f-account">' + accountOptions(c.accountId) + '</select></div>' +
      '<div id="cycle-wrap">' + cycleFieldsHtml() + '</div>' +
      '<div class="field"><label>メモ</label><input type="text" id="f-note" value="' + esc(c.note) + '" /></div>' +
      '<div class="sheet-actions">' +
      '<button class="btn primary" id="f-save">保存</button>' +
      (existing ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '</div>';
    openSheet(existing ? 'カードを編集' : 'カードを追加', html, function (body) {
      body.querySelectorAll('#f-cardtype button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          cardType = btn.getAttribute('data-cardtype');
          body.querySelectorAll('#f-cardtype button').forEach(function (b) { b.classList.toggle('active', b === btn); });
          body.querySelector('#cycle-wrap').innerHTML = cycleFieldsHtml();
        });
      });

      body.querySelector('#f-save').addEventListener('click', function () {
        var closingEl = body.querySelector('#f-closing');
        var paydayEl = body.querySelector('#f-payday');
        var offsetEl = body.querySelector('#f-offset');
        var fields = {
          name: body.querySelector('#f-name').value.trim() || '無題のカード',
          accountId: body.querySelector('#f-account').value,
          cardType: cardType,
          closingDay: closingEl ? Number(closingEl.value) || 31 : 31,
          paymentDay: paydayEl ? Number(paydayEl.value) || 27 : 27,
          paymentMonthOffset: offsetEl ? Number(offsetEl.value) : 1,
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
      type: 'expense', status: 'confirmed', date: U.todayStr(), settleDate: U.todayStr(),
      accountId: (S.activeAccounts()[0] || {}).id || '', cardId: null, amount: '', title: '', note: ''
    };
    var type = t.type;
    var status = t.status || 'confirmed';

    function fieldsHtml() {
      return '<div class="toggle-row" id="f-type">' +
        '<button type="button" data-type="expense" class="' + (type === 'expense' ? 'active' : '') + '">支出</button>' +
        '<button type="button" data-type="income" class="' + (type === 'income' ? 'active' : '') + '">収入</button>' +
        '</div>' +
        '<div class="toggle-row" id="f-status">' +
        '<button type="button" data-status="planned" class="' + (status === 'planned' ? 'active' : '') + '">予定</button>' +
        '<button type="button" data-status="confirmed" class="' + (status === 'confirmed' ? 'active' : '') + '">確定</button>' +
        '</div>' +
        '<div class="field"><label>内容（何に対して／何の入金か）</label><input type="text" id="f-title" value="' + esc(t.title) + '" placeholder="例：教科書代 / アルバイト代" /></div>' +
        '<div class="field"><label>金額</label><input type="number" id="f-amount" value="' + t.amount + '" /></div>' +
        '<div class="field-row">' +
        '<div class="field"><label>日付（購入日／入金日）</label><input type="date" id="f-date" value="' + t.date + '" /></div>' +
        '<div class="field"><label>口座反映日（引き落とし日）</label><input type="date" id="f-settle" value="' + t.settleDate + '" /></div>' +
        '</div>' +
        '<div class="field"><label>口座</label><select id="f-account">' + accountOptions(t.accountId) + '</select></div>' +
        (type === 'expense' ? '<div class="field"><label>クレジットカード（任意）</label><select id="f-card">' + cardOptions(t.cardId) + '</select></div>' : '') +
        (type === 'expense' && t.cardId ? '<p class="note" id="f-settle-note">カードの締め日・支払日から引き落とし日を自動計算しています。手動で変更もできます。</p>' : '') +
        '<div class="field"><label>メモ</label><textarea id="f-note">' + esc(t.note) + '</textarea></div>';
    }

    var html = '<div id="fields-wrap">' + fieldsHtml() + '</div>' +
      '<div class="sheet-actions">' +
      '<button class="btn primary" id="f-save">保存</button>' +
      (existing ? '<button class="btn danger" id="f-delete">削除</button>' : '') +
      '</div>';

    openSheet(existing ? '取引を編集' : '取引を追加', html, function (body) {
      function syncFromDom() {
        t.title = body.querySelector('#f-title').value;
        t.amount = body.querySelector('#f-amount').value;
        t.date = body.querySelector('#f-date').value;
        t.settleDate = body.querySelector('#f-settle').value;
        t.accountId = body.querySelector('#f-account').value;
        var cardEl = body.querySelector('#f-card');
        t.cardId = cardEl ? cardEl.value || null : null;
      }
      function rebuild() {
        syncFromDom();
        body.querySelector('#fields-wrap').innerHTML = fieldsHtml();
        bindAll();
      }
      function autoSettle() {
        var cardEl = body.querySelector('#f-card');
        var cardId = cardEl ? cardEl.value : null;
        var dateVal = body.querySelector('#f-date').value || U.todayStr();
        if (cardId) {
          body.querySelector('#f-settle').value = S.settleDateForCard(dateVal, cardId);
        } else {
          body.querySelector('#f-settle').value = dateVal;
        }
      }
      function bindAll() {
        body.querySelectorAll('#f-type button').forEach(function (btn) {
          btn.addEventListener('click', function () { type = btn.getAttribute('data-type'); rebuild(); });
        });
        body.querySelectorAll('#f-status button').forEach(function (btn) {
          btn.addEventListener('click', function () {
            status = btn.getAttribute('data-status');
            body.querySelectorAll('#f-status button').forEach(function (b) { b.classList.toggle('active', b === btn); });
          });
        });
        var cardEl = body.querySelector('#f-card');
        if (cardEl) cardEl.addEventListener('change', function () { autoSettle(); rebuild(); });
        var dateEl = body.querySelector('#f-date');
        if (dateEl) dateEl.addEventListener('change', autoSettle);
      }
      bindAll();

      body.querySelector('#f-save').addEventListener('click', function () {
        var date = body.querySelector('#f-date').value || U.todayStr();
        var settle = body.querySelector('#f-settle').value || date;
        var fields = {
          type: type,
          status: status,
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

  var CURRENCIES = ['JPY', 'USD', 'EUR', 'GBP', 'KRW', 'CNY', 'AUD'];

  function openSubscriptionForm(existing) {
    var s = existing || {
      name: '', amount: '', currency: 'JPY', foreignAmount: '', fxRate: 1, billingDay: 1, startDate: U.todayStr(),
      accountId: (S.activeAccounts()[0] || {}).id || '', cardId: null, active: true, note: ''
    };
    var currency = s.currency || 'JPY';

    function amountFieldsHtml() {
      if (currency === 'JPY') {
        return '<div class="field"><label>金額（毎月）</label><input type="number" id="f-amount" value="' + (s.amount || '') + '" /></div>';
      }
      var fx = s.currency === currency && s.fxRate ? s.fxRate : (FX_PRESETS[currency] || 1);
      var fAmt = s.currency === currency && s.foreignAmount != null ? s.foreignAmount : '';
      return '<div class="field-row">' +
        '<div class="field"><label>金額（' + currency + '）</label><input type="number" step="0.01" id="f-famount" value="' + fAmt + '" /></div>' +
        '<div class="field"><label>概算レート（1' + currency + '=◯円）</label><input type="number" step="0.01" id="f-fxrate" value="' + fx + '" /></div>' +
        '</div>' +
        '<p class="note" id="f-fx-preview">' + fxPreviewText(fAmt, fx) + '</p>';
    }
    function fxPreviewText(fAmt, fx) {
      return '≈ ' + fmtYen((Number(fAmt) || 0) * (Number(fx) || 0)) + '（レートは概算です。実際の請求額に合わせて調整してください）';
    }
    var currencyOptions = CURRENCIES.map(function (c) {
      return '<option value="' + c + '"' + (c === currency ? ' selected' : '') + '>' + c + '</option>';
    }).join('');

    var html =
      '<div class="field"><label>サブスク名</label><input type="text" id="f-name" value="' + esc(s.name) + '" placeholder="例：Netflix" /></div>' +
      '<div class="field"><label>通貨</label><select id="f-currency">' + currencyOptions + '</select></div>' +
      '<div id="amount-wrap">' + amountFieldsHtml() + '</div>' +
      '<div class="field"><label>請求日（毎月◯日・カードに計上される日）</label><input type="number" id="f-day" min="1" max="31" value="' + s.billingDay + '" /></div>' +
      '<div class="field"><label>口座</label><select id="f-account">' + accountOptions(s.accountId) + '</select></div>' +
      '<div class="field"><label>クレジットカード（任意）</label><select id="f-card">' + cardOptions(s.cardId, s.accountId) + '</select></div>' +
      '<p class="note">カードを選ぶと、そのカードの締め日・支払日から実際に口座から引き落とされる日を自動計算します。</p>' +
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

      function bindAmountInputs() {
        var famountEl = body.querySelector('#f-famount');
        var fxrateEl = body.querySelector('#f-fxrate');
        if (famountEl && fxrateEl) {
          var updatePreview = function () {
            var preview = body.querySelector('#f-fx-preview');
            if (preview) preview.textContent = fxPreviewText(famountEl.value, fxrateEl.value);
          };
          famountEl.addEventListener('input', updatePreview);
          fxrateEl.addEventListener('input', updatePreview);
        }
      }
      bindAmountInputs();
      body.querySelector('#f-currency').addEventListener('change', function () {
        currency = this.value;
        body.querySelector('#amount-wrap').innerHTML = amountFieldsHtml();
        bindAmountInputs();
      });

      body.querySelector('#f-save').addEventListener('click', function () {
        var amount, foreignAmount, fxRate;
        if (currency === 'JPY') {
          amount = Number(body.querySelector('#f-amount').value) || 0;
          foreignAmount = amount;
          fxRate = 1;
        } else {
          foreignAmount = Number(body.querySelector('#f-famount').value) || 0;
          fxRate = Number(body.querySelector('#f-fxrate').value) || 0;
          amount = Math.round(foreignAmount * fxRate);
        }
        var fields = {
          name: body.querySelector('#f-name').value.trim() || '無題のサブスク',
          currency: currency,
          amount: amount,
          foreignAmount: foreignAmount,
          fxRate: fxRate,
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
      return '<div class="mini-row"><span>' + esc(c.name) + ' ・ ' + esc(accountName(c.accountId)) +
        '<br><span class="cal-detail-head">' + esc(cardCycleLabel(c)) + '</span></span>' +
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
