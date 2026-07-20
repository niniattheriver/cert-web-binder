# 설치 (내부망 오프라인)

인증 근거자료 웹 바인더는 **단일 Node 프로세스**가 웹화면(SPA)과 API를 한 포트로 서빙합니다.
대상 서버의 선행조건은 **Node LTS(20 또는 22) 설치 하나**뿐이며, 런타임에 인터넷·CDN 접근이 전혀 없습니다.

## 0. 가장 간단한 실행 (개발 지식 불필요)

GitHub **Releases에서 zip을 내려받아 푼 뒤**:

- **Windows**: `start-windows.bat` **더블클릭** → 몇 초 뒤 브라우저가 자동으로 열립니다.
- **Linux/맥**: 터미널에서 `sh start-linux.sh` → 브라우저에서 `http://localhost:8080` 접속.

첫 실행 시 관리자 계정(`admin`)의 초기 비밀번호가 실행 창(콘솔)에 표시되고
`data/initial-admin-password.txt` 에도 기록됩니다(로그인 후 변경 권장).
창을 닫으면 서버가 꺼지므로, **상시 운영(부팅 시 자동 시작)**은 아래 4장의 서비스 등록을 따르세요.

> 요약 흐름(상시 운영): (빌드 머신) 릴리스 zip 생성 → (대상 서버) 압축 해제 → `config.json` → 서비스 등록 → 최초 로그인.

## 1. 릴리스 준비 (빌드 머신, 인터넷 가능)

배포 대상과 **같은 OS/아키텍처**에서 릴리스 zip을 만듭니다(네이티브 모듈 `better-sqlite3`·esbuild 포함).

```bash
npm ci                       # 최초 1회
npm run release -w server    # → dist/cert-web-binder-<version>-<platform>.zip
```

이 zip에는 서버 코드 · 빌드된 SPA(`web/dist`) · **prod `node_modules`** · pdf.js cMaps/표준폰트가
모두 들어 있어 대상 서버에서 추가 설치(npm)가 필요 없습니다. (자세히: [`packaging/README.md`](../packaging/README.md))

> 대상과 다른 OS/아키텍처에서 패키징했다면, 대상 서버에서 `npm rebuild better-sqlite3` 로 네이티브만 재빌드하세요.

## 2. 압축 해제 (대상 서버)

- Linux: `/opt/qaevidence` 에 해제
- Windows: `C:\qaevidence` 에 해제

압축을 풀면 설치 루트에 `server/ web/ node_modules/ package.json config.example.json packaging/ docs/` 가 펼쳐집니다.

## 3. 설정

```bash
cp config.example.json config.json     # 필요 시 port/dataDir/maxPdfMB 수정
```

```json
{ "port": 8080, "dataDir": "./data", "maxPdfMB": 200 }
```

- `port` — SPA+API 단일 포트(환경변수 `PORT` 가 있으면 우선).
- `dataDir` — 런타임 상태 폴더(설치 루트 기준 상대경로 또는 절대경로).
- `maxPdfMB` — 지침서 PDF 업로드 최대 크기.
- (선택) `secureCookies: true` — HTTPS 종단(리버스 프록시) 뒤에 둘 때만. 내부망 HTTP 기본은 생략.
- (선택) `trustProxy` — HTTPS 리버스 프록시(Nginx/Caddy 등) 뒤에 둘 때 **`secureCookies`와 함께 반드시 설정**.
  프록시가 서버 바로 앞 1대면 `"trustProxy": 1`, 특정 주소만 신뢰하려면 `"trustProxy": "127.0.0.1"`.
  이 값이 없으면 Express가 요청을 HTTP로 판단해 secure 쿠키가 발급되지 않아 로그인이 유지되지 않습니다.
  `true`(모든 프록시 신뢰)는 헤더 위조 위험 때문에 서버가 거부합니다 — 홉 수나 주소로 지정하세요.

`config.json` 이 없으면 최초 기동 시 기본값으로 자동 생성됩니다. **세션 시크릿은 설정에 두지 않습니다** —
최초 기동 시 `data/session-secret.txt`(권한 0600)로 자동 생성되어 재기동·업그레이드 후에도 유지됩니다.

## 4. 서비스 등록 (자동 시작·자동 재시작)

- **Linux(systemd)** — [`packaging/qaevidence.service`](../packaging/qaevidence.service) 상단 주석대로
  전용 사용자 생성 → 소유권 → `/etc/systemd/system/` 복사 → `sudo systemctl enable --now qaevidence`.
- **Windows(WinSW)** — [`packaging/winsw/README.md`](../packaging/winsw/README.md) 참조(WinSW 실행파일은
  내부망 정책상 보안팀 승인 하에 1회 내려받아 `qaevidence-service.exe` 로 배치).
- **컨테이너(선택)** — [`packaging/Dockerfile`](../packaging/Dockerfile).
- **수동 실행(점검용)** — 설치 루트에서 `NODE_ENV=production npm start`
  (`NODE_ENV=production` 이면 `web/dist` SPA를 API와 같은 포트로 정적 서빙).

## 5. 최초 로그인

- 관리자 초기 비밀번호는 `data/initial-admin-password.txt`(권한 0600)에 생성되며 기동 로그에도 출력됩니다.
  (`ADMIN_INITIAL_PASSWORD` 환경변수로 지정도 가능.)
- 아이디는 `admin`. **로그인 후 즉시 비밀번호를 바꾸고 이 파일을 삭제**하세요.

## 6. 확인

- 브라우저에서 `http://서버:8080` 접속 → 로그인.
- `GET /api/health` → `{ "ok": true, "version": … }`

## 업그레이드

[`packaging/upgrade.sh`](../packaging/upgrade.sh)(Linux) / [`packaging/upgrade.ps1`](../packaging/upgrade.ps1)(Windows) 사용.
**app 파일(`server/`·`web/`·`node_modules/`·`package.json`)만 교체**하고 `config.json`·`data/` 는 보존합니다.
기동 시 DB 마이그레이션이 자동 적용됩니다.

## 문제 해결

| 증상 | 원인·조치 |
|------|-----------|
| 기동 즉시 종료 | Node 버전 확인(`node -v` → 20/22). 로그(systemd `journalctl -u qaevidence -e` / WinSW `*.err.log`) 확인. |
| `better-sqlite3` 로드 오류 | 패키징 OS/아키텍처 불일치 → 대상에서 `npm rebuild better-sqlite3`. |
| 로그인 후 바로 로그아웃 | 리버스 프록시 HTTPS인데 `secureCookies`/`trustProxy` 누락, 또는 `data/` 쓰기권한 없음(세션 시크릿 생성 실패). |
| 포트 충돌 | `config.json` 의 `port` 또는 `PORT` 환경변수 변경. |
