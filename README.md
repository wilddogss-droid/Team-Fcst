# 팀 FCST 집계 (GitHub Pages + Google Sheets)

여러 담당자가 **동시에** 입력해도 데이터가 유실되지 않도록 만든 팀 FCST 집계 웹 도구입니다.

```
fcst-app/
├─ index.html      화면
├─ app.js          클라이언트 로직 (동기화 / 충돌 처리)
├─ config.js       ★ 팀마다 수정하는 유일한 파일
├─ Code.gs         Google Apps Script 백엔드 (구글 시트에 붙여넣기)
├─ .nojekyll
└─ .github/workflows/pages.yml   GitHub Pages 자동 배포
```

---

## 1. 구글 시트(중앙 DB) 준비

1. 구글 드라이브에서 새 스프레드시트를 만듭니다. (예: `팀FCST_DB`)
2. **확장 프로그램 → Apps Script** 를 엽니다.
3. 기본 `Code.gs` 내용을 지우고 이 저장소의 `Code.gs` 전체를 붙여넣습니다.
4. 맨 위 `APP_TOKEN` 값을 팀 전용 문자열로 바꿉니다. (예: `kolon-fcst-7f3a91`)
5. **배포 → 새 배포 → 유형: 웹 앱**
   - 설명: `fcst v1`
   - **실행 계정: 나**
   - **액세스 권한: 모든 사용자(Anyone)** ← 이게 아니면 팀원 브라우저에서 CORS 오류가 납니다.
6. 발급된 `https://script.google.com/macros/s/.../exec` URL을 복사합니다.

`FCST` / `HISTORY` / `LOG` 시트는 첫 요청 때 자동으로 만들어집니다.

> 코드를 수정하면 반드시 **배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포** 를 해야 반영됩니다.
> URL은 그대로 유지됩니다.

---

## 2. `config.js` 수정

```js
window.FCST_CONFIG = {
  gasUrl: "https://script.google.com/macros/s/AKfy.../exec",
  token:  "kolon-fcst-7f3a91",          // Code.gs 의 APP_TOKEN 과 동일
  owners: ["손창곤","유슬아","옥수영","박명선","최원준"],
  pollMs: 5000,
  restrictToOwnRow: false               // true 면 본인 행만 수정 가능
};
```

---

## 3. GitHub 배포

```bash
git init
git add .
git commit -m "팀 FCST 집계 도구"
git branch -M main
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

저장소 **Settings → Pages → Build and deployment → Source: GitHub Actions** 로 설정하면
포함된 워크플로가 `main` 푸시마다 자동 배포합니다.
(Actions 대신 `Deploy from a branch → main / (root)` 를 골라도 됩니다.)

배포 주소: `https://<계정>.github.io/<저장소>/`

### 보안 안내 (중요)

공개(Public) 저장소로 올리면 `config.js` 안의 **Apps Script URL과 토큰이 그대로 노출**됩니다.
토큰은 검색엔진 크롤러·무작위 접근을 막는 수준일 뿐, 링크를 아는 사람의 쓰기를 막지 못합니다.
사내 데이터라면 다음 중 하나를 권합니다.

- 저장소를 **Private** 으로 만들고 GitHub Pages(Enterprise/Team 플랜)로 배포
- 또는 Apps Script 배포 액세스 권한을 **"Google Workspace 도메인 내 사용자"** 로 두고
  팀원이 회사 계정으로 로그인한 상태에서 사용 (이 경우 `Anyone` 이 아니므로 외부 접근이 차단됨)
- `LOG` 시트에 모든 변경 이력(누가·언제·무엇)이 남으므로 사후 추적은 가능합니다

---

## 4. 동시 입력 문제를 어떻게 없앴는가

| 기존 코드의 문제 | 이 버전의 처리 |
|---|---|
| `sheet.clear()` 후 전체 재기록 → 남의 입력이 통째로 사라짐 | **행 단위 upsert**. 담당자 행만 갱신하고 나머지는 손대지 않음 |
| 동시 요청 시 시트가 반쯤 지워진 채 남음 | 모든 쓰기를 `LockService` 로 감싸 **직렬 처리**, `flush()` 후 락 해제 |
| 같은 행을 둘이 고치면 나중 사람이 조용히 덮어씀 | 레코드별 `rev`(개정번호) **낙관적 잠금**. 어긋나면 `CONFLICT` 반환 → 화면에서 *내 값 / 서버 값* 선택 |
| `mode:'no-cors'` 라 실패해도 "저장됨" 표시 | `text/plain` POST 로 preflight 회피 + **응답 검증**. 실패는 실패로 표시 |
| 최초 1회만 로드 → 각자 다른 화면 | `version` **폴링(5초)** + 창 포커스 시 즉시 동기화 |
| localStorage 가 사실상 원본 → 서버와 영구 분기 | 서버가 유일한 원본. localStorage 는 서버 미설정 시에만 사용 |
| `deleteData(index)` → 목록이 바뀌면 엉뚱한 사람 삭제 | **담당자명(키) 기준 삭제** + `rev` 검증, 중복 삭제는 멱등 처리 |
| 월별 실적이 각자 PC에만 존재 | `HISTORY` 시트로 서버 공유, 동일한 충돌 처리 적용 |
| 버튼 연타 시 요청이 서로 추월 | 클라이언트 **요청 큐**로 쓰기 직렬화 + 전송 중 버튼 비활성화 |
| 입력 중인데 폴링이 값을 덮어씀 | 입력 중(dirty)에는 화면만 갱신하고 **입력칸은 보존**, 배너로 알림 |
| 기준월을 각 PC 시계로 계산 | 서버(Asia/Seoul) 기준 `YYYY-MM` 을 전원이 공유 |
| 더미 `defaultHistory` 가 공용 DB 오염 | 초기 데이터 없음. 실제 입력만 저장 |
| 팀원마다 GAS URL 직접 입력 | `config.js` 한 곳에서 배포 시 고정 |
| 락 대기 초과(BUSY) | 클라이언트가 지수 백오프로 최대 3회 자동 재시도 |

### 남는 제약

- Apps Script 웹앱은 동시 실행 처리량이 크지 않습니다. 락 직렬화 때문에 **수십 명이 초당 여러 번** 저장하는 규모에는 부적합합니다(팀 5~20명 수준에는 충분).
- 폴링 주기(기본 5초)만큼의 표시 지연이 있습니다. 실시간성이 더 필요하면 `pollMs` 를 줄이되, Apps Script 호출 쿼터를 고려하세요.
- 같은 담당자 행을 두 사람이 동시에 고치는 상황은 *막지 않고* **감지해서 물어봅니다**. 아예 차단하려면 `config.js` 의 `restrictToOwnRow: true` 를 켜세요.

---

## 5. 로컬에서 테스트

`file://` 로 열면 fetch 가 막히므로 간단한 서버로 띄우세요.

```bash
npx serve .
```

동시 입력 확인은 브라우저 창 2개(또는 다른 PC)를 띄우고 같은 담당자를 서로 다른 값으로 저장해 보면 됩니다.
나중에 저장한 쪽에 충돌 모달이 떠야 정상입니다.
