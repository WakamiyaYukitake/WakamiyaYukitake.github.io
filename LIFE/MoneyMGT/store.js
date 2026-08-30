/* MoneyMGT — データストア（localStorage）
 *
 * PINTと同じ考え方：全データをこの端末のlocalStorageに持つ。
 * クラウド同期（GAS＋スプレッドシート）は次のフェーズで追加する前提で、
 * ユーザーIDと更新時刻だけは最初から持たせておく。
 *
 * data = {
 *   version: 2,
 *   userId: "u-xxxxxxxx",
 *   updatedAt: ts,
 *   accounts:      [{ id, name, purpose, baseBalance, baseDate, order, archived }],
 *   cards:         [{ id, accountId, name, note, order, archived, cardType:'credit'|'debit',
 *                      closingDay, paymentDay, paymentMonthOffset }],
 *   jobs:          [{ id, name, accountId, normalRate, holidayRate, defaultHours,
 *                      closingDay, paymentDay, paymentMonthOffset, archived, note, createdAt }],
 *   transactions:  [{ id, type:'expense'|'income'|'refund', status:'planned'|'confirmed',
 *                      date, settleDate, accountId, amount, title, note, createdAt,
 *                      cardId,                          // expense のみ（支払い方法）
 *                      refundSource, targetTransactionId, // refund のみ
 *                      jobId, shiftHours, shiftHolidayRate // income のうちバイトのシフト由来のみ
 *                    }],
 *   subscriptions: [{ id, name, accountId, cardId, amount, billingDay, startDate,
 *                      active, note, createdAt, currency, foreignAmount, fxRate }]
 * }
 *
 * 入出金は「支出／収入／払い戻し」の3種類をすべて transactions の1つの配列にまとめている
 * （以前は refunds・earnings を別配列にしていたが、3種類とも同じように予定→確定の流れを
 * 持つべきなので、type だけが違う同じレコードとして扱う方が素直）。
 *
 * カード引き落とし日の考え方（closingDay/paymentDay/paymentMonthOffset）：
 * 「毎月closingDay日締め、paymentMonthOffsetヶ月後のpaymentDay日払い」というよくある
 * クレジットカードのルールをそのまま持たせる。closingDay=31 は「月末締め」の意味で、
 * その月の実際の日数にクランプする（addMonthsClamped と同じやり方）。
 * このカード情報から、取引の実際の口座引き落とし日（settleDate）を自動計算する。
 * cardType==='debit'（デビットカード）はこの締め日ルールを使わず、常に支払った翌日に
 * 引き落とされるものとして扱う。
 * バイト（jobs）の給料日も同じ形（closingDay/paymentDay/paymentMonthOffset）で持たせ、
 * 同じ計算式をそのまま使い回している。
 */
