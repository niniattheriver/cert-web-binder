@echo off
rem 우수검사실 인증심사 웹 바인더 — 간단 실행 (더블클릭)
rem 선행조건: Node.js LTS 1회 설치 (https://nodejs.org). 상시 운영은 packaging\winsw 참고.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js LTS 가 설치되어 있지 않습니다.
  echo   https://nodejs.org 에서 LTS 버전을 한 번만 설치한 뒤 이 파일을 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)
set NODE_ENV=production
echo.
echo   웹 바인더를 시작합니다 — 잠시 후 브라우저가 자동으로 열립니다.
echo   주소: http://localhost:8080   (안 열리면 브라우저에 직접 입력)
rem config.json 에서 port 를 바꿨다면 위/아래 주소의 8080 도 그 포트로 읽어 주세요.
echo   이 창을 닫으면 서버가 종료됩니다. 부팅 시 자동 시작은 packaging\winsw 안내 참고.
echo.
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:8080"
node --import tsx server/src/index.ts
pause
