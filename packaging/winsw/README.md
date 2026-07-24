# Windows 서비스 설치 (WinSW)

Windows에서 웹 바인더를 자동 시작·자동 재시작 서비스로 등록하는 방법입니다.
(설계서 §7 — 릴리스 zip에 실행 엔진 동봉, 선행 설치 없음)

## 준비물

1. 릴리스 zip (실행 엔진 `runtime\node.exe` 동봉 — Node 별도 설치 불필요).
2. **WinSW 실행파일** (MIT 라이선스). 내부망 정책상 저장소에는 바이너리를 동봉하지 않습니다.
   보안팀 승인 하에 아래에서 1회 내려받아 사용하세요.
   - https://github.com/winsw/winsw/releases (예: `WinSW-x64.exe`)
   - 내려받은 파일을 **`qaevidence-service.exe`** 로 이름을 바꿉니다.

## 배치

릴리스 zip을 설치 루트(예: `C:\qaevidence`)에 펼친 뒤, 그 **루트**에 아래 두 파일을 둡니다.

```
C:\qaevidence\
├── qaevidence-service.exe     ← WinSW 실행파일(이름 변경본)
├── qaevidence.xml             ← 이 폴더의 파일을 복사
├── server\  web\  node_modules\  package.json  config.example.json
├── config.json                ← config.example.json 을 복사해 생성(포트 등 조정)
└── data\                      ← 최초 기동 시 자동 생성
```

`%BASE%`(=서비스 실행파일 폴더)가 설치 루트가 되도록 반드시 루트에 둡니다.

## 명령

```bat
:: 관리자 명령 프롬프트에서
cd C:\qaevidence
copy packaging\winsw\qaevidence.xml qaevidence.xml
qaevidence-service.exe install
qaevidence-service.exe start
```

- 상태:   `qaevidence-service.exe status`
- 중지:   `qaevidence-service.exe stop`
- 제거:   `qaevidence-service.exe uninstall`
- 로그:   설치 루트의 `qaevidence-service.out.log` / `.err.log`

## 업그레이드

`packaging\upgrade.ps1` 참고 — 서비스 중지 → `server\ web\ node_modules\ package.json` 교체 →
서비스 시작. **`config.json` 과 `data\` 는 건드리지 않습니다.**
