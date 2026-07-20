# packaging — 배포·서비스·릴리스

인증 근거자료 웹 바인더의 배포 산출물과 운영체제 서비스 정의를 담습니다. (설계서 §7)

## 파일

| 파일 | 용도 |
|------|------|
| `release.mjs` | 릴리스 zip 생성기(웹 빌드 + 서버 + prod node_modules + cMaps/폰트). `npm run release -w server` |
| `start-windows.bat`, `start-linux.sh` | **간단 실행 스크립트(zip 루트에도 동봉)** — 압축 해제 후 더블클릭(윈도우)/`sh` 실행(리눅스)만으로 기동. 상시 운영은 아래 서비스 등록 |
| `qaevidence.service` | Linux systemd 유닛(자동시작·자동재시작) |
| `winsw/qaevidence.xml`, `winsw/README.md` | Windows 서비스(WinSW) 정의·안내 |
| `Dockerfile` | 컨테이너 이미지(2순위/선택) |
| `upgrade.sh`, `upgrade.ps1` | app 파일만 교체하고 `config.json`·`data/` 를 보존하는 업그레이드 |

## 릴리스 만들기

```bash
npm run release -w server      # 또는  node packaging/release.mjs
```

- 산출물: `dist/<name>-<version>-<platform>.zip` (git 제외 경로).
- **플랫폼 종속**: `better-sqlite3`·`esbuild`(tsx) 네이티브 바이너리를 포함하므로, **배포 대상과
  같은 OS/아키텍처**에서 패키징하거나, 대상에서 `npm rebuild` 로 재빌드하세요.
- 새 npm 의존성을 설치하지 않고, 이미 설치·빌드된 `node_modules` 에서 prod 폐쇄집합만
  복사합니다(완전 오프라인). zip 압축에는 OS 기본 도구(`zip` / PowerShell `Compress-Archive`)를 씁니다.

## 압축 해제 후 레이아웃 (설치 루트)

```
설치루트/                    (예: /opt/qaevidence, C:\qaevidence)
├── server/                 ┐
├── web/dist/               │ 설계서 §7의 "app/" 묶음 = 업그레이드 시 교체 대상
├── node_modules/           │
├── package.json            ┘
├── config.example.json     → config.json 으로 복사(필요 시 port/dataDir/maxPdfMB 수정)
├── packaging/  docs/
├── config.json             ← 최초 기동 시 자동 생성(없으면 기본값). 업그레이드가 건드리지 않음
└── data/                   ← 모든 런타임 상태(app.db, files/, backups/, 세션시크릿).
                              업그레이드가 절대 건드리지 않음
```

> 참고: 설계서 §7 다이어그램은 app 파일을 `app/` 하위폴더로 묶습니다. 이 릴리스는 서버 코드가
> 기대하는 경로(설치 루트 직속)에 그대로 펼쳐, `config.json`·`data/` 를 형제 위치에 두어
> 업그레이드 불변성을 보장합니다. "app/ 만 교체" 원칙은 `upgrade.sh`/`upgrade.ps1` 이
> **server/·web/·node_modules/·package.json 만** 교체하는 것으로 동일하게 구현됩니다.

## 실행 (프로덕션)

```bash
# 설치 루트에서
NODE_ENV=production node --import tsx server/src/index.ts
# 또는
NODE_ENV=production npm start
```

- `NODE_ENV=production` 이면 서버가 `web/dist` SPA 를 API와 **같은 포트**로 정적 서빙합니다.
- 서비스로 상시 구동하려면 systemd/WinSW 를 쓰세요(각 파일 상단 주석 참조).

## 설정과 세션 시크릿

`config.json`(설치 루트):

```json
{ "port": 8080, "dataDir": "./data", "maxPdfMB": 200 }
```

- `port` — SPA + API 단일 포트. 환경변수 `PORT` 가 있으면 우선.
- `dataDir` — 런타임 상태 폴더(설치 루트 기준 상대경로 또는 절대경로).
- `maxPdfMB` — 지침서 PDF 업로드 최대 크기.
- (선택) `secureCookies` — HTTPS 종단 뒤에 둘 때만 `true`. 내부망 HTTP 기본은 `false`.

**세션 시크릿은 설정에 두지 않습니다.** 최초 기동 시 `data/session-secret.txt`(권한 0600)로
자동 생성되어 재기동·업그레이드 후에도 유지됩니다. `data/` 를 복사·복원하면 세션 시크릿도 함께
따라옵니다. 관리자 초기 비밀번호도 최초 기동 시 `data/initial-admin-password.txt` 로 생성됩니다
(로그인 후 변경하고 파일 삭제).

## 백업·복원 (설계서 §7)

- **자동**: 앱이 매일 **03:00** 에 `data/backups/app-YYYYMMDD.db`(VACUUM INTO) 생성 — 일 30 + 월 12 보존.
  cron/작업 스케줄러 설정이 필요 없습니다.
- **즉시 백업**: `POST /api/admin/backup`(admin) → DB 스냅샷 + 파일 매니페스트 ZIP 을
  `data/backups/backup-….zip` 로 생성.
- **회사 측 절차(한 줄)**: `data/` 폴더를 다른 장비로 복사(robocopy/rsync — 내용주소·불변이라 자연 증분).
  **복원 = 폴더 되돌리고 서비스 시작.**

## 무결성 점검

- 기동 직후 + 주간 자동 점검(§2 불변식). 결과는 `GET /api/admin/integrity`(admin) 로 확인.
- 즉시 점검: `POST /api/admin/integrity/run`(admin).
- 대시보드 요약(디스크 게이지·백업·무결성): `GET /api/admin/status`(admin).
