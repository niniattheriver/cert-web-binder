#!/usr/bin/env bash
# 인증 근거자료 웹 바인더: 업그레이드 (Linux/systemd, 설계서 §7)
# 배포 파일을 새 릴리스로 바꾼다: 실행 엔진(runtime/), server/ web/ node_modules/ packaging/ docs/ 와 루트의 package.json,
# config.example.json, 시작 스크립트, 설명서(README.md, 처음 읽어주세요.txt), 고지(NOTICE, LICENSE, THIRD_PARTY_LICENSES.txt).
# 실행 엔진도 함께 바꿔야 새 node_modules 의 네이티브 모듈(better-sqlite3)과 짝이 맞는다. config.json 과 data/ 는 그대로 둔다.
#
# 안전장치 (upgrade.ps1 과 같다)
# - 서비스가 멈춘 것을 확인한 뒤에만 파일을 바꾼다.
# - 바꾸기 전의 파일과 DB(data/app.db)는 설치 루트의 _upgrade_backup_<시각>/ 에 남긴다.
# - 파일을 바꾸다 실패하면 이전 파일로 되돌리고 이전 버전으로 서비스를 다시 켠다.
# - 새 버전이 /api/health 에 응답하지 않으면 실패(종료 코드 1)로 끝내고 되돌리는 명령을 알려 준다.
#
# 사용법:
#   sudo ./upgrade.sh /opt/qaevidence /path/to/새릴리스.zip
# 되돌리기(업그레이드가 남긴 백업 폴더로):
#   sudo ./upgrade.sh --rollback /opt/qaevidence /opt/qaevidence/_upgrade_backup_20261014-093000
# 서비스 이름, 실행 계정이 다르면 QAE_SERVICE, QAE_USER 로 지정한다(기본 qaevidence). 새 버전의 응답을 기다리는 최대 초는
# QAE_HEALTH_TIMEOUT(기본 180, 처음 켜는 서버는 1~3분 걸릴 수 있다).
set -euo pipefail

SERVICE="${QAE_SERVICE:-qaevidence}"
SERVICE_USER="${QAE_USER:-qaevidence}"
HEALTH_TIMEOUT="${QAE_HEALTH_TIMEOUT:-180}"
# 새 릴리스로 바꾸는 항목 (release.mjs 가 zip 루트에 두는 것. 이 릴리스에 없는 항목은 건너뛴다)
ITEMS=(runtime server web node_modules packaging docs package.json config.example.json start-windows.bat start-linux.sh
  README.md "처음 읽어주세요.txt" NOTICE LICENSE THIRD_PARTY_LICENSES.txt)
# 백업 폴더에 남기는 목록 파일 (되돌릴 때 이 항목들을 지우고 백업에 있던 것을 되돌린다)
MANIFEST="upgrade-items.txt"
DB_FILES=(app.db app.db-wal app.db-shm)

MODE="upgrade"
if [ "${1:-}" = "--rollback" ]; then
  MODE="rollback"
  shift
fi
INSTALL_ROOT="${1:?설치 루트 경로를 지정하세요 (예: /opt/qaevidence)}"
INSTALL_ROOT="$(cd "${INSTALL_ROOT}" && pwd)"

# config.json 의 값 하나 (동봉 실행 엔진으로 읽고, 없으면 글자로 찾는다)
config_value() {
  local key="$1" cfg="${INSTALL_ROOT}/config.json"
  [ -f "${cfg}" ] || return 0
  if [ -x "${INSTALL_ROOT}/runtime/node" ]; then
    "${INSTALL_ROOT}/runtime/node" -e \
      'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v != null) process.stdout.write(String(v));' \
      "${cfg}" "${key}" 2>/dev/null || true
  else
    sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\).*/\1/p" "${cfg}" | head -n1 | sed 's/[[:space:]]*$//'
  fi
}

