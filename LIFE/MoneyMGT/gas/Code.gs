/**
 * MoneyMGT — GAS 同期バックエンド（参考コード）
 *
 * このファイルは GitHub Pages 上では実行されません。
 * スプレッドシートの「拡張機能 > Apps Script」から開いたプロジェクトに、
 * このファイルの中身をまるごと貼り付けて使う（＝スプレッドシート紐づけのスクリプトとして使う想定）。
 *
 * データの持ち方
 * 「Backups」シートに 1ユーザー1行。列は [userId, updatedAt, json]。
 * シート自体は setup() を一度実行すれば自動で作られる（手動で用意する必要はない）。
 * json 列に MoneyStore.data をまるごと JSON 文字列で保存する（バックアップと同じ形式）。
 */

// スプレッドシートに紐づけたスクリプト（拡張機能 > Apps Script）として使うので空文字のままでよい。
// 別のスプレッドシートを明示的に指定したい場合だけ、その ID を入れる。
var SPREADSHEET_ID = '';
var API_TOKEN = 'ここに好きなトークン文字列を入力';
var SHEET_NAME = 'Backups';

/**
 * 初回セットアップ用。エディタ上部の関数選択で setup を選び、実行ボタンを押す。
 * ・権限確認ダイアログが出るので許可する
 * ・実行後、スプレッドシートに「Backups」シートと見出し行ができていれば成功
 */
function setup() {
  var sheet = getSheet_();
  Logger.log('OK: ' + sheet.getParent().getUrl());
}

function getSheet_() {
  var ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['userId', 'updatedAt', 'json']);
  }
  return sheet;
}

function findRow_(sheet, userId) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === userId) return i + 1; // 1-indexed row number
  }
  return -1;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  return API_TOKEN && token === API_TOKEN;
}

/**
 * GET /exec?userId=xxx&token=xxx
 * -> { ok:true, updatedAt, data } または { ok:false, error }
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (!checkToken_(params.token)) {
    return jsonOutput_({ ok: false, error: 'invalid token' });
  }
  var userId = params.userId;
  if (!userId) {
    return jsonOutput_({ ok: false, error: 'userId is required' });
  }

  var sheet = getSheet_();
  var row = findRow_(sheet, userId);
  if (row < 0) {
    return jsonOutput_({ ok: false, error: 'not found' });
  }
  var values = sheet.getRange(row, 1, 1, 3).getValues()[0];
  var data;
  try {
    data = JSON.parse(values[2]);
  } catch (err) {
    return jsonOutput_({ ok: false, error: 'stored data is corrupted' });
  }
  return jsonOutput_({ ok: true, updatedAt: values[1], data: data });
}

/**
 * POST /exec?token=xxx
 * body: { userId, data }
 * -> { ok:true, updatedAt }
 *
 * data には MoneyStore.data（store.js の exportJson() と同じ形）をそのまま渡す。
 * 既存行があれば上書き、なければ新規行を追加する（シンプルな「最後に保存した方が勝つ」方式）。
 */
function doPost(e) {
  var params = (e && e.parameter) || {};
  if (!checkToken_(params.token)) {
    return jsonOutput_({ ok: false, error: 'invalid token' });
  }
  if (!e || !e.postData) {
    return jsonOutput_({ ok: false, error: 'missing request body' });
  }

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput_({ ok: false, error: 'invalid JSON body' });
  }
  if (!body.userId || !body.data) {
    return jsonOutput_({ ok: false, error: 'userId and data are required' });
  }

  var sheet = getSheet_();
  var row = findRow_(sheet, body.userId);
  var updatedAt = Date.now();
  var json = JSON.stringify(body.data);

  if (row < 0) {
    sheet.appendRow([body.userId, updatedAt, json]);
  } else {
    sheet.getRange(row, 2, 1, 2).setValues([[updatedAt, json]]);
  }
  return jsonOutput_({ ok: true, updatedAt: updatedAt });
}
