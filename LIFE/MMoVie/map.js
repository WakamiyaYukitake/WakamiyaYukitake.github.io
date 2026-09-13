/* MMoVie — 地図表示（Leaflet + OpenStreetMap）
 * 編集画面で見せるための「本物の地図」。書き出し動画側は別途 export.js が
 * CORS制約のない簡易地図を自前描画するので、ここは画面表示専用。
 */
(function (global) {
  'use strict';

  function numberedIcon(n, active) {
    return L.divIcon({
      className: 'mm-pin' + (active ? ' active' : ''),
      html: '<div class="mm-pin-dot">' + n + '</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }

  function addTiles(map) {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }

  function createOverviewMap(containerId, items) {
    var map = L.map(containerId, { zoomControl: true, attributionControl: true });
    addTiles(map);

    var pts = items.filter(function (it) { return it.lat != null && it.lng != null; });
    var markers = pts.map(function (it, idx) {
      return L.marker([it.lat, it.lng], { icon: numberedIcon(idx + 1) }).addTo(map);
    });
    if (pts.length) {
      map.fitBounds(L.latLngBounds(pts.map(function (it) { return [it.lat, it.lng]; })), { padding: [32, 32] });
    } else {
      map.setView([35.681, 139.767], 5);
    }
    setTimeout(function () { map.invalidateSize(); }, 50);
    return { map: map, markers: markers, pts: pts };
  }

  function highlightMarker(handle, index) {
    handle.markers.forEach(function (m, i) {
      m.setIcon(numberedIcon(i + 1, i === index));
    });
  }

  function createPinPicker(containerId, lat, lng, onChange) {
    var hasPoint = lat != null && lng != null;
    var center = hasPoint ? [lat, lng] : [35.681, 139.767];
    var map = L.map(containerId, { zoomControl: true, attributionControl: false })
      .setView(center, hasPoint ? 16 : 5);
    addTiles(map);
    var marker = L.marker(center, { draggable: true }).addTo(map);
    marker.on('dragend', function () {
      var p = marker.getLatLng();
      onChange(p.lat, p.lng);
    });
    map.on('click', function (e) {
      marker.setLatLng(e.latlng);
      onChange(e.latlng.lat, e.latlng.lng);
    });
    setTimeout(function () { map.invalidateSize(); }, 50);
    return {
      destroy: function () { map.remove(); },
      invalidateSize: function () { map.invalidateSize(); }
    };
  }

  global.MMovieMap = {
    createOverviewMap: createOverviewMap,
    highlightMarker: highlightMarker,
    createPinPicker: createPinPicker
  };
})(window);
