/* MoneyMGT — データストア（localStorage）
 *
 * PINTと同じ考え方：全データをこの端末のlocalStorageに持つ。
 * クラウド同期（GAS＋スプレッドシート）は次のフェーズで追加する前提で、
 * ユーザーIDと更新時刻だけは最初から持たせておく。
 *
 * data = {
 *   version: 1,
 *   userId: "u-xxxxxxxx",
 *   updatedAt: ts,
 *   accounts:      [{ id, name, purpose, baseBalance, baseDate, order, archived }],
 *   cards:         [{ id, accountId, name, note, order, archived }],
 *   transactions:  [{ id, type:'expense'|'income', date, settleDate, accountId, cardId,
 *                      amount, title, note, createdAt }],
 *   refunds:       [{ id, date, amount, source, targetTransactionId, accountId,
 *                      received, note, createdAt }],
 *   earnings:      [{ id, title, amount, earnedDate, expectedPayDate, actualPayDate,
 *                      accountId, status:'planned'|'received', note, createdAt }],
 *   subscriptions: [{ id, name, accountId, cardId, amount, billingDay, startDate,
 *                      active, note, createdAt }]
 * }
 */
(function (global) {
  'use strict';

  var DATA_KEY = 'moneymgt.data.v1';
  var VERSION = 1;

  function newId(prefix) {
    var s = (prefix || 'id') + '-';
    for (var i = 0; i < 10; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  }

  function emptyData() {
    return {
      version: VERSION,
      userId: newId('u'),
      updatedAt: 0,
      accounts: [],
      cards: [],
      transactions: [],
      refunds: [],
      earnings: [],
      subscriptions: []
    };
  }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      console.warn('MoneyMGT: failed to read ' + key, e);
      return fallback;
    }
  }

  /* ---------------- 日付ユーティリティ ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseDate(s) {
    var p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function fmtDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function addDays(s, n) {
    var d = parseDate(s);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  }

  function addMonthsClamped(s, n, dayOfMonth) {
    var d = parseDate(s);
    var y = d.getFullYear();
    var m = d.getMonth() + n;
    var target = new Date(y, m, 1);
    var lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    var day = Math.min(dayOfMonth || d.getDate(), lastDay);
    target.setDate(day);
    return fmtDate(target);
  }

  function cmpDate(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }

  /* ---------------- ストア本体 ---------------- */

  var Store = {
    rev: 0,
    data: null,

    load: function () {
      var saved = read(DATA_KEY, null);
      this.data = (saved && saved.version === VERSION) ? saved : emptyData();
      ['accounts', 'cards', 'transactions', 'refunds', 'earnings', 'subscriptions'].forEach(function (k) {
        if (!Array.isArray(this.data[k])) this.data[k] = [];
      }, this);
      if (!this.data.userId) this.data.userId = newId('u');
      this.rev++;
      return this;
    },

    save: function () {
      this.data.updatedAt = Date.now();
      try {
        localStorage.setItem(DATA_KEY, JSON.stringify(this.data));
      } catch (e) {
        console.warn('MoneyMGT: failed to save data', e);
      }
      this.rev++;
      if (typeof this.onSave === 'function') this.onSave();
    },

    /* ---------- 口座 ---------- */

    addAccount: function (fields) {
      var order = this.data.accounts.length;
      var acc = {
        id: newId('acc'),
        name: fields.name || '無題の口座',
        purpose: fields.purpose || '',
        baseBalance: Number(fields.baseBalance) || 0,
        baseDate: fields.baseDate || todayStr(),
        order: order,
        archived: false
      };
      this.data.accounts.push(acc);
      this.save();
      return acc;
    },

    updateAccount: function (id, fields) {
      var acc = this.getAccount(id);
      if (!acc) return null;
      Object.assign(acc, fields);
      this.save();
      return acc;
    },

    getAccount: function (id) {
      return this.data.accounts.filter(function (a) { return a.id === id; })[0] || null;
    },

    /* 参照が残っていれば完全削除はさせず、アーカイブだけ許す */
    removeAccount: function (id) {
      if (this.referencesAccount(id)) return false;
      this.data.accounts = this.data.accounts.filter(function (a) { return a.id !== id; });
      this.save();
      return true;
    },

    referencesAccount: function (id) {
      return this.data.cards.some(function (c) { return c.accountId === id; }) ||
        this.data.transactions.some(function (t) { return t.accountId === id; }) ||
        this.data.refunds.some(function (r) { return r.accountId === id; }) ||
        this.data.earnings.some(function (e) { return e.accountId === id; }) ||
        this.data.subscriptions.some(function (s) { return s.accountId === id; });
    },

    activeAccounts: function () {
      return this.data.accounts.filter(function (a) { return !a.archived; })
        .sort(function (a, b) { return a.order - b.order; });
    },

    /* ---------- カード ---------- */

    addCard: function (fields) {
      var card = {
        id: newId('card'),
        accountId: fields.accountId,
        name: fields.name || '無題のカード',
        note: fields.note || '',
        order: this.data.cards.length,
        archived: false
      };
      this.data.cards.push(card);
      this.save();
      return card;
    },

    updateCard: function (id, fields) {
      var card = this.getCard(id);
      if (!card) return null;
      Object.assign(card, fields);
      this.save();
      return card;
    },

    getCard: function (id) {
      return this.data.cards.filter(function (c) { return c.id === id; })[0] || null;
    },

    removeCard: function (id) {
      var used = this.data.transactions.some(function (t) { return t.cardId === id; }) ||
        this.data.subscriptions.some(function (s) { return s.cardId === id; });
      if (used) return false;
      this.data.cards = this.data.cards.filter(function (c) { return c.id !== id; });
      this.save();
      return true;
    },

    cardsOf: function (accountId) {
      return this.data.cards.filter(function (c) { return !c.archived && c.accountId === accountId; });
    },

    activeCards: function () {
      return this.data.cards.filter(function (c) { return !c.archived; });
    },

    /* ---------- 取引（支出・収入） ---------- */

    addTransaction: function (fields) {
      var t = {
        id: newId('tx'),
        type: fields.type === 'income' ? 'income' : 'expense',
        date: fields.date || todayStr(),
        settleDate: fields.settleDate || fields.date || todayStr(),
        accountId: fields.accountId,
        cardId: fields.cardId || null,
        amount: Math.abs(Number(fields.amount)) || 0,
        title: fields.title || '',
        note: fields.note || '',
        createdAt: Date.now()
      };
      this.data.transactions.push(t);
      this.save();
      return t;
    },

    updateTransaction: function (id, fields) {
      var t = this.getTransaction(id);
      if (!t) return null;
      Object.assign(t, fields);
      if (fields.amount != null) t.amount = Math.abs(Number(fields.amount)) || 0;
      this.save();
      return t;
    },

    getTransaction: function (id) {
      return this.data.transactions.filter(function (t) { return t.id === id; })[0] || null;
    },

    removeTransaction: function (id) {
      this.data.refunds = this.data.refunds.filter(function (r) { return r.targetTransactionId !== id; });
      this.data.transactions = this.data.transactions.filter(function (t) { return t.id !== id; });
      this.save();
    },

    transactionsSorted: function () {
      return this.data.transactions.slice().sort(function (a, b) {
        return cmpDate(b.date, a.date) || (b.createdAt - a.createdAt);
      });
    },

    /* ---------- 払い戻し ---------- */

    addRefund: function (fields) {
      var r = {
        id: newId('rf'),
        date: fields.date || todayStr(),
        amount: Math.abs(Number(fields.amount)) || 0,
        source: fields.source || '',
        targetTransactionId: fields.targetTransactionId || null,
        accountId: fields.accountId,
        received: !!fields.received,
        note: fields.note || '',
        createdAt: Date.now()
      };
      this.data.refunds.push(r);
      this.save();
      return r;
    },

    updateRefund: function (id, fields) {
      var r = this.getRefund(id);
      if (!r) return null;
      Object.assign(r, fields);
      if (fields.amount != null) r.amount = Math.abs(Number(fields.amount)) || 0;
      this.save();
      return r;
    },

    getRefund: function (id) {
      return this.data.refunds.filter(function (r) { return r.id === id; })[0] || null;
    },

    removeRefund: function (id) {
      this.data.refunds = this.data.refunds.filter(function (r) { return r.id !== id; });
      this.save();
    },

    refundsSorted: function () {
      return this.data.refunds.slice().sort(function (a, b) {
        return cmpDate(b.date, a.date) || (b.createdAt - a.createdAt);
      });
    },

    /* ---------- 収入予定（稼いだ／確定／入金） ---------- */

    addEarning: function (fields) {
      var e = {
        id: newId('ea'),
        title: fields.title || '',
        amount: Math.abs(Number(fields.amount)) || 0,
        earnedDate: fields.earnedDate || todayStr(),
        expectedPayDate: fields.expectedPayDate || fields.earnedDate || todayStr(),
        actualPayDate: fields.actualPayDate || null,
        accountId: fields.accountId,
        status: fields.status === 'received' ? 'received' : 'planned',
        note: fields.note || '',
        createdAt: Date.now()
      };
      this.data.earnings.push(e);
      this.save();
      return e;
    },

    updateEarning: function (id, fields) {
      var e = this.getEarning(id);
      if (!e) return null;
      Object.assign(e, fields);
      if (fields.amount != null) e.amount = Math.abs(Number(fields.amount)) || 0;
      this.save();
      return e;
    },

    getEarning: function (id) {
      return this.data.earnings.filter(function (e) { return e.id === id; })[0] || null;
    },

    removeEarning: function (id) {
      this.data.earnings = this.data.earnings.filter(function (e) { return e.id !== id; });
      this.save();
    },

    earningsSorted: function () {
      return this.data.earnings.slice().sort(function (a, b) {
        return cmpDate(b.expectedPayDate, a.expectedPayDate) || (b.createdAt - a.createdAt);
      });
    },

    /* ---------- サブスクリプション ---------- */

    addSubscription: function (fields) {
      var s = {
        id: newId('sub'),
        name: fields.name || '無題のサブスク',
        accountId: fields.accountId,
        cardId: fields.cardId || null,
        amount: Math.abs(Number(fields.amount)) || 0,
        billingDay: Math.min(31, Math.max(1, Number(fields.billingDay) || 1)),
        startDate: fields.startDate || todayStr(),
        active: fields.active !== false,
        note: fields.note || '',
        createdAt: Date.now()
      };
      this.data.subscriptions.push(s);
      this.save();
      return s;
    },

    updateSubscription: function (id, fields) {
      var s = this.getSubscription(id);
      if (!s) return null;
      Object.assign(s, fields);
      if (fields.amount != null) s.amount = Math.abs(Number(fields.amount)) || 0;
      if (fields.billingDay != null) s.billingDay = Math.min(31, Math.max(1, Number(fields.billingDay) || 1));
      this.save();
      return s;
    },

    getSubscription: function (id) {
      return this.data.subscriptions.filter(function (s) { return s.id === id; })[0] || null;
    },

    removeSubscription: function (id) {
      this.data.subscriptions = this.data.subscriptions.filter(function (s) { return s.id !== id; });
      this.save();
    },

    subscriptionsSorted: function () {
      return this.data.subscriptions.slice().sort(function (a, b) {
        return a.billingDay - b.billingDay;
      });
    },

    monthlySubscriptionTotal: function () {
      return this.data.subscriptions.reduce(function (sum, s) {
        return sum + (s.active ? s.amount : 0);
      }, 0);
    },

    /* ---------- 残高計算 ---------- */

    /* asOf 時点までに確定している入出（実績のみ）で口座残高を求める */
    accountBalance: function (accountId, asOf) {
      var acc = this.getAccount(accountId);
      if (!acc) return 0;
      var total = acc.baseBalance;
      if (cmpDate(acc.baseDate, asOf) > 0) return total;

      this.data.transactions.forEach(function (t) {
        if (t.accountId !== accountId) return;
        if (cmpDate(t.settleDate, acc.baseDate) < 0 || cmpDate(t.settleDate, asOf) > 0) return;
        total += t.type === 'income' ? t.amount : -t.amount;
      });
      this.data.refunds.forEach(function (r) {
        if (r.accountId !== accountId || !r.received) return;
        if (cmpDate(r.date, acc.baseDate) < 0 || cmpDate(r.date, asOf) > 0) return;
        total += r.amount;
      });
      this.data.earnings.forEach(function (e) {
        if (e.accountId !== accountId || e.status !== 'received' || !e.actualPayDate) return;
        if (cmpDate(e.actualPayDate, acc.baseDate) < 0 || cmpDate(e.actualPayDate, asOf) > 0) return;
        total += e.amount;
      });
      return total;
    },

    totalBalance: function (asOf) {
      var self = this;
      return this.activeAccounts().reduce(function (sum, a) {
        return sum + self.accountBalance(a.id, asOf);
      }, 0);
    },

    /* 今日以降・horizonDays 以内に起こりうる入出金イベント一覧（未来分のみ） */
    upcomingEvents: function (horizonDays) {
      var today = todayStr();
      var horizonEnd = addDays(today, horizonDays);
      var events = [];

      this.data.transactions.forEach(function (t) {
        if (cmpDate(t.settleDate, today) > 0 && cmpDate(t.settleDate, horizonEnd) <= 0) {
          events.push({
            date: t.settleDate,
            label: t.title || (t.type === 'income' ? '入金' : '支出'),
            amount: t.type === 'income' ? t.amount : -t.amount,
            accountId: t.accountId,
            kind: t.type === 'income' ? 'income' : 'expense'
          });
        }
      });

      this.data.refunds.forEach(function (r) {
        if (r.received) return;
        if (cmpDate(r.date, today) >= 0 && cmpDate(r.date, horizonEnd) <= 0) {
          events.push({
            date: r.date,
            label: '払い戻し：' + (r.source || '未設定'),
            amount: r.amount,
            accountId: r.accountId,
            kind: 'refund'
          });
        }
      });

      this.data.earnings.forEach(function (e) {
        if (e.status === 'received') return;
        var payDate = e.expectedPayDate || e.earnedDate;
        if (cmpDate(payDate, today) >= 0 && cmpDate(payDate, horizonEnd) <= 0) {
          events.push({
            date: payDate,
            label: '収入予定：' + (e.title || '無題'),
            amount: e.amount,
            accountId: e.accountId,
            kind: 'earning'
          });
        }
      });

      this.data.subscriptions.forEach(function (s) {
        if (!s.active) return;
        var cursor = cmpDate(s.startDate, today) > 0 ? s.startDate : today;
        var occ = addMonthsClamped(cursor, 0, s.billingDay);
        if (cmpDate(occ, cursor) < 0) occ = addMonthsClamped(occ, 1, s.billingDay);
        var guard = 0;
        while (cmpDate(occ, horizonEnd) <= 0 && guard < 60) {
          if (cmpDate(occ, today) > 0) {
            events.push({
              date: occ,
              label: 'サブスク：' + s.name,
              amount: -s.amount,
              accountId: s.accountId,
              kind: 'subscription'
            });
          }
          occ = addMonthsClamped(occ, 1, s.billingDay);
          guard++;
        }
      });

      events.sort(function (a, b) { return cmpDate(a.date, b.date); });
      return events;
    },

    /* horizonDays 分のシミュレーション。日ごとの累計残高の折れ線用データを返す */
    simulate: function (horizonDays) {
      var today = todayStr();
      var start = this.totalBalance(today);
      var events = this.upcomingEvents(horizonDays);
      var horizonEnd = addDays(today, horizonDays);

      var points = [{ date: today, total: start }];
      var running = start;
      events.forEach(function (ev) {
        running += ev.amount;
        points.push({ date: ev.date, total: running });
      });
      if (points[points.length - 1].date !== horizonEnd) {
        points.push({ date: horizonEnd, total: running });
      }

      var perAccountEnd = {};
      this.activeAccounts().forEach(function (a) {
        perAccountEnd[a.id] = null;
      });
      var self = this;
      this.activeAccounts().forEach(function (a) {
        var bal = self.accountBalance(a.id, today);
        events.forEach(function (ev) {
          if (ev.accountId === a.id) bal += ev.amount;
        });
        perAccountEnd[a.id] = bal;
      });

      var days = Math.max(1, daysBetween(today, horizonEnd));
      return {
        start: start,
        end: running,
        netChange: running - start,
        dailyAverage: (running - start) / days,
        points: points,
        events: events,
        perAccountEnd: perAccountEnd,
        horizonEnd: horizonEnd
      };
    },

    /* 特定の1日の予測残高（イベントをその日まで積算） */
    balanceOnDate: function (dateStr) {
      var today = todayStr();
      if (cmpDate(dateStr, today) <= 0) return this.totalBalance(dateStr);
      var horizon = daysBetween(today, dateStr);
      var sim = this.simulate(horizon);
      var total = sim.start;
      sim.events.forEach(function (ev) {
        if (cmpDate(ev.date, dateStr) <= 0) total += ev.amount;
      });
      return total;
    },

    clearAll: function () {
      var userId = this.data.userId;
      this.data = emptyData();
      this.data.userId = userId;
      this.save();
    },

    exportJson: function () {
      return JSON.stringify(this.data, null, 2);
    },

    importJson: function (text) {
      var incoming = JSON.parse(text);
      if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.accounts)) {
        throw new Error('MoneyMGTのバックアップ形式ではありません');
      }
      var userId = this.data.userId;
      this.data = Object.assign(emptyData(), incoming);
      this.data.userId = incoming.userId || userId;
      this.save();
    }
  };

  /* ---------------- クラウド同期（GAS） ----------------
   * URL・トークンはこの端末のブラウザ内だけに保存し、バックアップJSONには含めない。
   * データ本体は Store.data をまるごと1ユーザー1行として同期する「最後に保存した方が勝つ」方式。
   */
  var SYNC_KEY = 'moneymgt.sync.v1';

  Store.loadSync = function () {
    var cfg = read(SYNC_KEY, { url: '', token: '', syncId: 'me', lastSyncAt: 0, lastError: '' });
    if (!cfg.syncId) cfg.syncId = 'me';
    this.syncCfg = cfg;
    return cfg;
  };

  Store.saveSyncCfg = function (fields) {
    Object.assign(this.syncCfg, fields);
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify(this.syncCfg));
    } catch (e) {
      console.warn('MoneyMGT: failed to save sync config', e);
    }
  };

  Store.pushToCloud = function (cb) {
    var cfg = this.syncCfg;
    if (!cfg || !cfg.url || !cfg.token) { if (cb) cb('URL・トークンが未設定です'); return; }
    var self = this;
    fetch(cfg.url + '?token=' + encodeURIComponent(cfg.token), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // application/json だとCORSプリフライトでGASが弾くため
      body: JSON.stringify({ userId: cfg.syncId, data: this.data })
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) {
          self.saveSyncCfg({ lastSyncAt: res.updatedAt, lastError: '' });
          if (cb) cb(null, res);
        } else {
          self.saveSyncCfg({ lastError: res.error || '不明なエラー' });
          if (cb) cb(res.error || '不明なエラー');
        }
      })
      .catch(function (err) {
        self.saveSyncCfg({ lastError: String(err) });
        if (cb) cb(String(err));
      });
  };

  Store.pullFromCloud = function (cb) {
    var cfg = this.syncCfg;
    if (!cfg || !cfg.url || !cfg.token) { if (cb) cb('URL・トークンが未設定です'); return; }
    fetch(cfg.url + '?userId=' + encodeURIComponent(cfg.syncId) + '&token=' + encodeURIComponent(cfg.token))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) { if (cb) cb(null, res); } else { if (cb) cb(res.error || '不明なエラー'); }
      })
      .catch(function (err) { if (cb) cb(String(err)); });
  };

  /* リモートのデータでこの端末のデータを丸ごと置き換える */
  Store.applyRemote = function (remoteData) {
    var localUserId = this.data.userId;
    this.data = Object.assign(emptyData(), remoteData);
    ['accounts', 'cards', 'transactions', 'refunds', 'earnings', 'subscriptions'].forEach(function (k) {
      if (!Array.isArray(this.data[k])) this.data[k] = [];
    }, this);
    if (!this.data.userId) this.data.userId = localUserId;
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('MoneyMGT: failed to save data', e);
    }
    this.rev++;
  };

  Store.util = {
    todayStr: todayStr,
    parseDate: parseDate,
    fmtDate: fmtDate,
    addDays: addDays,
    addMonthsClamped: addMonthsClamped,
    cmpDate: cmpDate,
    daysBetween: daysBetween
  };

  global.MoneyStore = Store;
})(window);
