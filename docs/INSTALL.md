# 설치 (내부망 오프라인)

인증 근거자료 웹 바인더는 **단일 Node 프로세스**가 웹화면(SPA)과 API를 한 포트로 서빙합니다.
릴리스 zip에는 **실행 엔진(Node)이 동봉**되어 대상 서버에 선행 설치가 필요 없고, 런타임에 인터넷·CDN 접근이 전혀 없습니다.
(소스에서 직접 실행하는 경우에만 Node LTS 20.19+/22.12+ 설치가 필요합니다.)

**지원 OS: Windows x64 · Linux x64.** (macOS용 배포본은 제공하지 않습니다 — 릴리스 zip의
실행 엔진이 해당 OS 전용이라 맥에서는 실행되지 않습니다. 맥에서는 소스로 개발 실행만 가능합니다.)

## 0. 가장 간단한 실행 (개발 지식 불필요)

릴리스 zip에는 **실행 엔진(Node)이 동봉**되어 있어 아무것도 미리 설치할 필요가 없습니다.
GitHub **Releases에서 zip을 내려받아 푼 뒤** (zip 안의 `처음 읽어주세요.txt` 에도 같은 내용이 있습니다):

- **Windows**: `start-windows.bat` **더블클릭** → 준비가 끝나면 브라우저가 자동으로 열립니다.
  (**처음 실행하는 PC에서는 보안 검사 때문에 1~3분** 걸릴 수 있습니다 — 검은 창을 닫지 말고
  기다리세요. 실행 스크립트가 서버 응답을 확인한 뒤에 브라우저를 열므로, 열린 화면이 오류일
  일은 없습니다. 두 번째 실행부터는 몇 초입니다.)
- **Linux**: 터미널에서 `sh start-linux.sh` → 브라우저에서 `http://localhost:8080` 접속.

첫 실행 시 관리자 계정(`admin`)의 초기 비밀번호가 실행 창(콘솔)에 1회 표시되고
`data/initial-admin-password.txt` 에도 기록됩니다 — 놓쳤다면 이 파일을 열어 확인하세요.
(파일이 남아 있는 동안은 매 부팅 콘솔과 로그인 화면에 파일 위치가 안내됩니다.
관리자 비밀번호를 바꾸면 이 파일은 자동으로 삭제됩니다.)
창을 닫으면 서버가 꺼지므로, **상시 운영**(부팅 시 자동 시작)은 아래 4장의 서비스 등록을 따르세요.

### 0-1. Windows 방화벽 — 다른 PC에서도 접속하려면

- 첫 실행 때 Windows가 **"이 앱의 기능 중 일부를 차단했습니다"** 방화벽 창을 띄우면
  **[액세스 허용]** 을 누르세요. 체크 상자는 기관 네트워크가 "개인 네트워크"로 잡혀 있으면 개인만,
  잘 모르겠으면 둘 다 체크해도 됩니다.
- 허용하지 않으면 **서버 PC에서는 열리지만 다른 PC에서는 접속되지 않습니다.** 나중에 허용하려면:
  제어판 → Windows Defender 방화벽 → "Windows Defender 방화벽을 통해 앱 또는 기능 허용" 에서
  `node.exe`(또는 웹 바인더 항목)를 찾아 체크하세요.
- 다른 PC에서 접속할 주소는 실행 창(검은 창)에 **"같은 내부망에서 열기: http://…"** 로 표시됩니다.
  안 보이면 서버 PC에서 `ipconfig` 를 실행해 "IPv4 주소"를 확인하고 `http://그주소:8080` 으로 접속하세요.

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

압축을 풀면 `cert-web-binder-<버전>-<플랫폼>` 폴더가 나오고, 그 안에 `server/ web/ node_modules/ runtime/ package.json
config.example.json packaging/ docs/` 와 시작 스크립트(`start-windows.bat` 또는 `start-linux.sh`), `처음 읽어주세요.txt`,
`README.md`, `NOTICE`, `LICENSE`, `THIRD_PARTY_LICENSES.txt` 가 들어 있습니다. 이 폴더 안의 내용을 위 설치 루트에 둡니다.

## 3. 설정

```bash
cp config.example.json config.json     # 필요 시 port/dataDir/maxPdfMB 수정
```

