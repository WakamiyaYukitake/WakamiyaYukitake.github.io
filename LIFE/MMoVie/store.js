/* MMoVie — データストア（localStorage）
 *
 * 写真・動画そのものは保存しない（毎回iPhoneの写真アプリから選び直してもらう前提）。
 * 保存するのは「編集した文字・位置・範囲」などの軽いメタデータだけ：
 *   - タイトル、日付範囲
 *   - 各写真/動画ごとの: 撮影日時（編集後）、緯度経度（編集後）、地名タイトル、
 *     非表示フラグ、切り抜き範囲、モザイク範囲
 * 各写真/動画は fp（ファイル名+サイズ+更新日時から作る指紋）で識別し、
 * 次回同じ写真を選び直したときに指紋が一致すれば編集内容を復元する。
 *
 * data = {
 *   version: 1,
 *   projects: [{
 *     id, title, dateFrom, dateTo,   // 'YYYY-MM-DD'
 *     createdAt, updatedAt,
 *     items: [{
 *       id, fp, kind: 'photo'|'video',
 *       takenAt,               // ISO文字列
 *       lat, lng,              // number | null
 *       placeName,             // string
 *       placeNameAuto,         // bool（まだ自動判定のままか）
 *       hidden,                // bool
 *       crop: {x,y,w,h} | null,// 元画像に対する正規化(0..1)矩形
 *       mosaics: [{x,y,w,h}],  // 同上、複数
 *     }],
 *     excluded: ['fp', ...]    // 取り込み時に「除外する」を選んだ指紋
 *   }]
 * }
 */
(function (global) {
  'use strict';

  var DATA_KEY = 'mmovie.data.v1';
  var VERSION = 1;

  function newId(prefix) {
    var s = (prefix || 'id') + '-';
    for (var i = 0; i < 10; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  }

  function emptyData() {
    return { version: VERSION, projects: [] };
  }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      console.warn('MMoVie: failed to read ' + key, e);
      return fallback;
    }
  }
  function write(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('MMoVie: failed to write ' + key, e);
    }
  }

  function Store() {
    this.data = read(DATA_KEY, null) || emptyData();
    if (!Array.isArray(this.data.projects)) this.data.projects = [];
  }

  Store.prototype.save = function () {
    write(DATA_KEY, this.data);
  };

  Store.prototype.listProjects = function () {
    return this.data.projects.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  };

  Store.prototype.getProject = function (id) {
    return this.data.projects.find(function (p) { return p.id === id; }) || null;
  };

  Store.prototype.createProject = function (patch) {
    var p = {
      id: newId('proj'),
      title: '',
      dateFrom: '',
      dateTo: '',
      items: [],
      excluded: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    Object.assign(p, patch);
    this.data.projects.push(p);
    this.save();
    return p;
  };

  Store.prototype.updateProject = function (id, patch) {
    var p = this.getProject(id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: Date.now() });
    this.save();
    return p;
  };

  Store.prototype.deleteProject = function (id) {
    this.data.projects = this.data.projects.filter(function (p) { return p.id !== id; });
    this.save();
  };

  Store.prototype.touchProject = function (p) {
    p.updatedAt = Date.now();
    this.save();
  };

  Store.prototype.findItemByFp = function (project, fp) {
    return project.items.find(function (it) { return it.fp === fp; }) || null;
  };

  Store.prototype.upsertItem = function (project, patch) {
    var it = this.findItemByFp(project, patch.fp);
    if (it) {
      Object.assign(it, patch);
    } else {
      it = Object.assign({
        id: newId('itm'),
        hidden: false,
        placeName: '',
        placeNameAuto: true,
        crop: null,
        mosaics: []
      }, patch);
      project.items.push(it);
    }
    this.touchProject(project);
    return it;
  };

  Store.prototype.updateItem = function (project, itemId, patch) {
    var it = project.items.find(function (i) { return i.id === itemId; });
    if (!it) return null;
    Object.assign(it, patch);
    this.touchProject(project);
    return it;
  };

  Store.prototype.deleteItem = function (project, itemId) {
    project.items = project.items.filter(function (i) { return i.id !== itemId; });
    this.touchProject(project);
  };

  Store.prototype.isExcluded = function (project, fp) {
    return project.excluded.indexOf(fp) !== -1;
  };

  Store.prototype.addExcluded = function (project, fp) {
    if (!this.isExcluded(project, fp)) project.excluded.push(fp);
    this.touchProject(project);
  };

  global.MMovieStore = { load: function () { return new Store(); }, newId: newId };
})(window);
