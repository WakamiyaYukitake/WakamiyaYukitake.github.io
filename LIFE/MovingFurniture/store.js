/* MovingFurniture — データストア（localStorage）
 *
 * 考え方はシンプルに1つ：
 *   持ち物（items）が1件ずつあり、それぞれに「行き先・予定」（destination）と
 *   「対応が終わったか」（done）が付いている。
 *   「残っているもの」というのは特別な分類ではなく、単に done=false の持ち物のこと。
 *
 * data = {
 *   version: 2,
 *   userId: "u-xxxxxxxx",
 *   updatedAt: ts,
 *   items: [{
 *     id, name,
 *     destination: '' | 'tokyo' | 'home' | 'sell' | 'discard' | 'unsure' | 'buy',
 *     done: bool,        // 対応済みか（移動・売却・処分・購入などが完了）
 *     moveDate: 'YYYY-MM-DD' | '',
 *     moveTiming: string, // 日付が決まらないときの時期メモ（例：シルバーウィーク中）
 *     price: number | null,
 *     notes: string,
 *     order: number,
 *     createdAt: ts, updatedAt: ts
 *   }]
 * }
 */
(function (global) {
  'use strict';

  var DATA_KEY = 'movingfurniture.data.v2';
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
      items: []
    };
  }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      console.warn('MovingFurniture: failed to read ' + key, e);
      return fallback;
    }
  }
  function write(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('MovingFurniture: failed to write ' + key, e);
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
  function cmpDate(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : (a > b ? 1 : 0);
  }
  function fmtDateShort(s) {
    if (!s) return '';
    var d = parseDate(s);
    var out = (d.getMonth() + 1) + '/' + d.getDate();
    if (d.getFullYear() !== new Date().getFullYear()) out = d.getFullYear() + '/' + out;
    return out;
  }

  var util = { newId: newId, pad2: pad2, todayStr: todayStr, parseDate: parseDate, cmpDate: cmpDate, fmtDateShort: fmtDateShort };

  /* ---------------- ストア本体 ---------------- */

  function Store() {
    this.data = read(DATA_KEY, null) || emptyData();
    if (!Array.isArray(this.data.items)) this.data.items = [];
  }

  Store.prototype.save = function () {
    this.data.updatedAt = Date.now();
    write(DATA_KEY, this.data);
  };

  Store.prototype.getItem = function (id) {
    return this.data.items.find(function (i) { return i.id === id; }) || null;
  };

  Store.prototype.addItem = function (patch) {
    var it = Object.assign({
      id: newId('it'),
      name: '',
      destination: '',
      done: false,
      moveDate: '',
      moveTiming: '',
      price: null,
      notes: '',
      order: this.data.items.length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, patch);
    this.data.items.push(it);
    this.save();
    return it;
  };

  Store.prototype.updateItem = function (id, patch) {
    var it = this.getItem(id);
    if (!it) return null;
    Object.assign(it, patch, { updatedAt: Date.now() });
    this.save();
    return it;
  };

  Store.prototype.deleteItem = function (id) {
    this.data.items = this.data.items.filter(function (i) { return i.id !== id; });
    this.save();
  };

  Store.prototype.exportJson = function () {
    return JSON.stringify(this.data, null, 2);
  };
  Store.prototype.importJson = function (str) {
    var parsed = JSON.parse(str);
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('不正なデータです');
    parsed.version = VERSION;
    this.data = parsed;
    this.save();
  };
  Store.prototype.clearAll = function () {
    this.data = emptyData();
    this.save();
  };

  /* ---------------- 初期データ（長崎の部屋の現状） ---------------- */

  function seedIfEmpty(store) {
    if (store.data.items.length > 0) return false;

    // 「シルバーウィークに片付けたいもの」は時期メモとして持たせる（特別な分類にはしない）
    var silver = [
      '食器類', '調理器具類', '教科書', '洋服', '椅子', 'ディスプレイ', 'ケトル',
      '炊飯器', '物干し竿（外）', '鏡', 'プリンター', 'カーペット', 'ヒートカーペット'
    ];
    var other = [
      '電子レンジ', '冷蔵庫', '洗濯機', 'テレビ', 'テレビ台', 'ベッド（マットレス）', '枕',
      '掛け布団', 'ベッドフレーム', 'テーブル', '机', '扇風機', 'ドライヤー', 'WiFiルーター',
      '掃除機', 'Switchbot', 'ハンガー', '洗濯物干し（室内）', 'タオル掛け', '靴下掛け',
      'タオル類', 'Amazonエコー', 'PS4', 'アイロン', 'タオルカゴ', '洗濯物カゴ', '洗濯機棚',
      'チリトリ', 'カーテン', 'ゴミ箱', 'トイレットペーパー置き', 'トイレマット', 'トイレブラシ',
      '風呂桶', '風呂椅子', 'バスマット', '体重計', 'スポンジや雑巾、バケツ類', '延長コード2本',
      '衣装ケース3個', '傘立て'
    ];
    var destinationByName = {
      '食器類': 'tokyo', '洋服': 'tokyo', 'ディスプレイ': 'tokyo', 'ケトル': 'tokyo',
      'ドライヤー': 'tokyo', 'Switchbot': 'tokyo', 'WiFiルーター': 'tokyo',
      '椅子': 'home', '教科書': 'home',
      '洗濯機': 'sell', '冷蔵庫': 'sell',
      'トイレブラシ': 'discard',
      '電子レンジ': 'unsure', '炊飯器': 'unsure'
    };
    var notesByName = { '電子レンジ': '売るかも？' };

    silver.concat(other).forEach(function (name, idx) {
      store.data.items.push({
        id: newId('it'),
        name: name,
        destination: destinationByName[name] || '',
        done: false,
        moveDate: '',
        moveTiming: silver.indexOf(name) >= 0 ? 'シルバーウィーク中に片付けたい' : '',
        price: null,
        notes: notesByName[name] || '',
        order: idx,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    });

    store.data.items.push({
      id: newId('it'),
      name: '乾燥機付きドラム式洗濯機',
      destination: 'buy',
      done: false,
      moveDate: '',
      moveTiming: '',
      price: 200000,
      notes: '',
      order: store.data.items.length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    store.save();
    return true;
  }

  global.MovingStore = {
    load: function () { return new Store(); },
    seedIfEmpty: seedIfEmpty,
    util: util
  };
})(window);
