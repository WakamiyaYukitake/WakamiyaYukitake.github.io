/* MMoVie — 動画書き出し用の描画ヘルパー
 *
 * 書き出し動画に「本物の地図タイル」は使わない：OpenStreetMapのタイル画像は
 * クロスオリジンでcanvasを汚染してしまい、MediaRecorderでの録画が壊れるため。
 * 代わりに、撮影地点の緯度経度だけを使って簡易的な地図風の図（グリッド背景＋
 * 番号ピン＋経路線）を自前描画する。実際の地図（Leafletタイル）は編集画面side
 * （map.js）でのみ使う。
 */
(function (global) {
  'use strict';

  var W = 1080, H = 1920;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDateTime(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtRange(from, to) {
    if (!from && !to) return '';
    if (!to || from === to) return from;
    return from + '  〜  ' + to;
  }

  function fontStack() {
    return '-apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
  }

  /* 画像/動画フレームを「cover」でcanvas全面に描く。crop は元画像に対する正規化矩形 */
  function drawCover(ctx, media, iw, ih, crop) {
    var c = crop || { x: 0, y: 0, w: 1, h: 1 };
    var sx = c.x * iw, sy = c.y * ih, sw = c.w * iw, sh = c.h * ih;
    var scale = Math.max(W / sw, H / sh);
    var dw = sw * scale, dh = sh * scale;
    var dx = (W - dw) / 2, dy = (H - dh) / 2;
    ctx.drawImage(media, sx, sy, sw, sh, dx, dy, dw, dh);
    return { sx: sx, sy: sy, sw: sw, sh: sh, dx: dx, dy: dy, scale: scale };
  }

  /* モザイク矩形（元画像正規化座標）をxformで変換してピクセレート描画 */
  function drawMosaics(ctx, media, iw, ih, mosaics, xform) {
    (mosaics || []).forEach(function (m) {
      var rx = m.x * iw, ry = m.y * ih, rw = m.w * iw, rh = m.h * ih;
      var cx = xform.dx + (rx - xform.sx) * xform.scale;
      var cy = xform.dy + (ry - xform.sy) * xform.scale;
      var cw = rw * xform.scale, ch = rh * xform.scale;
      if (cw <= 1 || ch <= 1) return;
      var block = 16;
      var tw = Math.max(1, Math.floor(cw / block));
      var th = Math.max(1, Math.floor(ch / block));
      var tmp = document.createElement('canvas');
      tmp.width = tw; tmp.height = th;
      var tctx = tmp.getContext('2d');
      try { tctx.drawImage(media, rx, ry, rw, rh, 0, 0, tw, th); } catch (e) { return; }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, tw, th, cx, cy, cw, ch);
      ctx.imageSmoothingEnabled = true;
    });
  }

  function drawCaption(ctx, title, dateStr) {
    var padX = 56, barH = 210;
    var grad = ctx.createLinearGradient(0, H - barH, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, H - barH, W, barH);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = '700 46px ' + fontStack();
    ctx.fillText(title || '', padX, H - 100, W - padX * 2);
    ctx.font = '500 30px ' + fontStack();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(dateStr || '', padX, H - 52);
  }

  function wrapText(ctx, text, cx, cy, maxWidth, lineHeight) {
    var chars = String(text || '').split('');
    var lines = [], cur = '';
    chars.forEach(function (ch) {
      var test = cur + ch;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = ch; }
      else cur = test;
    });
    if (cur) lines.push(cur);
    var startY = cy - (lines.length - 1) * lineHeight / 2;
    lines.forEach(function (l, i) { ctx.fillText(l, cx, startY + i * lineHeight); });
  }

  function drawTitleCard(ctx, project) {
    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = '800 64px ' + fontStack();
    wrapText(ctx, project.title || 'メモリームーヴィー', W / 2, H / 2 - 30, W - 140, 78);
    ctx.font = '500 34px ' + fontStack();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(fmtRange(project.dateFrom, project.dateTo), W / 2, H / 2 + 100);
    ctx.textAlign = 'left';
  }

  function drawSummaryCard(ctx, project, stats) {
    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = '800 52px ' + fontStack();
    wrapText(ctx, project.title || '', W / 2, H / 2 - 150, W - 160, 62);
    ctx.font = '500 32px ' + fontStack();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(fmtRange(project.dateFrom, project.dateTo), W / 2, H / 2 - 50);
    ctx.font = '600 38px ' + fontStack();
    ctx.fillStyle = '#fff';
    ctx.fillText('写真 ' + stats.photos + '枚 ・ 動画 ' + stats.videos + '本', W / 2, H / 2 + 30);
    ctx.textAlign = 'left';
  }

  function computeBounds(pts) {
    var lats = pts.map(function (i) { return i.lat; });
    var lngs = pts.map(function (i) { return i.lng; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
    if (minLat === maxLat) { minLat -= 0.002; maxLat += 0.002; }
    if (minLng === maxLng) { minLng -= 0.002; maxLng += 0.002; }
    return { minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng };
  }

  function project2d(lat, lng, bounds) {
    var x = (lng - bounds.minLng) / (bounds.maxLng - bounds.minLng);
    var y = 1 - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
    var pad = 0.18;
    return {
      x: (pad + x * (1 - 2 * pad)) * W,
      y: (pad + y * (1 - 2 * pad)) * (H * 0.66) + H * 0.14
    };
  }

  /* revealCount 件目までのピンと経路を表示（アニメーション用） */
  function drawMapFrame(ctx, pts, revealCount, title) {
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(20,24,33,0.06)';
    ctx.lineWidth = 2;
    var i;
    for (i = 0; i <= 10; i++) { var gx = i * W / 10; ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (i = 0; i <= 16; i++) { var gy = i * H / 16; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    ctx.fillStyle = '#1c2130';
    ctx.font = '700 40px ' + fontStack();
    ctx.textAlign = 'left';
    ctx.fillText(title || '', 48, 90, W - 96);

    if (!pts.length) return;
    var bounds = computeBounds(pts);
    var shown = pts.slice(0, revealCount);

    ctx.strokeStyle = '#0f9d8e';
    ctx.lineWidth = 5;
    ctx.beginPath();
    shown.forEach(function (it, idx) {
      var p = project2d(it.lat, it.lng, bounds);
      if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    shown.forEach(function (it, idx) {
      var p = project2d(it.lat, it.lng, bounds);
      var active = idx === shown.length - 1;
      ctx.fillStyle = active ? '#0f9d8e' : 'rgba(15,157,142,0.55)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, active ? 24 : 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 20px ' + fontStack();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), p.x, p.y + 1);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
    });
  }

  global.MMovieExport = {
    W: W, H: H,
    drawCover: drawCover,
    drawMosaics: drawMosaics,
    drawCaption: drawCaption,
    drawTitleCard: drawTitleCard,
    drawSummaryCard: drawSummaryCard,
    drawMapFrame: drawMapFrame,
    fmtDateTime: fmtDateTime,
    fmtRange: fmtRange
  };
})(window);
