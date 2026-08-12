/* =========================================================================
 * 팀 FCST 집계 - 프론트엔드
 *
 * 동시 입력 대응 요약
 *  - 서버가 유일한 원본(single source of truth). localStorage 는 캐시가 아니라
 *    '서버 미설정(로컬 전용)' 모드에서만 저장소로 쓰입니다.
 *  - 모든 쓰기는 요청 큐에 넣어 한 번에 하나씩만 전송(내 클릭끼리의 경합 제거).
 *  - 레코드별 rev 를 함께 보내 낙관적 잠금. 서버가 CONFLICT 를 주면 사용자에게
 *    '서버 값 / 내 값' 선택을 물어봅니다(조용한 덮어쓰기 없음).
 *  - version 폴링으로 다른 사람의 변경을 자동 반영.
 *  - 입력 중(dirty)일 때는 폴링이 내 입력칸을 건드리지 않고 배너로만 알립니다.
 *  - 삭제는 인덱스가 아니라 담당자명(키) 기준.
 *  - 기준월(YYYY-MM)은 서버 시간대(Asia/Seoul)로 통일.
 * ========================================================================= */
(function () {
  'use strict';

  var CFG = window.FCST_CONFIG || {};
  var OWNERS = Array.isArray(CFG.owners) && CFG.owners.length
    ? CFG.owners : ['손창곤', '유슬아', '옥수영', '박명선', '최원준'];
  var REMOTE = !!(CFG.gasUrl && String(CFG.gasUrl).trim());
  var POLL_MS = Number(CFG.pollMs) > 0 ? Number(CFG.pollMs) : 5000;
  var LS_DB = 'fcst.local.v2';
  var LS_ME = 'fcst.me';

  var state = { version: -1, ym: '', fcst: [], history: {}, serverTime: '' };
  var formDirty = false;      // 사용자가 입력칸을 건드린 상태인가
  var pendingWrite = false;   // 쓰기 요청 진행 중인가
  var conflictCtx = null;     // 충돌 해결 모달 컨텍스트
  var bc = null;              // 로컬 모드용 탭 간 동기화

  /* ------------------------------------------------------------- 요청 큐 */
  // 사용자가 버튼을 연타하거나, 모달 저장과 폼 제출이 겹쳐도
  // 서버로 나가는 쓰기 요청은 항상 직렬입니다.
  var chain = Promise.resolve();
  function enqueue(task) {
    var p = chain.then(task, task);
    chain = p.then(function () {}, function () {});
    return p;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* --------------------------------------------------------- 원격 백엔드 */
  function callRemote(action, payload, attempt) {
    attempt = attempt || 0;
    var body = JSON.stringify(Object.assign(
      { action: action, token: CFG.token || '', user: myName() }, payload || {}
    ));

    // Content-Type 을 text/plain 으로 보내면 CORS preflight 가 발생하지 않아
    // Apps Script 웹앱에 그대로 POST 할 수 있습니다(no-cors 불필요 → 응답 확인 가능).
    return fetch(CFG.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow',
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) throw { code: 'HTTP_' + res.status, message: '서버 응답 오류(' + res.status + ')' };
      return res.text();
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); }
      catch (e) { throw { code: 'PARSE', message: '응답을 해석하지 못했습니다. 웹앱 액세스 권한을 확인하세요.' }; }
      if (!data.ok && data.code === 'BUSY' && attempt < 3) {
        return sleep(300 * (attempt + 1)).then(function () {
          return callRemote(action, payload, attempt + 1);
        });
      }
      return data;
    }).catch(function (e) {
      if (e && e.code) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: 'NETWORK', message: '네트워크에 연결하지 못했습니다.' };
    });
  }

  /* --------------------------------------------------------- 로컬 백엔드 */
  function localLoad() {
    try {
      var db = JSON.parse(localStorage.getItem(LS_DB));
      if (db && Array.isArray(db.fcst)) return db;
    } catch (e) { /* 손상된 값은 버림 */ }
    return { version: 0, fcst: [], history: {} };
  }

  function localSave(db) {
    db.version = (db.version || 0) + 1;
    localStorage.setItem(LS_DB, JSON.stringify(db));
    if (bc) { try { bc.postMessage('changed'); } catch (e) {} }
    return db;
  }

  function localState(db) {
    db = db || localLoad();
    return {
      version: db.version || 0,
      ym: ymNow(),
      serverTime: new Date().toISOString(),
      fcst: db.fcst,
      history: db.history
    };
  }

  function callLocal(action, p) {
    p = p || {};
    var db = localLoad(), i, cur, now = new Date().toISOString(), me = myName();

    if (action === 'ping')  return Promise.resolve({ ok: true, version: db.version || 0, ym: ymNow() });
    if (action === 'state') return Promise.resolve({ ok: true, state: localState(db) });

    if (action === 'upsertFcst') {
      i = db.fcst.findIndex(function (r) { return r.owner === p.owner; });
      cur = i >= 0 ? db.fcst[i] : null;
      var exp = Number(p.rev) || 0;
      if (!p.force && (cur ? cur.rev : 0) !== exp) {
        return Promise.resolve({ ok: false, code: 'CONFLICT', reason: cur ? 'STALE' : 'DELETED',
          current: cur, state: localState(db) });
      }
      var recF = { owner: p.owner, handling: p.handling, revenue: p.revenue,
        rev: (cur ? cur.rev : 0) + 1, updatedAt: now, updatedBy: me };
      if (i >= 0) db.fcst[i] = recF; else db.fcst.push(recF);
      return Promise.resolve({ ok: true, state: localState(localSave(db)) });
    }

    if (action === 'deleteFcst') {
      i = db.fcst.findIndex(function (r) { return r.owner === p.owner; });
      if (i < 0) return Promise.resolve({ ok: true, state: localState(db) });
      if (!p.force && db.fcst[i].rev !== (Number(p.rev) || 0)) {
        return Promise.resolve({ ok: false, code: 'CONFLICT', reason: 'STALE',
          current: db.fcst[i], state: localState(db) });
      }
      db.fcst.splice(i, 1);
      return Promise.resolve({ ok: true, state: localState(localSave(db)) });
    }

    if (action === 'upsertHistory') {
      cur = db.history[p.ym] || null;
      if (!p.force && (cur ? cur.rev : 0) !== (Number(p.rev) || 0)) {
        return Promise.resolve({ ok: false, code: 'CONFLICT', reason: 'STALE',
          current: cur, state: localState(db) });
      }
      db.history[p.ym] = { ym: p.ym, handling: p.handling, revenue: p.revenue,
        rev: (cur ? cur.rev : 0) + 1, updatedAt: now, updatedBy: me };
      return Promise.resolve({ ok: true, state: localState(localSave(db)) });
    }

    return Promise.resolve({ ok: false, code: 'BAD_ACTION' });
  }

  var call = REMOTE ? callRemote : callLocal;

  /* ------------------------------------------------------------ 상태 적용 */
  function applyState(s) {
    if (!s) return;
    // 폴링 응답이 쓰기 응답보다 늦게 도착해도 과거 상태로 되돌아가지 않도록 방어
    if (typeof s.version === 'number' && s.version < state.version) return;

    var prevSelected = selectedOwnerRecord();
    state = {
      version: s.version, ym: s.ym, serverTime: s.serverTime,
      fcst: Array.isArray(s.fcst) ? s.fcst : [],
      history: s.history || {}
    };

    render();

    if (formDirty) {
      // 내가 입력 중인 담당자의 서버 값이 바뀌었으면 덮어쓰지 않고 알려만 줍니다.
      var nowRec = selectedOwnerRecord();
      var changed = (prevSelected ? prevSelected.rev : 0) !== (nowRec ? nowRec.rev : 0);
      showStaleBanner(changed ? nowRec : null);
    } else {
      fillFormFromState();
      showStaleBanner(null);
    }
  }

  function refreshState() {
    return call('state').then(function (r) {
      if (r.ok) { applyState(r.state); setStatus('ok'); }
      else setStatus('err', r.message || r.code);
      return r;
    });
  }

  /* --------------------------------------------------------------- 폴링 */
  function startPolling() {
    if (REMOTE) {
      setInterval(tick, POLL_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
      window.addEventListener('focus', tick);
    } else {
      // 같은 PC에서 탭을 여러 개 띄운 경우를 위한 동기화
      try { bc = new BroadcastChannel('fcst'); bc.onmessage = function () { refreshState(); }; } catch (e) {}
      window.addEventListener('storage', function (e) { if (e.key === LS_DB) refreshState(); });
    }
  }

  function tick() {
    if (document.hidden || pendingWrite) return;
    call('ping').then(function (r) {
      if (!r.ok) { setStatus('err', r.message || r.code); return; }
      setStatus('ok');
      if (r.version !== state.version) refreshState();
    });
  }

  /* --------------------------------------------------------------- 쓰기 */
  function write(action, payload) {
    return enqueue(function () {
      pendingWrite = true;
      setBusy(true);
      return call(action, payload).then(function (r) {
        if (r.state) applyState(r.state);
        return r;
      }).then(function (r) {
        pendingWrite = false; setBusy(false); return r;
      }, function (e) {
        pendingWrite = false; setBusy(false);
        return { ok: false, code: 'ERROR', message: String(e) };
      });
    });
  }

  function submitForm() {
    var owner = el('owner').value;
    var handling = parseFloat(el('handling').value);
    var revenue = parseFloat(el('revenue').value);

    if (!owner) return toast('⚠️ 담당자를 선택해 주세요.');
    if (!isFinite(handling) || handling <= 0) return toast('⚠️ 올바른 취급액을 입력해 주세요.');
    if (!isFinite(revenue) || revenue < 0) return toast('⚠️ 올바른 매출액을 입력해 주세요.');
    if (CFG.restrictToOwnRow && owner !== myName()) {
      return toast('⚠️ 본인(' + myName() + ') 항목만 수정할 수 있습니다.');
    }

    var rec = findFcst(owner);
    write('upsertFcst', {
      owner: owner, handling: handling, revenue: revenue, rev: rec ? rec.rev : 0
    }).then(function (r) {
      if (r.ok) {
        formDirty = false;
        fillFormFromState();
        showStaleBanner(null);
        toast('✅ ' + owner + ' 님의 FCST가 저장되었습니다.');
      } else if (r.code === 'CONFLICT') {
        openConflict({
          kind: 'fcst', owner: owner, handling: handling, revenue: revenue,
          current: r.current, reason: r.reason
        });
      } else {
        toast('❌ 저장 실패: ' + (r.message || r.code));
      }
    });
  }

  function deleteOwner(owner) {
    var rec = findFcst(owner);
    if (!rec) return;
    if (CFG.restrictToOwnRow && owner !== myName()) {
      return toast('⚠️ 본인(' + myName() + ') 항목만 삭제할 수 있습니다.');
    }
    if (!confirm(owner + ' 님의 이번 달 FCST를 삭제할까요?')) return;

    write('deleteFcst', { owner: owner, rev: rec.rev }).then(function (r) {
      if (r.ok) { formDirty = false; fillFormFromState(); toast('🗑️ ' + owner + ' 님 항목을 삭제했습니다.'); }
      else if (r.code === 'CONFLICT') {
        toast('⚠️ ' + (r.current && r.current.updatedBy || '다른 사용자') + ' 님이 방금 수정했습니다. 최신값을 불러왔습니다.');
      } else toast('❌ 삭제 실패: ' + (r.message || r.code));
    });
  }

  function saveHistory() {
    var ym = el('editTargetYm').value;
    var handling = parseFloat(el('modalHandling').value);
    var revenue = parseFloat(el('modalRevenue').value);
    if (!isFinite(handling) || handling < 0 || !isFinite(revenue) || revenue < 0) {
      return toast('⚠️ 금액은 0 이상의 숫자여야 합니다.');
    }
    var cur = state.history[ym];
    write('upsertHistory', { ym: ym, handling: handling, revenue: revenue, rev: cur ? cur.rev : 0 })
      .then(function (r) {
        if (r.ok) { closeModal('editMonthModal'); toast('✅ ' + ymLabel(ym) + ' 실적이 저장되었습니다.'); }
        else if (r.code === 'CONFLICT') {
          var c = r.current;
          toast('⚠️ ' + (c && c.updatedBy || '다른 사용자') + ' 님이 먼저 수정했습니다. 최신값으로 갱신했습니다.');
          openMonthModal(ym);   // 최신 rev 로 다시 채움
        } else toast('❌ 저장 실패: ' + (r.message || r.code));
      });
  }

  /* ---------------------------------------------------------- 충돌 해결 */
  function openConflict(ctx) {
    conflictCtx = ctx;
    var c = ctx.current;
    el('conflictWho').innerText = c
      ? (c.updatedBy || '다른 사용자') + ' 님이 ' + timeLabel(c.updatedAt) + '에 먼저 저장했습니다.'
      : '다른 사용자가 이 항목을 삭제했습니다.';
    el('conflictMine').innerHTML =
      '취급액 ' + fmt(ctx.handling) + '<br>매출액 ' + fmt(ctx.revenue) +
      '<br>수수료율 ' + rateStr(ctx.handling, ctx.revenue);
    el('conflictTheirs').innerHTML = c
      ? ('취급액 ' + fmt(c.handling) + '<br>매출액 ' + fmt(c.revenue) +
         '<br>수수료율 ' + rateStr(c.handling, c.revenue))
      : '(삭제됨)';
    openModal('conflictModal');
  }

  function conflictKeepTheirs() {
    closeModal('conflictModal');
    conflictCtx = null;
    formDirty = false;
    fillFormFromState();
    showStaleBanner(null);
    toast('서버의 최신 값을 유지했습니다.');
  }

  function conflictKeepMine() {
    if (!conflictCtx) return closeModal('conflictModal');
    var c = conflictCtx;
    closeModal('conflictModal');
    conflictCtx = null;
    write('upsertFcst', {
      owner: c.owner, handling: c.handling, revenue: c.revenue, rev: 0, force: true
    }).then(function (r) {
      if (r.ok) { formDirty = false; fillFormFromState(); toast('✅ 내 값으로 덮어썼습니다.'); }
      else toast('❌ 저장 실패: ' + (r.message || r.code));
    });
  }

  /* --------------------------------------------------------------- 렌더 */
  function render() {
    renderTitle();
    renderTable();
    renderMatrix();
    renderMeta();
  }

  function renderTitle() {
    el('currentMonthTitle').innerText = '📈 ' + ymLabel(state.ym) + ' 팀 FCST 집계 현황';
  }

  function renderTable() {
    var tbody = el('dataTable');
    tbody.innerHTML = '';
    var th = 0, tr = 0;

    var list = state.fcst.slice().sort(function (a, b) {
      return OWNERS.indexOf(a.owner) - OWNERS.indexOf(b.owner);
    });

    list.forEach(function (item) {
      th += item.handling; tr += item.revenue;
      var row = document.createElement('tr');
      row.innerHTML =
        '<td>' + esc(item.owner) + '</td>' +
        '<td>' + fmt(item.handling) + '</td>' +
        '<td>' + fmt(item.revenue) + '</td>' +
        '<td>' + rateStr(item.handling, item.revenue) + '</td>' +
        '<td class="who">' + esc(item.updatedBy || '-') +
        '<br><span class="when">' + timeLabel(item.updatedAt) + '</span></td>' +
        '<td style="text-align:center;">' +
          '<button class="btn-delete" data-del="' + esc(item.owner) + '">삭제</button></td>';
      tbody.appendChild(row);
    });

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#888; padding:18px;">' +
        '아직 입력된 FCST가 없습니다.</td></tr>';
    }

    el('kpiHandling').innerText = fmt(th) + ' 원';
    el('kpiRevenue').innerText = fmt(tr) + ' 원';
    el('kpiRate').innerText = (th > 0 ? (tr / th * 100).toFixed(2) : '0.00') + ' %';
  }

  function renderMatrix() {
    var year = (state.ym || ymNow()).slice(0, 4);
    var curM = parseInt((state.ym || ymNow()).slice(5, 7), 10);
    var totals = state.fcst.reduce(function (a, r) {
      a.h += r.handling; a.r += r.revenue; return a;
    }, { h: 0, r: 0 });

    var head = '<tr><th>구분</th>';
    var months = [];
    for (var m = 1; m <= 12; m++) {
      var ym = year + '-' + pad(m);
      var isCur = m === curM;
      var rec = isCur ? { handling: totals.h, revenue: totals.r } : (state.history[ym] || { handling: 0, revenue: 0 });
      months.push({ m: m, ym: ym, isCur: isCur, h: rec.handling, r: rec.revenue,
        by: (!isCur && state.history[ym]) ? state.history[ym].updatedBy : '' });
      head += isCur
        ? '<th class="current-month">' + m + '월 (예상)</th>'
        : '<th class="editable-month" data-ym="' + ym + '" title="' + m + '월 실적 수정">' + m + '월 ✏️</th>';
    }
    head += '<th class="ytd-cell">연간 누계 (YTD)</th></tr>';
    el('monthlyMatrixHead').innerHTML = head;

    var ytdH = months.reduce(function (s, x) { return s + x.h; }, 0);
    var ytdR = months.reduce(function (s, x) { return s + x.r; }, 0);

    function row(label, pick) {
      var html = '<td>' + label + '</td>';
      months.forEach(function (x) {
        var v = pick(x);
        var title = x.by ? ' title="최종수정: ' + esc(x.by) + '"' : '';
        html += x.isCur
          ? '<td class="current-month">' + v + '</td>'
          : '<td class="editable-cell" data-ym="' + x.ym + '"' + title + '>' + v + '</td>';
      });
      return html;
    }

    var tbody = el('monthlyMatrixTable');
    tbody.innerHTML = '';
    var r1 = document.createElement('tr');
    r1.innerHTML = row('취급액', function (x) { return x.h > 0 ? fmt(x.h) : '-'; }) +
      '<td class="ytd-cell">' + fmt(ytdH) + '</td>';
    var r2 = document.createElement('tr');
    r2.innerHTML = row('매출액', function (x) { return x.r > 0 ? fmt(x.r) : '-'; }) +
      '<td class="ytd-cell">' + fmt(ytdR) + '</td>';
    var r3 = document.createElement('tr');
    r3.innerHTML = row('수수료율', function (x) { return x.h > 0 ? rateStr(x.h, x.r) : '-'; }) +
      '<td class="ytd-cell">' + (ytdH > 0 ? (ytdR / ytdH * 100).toFixed(2) : '0.00') + '%</td>';
    tbody.appendChild(r1); tbody.appendChild(r2); tbody.appendChild(r3);
  }

  function renderMeta() {
    el('lastSync').innerText = '최근 동기화 ' + new Date().toLocaleTimeString('ko-KR');
  }

  /* ----------------------------------------------------------- 폼 제어 */
  function fillFormFromState() {
    var owner = el('owner').value;
    var rec = findFcst(owner);
    if (rec) {
      el('handling').value = rec.handling;
      el('revenue').value = rec.revenue;
      el('btnSubmit').innerText = '수정하기';
    } else {
      el('handling').value = '';
      el('revenue').value = '';
      el('btnSubmit').innerText = '제출하기';
    }
    calcRate();
  }

  function calcRate() {
    var h = parseFloat(el('handling').value) || 0;
    var r = parseFloat(el('revenue').value) || 0;
    el('rate').value = h > 0 ? (r / h * 100).toFixed(2) + '%' : '0.00%';
  }

  function calcModalRate() {
    var h = parseFloat(el('modalHandling').value) || 0;
    var r = parseFloat(el('modalRevenue').value) || 0;
    el('modalRate').value = h > 0 ? (r / h * 100).toFixed(2) + '%' : '0.00%';
  }

  function showStaleBanner(rec) {
    var b = el('staleBanner');
    if (!rec) { b.style.display = 'none'; return; }
    b.innerHTML = '⚠️ <b>' + esc(rec.updatedBy || '다른 사용자') + '</b> 님이 방금 ' +
      esc(rec.owner) + ' 항목을 수정했습니다 (취급액 ' + fmt(rec.handling) +
      ' / 매출액 ' + fmt(rec.revenue) + '). ' +
      '<button id="btnTakeServer" class="btn-link">서버 값 불러오기</button>';
    b.style.display = 'block';
    el('btnTakeServer').onclick = function () {
      formDirty = false; fillFormFromState(); showStaleBanner(null);
    };
  }

  function openMonthModal(ym) {
    if (ym === state.ym) return toast('당월은 위의 FCST 입력으로 집계됩니다.');
    var rec = state.history[ym] || { handling: 0, revenue: 0 };
    el('editTargetYm').value = ym;
    el('editMonthModalTitle').innerText = '📅 ' + ymLabel(ym) + ' 확정 실적 수정';
    el('modalHandling').value = rec.handling;
    el('modalRevenue').value = rec.revenue;
    el('modalMeta').innerText = state.history[ym]
      ? '최종수정: ' + (state.history[ym].updatedBy || '-') + ' / ' + timeLabel(state.history[ym].updatedAt)
      : '아직 입력된 실적이 없습니다.';
    calcModalRate();
    openModal('editMonthModal');
  }

  /* ------------------------------------------------------------- 유틸 */
  function el(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmt(n) { return (Number(n) || 0).toLocaleString('ko-KR'); }
  function rateStr(h, r) { return (h > 0 ? (r / h * 100).toFixed(2) : '0.00') + '%'; }
  function findFcst(owner) {
    return state.fcst.filter(function (r) { return r.owner === owner; })[0] || null;
  }
  function selectedOwnerRecord() { return findFcst(el('owner') ? el('owner').value : ''); }
  function ymNow() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function ymLabel(ym) { return ym ? (parseInt(ym.slice(5, 7), 10) + '월') : ''; }
  function timeLabel(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function myName() { return localStorage.getItem(LS_ME) || OWNERS[0]; }

  function toast(msg) {
    var t = el('toast');
    t.innerText = msg;
    t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.style.display = 'none'; }, 2600);
  }

  function openModal(id) { el(id).classList.add('active'); }
  function closeModal(id) { el(id).classList.remove('active'); }

  function setBusy(on) {
    el('btnSubmit').disabled = on;
    el('btnSaveMonth').disabled = on;
    document.body.style.cursor = on ? 'progress' : '';
  }

  function setStatus(kind, msg) {
    var b = el('syncStatusBadge');
    if (!REMOTE) {
      b.className = 'sync-badge sync-local';
      b.innerText = '💻 로컬 전용 모드 (팀 공유 안 됨)';
      return;
    }
    if (kind === 'ok') { b.className = 'sync-badge sync-active'; b.innerText = '☁️ 팀 공유 연결됨'; }
    else { b.className = 'sync-badge sync-error'; b.innerText = '⚠️ 연결 오류: ' + (msg || ''); }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(function () {});
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ------------------------------------------------------------- 초기화 */
  document.addEventListener('DOMContentLoaded', function () {
    // 담당자 / 내 이름 선택지 구성
    var ownerSel = el('owner'), meSel = el('meSelect');
    OWNERS.forEach(function (o) {
      ownerSel.appendChild(new Option(o, o));
      meSel.appendChild(new Option(o, o));
    });
    meSel.value = myName();
    ownerSel.value = CFG.restrictToOwnRow ? myName() : myName();
    if (CFG.restrictToOwnRow) ownerSel.disabled = true;

    meSel.addEventListener('change', function () {
      localStorage.setItem(LS_ME, meSel.value);
      if (CFG.restrictToOwnRow) { ownerSel.value = meSel.value; }
      formDirty = false;
      fillFormFromState();
      toast('내 이름을 ' + meSel.value + ' 로 설정했습니다.');
    });

    ownerSel.addEventListener('change', function () {
      formDirty = false;
      fillFormFromState();
      showStaleBanner(null);
    });

    ['handling', 'revenue'].forEach(function (id) {
      el(id).addEventListener('input', function () { formDirty = true; calcRate(); });
    });
    ['modalHandling', 'modalRevenue'].forEach(function (id) {
      el(id).addEventListener('input', calcModalRate);
    });

    el('btnSubmit').addEventListener('click', submitForm);
    el('btnSaveMonth').addEventListener('click', saveHistory);
    el('btnCancelMonth').addEventListener('click', function () { closeModal('editMonthModal'); });
    el('btnKeepMine').addEventListener('click', conflictKeepMine);
    el('btnKeepTheirs').addEventListener('click', conflictKeepTheirs);
    el('btnCopyUrl').addEventListener('click', function () {
      copyText(location.href.split('#')[0]);
      toast('📋 주소를 복사했습니다. 팀원에게 공유하세요.');
    });
    el('btnRefresh').addEventListener('click', function () {
      refreshState().then(function () { toast('🔄 최신 데이터를 불러왔습니다.'); });
    });

    // 삭제 버튼 / 월 셀은 이벤트 위임 — 인덱스가 아니라 키(담당자·연월) 기준
    el('dataTable').addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (b) deleteOwner(b.getAttribute('data-del'));
    });
    document.querySelector('.matrix-wrapper').addEventListener('click', function (e) {
      var c = e.target.closest('[data-ym]');
      if (c) openMonthModal(c.getAttribute('data-ym'));
    });
    [['editMonthModal'], ['conflictModal']].forEach(function (p) {
      el(p[0]).addEventListener('click', function (e) {
        if (e.target === this && p[0] !== 'conflictModal') closeModal(p[0]);
      });
    });

    if (!REMOTE) {
      el('setupNotice').style.display = 'block';
    }

    setStatus(REMOTE ? 'ok' : 'local');
    state.ym = ymNow();
    render();
    refreshState().then(function () { fillFormFromState(); });
    startPolling();
  });
})();
