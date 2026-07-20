#!/bin/sh
# 우수검사실 인증심사 웹 바인더 — 간단 실행 (터미널에서: sh start-linux.sh)
# 선행조건: Node.js LTS 1회 설치. 상시 운영(자동 시작)은 packaging/qaevidence.service 참고.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js LTS 가 설치되어 있지 않습니다 — https://nodejs.org 에서 설치 후 다시 실행하세요."
  exit 1
fi
export NODE_ENV=production
echo "웹 바인더 시작 — 브라우저에서 http://localhost:8080 을 여세요."
echo "(config.json 에서 port 를 바꿨다면 그 포트로 접속하세요.)"
echo "(이 터미널을 닫으면 서버가 종료됩니다. 상시 운영: packaging/qaevidence.service)"
exec node --import tsx server/src/index.ts
