#!/usr/bin/env bash
# 인증 근거자료 웹 바인더 — 업그레이드 (Linux/systemd, 설계서 §7)
# app 파일(server/ web/ node_modules/ package.json)만 교체하고 config.json·data/ 는 보존한다.
#
# 사용법:
#   sudo ./upgrade.sh /opt/qaevidence /path/to/새릴리스.zip
set -euo pipefail

INSTALL_ROOT="${1:?설치 루트 경로를 지정하세요 (예: /opt/qaevidence)}"
RELEASE_ZIP="${2:?새 릴리스 zip 경로를 지정하세요}"
SERVICE="qaevidence"

echo "[업그레이드] 서비스 중지: ${SERVICE}"
systemctl stop "${SERVICE}"

# 안전망: 교체 전 즉시 DB 스냅샷은 서비스 정지 전에 남기는 것이 이상적이나,
# 야간 백업(data/backups)이 있으므로 여기서는 app 파일만 교체한다.
TMP="$(mktemp -d)"
echo "[업그레이드] 압축 해제: ${RELEASE_ZIP}"
unzip -q "${RELEASE_ZIP}" -d "${TMP}"
SRC="$(find "${TMP}" -maxdepth 1 -mindepth 1 -type d | head -n1)"

echo "[업그레이드] app 파일 교체 (config.json·data/ 보존)"
for item in server web node_modules package.json config.example.json packaging docs; do
  if [ -e "${SRC}/${item}" ]; then
    rm -rf "${INSTALL_ROOT}/${item}"
    cp -a "${SRC}/${item}" "${INSTALL_ROOT}/${item}"
  fi
done

rm -rf "${TMP}"
echo "[업그레이드] 소유권 정리"
chown -R qaevidence:qaevidence "${INSTALL_ROOT}"

echo "[업그레이드] 서비스 시작 (기동 시 DB 마이그레이션 자동 적용)"
systemctl start "${SERVICE}"
sleep 2
systemctl --no-pager --lines=5 status "${SERVICE}" || true
echo "[업그레이드] 완료. config.json 과 data/ 는 그대로 유지되었습니다."
