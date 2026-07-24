/**
 * 세션 미들웨어 구성 (설계서 §5)
 * - express-session + SqliteSessionStore, 쿠키 httpOnly·SameSite=Lax, 유휴 12시간(rolling).
 * - secure 플래그는 config.secureCookies 조건부(내부망 HTTP 기본 false).
 * - 세션 시크릿은 최초 기동 시 dataDir/session-secret.txt(0600)에 자동 생성(설계서 §7).
 */
import type Database from 'better-sqlite3';
import type { RequestHandler } from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SqliteSessionStore } from './session-store.js';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12시간 유휴 만료

/** dataDir의 세션 시크릿 로드(없으면 생성, 0600) */
function loadOrCreateSecret(dataDir: string): string {
  const secretPath = path.join(dataDir, 'session-secret.txt');
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret + '\n', { mode: 0o600 });
  return secret;
}

export function createSessionMiddleware(db: Database.Database, dataDir: string): RequestHandler {
  const store = new SqliteSessionStore(db);
  return session({
    store,
    secret: loadOrCreateSecret(dataDir),
    name: 'webbinder.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true, // 요청마다 유휴 만료 연장
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies === true,
      maxAge: SESSION_TTL_MS,
    },
  });
}
