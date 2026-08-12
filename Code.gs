/**
 * 팀 FCST 집계 - Google Apps Script 백엔드
 *
 * 동시 입력 안전성 설계
 *  1) 모든 쓰기는 LockService(스크립트 락) 안에서 read-modify-write → 요청이 겹쳐도 직렬 처리
 *  2) sheet.clear() 전체 덮어쓰기 금지 → 담당자(행) 단위 upsert 만 수행
 *  3) 레코드마다 rev(개정번호) 보관 → 낙관적 잠금. 내가 읽은 rev 와 서버 rev 가 다르면
 *     덮어쓰지 않고 CONFLICT 를 돌려줌(클라이언트가 사용자에게 선택을 물음)
 *  4) 쓰기 결과로 항상 전체 최신 상태를 함께 반환 → 클라이언트 화면 즉시 정합
 *  5) version 카운터 제공 → 클라이언트는 ping 으로 변경 여부만 싸게 확인
 *
 * 설치
 *  - 구글 시트를 하나 만들고 [확장 프로그램] > [Apps Script] 로 열어 이 코드를 붙여넣기
 *  - APP_TOKEN 을 팀 전용 값으로 바꾸고, 같은 값을 config.js 의 token 에 넣기
 *  - [배포] > [새 배포] > 유형: 웹 앱
 *      실행 계정: 나
 *      액세스 권한: 모든 사용자(Anyone)
 *  - 생성된 .../exec URL 을 config.js 의 gasUrl 에 넣기
 *  - 시트(FCST / HISTORY / LOG)는 최초 요청 때 자동 생성됩니다.
 */

var APP_TOKEN = 'CHANGE_ME_TOKEN';   // ★ config.js 의 token 과 동일하게
var TZ        = 'Asia/Seoul';        // 기준월 판정 시간대(모든 사용자 공통)
var SHEET_ID  = '';                  // 컨테이너 바인딩이 아니면 시트 ID 입력

var SH_FCST = 'FCST', SH_HIST = 'HISTORY', SH_LOG = 'LOG';
var H_FCST = ['owner', 'handling', 'revenue', 'rev', 'updatedAt', 'updatedBy'];
var H_HIST = ['ym', 'handling', 'revenue', 'rev', 'updatedAt', 'updatedBy'];
var H_LOG  = ['ts', 'user', 'action', 'target', 'handling', 'revenue', 'rev'];
var LOG_MAX = 5000;

/* ------------------------------------------------------------------ 엔트리 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  return json_(route_({ action: p.action || 'state', token: p.token }));
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'BAD_JSON', message: '요청 형식 오류' });
  }
  var out;
  try {
    out = route_(req);
  } catch (err) {
    out = { ok: false, code: 'SERVER_ERROR', message: String(err && err.message || err) };
  }
  return json_(out);
}

function route_(req) {
  req = req || {};
  if (APP_TOKEN && String(req.token || '') !== APP_TOKEN) {
    return { ok: false, code: 'UNAUTHORIZED', message: '토큰이 일치하지 않습니다.' };
  }
  var a = String(req.action || '');

  if (a === 'ping')  return { ok: true, version: getVersion_(), ym: ym_() };
  if (a === 'state') return { ok: true, state: readState_() };

  if (a === 'upsertFcst' || a === 'deleteFcst' || a === 'upsertHistory') {
    return withLock_(function () {
      if (a === 'upsertFcst')  return upsertFcst_(req);
      if (a === 'deleteFcst')  return deleteFcst_(req);
      return upsertHistory_(req);
    });
  }
  return { ok: false, code: 'BAD_ACTION', message: '알 수 없는 요청: ' + a };
}

/* -------------------------------------------------------------------- 잠금 */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  // 동시 요청은 여기서 줄을 섭니다. 25초 안에 못 잡으면 클라이언트가 재시도합니다.
  if (!lock.tryLock(25000)) {
    return { ok: false, code: 'BUSY', message: '다른 저장이 처리 중입니다.' };
  }
  try {
    var r = fn();
    SpreadsheetApp.flush();   // 락을 놓기 전에 반드시 디스크 반영
    return r;
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ 쓰기 */

function upsertFcst_(req) {
  var owner = String(req.owner || '').trim();
  if (!owner) return { ok: false, code: 'BAD_REQUEST', message: '담당자가 비어 있습니다.' };

  var handling = num_(req.handling), revenue = num_(req.revenue);
  if (handling === null || revenue === null || handling < 0 || revenue < 0) {
    return { ok: false, code: 'BAD_REQUEST', message: '금액은 0 이상의 숫자여야 합니다.' };
  }

  var sh = getSheet_(SH_FCST, H_FCST);
  var rows = sh.getDataRange().getValues();
  var at = -1;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === owner) { at = i; break; }
  }

  var expected = num_(req.rev) || 0;
  var user = String(req.user || '').trim() || '알수없음';
  var now = new Date();
  var newRev;

  if (at === -1) {
    // 내가 읽을 때는 있었는데 지금 없다 = 그 사이 누군가 삭제함
    if (expected > 0 && !req.force) {
      return { ok: false, code: 'CONFLICT', reason: 'DELETED', current: null, state: readState_() };
    }
    newRev = 1;
    sh.appendRow([owner, handling, revenue, newRev, now, user]);
  } else {
    var curRev = num_(rows[at][3]) || 0;
    if (!req.force && expected !== curRev) {
      return {
        ok: false, code: 'CONFLICT', reason: 'STALE',
        current: fcstRec_(rows[at]), state: readState_()
      };
    }
    newRev = curRev + 1;
    sh.getRange(at + 1, 1, 1, H_FCST.length)
      .setValues([[owner, handling, revenue, newRev, now, user]]);
  }

  log_(user, 'upsertFcst', owner, handling, revenue, newRev);
  bumpVersion_();
  return { ok: true, state: readState_() };
}

