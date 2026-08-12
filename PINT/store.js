/* PINT — データストア（localStorage）
 *
 * 保存するのは「測位1回ぶんの生ログ」だけにして、
 * メッシュ番号とレベルはそこから毎回集計して求める。
 * こうするとメッシュサイズは表示の切り替えでしかなくなり、
 * 50m と 250m を行き来しても同じ行動履歴を塗り直せる。
 *
 * data = {
 *   version: 2,
 *   userId:  "u-xxxxxxxx",   // 端末で自動発行。Phase 2 でGAS側のユーザーと紐づける
 *   userName: null,
 *   visits: [ [ts, lat, lon, acc], ... ],   // 時刻の昇順。容量節約のため配列で持つ
 *   synced: 0,               // visits の先頭から何件をGASへ送信済みか
 *   lastTickAt: ts           // 最後に測位した時刻（自動記録の間隔判定に使う）
 * }
 */
(function (global) {
  'use strict';

  var DATA_KEY = 'pint.data.v2';
  var SETTINGS_KEY = 'pint.settings.v1';
  var VERSION = 2;
  var SAME_CELL_MIN_GAP_MS = 60 * 1000;  // 同じメッシュのレベルを上げる最短間隔
  var MAX_VISITS = 200000;

  var DEFAULT_SETTINGS = {
    gridSize: 100,
    intervalMin: 60,
    autoRecord: true,
    mode: 'color',      // 'color' | 'reveal'
    follow: true,
    keepAwake: false
  };

  function newUserId() {
    var s = 'u-';
    for (var i = 0; i < 8; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  }

  function emptyData() {
    return {
      version: VERSION,
      userId: newUserId(),
      userName: null,
      visits: [],
      synced: 0,
      lastTickAt: 0
    };
  }

  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      console.warn('PINT: failed to read ' + key, e);
      return fallback;
    }
  }

  var Store = {
    rev: 0,          // データが変わるたびに増える。集計と描画のキャッシュ判定に使う
    data: null,
    settings: null,
    _agg: null,

    load: function () {
      var saved = read(DATA_KEY, null);
      this.data = (saved && saved.version === VERSION && Array.isArray(saved.visits))
        ? saved : emptyData();
      if (!this.data.userId) this.data.userId = newUserId();
      if (typeof this.data.synced !== 'number') this.data.synced = 0;

      var opts = read(SETTINGS_KEY, {});
      this.settings = Object.assign({}, DEFAULT_SETTINGS, opts);
      if (PintMesh.sizes.indexOf(this.settings.gridSize) < 0) {
        this.settings.gridSize = DEFAULT_SETTINGS.gridSize;
      }
      this.rev++;
      return this;
    },

    save: function () {
      try {
        localStorage.setItem(DATA_KEY, JSON.stringify(this.data));
      } catch (e) {
        console.warn('PINT: failed to save data', e);
      }
    },

    saveSettings: function () {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
      } catch (e) {
        console.warn('PINT: failed to save settings', e);
      }
    },

    set: function (key, value) {
      this.settings[key] = value;
      this.saveSettings();
    },

    /* ---- 集計 ----
     * visits を指定サイズのメッシュで畳み込み、{ meshId: {lv, first, last} } を作る。
     * 短時間に同じメッシュで何度も測位してもレベルは1しか上がらない。 */
    agg: function (size) {
      var key = String(size);
      if (this._agg && this._agg.key === key && this._agg.rev === this.rev) {
        return this._agg.map;
      }
      var map = {};
      var visits = this.data.visits;
      for (var i = 0; i < visits.length; i++) {
        var v = visits[i];
        var ts = v[0];
        var id = PintMesh.idOf(v[1], v[2], size);
        var cell = map[id];
        if (!cell) {
          map[id] = { lv: 1, first: ts, last: ts };
        } else if (ts - cell.last < SAME_CELL_MIN_GAP_MS) {
          cell.last = ts;
        } else {
          cell.lv += 1;
          cell.last = ts;
        }
      }
      this._agg = { key: key, rev: this.rev, map: map, list: null };
      return map;
    },

    levelOf: function (meshId, size) {
      var cell = this.agg(size)[meshId];
      return cell ? cell.lv : 0;
    },

    /* 測位1回ぶんを追加する。
     * 戻り値: { meshId, level, counted } — counted=false ならレベルは据え置き */
    addVisit: function (lat, lon, acc, ts) {
      var size = this.settings.gridSize;
      var before = this.levelOf(PintMesh.idOf(lat, lon, size), size);

      this.data.visits.push([ts, round6(lat), round6(lon), acc == null ? null : Math.round(acc)]);
      if (this.data.visits.length > MAX_VISITS) {
        var drop = this.data.visits.length - MAX_VISITS;
        this.data.visits.splice(0, drop);
        this.data.synced = Math.max(0, this.data.synced - drop);
      }
      this.data.lastTickAt = ts;
      this.rev++;
      this.save();

      var meshId = PintMesh.idOf(lat, lon, size);
      var after = this.levelOf(meshId, size);
      return { meshId: meshId, level: after, counted: after > before };
    },

    /* 描画用のセル一覧 */
    cells: function (size) {
      var map = this.agg(size);
      if (this._agg.list) return this._agg.list;
      var list = Object.keys(map).map(function (idStr) {
        var id = Number(idStr);
        var b = PintMesh.boundsOf(id, size);
        return {
          id: id,
          lv: map[idStr].lv,
          last: map[idStr].last,
          south: b.south, west: b.west, north: b.north, east: b.east
        };
      });
      this._agg.list = list;
      return list;
    },

    stats: function (size) {
      var map = this.agg(size);
      var keys = Object.keys(map);
      var total = 0, max = 0;
      keys.forEach(function (k) {
        total += map[k].lv;
        if (map[k].lv > max) max = map[k].lv;
      });
      return { cells: keys.length, levels: total, visits: this.data.visits.length, maxLevel: max };
    },

    unsyncedCount: function () {
      return Math.max(0, this.data.visits.length - this.data.synced);
    },

    /* "meshId:level" 形式のテキスト（GAS側の管理フォーマットと同じ並び） */
    toCompactText: function (size) {
      var map = this.agg(size);
      return Object.keys(map)
        .sort(function (a, b) { return Number(a) - Number(b); })
        .map(function (k) { return k + ':' + map[k].lv; })
        .join('\n');
    },

    exportJson: function () {
      return JSON.stringify(this.data);
    },

    /* バックアップを取り込む。同じ時刻・同じ座標の測位は重複とみなす */
    importJson: function (text) {
      var incoming = JSON.parse(text);
      if (!incoming || !Array.isArray(incoming.visits)) {
        throw new Error('PINTのバックアップ形式ではありません');
      }
      var seen = {};
      var merged = this.data.visits.concat(incoming.visits).filter(function (v) {
        var key = v[0] + ',' + v[1] + ',' + v[2];
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
      merged.sort(function (a, b) { return a[0] - b[0]; });
      var added = merged.length - this.data.visits.length;
      this.data.visits = merged;
      this.rev++;
      this.save();
      return added;
    },

    clearAll: function () {
      var userId = this.data.userId;
      this.data = emptyData();
      this.data.userId = userId;
      this.rev++;
      this.save();
    }
  };

  global.PintStore = Store;
})(window);
