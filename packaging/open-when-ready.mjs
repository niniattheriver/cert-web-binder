/**
 * Windows 시작 도우미 — 서버가 실제로 응답할 때까지 기다렸다가 브라우저를 연다.
 * start-windows.bat 이 백그라운드로 실행한다(cwd = 설치 루트).
 *
 * 왜 필요한가: 첫 실행 PC에서는 Windows 보안 검사(Defender)가 동봉 실행 엔진과 수천 개
 * 파일을 처음 훑느라 기동까지 1~3분이 걸린다. 고정 지연(3초) 뒤 브라우저를 열면
 * "사이트에 연결할 수 없음"이 떠서 비개발자가 고장으로 오인한다(실PC 보고 사례).
 *
 * - 포트는 config.json 의 port 를 읽는다(없으면 8080) — bat 은 CP949 인코딩이 민감해
 *   설정 파싱을 이 JS 파일이 대신한다.
 * - 최대 10분까지 1초 간격으로 /api/health 를 확인하고, 응답이 오면 기본 브라우저를 연다.
 */
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

let port = 8080;
try {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config.json'), 'utf8'));
  if (Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536) port = cfg.port;
} catch {
  // config.json 이 없거나 읽기 실패 — 기본 8080
}
const url = `http://localhost:${port}`;
const deadline = Date.now() + 10 * 60 * 1000; // 첫 실행 보안 검사 대비 최대 10분

function openBrowser() {
  const cmd = process.platform === 'win32' ? `start "" ${url}` : `open ${url}`;
  exec(cmd, () => {
    // 브라우저 실행 실패는 무시 — 콘솔 안내에 주소가 이미 표시되어 있다
  });
}

function tick() {
  fetch(`${url}/api/health`)
    .then((r) => {
      if (r.ok) openBrowser();
      else retry();
    })
    .catch(retry);
}
function retry() {
  if (Date.now() < deadline) setTimeout(tick, 1000);
}
tick();