function deleteFcst_(req) {
  var owner = String(req.owner || '').trim();
  if (!owner) return { ok: false, code: 'BAD_REQUEST', message: '담당자가 비어 있습니다.' };

  var sh = getSheet_(SH_FCST, H_FCST);
  var rows = sh.getDataRange().getValues();
  var at = -1;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === owner) { at = i; break; }
  }
  // 이미 지워졌으면 성공으로 간주(멱등) — 두 명이 동시에 삭제해도 에러 안 남
  if (at === -1) return { ok: true, state: readState_() };

  var curRev = num_(rows[at][3]) || 0;
  var expected = num_(req.rev) || 0;
  if (!req.force && expected !== curRev) {
    return {
      ok: false, code: 'CONFLICT', reason: 'STALE',
      current: fcstRec_(rows[at]), state: readState_()
    };
  }

  sh.deleteRow(at + 1);
  log_(String(req.user || '알수없음'), 'deleteFcst', owner, '', '', curRev);
  bumpVersion_();
  return { ok: true, state: readState_() };
}

function upsertHistory_(req) {
  var ym = String(req.ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    return { ok: false, code: 'BAD_REQUEST', message: '연월 형식(YYYY-MM) 오류' };
  }
  if (ym === ym_()) {
    return { ok: false, code: 'BAD_REQUEST', message: '당월은 FCST 입력으로 집계됩니다.' };
  }

  var handling = num_(req.handling), revenue = num_(req.revenue);
  if (handling === null || revenue === null || handling < 0 || revenue < 0) {
    return { ok: false, code: 'BAD_REQUEST', message: '금액은 0 이상의 숫자여야 합니다.' };
  }

  var sh = getSheet_(SH_HIST, H_HIST);
  var rows = sh.getDataRange().getValues();
  var at = -1;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === ym) { at = i; break; }
  }

  var expected = num_(req.rev) || 0;
  var user = String(req.user || '').trim() || '알수없음';
  var now = new Date();
  var newRev;

  if (at === -1) {
    if (expected > 0 && !req.force) {
      return { ok: false, code: 'CONFLICT', reason: 'DELETED', current: null, state: readState_() };
    }
    newRev = 1;
    sh.appendRow([ym, handling, revenue, newRev, now, user]);
  } else {
    var curRev = num_(rows[at][3]) || 0;
    if (!req.force && expected !== curRev) {
      return {
        ok: false, code: 'CONFLICT', reason: 'STALE',
        current: histRec_(rows[at]), state: readState_()
      };
    }
    newRev = curRev + 1;
    sh.getRange(at + 1, 1, 1, H_HIST.length)
      .setValues([[ym, handling, revenue, newRev, now, user]]);
  }

  log_(user, 'upsertHistory', ym, handling, revenue, newRev);
  bumpVersion_();
  return { ok: true, state: readState_() };
}

/* ------------------------------------------------------------------ 읽기 */

function readState_() {
  var fsh = getSheet_(SH_FCST, H_FCST);
  var hsh = getSheet_(SH_HIST, H_HIST);

  var fRows = fsh.getDataRange().getValues();
  var fcst = [];
  for (var i = 1; i < fRows.length; i++) {
    if (String(fRows[i][0]).trim() === '') continue;   // 빈 행 방어
    fcst.push(fcstRec_(fRows[i]));
  }

  var hRows = hsh.getDataRange().getValues();
  var history = {};
  for (var j = 1; j < hRows.length; j++) {
    var key = String(hRows[j][0]).trim();
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    history[key] = histRec_(hRows[j]);
  }

  return {
    version: getVersion_(),
    ym: ym_(),
    serverTime: iso_(new Date()),
    fcst: fcst,
    history: history
  };
}

function fcstRec_(r) {
  return {
    owner: String(r[0]).trim(),
    handling: num_(r[1]) || 0,
    revenue: num_(r[2]) || 0,
    rev: num_(r[3]) || 0,
    updatedAt: iso_(r[4]),
    updatedBy: String(r[5] || '')
  };
}

function histRec_(r) {
  return {
    ym: String(r[0]).trim(),
    handling: num_(r[1]) || 0,
    revenue: num_(r[2]) || 0,
    rev: num_(r[3]) || 0,
    updatedAt: iso_(r[4]),
    updatedBy: String(r[5] || '')
  };
}

/* ------------------------------------------------------------------ 유틸 */

function ss_() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function log_(user, action, target, handling, revenue, rev) {
  try {
    var sh = getSheet_(SH_LOG, H_LOG);
    sh.appendRow([new Date(), user, action, target, handling, revenue, rev]);
    var last = sh.getLastRow();
    if (last > LOG_MAX) sh.deleteRows(2, last - LOG_MAX);
  } catch (e) { /* 로그 실패가 본 로직을 막지 않도록 무시 */ }
}

function getVersion_() {
  var v = PropertiesService.getScriptProperties().getProperty('version');
  return Number(v) || 0;
}

function bumpVersion_() {
  var p = PropertiesService.getScriptProperties();
  var v = (Number(p.getProperty('version')) || 0) + 1;
  p.setProperty('version', String(v));
  return v;
}

function ym_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
}

function iso_(d) {
  if (!d) return '';
  if (Object.prototype.toString.call(d) !== '[object Date]') return String(d);
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