```json
{ "port": 8080, "dataDir": "./data", "maxPdfMB": 200 }
```

- `port`: SPA+API 단일 포트(환경변수 `PORT` 가 있으면 우선).
- `dataDir`: 런타임 상태 폴더(설치 루트 기준 상대경로 또는 절대경로).
- `maxPdfMB`: 근거자료 파일 업로드 최대 크기(MB). 이름과 달리 PDF, Word(docx, doc), Excel(xlsx, xls),
  PowerPoint(pptx), 한글(hwpx, hwp), 텍스트 모두에 적용됩니다.
- (선택) `secureCookies`: HTTPS 종단(리버스 프록시) 뒤에 둘 때만 `true`. 내부망 HTTP 기본은 생략.
- (선택) `trustProxy`: HTTPS 리버스 프록시(Nginx/Caddy 등) 뒤에 둘 때 **`secureCookies`와 함께 반드시 설정**.
  프록시가 서버 바로 앞 1대면 `"trustProxy": 1`, 특정 주소만 신뢰하려면 `"trustProxy": "127.0.0.1"`.
  이 값이 없으면 Express가 요청을 HTTP로 판단해 secure 쿠키가 발급되지 않아 로그인이 유지되지 않습니다.
  `true`(모든 프록시 신뢰)는 헤더 위조 위험 때문에 서버가 거부합니다 — 홉 수나 주소로 지정하세요.

`config.json` 이 없으면 최초 기동 시 기본값으로 자동 생성됩니다. **세션 시크릿은 설정에 두지 않습니다** —
최초 기동 시 `data/session-secret.txt`(권한 0600)로 자동 생성되어 재기동·업그레이드 후에도 유지됩니다.

## 4. 서비스 등록 (자동 시작·자동 재시작)

- **Linux(systemd)** — [`packaging/qaevidence.service`](../packaging/qaevidence.service) 상단 주석대로
  전용 사용자 생성 → 데이터 폴더(`data/`)와 설정 파일(`config.json`) 준비 → 소유권 → `/etc/systemd/system/` 복사 →
  `sudo systemctl enable --now qaevidence`.
- **Windows(WinSW)** — [`packaging/winsw/README.md`](../packaging/winsw/README.md) 참조(WinSW 실행파일은
  내부망 정책상 보안팀 승인 하에 1회 내려받아 `qaevidence-service.exe` 로 배치).
- **컨테이너(선택)** — [`packaging/Dockerfile`](../packaging/Dockerfile).
- **수동 실행(점검용)** — 설치 루트에서 `NODE_ENV=production npm start`
  (`NODE_ENV=production` 이면 `web/dist` SPA를 API와 같은 포트로 정적 서빙).

## 5. 최초 로그인

- 관리자 초기 비밀번호는 `data/initial-admin-password.txt`(권한 0600)에 생성되며 기동 로그에도 출력됩니다.
  (`ADMIN_INITIAL_PASSWORD` 환경변수로 지정도 가능.)
- 아이디는 `admin`. **로그인 후 즉시 비밀번호를 바꾸세요** — 바꾸면 초기 비밀번호 파일은
  자동으로 삭제됩니다(자동 삭제에 실패하면 콘솔에 안내가 뜨니 직접 삭제).

## 6. 확인

- 브라우저에서 `http://서버:8080` 접속 → 로그인.
- `GET /api/health` → `{ "ok": true, "version": … }`

## 업그레이드

- **압축을 풀어 실행해 온 경우**(서비스로 등록하지 않음): 실행 창을 닫고, 새 zip 을 다른 폴더에 풉니다. 이전 폴더의
  `data` 폴더와 `config.json` 을 새 폴더로 복사한 뒤 새 폴더의 `start-windows.bat`(Linux 는 `start-linux.sh`)를 실행합니다.
  이전 폴더는 새 버전을 확인할 때까지 지우지 말고 두세요. 문제가 있으면 새 폴더의 창을 닫고 이전 폴더에서 다시 실행하면
  바꾸기 전 상태로 돌아갑니다.
- **서비스로 등록해 운영하는 경우**: [`packaging/upgrade.sh`](../packaging/upgrade.sh)(Linux) /
  [`packaging/upgrade.ps1`](../packaging/upgrade.ps1)(Windows) 를 씁니다.

