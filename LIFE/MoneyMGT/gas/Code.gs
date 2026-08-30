/**
 * MoneyMGT — GAS 同期バックエンド（参考コード）
 *
 * このファイルは GitHub Pages 上では実行されません。
 * Google Apps Script のプロジェクトに貼り付けて「ウェブアプリとしてデプロイ」してください。
 *
 * 使い方（初回セットアップ）
 * 1. Google スプレッドシートを新規作成し、その URL から SPREADSHEET_ID を controls.gs の
 *    SPREADSHEET_ID に貼り付ける（拡張機能 > Apps Script からこのコードを開いてもOK）。
 * 2. API_TOKEN を好きな文字列に変更する（推測されにくい適当な文字列でよい）。
 *    フロント側（app.js）から呼ぶときはこのトークンをURLの ?token= に付ける。
 * 3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *    - 実行するユーザー：自分
 *    - アクセスできるユーザー：全員（token で保護しているため）
 * 4. 発行された /exec の URL を控えておく。フロント側の同期機能はこのURLへ
 *    GET（読み込み）・POST（保存）する。
 *
 * データの持ち方
 * 「Backups」シートに 1ユーザー1行。列は [userId, updatedAt, json]。
 * json 列に MoneyStore.data をまるごと JSON 文字列で保存する（バックアップと同じ形式）。
 */

var SPREADSHEET_ID = 'ここに保存先スプレッドシートのIDを入力';
var API_TOKEN = 'ここに好きなトークン文字列を入力';
var SHEET_NAME = 'Backups';

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
  var params = e.parameter || {};
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
  var params = e.parameter || {};
  if (!checkToken_(params.token)) {
    return jsonOutput_({ ok: false, error: 'invalid token' });
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