data_dir() {
  local d
  d="$(config_value dataDir)"
  [ -n "${d}" ] || d="./data"
  case "${d}" in
    /*) printf '%s' "${d}" ;;
    *) printf '%s/%s' "${INSTALL_ROOT}" "${d#./}" ;;
  esac
}

stop_service() {
  echo "[업그레이드] 서비스 중지: ${SERVICE}"
  systemctl stop "${SERVICE}"
  # stop 은 멈출 때까지 기다린다. 그래도 돌고 있으면 파일을 바꾸지 않는다
  if systemctl is-active --quiet "${SERVICE}"; then
    echo "[업그레이드] 서비스가 멈추지 않았습니다. 파일은 바꾸지 않았습니다." >&2
    exit 1
  fi
}

health_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 -o /dev/null "$1" 2>/dev/null
  else
    "${INSTALL_ROOT}/runtime/node" -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$1"
  fi
}

# 서비스를 켜고 /api/health 가 200 을 돌려줄 때까지 기다린다 (포트는 config.json, 없으면 8080)
start_and_wait() {
  local port url waited=0
  systemctl start "${SERVICE}" || return 1
  port="$(config_value port)"
  [ -n "${port}" ] || port=8080
  url="http://127.0.0.1:${port}/api/health"
  while [ "${waited}" -lt "${HEALTH_TIMEOUT}" ]; do
    if health_ok "${url}"; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

if [ "${MODE}" = "rollback" ]; then
  # ── 되돌리기 ──────────────────────────────────────────────────────────────
  BACKUP="${2:?되돌릴 백업 폴더(_upgrade_backup_<시각>)를 지정하세요}"
  BACKUP="$(cd "${BACKUP}" && pwd)"
  if [ ! -f "${BACKUP}/${MANIFEST}" ]; then
    echo "업그레이드 백업 폴더가 아닙니다(${MANIFEST} 없음): ${BACKUP}" >&2
    exit 1
  fi
  stop_service
  echo "[되돌리기] 배포 파일을 백업의 것으로 되돌립니다: ${BACKUP}"
  while IFS= read -r item; do
    [ -n "${item}" ] || continue
    rm -rf "${INSTALL_ROOT:?}/${item}"
    if [ -e "${BACKUP}/${item}" ]; then mv "${BACKUP}/${item}" "${INSTALL_ROOT}/${item}"; fi
  done < "${BACKUP}/${MANIFEST}"
  # DB 는 업그레이드 직전 사본으로 (새 버전이 마이그레이션으로 바꿨을 수 있다). 지금의 WAL 이 옛 DB 에 섞이지 않게 먼저 지운다
  DATA_DIR="$(data_dir)"
  if [ -f "${BACKUP}/data/app.db" ]; then
    for f in "${DB_FILES[@]}"; do rm -f "${DATA_DIR}/${f}"; done
    for f in "${DB_FILES[@]}"; do
      if [ -f "${BACKUP}/data/${f}" ]; then cp -a "${BACKUP}/data/${f}" "${DATA_DIR}/${f}"; fi
    done
    echo "[되돌리기] DB 를 업그레이드 직전 사본으로 되돌렸습니다"
  fi
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_ROOT}"
  echo "[되돌리기] 서비스 시작"
  if start_and_wait; then
    echo "[되돌리기] 완료. 이전 버전이 응답합니다."
    exit 0
  fi
  echo "[되돌리기] 이전 버전이 응답하지 않습니다. journalctl -u ${SERVICE} -e 로 확인하세요." >&2
  exit 1
fi

# ── 업그레이드 ────────────────────────────────────────────────────────────────
RELEASE_ZIP="${2:?새 릴리스 zip 경로를 지정하세요}"

# 1) 새 릴리스를 임시 폴더에 풀고 구성을 확인한다 (설치 폴더는 아직 건드리지 않는다)
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
echo "[업그레이드] 압축 해제: ${RELEASE_ZIP}"
unzip -q "${RELEASE_ZIP}" -d "${TMP}"
SRC="$(find "${TMP}" -maxdepth 1 -mindepth 1 -type d | head -n1)"
if [ -z "${SRC}" ] || [ ! -d "${SRC}/server" ] || [ ! -d "${SRC}/runtime" ]; then
  echo "릴리스 zip 의 구성이 예상과 다릅니다(server, runtime 폴더가 없음): ${RELEASE_ZIP}" >&2
  exit 1
fi

# 2) 서비스 중지 (돌고 있는 실행 엔진 밑에서 파일을 바꾸지 않는다)
stop_service

# 3) 바꾸기 전의 DB 사본
BACKUP="${INSTALL_ROOT}/_upgrade_backup_$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP}/data"
DATA_DIR="$(data_dir)"
for f in "${DB_FILES[@]}"; do
  if [ -f "${DATA_DIR}/${f}" ]; then cp -a "${DATA_DIR}/${f}" "${BACKUP}/data/${f}"; fi
done

# 4) 배포 파일 바꾸기: 이전 것은 백업 폴더로 옮기고 새 것을 복사한다. 실패하면 되돌리고 이전 버전으로 다시 켠다
echo "[업그레이드] 배포 파일 교체 (config.json, data/ 는 그대로)"
MOVED=()
COPIED=()
replace_items() {
  local item
  for item in "${ITEMS[@]}"; do
    [ -e "${SRC}/${item}" ] || continue
    if [ -e "${INSTALL_ROOT}/${item}" ]; then
      mv "${INSTALL_ROOT}/${item}" "${BACKUP}/${item}" || return 1
      MOVED+=("${item}")
    fi
    COPIED+=("${item}")
    cp -a "${SRC}/${item}" "${INSTALL_ROOT}/${item}" || return 1
  done
}
if ! replace_items; then
  echo "[업그레이드] 파일을 바꾸다 실패했습니다. 이전 파일로 되돌리고 이전 버전으로 다시 켭니다" >&2
  # 빈 배열도 set -u 에 걸리지 않게 (bash 4.3 이하)
  for item in ${COPIED[@]+"${COPIED[@]}"}; do rm -rf "${INSTALL_ROOT:?}/${item}"; done
  for item in ${MOVED[@]+"${MOVED[@]}"}; do mv "${BACKUP}/${item}" "${INSTALL_ROOT}/${item}"; done
  systemctl start "${SERVICE}" || true
  exit 1
fi
printf '%s\n' "${COPIED[@]}" > "${BACKUP}/${MANIFEST}"

echo "[업그레이드] 소유권 정리"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_ROOT}"

# 5) 새 버전 시작과 응답 확인 (기동 때 DB 마이그레이션이 자동으로 적용된다)
echo "[업그레이드] 서비스 시작 (기동 시 DB 마이그레이션 자동 적용)"
if start_and_wait; then
  echo "[업그레이드] 완료. 새 버전이 응답합니다. config.json 과 data/ 는 그대로입니다."
  echo "  이전 파일과 업그레이드 직전 DB 사본: ${BACKUP} (새 버전을 확인한 뒤 지워도 됩니다)"
  exit 0
fi
systemctl --no-pager --lines=10 status "${SERVICE}" || true
echo "[업그레이드] 새 버전이 ${HEALTH_TIMEOUT}초 안에 응답하지 않습니다. journalctl -u ${SERVICE} -e 로 확인하세요." >&2
echo "  이전 버전으로 되돌리려면: sudo $0 --rollback \"${INSTALL_ROOT}\" \"${BACKUP}\"" >&2
exit 1