(function (global) {
  'use strict';

  var DATA_KEY = 'moneymgt.data.v1';
  var VERSION = 2;

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
      jobs: [],
      transactions: [],
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

  function daysInMonth(dateStr) {
    var d = parseDate(dateStr);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }

  /* カード（またはバイトの給料日ルール）の締め日・支払日から、purchaseDate の
   * 実際の口座引き落とし／振込日を計算する。card が無ければ即日（purchaseDate をそのまま返す）。
   * デビットカードは締め日・支払日を持たず、常に翌日引き落としとして扱う。 */
  function computeCardSettleDate(purchaseDate, card) {
    if (!card) return purchaseDate;
    if (card.cardType === 'debit') return addDays(purchaseDate, 1);
    var closingDay = card.closingDay || 31;
    var effectiveClosing = Math.min(closingDay, daysInMonth(purchaseDate));
    var day = parseDate(purchaseDate).getDate();
    var cycleBase = day > effectiveClosing ? addMonthsClamped(purchaseDate, 1, 1) : purchaseDate;
    var offset = card.paymentMonthOffset != null ? card.paymentMonthOffset : 1;
    return addMonthsClamped(cycleBase, offset, card.paymentDay || 27);
  }

  /* サブスク sub の請求日のうち、実際の引き落とし日（card 経由）が [start, end] に入るものを
   * 全て返す（同じ月内で重複しないよう settle 日付でユニーク化）。monthEvents / cardMonthlyTotals で共用。 */
  function subscriptionSettleDatesInRange(sub, card, start, end) {
    var results = [];
    var seen = {};
    /* settle は charge と同じ月かそれより後にしかならないので、対象範囲より
     * 最大4ヶ月前までの請求日候補を洗い出す（締め日ロールオーバー+1ヶ月、支払月オフセット最大+3ヶ月の目安）。 */
    for (var back = 0; back <= 4; back++) {
      var chargeMonth = addMonthsClamped(start, -back, 1);
      var charge = addMonthsClamped(chargeMonth, 0, sub.billingDay);
      if (cmpDate(charge, sub.startDate) < 0) continue;
      var settle = computeCardSettleDate(charge, card);
      if (cmpDate(settle, start) >= 0 && cmpDate(settle, end) <= 0 && !seen[settle]) {
        seen[settle] = true;
        results.push(settle);
      }
    }
    return results;
  }

  function defaultTitleFor(type) {
    return type === 'income' ? '収入' : (type === 'refund' ? '払い戻し' : '支出');
  }

  /* ---------------- 旧データ形式からの移行 ----------------
   * v1: refunds・earnings が別配列だった形。それぞれ transactions（type:'refund'/'income'）に
   * 変換して1本化する。データを絶対に失わないよう、変換できるものはすべて変換する。 */
  function migrateToCurrent(raw) {
    var d = Object.assign(emptyData(), raw);
    d.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    d.transactions = (Array.isArray(raw.transactions) ? raw.transactions : []).map(function (t) {
      var copy = Object.assign({}, t);
      if (!copy.status) copy.status = 'confirmed';
      if (!copy.type) copy.type = 'expense';
      return copy;
    });

    (Array.isArray(raw.refunds) ? raw.refunds : []).forEach(function (r) {
      d.transactions.push({
        id: r.id || newId('rf'),
        type: 'refund',
        status: r.received ? 'confirmed' : 'planned',
        date: r.date || todayStr(),
        settleDate: r.date || todayStr(),
        accountId: r.accountId,
        cardId: null,
        amount: r.amount || 0,
        title: r.source || '払い戻し',
        note: r.note || '',
        refundSource: r.source || '',
        targetTransactionId: r.targetTransactionId || null,
        createdAt: r.createdAt || Date.now()
      });
    });

    (Array.isArray(raw.earnings) ? raw.earnings : []).forEach(function (e) {
      d.transactions.push({
        id: e.id || newId('ea'),
        type: 'income',
        status: e.status === 'received' ? 'confirmed' : 'planned',
        date: e.earnedDate || todayStr(),
        settleDate: (e.status === 'received' && e.actualPayDate) ? e.actualPayDate : (e.expectedPayDate || e.earnedDate || todayStr()),
        accountId: e.accountId,
        cardId: null,
        amount: e.amount || 0,
        title: e.title || '収入',
        note: e.note || '',
        createdAt: e.createdAt || Date.now()
      });
    });

    delete d.refunds;
    delete d.earnings;
    d.version = VERSION;
    return d;
  }

  function normalizeData(raw) {
    var d = (raw && typeof raw === 'object') ? (raw.version === VERSION ? raw : migrateToCurrent(raw)) : emptyData();
    ['accounts', 'cards', 'jobs', 'transactions', 'subscriptions'].forEach(function (k) {
      if (!Array.isArray(d[k])) d[k] = [];
    });
    if (!d.userId) d.userId = newId('u');
    d.version = VERSION;
    return d;
  }

  /* ---------------- ストア本体 ---------------- */

  var Store = {
    rev: 0,
    data: null,

    load: function () {
      var saved = read(DATA_KEY, null);
      var needsMigration = !!(saved && saved.version !== VERSION);
      this.data = normalizeData(saved);
      this.rev++;
      if (needsMigration) this.save(); // 移行後の形をすぐ保存しておく（onSave はまだ未設定なのでクラウド送信は起きない）
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
        this.data.jobs.some(function (j) { return j.accountId === id; }) ||
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
        archived: false,
        cardType: fields.cardType === 'debit' ? 'debit' : 'credit',
        closingDay: Math.min(31, Math.max(1, Number(fields.closingDay) || 31)),
        paymentDay: Math.min(31, Math.max(1, Number(fields.paymentDay) || 27)),
        paymentMonthOffset: fields.paymentMonthOffset != null ? Number(fields.paymentMonthOffset) : 1
      };
      this.data.cards.push(card);
      this.save();
      return card;
    },

    updateCard: function (id, fields) {
      var card = this.getCard(id);
      if (!card) return null;
      Object.assign(card, fields);
      if (fields.cardType != null) card.cardType = fields.cardType === 'debit' ? 'debit' : 'credit';
      if (fields.closingDay != null) card.closingDay = Math.min(31, Math.max(1, Number(fields.closingDay) || 31));
      if (fields.paymentDay != null) card.paymentDay = Math.min(31, Math.max(1, Number(fields.paymentDay) || 27));
      if (fields.paymentMonthOffset != null) card.paymentMonthOffset = Number(fields.paymentMonthOffset);
      this.save();
      return card;
    },

    /* card の締め日・支払日ルールから、購入日 purchaseDate の実際の引き落とし日を計算する */
    settleDateForCard: function (purchaseDate, cardId) {
      return computeCardSettleDate(purchaseDate, cardId ? this.getCard(cardId) : null);
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

    /* ---------- バイト・収入プロファイル ---------- */

    addJob: function (fields) {
      var j = {
        id: newId('job'),
        name: fields.name || '無題のバイト',
        accountId: fields.accountId,
        normalRate: Math.abs(Number(fields.normalRate)) || 0,
        holidayRate: Math.abs(Number(fields.holidayRate)) || 0,
        defaultHours: Number(fields.defaultHours) || 4.5,
        closingDay: Math.min(31, Math.max(1, Number(fields.closingDay) || 31)),
        paymentDay: Math.min(31, Math.max(1, Number(fields.paymentDay) || 27)),
        paymentMonthOffset: fields.paymentMonthOffset != null ? Number(fields.paymentMonthOffset) : 1,
        archived: false,
        note: fields.note || '',
        createdAt: Date.now()
      };
      this.data.jobs.push(j);
      this.save();
      return j;
    },

    updateJob: function (id, fields) {
      var j = this.getJob(id);
      if (!j) return null;
      Object.assign(j, fields);
      if (fields.normalRate != null) j.normalRate = Math.abs(Number(fields.normalRate)) || 0;
      if (fields.holidayRate != null) j.holidayRate = Math.abs(Number(fields.holidayRate)) || 0;
      if (fields.defaultHours != null) j.defaultHours = Number(fields.defaultHours) || 0;
      if (fields.closingDay != null) j.closingDay = Math.min(31, Math.max(1, Number(fields.closingDay) || 31));
      if (fields.paymentDay != null) j.paymentDay = Math.min(31, Math.max(1, Number(fields.paymentDay) || 27));
      if (fields.paymentMonthOffset != null) j.paymentMonthOffset = Number(fields.paymentMonthOffset);
      this.save();
      return j;
    },

    getJob: function (id) {
      return this.data.jobs.filter(function (j) { return j.id === id; })[0] || null;
    },

    removeJob: function (id) {
      var used = this.data.transactions.some(function (t) { return t.jobId === id; });
      if (used) return false;
      this.data.jobs = this.data.jobs.filter(function (j) { return j.id !== id; });
      this.save();
      return true;
    },

    activeJobs: function () {
      return this.data.jobs.filter(function (j) { return !j.archived; });
    },

    /* job の締め日・給料日ルールから、勤務日 workDate の実際の振込予定日を計算する
     * （card 用の computeCardSettleDate をそのまま流用できる形に job を作ってあるため）。 */
    settleDateForJob: function (workDate, jobId) {
      return computeCardSettleDate(workDate, this.getJob(jobId));
    },

    /* シフト（勤務）を記録し、給料日ルールから振込予定日を自動計算した「予定」の
     * 収入取引として登録する。戻り値はできた transaction。 */
    addShift: function (fields) {
      var job = this.getJob(fields.jobId);
      if (!job) return null;
      var hours = Number(fields.hours) || 0;
      var holiday = !!fields.holidayRate;
      var rate = holiday ? job.holidayRate : job.normalRate;
      var date = fields.date || todayStr();
      var amount = Math.round(hours * rate);
      var settle = computeCardSettleDate(date, job);
      return this.addTransaction({
        type: 'income',
        status: 'planned',
        date: date,
        settleDate: settle,
        accountId: job.accountId,
        amount: amount,
        title: job.name,
        note: fields.note || '',
        jobId: job.id,
        shiftHours: hours,
        shiftHolidayRate: holiday
      });
    },

    /* ---------- 取引（支出・収入・払い戻し） ---------- */

    addTransaction: function (fields) {
      var validTypes = ['expense', 'income', 'refund'];
      var type = validTypes.indexOf(fields.type) >= 0 ? fields.type : 'expense';
      var t = {
        id: newId('tx'),
        type: type,
        status: fields.status === 'planned' ? 'planned' : 'confirmed',
        date: fields.date || todayStr(),
        settleDate: fields.settleDate || fields.date || todayStr(),
        accountId: fields.accountId,
        cardId: fields.cardId || null,
        amount: Math.abs(Number(fields.amount)) || 0,
        title: fields.title || '',
        note: fields.note || '',
        refundSource: fields.refundSource || '',
        targetTransactionId: fields.targetTransactionId || null,
        jobId: fields.jobId || null,
        shiftHours: fields.shiftHours != null ? Number(fields.shiftHours) : null,
        shiftHolidayRate: !!fields.shiftHolidayRate,
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
      this.data.transactions.forEach(function (t) {
        if (t.targetTransactionId === id) t.targetTransactionId = null;
      });
      this.data.transactions = this.data.transactions.filter(function (t) { return t.id !== id; });
      this.save();
    },

    /* type を渡すと 'expense'|'income'|'refund' で絞り込む。省略時は全件 */
    transactionsSorted: function (type) {
      var list = type ? this.data.transactions.filter(function (t) { return t.type === type; }) : this.data.transactions.slice();
      return list.sort(function (a, b) {
        return cmpDate(b.date, a.date) || (b.createdAt - a.createdAt);
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
        currency: fields.currency || 'JPY',
        foreignAmount: fields.foreignAmount != null ? Math.abs(Number(fields.foreignAmount)) || 0 : null,
        fxRate: fields.fxRate != null ? Number(fields.fxRate) || 1 : 1,
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
      if (fields.foreignAmount != null) s.foreignAmount = Math.abs(Number(fields.foreignAmount)) || 0;
      if (fields.fxRate != null) s.fxRate = Number(fields.fxRate) || 1;
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
        if (t.accountId !== accountId || t.status === 'planned') return;
        if (cmpDate(t.settleDate, acc.baseDate) < 0 || cmpDate(t.settleDate, asOf) > 0) return;
        total += t.type === 'expense' ? -t.amount : t.amount;
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
      var cards = this.data.cards;
      function findCard(id) { return cards.filter(function (c) { return c.id === id; })[0] || null; }

      this.data.transactions.forEach(function (t) {
        if (cmpDate(t.settleDate, today) > 0 && cmpDate(t.settleDate, horizonEnd) <= 0) {
          events.push({
            date: t.settleDate,
            label: t.title || defaultTitleFor(t.type),
            amount: t.type === 'expense' ? -t.amount : t.amount,
            accountId: t.accountId,
            kind: t.type,
            pending: t.status === 'planned'
          });
        }
      });

      this.data.subscriptions.forEach(function (s) {
        if (!s.active) return;
        var cursor = cmpDate(s.startDate, today) > 0 ? s.startDate : today;
        var charge = addMonthsClamped(cursor, 0, s.billingDay);
        if (cmpDate(charge, cursor) < 0) charge = addMonthsClamped(charge, 1, s.billingDay);
        var guard = 0;
        while (guard < 60) {
          var settle = computeCardSettleDate(charge, s.cardId ? findCard(s.cardId) : null);
          if (cmpDate(settle, horizonEnd) > 0) break;
          if (cmpDate(settle, today) > 0) {
            events.push({
              date: settle,
              label: 'サブスク：' + s.name,
              amount: -s.amount,
              accountId: s.accountId,
              kind: 'subscription'
            });
          }
          charge = addMonthsClamped(charge, 1, s.billingDay);
          guard++;
        }
      });

      events.sort(function (a, b) { return cmpDate(a.date, b.date); });
      return events;
    },

    /* 指定した月（year, month:1-12）に発生する入出金イベント一覧。
     * upcomingEvents と違って過去日も含む（カレンダー表示用）。 */
    monthEvents: function (year, month) {
      var mm = pad2(month);
      var start = year + '-' + mm + '-01';
      var lastDay = new Date(year, month, 0).getDate();
      var end = year + '-' + mm + '-' + pad2(lastDay);
      var events = [];
      var cards = this.data.cards;
      function findCard(id) { return cards.filter(function (c) { return c.id === id; })[0] || null; }

      this.data.transactions.forEach(function (t) {
        if (cmpDate(t.settleDate, start) >= 0 && cmpDate(t.settleDate, end) <= 0) {
          events.push({
            date: t.settleDate,
            label: t.title || defaultTitleFor(t.type),
            amount: t.type === 'expense' ? -t.amount : t.amount,
            accountId: t.accountId,
            kind: t.type,
            pending: t.status === 'planned'
          });
        }
      });

      /* サブスクは「カードに請求される日」と「実際に口座から引き落とされる日」がズレるので、
       * この月に引き落としが来るものを探すため、前後数ヶ月ぶんの請求日候補を計算し直す。 */
      this.data.subscriptions.forEach(function (s) {
        if (!s.active) return;
        var card = s.cardId ? findCard(s.cardId) : null;
        subscriptionSettleDatesInRange(s, card, start, end).forEach(function (settle) {
          events.push({
            date: settle,
            label: 'サブスク：' + s.name,
            amount: -s.amount,
            accountId: s.accountId,
            kind: 'subscription'
          });
        });
      });

      events.sort(function (a, b) { return cmpDate(a.date, b.date); });
      return events;
    },

    /* year年month月に、各カードから実際に引き落とされる（決済される）合計金額。
     * confirmed: 確定した取引＋有効なサブスクのみ。withPlanned: それに「予定」ステータスの
     * 取引も加えた金額。 */
    cardMonthlyTotals: function (year, month) {
      var mm = pad2(month);
      var start = year + '-' + mm + '-01';
      var lastDay = new Date(year, month, 0).getDate();
      var end = year + '-' + mm + '-' + pad2(lastDay);
      var cards = this.data.cards;
      var totals = {};
      cards.forEach(function (c) { totals[c.id] = { confirmed: 0, planned: 0 }; });

      this.data.transactions.forEach(function (t) {
        if (!t.cardId || !totals[t.cardId]) return;
        if (cmpDate(t.settleDate, start) < 0 || cmpDate(t.settleDate, end) > 0) return;
        var amt = t.type === 'expense' ? t.amount : -t.amount;
        if (t.status === 'planned') totals[t.cardId].planned += amt;
        else totals[t.cardId].confirmed += amt;
      });

      this.data.subscriptions.forEach(function (s) {
        if (!s.active || !s.cardId || !totals[s.cardId]) return;
        var card = cards.filter(function (c) { return c.id === s.cardId; })[0] || null;
        var occurrences = subscriptionSettleDatesInRange(s, card, start, end);
        totals[s.cardId].confirmed += occurrences.length * s.amount;
      });

      return cards.filter(function (c) { return !c.archived; }).map(function (c) {
        var t = totals[c.id];
        return { cardId: c.id, name: c.name, confirmed: t.confirmed, withPlanned: t.confirmed + t.planned };
      });
    },

    /* 特定の1日・特定の口座の残高。
     * includePlanned=true 「実質残高」：予定ステータスの入出金も、その日までに来ていれば加味する。
     * includePlanned=false「実際の口座残高」：確定した入出金だけで計算する。
     * 過去日はどちらの意味でも同じ（accountBalance が既に確定分だけを積算しているため）。 */
    accountBalanceOnDate: function (accountId, dateStr, includePlanned) {
      var today = todayStr();
      if (cmpDate(dateStr, today) <= 0) return this.accountBalance(accountId, dateStr);
      var total = this.accountBalance(accountId, today);
      var events = this.upcomingEvents(daysBetween(today, dateStr));
      events.forEach(function (ev) {
        if (ev.accountId !== accountId || cmpDate(ev.date, dateStr) > 0) return;
        if (!includePlanned && ev.pending) return;
        total += ev.amount;
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
      this.data = normalizeData(incoming);
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
    this.data = normalizeData(remoteData);
    if (!remoteData || !remoteData.userId) this.data.userId = localUserId;
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
