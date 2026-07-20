@echo off
rem =====================================================================
rem  우수검사실 인증심사 웹 바인더 - 간단 실행 (더블클릭)
rem  실행 엔진(Node)이 runtime\ 폴더에 동봉되어 있어 별도 설치가 필요 없습니다.
rem  상시 운영(부팅 시 자동 시작)은 packaging\winsw 안내를 참고하세요.
rem =====================================================================
cd /d "%~dp0"
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" goto run
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   실행 엔진을 찾지 못했습니다.
  echo   zip 파일을 "모두 압축 풀기"로 전부 풀었는지 확인해 주세요.
  echo   (runtime\node.exe 파일이 함께 풀려 있어야 합니다^)
  echo.
  pause
  exit /b 1
)
set "NODE_EXE=node"
:run
set NODE_ENV=production
echo.
echo   웹 바인더를 시작합니다 - 잠시 후 브라우저가 자동으로 열립니다.
echo   주소: http://localhost:8080   (안 열리면 브라우저 주소창에 직접 입력^)
rem config.json 에서 port 를 바꿨다면 위/아래 주소의 8080 도 그 포트로 읽으세요.
echo   이 창을 닫으면 서버가 종료됩니다.
echo.
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:8080"
"%NODE_EXE%" --import tsx server/src/index.ts
echo.
echo   서버가 종료되었습니다. 위에 오류 메시지가 보이면 그 내용을 전달해 주세요.
pause
