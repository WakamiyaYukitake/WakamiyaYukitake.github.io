/* MMoVie — 写真・動画の読み取り
 * ファイルそのものは保存せず、その場でExif/メタデータ（撮影日時・GPS）だけを読み取る。
 * 指紋（fp）はファイル名+サイズ+更新日時から作り、次回の再選択時に同じ写真かどうかの
 * 判定に使う（ハッシュ計算は端末に負荷がかかるため行わない簡易な方法）。
 */
(function (global) {
  'use strict';

  function fingerprint(file) {
    return file.name + '|' + file.size + '|' + file.lastModified;
  }

  function isVideo(file) {
    return /^video\//.test(file.type) || /\.(mov|mp4|m4v)$/i.test(file.name);
  }
  function isImage(file) {
    return /^image\//.test(file.type) || /\.(jpe?g|heic|heif|png|gif)$/i.test(file.name);
  }

  function extractMeta(file) {
    var fallback = { takenAt: new Date(file.lastModified), lat: null, lng: null, dateSource: 'file' };
    if (typeof exifr === 'undefined') return Promise.resolve(fallback);
    return exifr.parse(file, { gps: true })
      .then(function (out) {
        if (!out) return fallback;
        var d = out.DateTimeOriginal || out.CreateDate || out.CreationDate || out.ModifyDate || null;
        var lat = (typeof out.latitude === 'number') ? out.latitude : null;
        var lng = (typeof out.longitude === 'number') ? out.longitude : null;
        return {
          takenAt: (d instanceof Date && !isNaN(d)) ? d : fallback.takenAt,
          lat: lat,
          lng: lng,
          dateSource: (d instanceof Date && !isNaN(d)) ? 'exif' : 'file'
        };
      })
      .catch(function () { return fallback; });
  }

  global.MMovieMedia = {
    fingerprint: fingerprint,
    isVideo: isVideo,
    isImage: isImage,
    extractMeta: extractMeta
  };
})(window);
