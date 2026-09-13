/* MMoVie — 逆ジオコーディング（OpenStreetMap Nominatim）
 * 無料・APIキー不要。利用ポリシーに配慮し、1秒に1回までのリクエストに絞り、
 * 同じ座標（小数点4桁=約10m単位）は結果をキャッシュして使い回す。
 */
(function (global) {
  'use strict';

  var cache = {};
  var lastCallAt = 0;
  var queue = Promise.resolve();

  function key(lat, lng) {
    return lat.toFixed(4) + ',' + lng.toFixed(4);
  }

  function throttle() {
    var wait = Math.max(0, 1100 - (Date.now() - lastCallAt));
    return new Promise(function (resolve) { setTimeout(resolve, wait); });
  }

  function pickName(json) {
    if (!json) return '';
    var a = json.address || {};
    return json.name || a.attraction || a.leisure || a.tourism || a.amenity ||
      a.building || a.suburb || a.neighbourhood || a.quarter ||
      a.city || a.town || a.village || a.county || '';
  }

  function reverseGeocode(lat, lng) {
    if (lat == null || lng == null) return Promise.resolve('');
    var k = key(lat, lng);
    if (cache[k] != null) return Promise.resolve(cache[k]);

    queue = queue.then(throttle).then(function () {
      lastCallAt = Date.now();
      var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + lat +
        '&lon=' + lng + '&zoom=18&addressdetails=1&accept-language=ja';
      return fetch(url)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          var name = pickName(json);
          cache[k] = name;
          return name;
        })
        .catch(function () { return ''; });
    });
    return queue;
  }

  global.MMovieGeocode = { reverseGeocode: reverseGeocode };
})(window);