```bash
sudo ./upgrade.sh /opt/qaevidence /path/to/새릴리스.zip                         # Linux
.\upgrade.ps1 -InstallRoot C:\qaevidence -ReleaseZip C:\temp\새릴리스.zip      # Windows(관리자 PowerShell)
```

- **바꾸는 것**: 배포 파일 전부. 실행 엔진(`runtime/`), `server/`, `web/`, `node_modules/`, `packaging/`, `docs/`, 루트의
  `package.json`, `config.example.json`, 시작 스크립트, 설명서(`README.md`, `처음 읽어주세요.txt`), 고지(`NOTICE`, `LICENSE`,
  `THIRD_PARTY_LICENSES.txt`). 실행 엔진도 함께 바꿔야 새 `node_modules` 의 네이티브 모듈과 짝이 맞습니다.
- **그대로 두는 것**: `config.json`, `data/`, 서비스 등록 파일(WinSW 실행 파일과 `qaevidence.xml`, systemd 유닛).
- **안전장치**: 서비스가 멈춘 것을 확인한 뒤에만 파일을 바꿉니다. 바꾸기 전의 파일과 DB(`data/app.db`) 사본을 설치 루트의
  `_upgrade_backup_<시각>` 에 남기고, 파일을 바꾸다 실패하면 이전 파일로 되돌려 이전 버전으로 다시 켭니다. 새 버전이
  `/api/health` 에 응답하지 않으면 실패로 끝나고 되돌리는 명령을 알려 줍니다.
- **되돌리기**: `sudo ./upgrade.sh --rollback /opt/qaevidence /opt/qaevidence/_upgrade_backup_<시각>` 또는
  `.\upgrade.ps1 -InstallRoot C:\qaevidence -RollbackFrom C:\qaevidence\_upgrade_backup_<시각>`. 배포 파일과 DB 를 업그레이드
  직전으로 되돌립니다(업그레이드 뒤에 입력한 내용은 DB 와 함께 되돌아갑니다). 새 버전을 확인했으면 백업 폴더는 지워도 됩니다.
- 서비스 이름, 실행 계정이 기본(`qaevidence`)과 다르면 Linux 는 `QAE_SERVICE`, `QAE_USER`, Windows 는 `-ServiceExe` 로 지정합니다.

기동 시 DB 마이그레이션이 자동 적용됩니다. (v1.6.0 의 마이그레이션 008 은 기존 근거자료 버전을 모두 PDF 로 표시하고,
Word, Excel 등 새 형식을 위한 칸을 더합니다. 기존 자료는 바뀌지 않습니다. 마이그레이션 009는 시스템
표시명이 옛 기본값('우수검사실 인증심사 웹 바인더') 그대로이면 '우수검사실 신임인증 웹 바인더'로 바꾸고, 기관 정보 화면에서
직접 정한 이름은 그대로 둡니다. v1.7.0 의 마이그레이션 010 은 근거자료에 그림 파일(png, jpg 등)을 받도록 버전 표를 새로 만들어 옮깁니다.
행 번호와 연결은 그대로입니다.) 업그레이드 스크립트가 남기는 사본은 DB 뿐이므로, 바꾸기 전에 운영 점검 화면의
[전체 백업(원본 파일 포함)]도 한 번 받아 두기를 권합니다.

## 문제 해결

| 증상 | 원인·조치 |
|------|-----------|
| 기동 즉시 종료 | 로그(systemd `journalctl -u qaevidence -e` / WinSW `*.err.log`) 확인. 동봉 런타임(`runtime/`) 대신 시스템 Node로 실행했다면 버전(20.19+/22.12+)·네이티브 모듈 호환 여부 확인. |
| `better-sqlite3` 로드 오류 | 패키징 OS/아키텍처 불일치 → 대상에서 `npm rebuild better-sqlite3`. |
| 로그인 후 바로 로그아웃 | 리버스 프록시 HTTPS인데 `secureCookies`/`trustProxy` 누락, 또는 `data/` 쓰기권한 없음(세션 시크릿 생성 실패). |
| 포트 충돌 | `config.json` 의 `port` 또는 `PORT` 환경변수 변경. |

## 고지

본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
제3자 구성요소와 그 라이선스는 배포 zip 의 `NOTICE`, `THIRD_PARTY_LICENSES.txt` 에 있습니다.
