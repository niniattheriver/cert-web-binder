#!/bin/sh
# 우수검사실 인증심사 웹 바인더 — 간단 실행 (터미널에서: sh start-linux.sh)
# 실행 엔진(Node)이 runtime/ 에 동봉되어 있어 별도 설치가 필요 없습니다.
# 상시 운영(자동 시작)은 packaging/qaevidence.service 참고.
cd "$(dirname "$0")" || exit 1
NODE_BIN="./runtime/node"
if [ ! -x "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=node
  else
    echo "실행 엔진을 찾지 못했습니다 — zip 을 전부 압축 해제했는지 확인하세요 (runtime/node)."
    exit 1
  fi
fi
export NODE_ENV=production
echo "웹 바인더 시작 — 브라우저에서 http://localhost:8080 을 여세요."
echo "(config.json 에서 port 를 바꿨다면 그 포트로 접속하세요.)"
echo "(이 터미널을 닫으면 서버가 종료됩니다. 상시 운영: packaging/qaevidence.service)"
exec "$NODE_BIN" --import tsx server/src/index.ts
