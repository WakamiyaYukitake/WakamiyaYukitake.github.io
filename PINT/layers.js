/* PINT — 地図レイヤ
 *
 * どちらも L.GridLayer を継承し、タイル1枚ぶんの canvas に
 * 「そのタイルに重なる訪問済みセル」だけを描く。パンやズームの
 * 追従は Leaflet 側が面倒を見てくれるので、更新は redraw() だけで済む。
 *
 *  - PintColorLayer  : レベルに応じた色でセルを塗る
 *  - PintRevealLayer : 訪問済みセルの形に切り抜いた航空写真を重ねる（開拓モード）
 */
(function (global) {
  'use strict';

  // YlOrRd（レベルが上がるほど濃い赤へ）
  var LEVEL_COLORS = [
    '#ffeda0', '#fed976', '#feb24c', '#fd8d3c',
    '#fc4e2a', '#e31a1c', '#bd0026', '#800026'
  ];

  var PHOTO_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';

  function colorFor(lv) {
    return LEVEL_COLORS[Math.min(lv, LEVEL_COLORS.length) - 1];
  }

  // 訪問回数が多いセルほど写真をはっきり見せる
  function revealAlpha(lv) {
    return Math.min(0.55 + 0.09 * lv, 1);
  }

  // 写真を半透明で重ねると下の淡色地図と混ざって濁るので、
  // いったん不透明な下地で覆ってから写真を重ねる（霧が晴れる見え方になる）
  var REVEAL_BACKDROP = '#eef1f5';

  var CellLayer = L.GridLayer.extend({
    // タイルに重なる訪問済みセルを集める
    _cellsIn: function (coords) {
      var b = this._tileCoordsToBounds(coords);
      var s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
      var list = PintStore.cells(PintStore.settings.gridSize);
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.north <= s || c.south >= n || c.east <= w || c.west >= e) continue;
        out.push(c);
      }
      return out;
    },

    // セルをタイル内のピクセル矩形に変換する。
    // 隣り合うセルの間に隙間が出ないよう 0.5px ぶん膨らませる。
    _rectOf: function (cell, coords, origin) {
      var map = this._map;
      var p1 = map.project(L.latLng(cell.north, cell.west), coords.z).subtract(origin);
      var p2 = map.project(L.latLng(cell.south, cell.east), coords.z).subtract(origin);
      return {
        x: p1.x - 0.5,
        y: p1.y - 0.5,
        w: (p2.x - p1.x) + 1,
        h: (p2.y - p1.y) + 1
      };
    },

    _newCanvas: function () {
      var size = this.getTileSize();
      var canvas = L.DomUtil.create('canvas', 'pint-tile');
      canvas.width = size.x;
      canvas.height = size.y;
      return canvas;
    }
  });

  var PintColorLayer = CellLayer.extend({
    createTile: function (coords) {
      var canvas = this._newCanvas();
      var cells = this._cellsIn(coords);
      if (!cells.length) return canvas;

      var ctx = canvas.getContext('2d');
      var origin = coords.scaleBy(this.getTileSize());
      ctx.globalAlpha = 0.62;
      for (var i = 0; i < cells.length; i++) {
        var r = this._rectOf(cells[i], coords, origin);
        ctx.fillStyle = colorFor(cells[i].lv);
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      return canvas;
    }
  });

  var PintRevealLayer = CellLayer.extend({
    createTile: function (coords, done) {
      var canvas = this._newCanvas();
      var cells = this._cellsIn(coords);
      if (!cells.length) {
        // 訪問済みセルが1つも無いタイルは写真を読みに行かない
        setTimeout(function () { done(null, canvas); }, 0);
        return canvas;
      }

      var self = this;
      var origin = coords.scaleBy(this.getTileSize());
      var img = new Image();

      img.onload = function () {
        var ctx = canvas.getContext('2d');
        for (var i = 0; i < cells.length; i++) {
          var r = self._rectOf(cells[i], coords, origin);
          ctx.save();
          ctx.beginPath();
          ctx.rect(r.x, r.y, r.w, r.h);
          ctx.clip();
          ctx.fillStyle = REVEAL_BACKDROP;
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.globalAlpha = revealAlpha(cells[i].lv);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          ctx.restore();
        }
        done(null, canvas);
      };
      img.onerror = function () { done(null, canvas); };
      img.src = L.Util.template(PHOTO_URL, { z: coords.z, x: coords.x, y: coords.y });

      return canvas;
    }
  });

  global.PintLayers = {
    LEVEL_COLORS: LEVEL_COLORS,
    colorFor: colorFor,
    color: function (opts) { return new PintColorLayer(opts); },
    reveal: function (opts) { return new PintRevealLayer(opts); }
  };
})(window);
