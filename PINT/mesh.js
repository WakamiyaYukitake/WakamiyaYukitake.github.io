/* PINT — メッシュ（グリッド）ユーティリティ
 *
 * 緯度経度を等分割した独自グリッドを使う。
 * 緯度1度 ≒ 111.0km、経度1度 ≒ 91.0km（北緯35度）を基準に、
 * 各サイズが日本付近でおおむね正方形になる刻み幅を採用している。
 *
 * メッシュIDは整数の通し番号:
 *   iy = floor((lat + 90) / latStep)
 *   ix = floor((lon + 180) / lonStep)
 *   id = iy * nx + ix
 * グリッドサイズごとにID空間が別なので、ログもサイズ別に持つ。
 */
(function (global) {
  'use strict';

  var GRIDS = {
    50:  { latStep: 0.00045, lonStep: 0.00055 },
    100: { latStep: 0.0009,  lonStep: 0.0011  },
    250: { latStep: 0.00225, lonStep: 0.00275 },
    500: { latStep: 0.0045,  lonStep: 0.0055  }
  };

  var specs = {};
  Object.keys(GRIDS).forEach(function (key) {
    var g = GRIDS[key];
    specs[key] = {
      size: Number(key),
      latStep: g.latStep,
      lonStep: g.lonStep,
      nx: Math.ceil(360 / g.lonStep),
      ny: Math.ceil(180 / g.latStep)
    };
  });

  function spec(size) {
    var s = specs[String(size)];
    if (!s) throw new Error('PINT: unknown grid size ' + size);
    return s;
  }

  function idOf(lat, lon, size) {
    var s = spec(size);
    var la = Math.min(89.999999, Math.max(-90, lat));
    var lo = lon;
    // 経度は -180..180 に正規化しておく（日付変更線をまたいでも壊れないように）
    while (lo < -180) lo += 360;
    while (lo >= 180) lo -= 360;
    var iy = Math.floor((la + 90) / s.latStep);
    var ix = Math.floor((lo + 180) / s.lonStep);
    return iy * s.nx + ix;
  }

  function boundsOf(id, size) {
    var s = spec(size);
    var iy = Math.floor(id / s.nx);
    var ix = id - iy * s.nx;
    var south = iy * s.latStep - 90;
    var west = ix * s.lonStep - 180;
    return {
      south: south,
      west: west,
      north: south + s.latStep,
      east: west + s.lonStep
    };
  }

  function centerOf(id, size) {
    var b = boundsOf(id, size);
    return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
  }

  global.PintMesh = {
    sizes: Object.keys(GRIDS).map(Number).sort(function (a, b) { return a - b; }),
    spec: spec,
    idOf: idOf,
    boundsOf: boundsOf,
    centerOf: centerOf
  };
})(window);
