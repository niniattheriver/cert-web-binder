/**
 * 설정 로더 (설계서 §1, §9)
 * - 저장소 루트의 config.json을 읽는다. 없으면 기본값으로 생성한다.
 * - config.json은 git 제외(.gitignore) — 커밋용 견본은 config.example.json.
 * - dataDir는 루트 기준 상대경로를 절대경로로 해석하고 디렉토리를 생성한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  /** HTTP 포트 (SPA + JSON API 단일 포트). 환경변수 PORT가 있으면 그 값이 우선한다. */
  port: number;
  /** 런타임 상태 디렉토리 (app.db, files/, backups/) — git 제외 */
  dataDir: string;
  /** PDF 업로드 최대 크기(MB) */
  maxPdfMB: number;
  /** 세션 쿠키 secure 플래그 (내부망 HTTP 기본이므로 false — HTTPS 종단 시에만 true) */
  secureCookies?: boolean;
  /**
   * 리버스 프록시(예: Nginx/Caddy TLS 종단) 뒤에서 구동할 때 Express 'trust proxy' 값.
   * 예: 1(직전 프록시 1홉 신뢰) 또는 "127.0.0.1". 미설정(기본)이면 프록시를 신뢰하지 않는다 —
   * secureCookies:true 를 쓰려면 반드시 함께 설정해야 세션 쿠키가 정상 발급된다.
   */
  trustProxy?: boolean | number | string;
}

const DEFAULTS: AppConfig = { port: 8080, dataDir: './data', maxPdfMB: 200 };

// server/src/config.ts (또는 server/dist/config.js) → 두 단계 위 = 저장소 루트
const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '..', '..');

const configPath = path.join(rootDir, 'config.json');

function loadConfig(): AppConfig {
  let loaded: AppConfig;
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
    loaded = { ...DEFAULTS };
  } else {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>;
    loaded = { ...DEFAULTS, ...raw };
  }
  // 환경변수 PORT 오버라이드 (검증·임시 기동용 — config.json은 건드리지 않음)
  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
    loaded.port = envPort;
  }
  // 기본 검증 — 잘못된 설정은 기동 단계에서 알기 쉬운 메시지로 실패시킨다
  if (!Number.isInteger(loaded.port) || loaded.port < 1 || loaded.port > 65535) {
    throw new Error(`config.json의 port 값이 올바르지 않습니다: ${JSON.stringify(loaded.port)} (1~65535 정수)`);
  }
  if (typeof loaded.maxPdfMB !== 'number' || !(loaded.maxPdfMB > 0) || loaded.maxPdfMB > 2048) {
    throw new Error(`config.json의 maxPdfMB 값이 올바르지 않습니다: ${JSON.stringify(loaded.maxPdfMB)} (1~2048)`);
  }
  if (typeof loaded.dataDir !== 'string' || loaded.dataDir.trim() === '') {
    throw new Error('config.json의 dataDir 값이 올바르지 않습니다 (비어 있지 않은 경로 문자열)');
  }
  if (loaded.trustProxy === true) {
    // true = 모든 프록시 신뢰 → X-Forwarded-* 위조로 IP 기반 방어(로그인 잠금)와
    // secure 쿠키 판정이 무력화된다. 홉 수(예: 1) 또는 프록시 주소로만 허용.
    throw new Error(
      'config.json의 trustProxy 는 true(전부 신뢰)를 허용하지 않습니다 — 홉 수(예: 1) 또는 프록시 주소(예: "127.0.0.1")로 지정하세요.',
    );
  }
  return loaded;
}

export const config: AppConfig = loadConfig();

/** dataDir 절대경로 (상대경로면 저장소 루트 기준) */
export const dataDir = path.isAbsolute(config.dataDir)
  ? config.dataDir
  : path.resolve(rootDir, config.dataDir);

fs.mkdirSync(dataDir, { recursive: true });
