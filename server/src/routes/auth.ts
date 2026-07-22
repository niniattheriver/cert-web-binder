/**
 * 인증 라우트 (API 계약)
 * - POST /api/auth/login  {username,password} → {user} | 401 {error:'invalid_credentials'}
 * - POST /api/auth/logout → {ok:true}
 * - GET  /api/me          → {user|null, settings} (공개 — 로그인 화면이 시스템명을 표시해야 함)
 */
import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { Router, type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dataDir } from '../config.js';
import { logChange } from '../db/change-log.js';
import { getSettings } from '../db/settings.js';
import { loadSessionUser, requireAuth, type AuthUser } from '../middleware/auth.js';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// ── 로그인 시도 제한 (무차별 대입 완화) ──
// 사용자명+IP 조합으로 연속 실패를 세고, 임계 초과 시 잠금 시간 동안 429 를 반환한다.
// 프로세스 메모리 기반(내부망 단일 프로세스 전제) — 재기동 시 초기화되는 것은 허용 범위.
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
interface FailState { count: number; lockedUntil: number }
const loginFails = new Map<string, FailState>();

function loginFailKey(username: string, ip: string | undefined): string {
  return `${username}|${ip ?? '?'}`;
}

/** 잠금 중이면 남은 ms, 아니면 0. 잠금이 만료된 항목은 카운터를 리셋(삭제)해 새로 5회를 부여한다. */
export function loginLockRemaining(username: string, ip: string | undefined, now = Date.now()): number {
  const key = loginFailKey(username, ip);
  const st = loginFails.get(key);
  if (!st) return 0;
  if (st.lockedUntil > now) return st.lockedUntil - now;
  if (st.lockedUntil !== 0) loginFails.delete(key); // 잠금 만료 → 실패 카운터 리셋
  return 0;
}

export function recordLoginFailure(username: string, ip: string | undefined, now = Date.now()): void {
  const key = loginFailKey(username, ip);
  const prev = loginFails.get(key);
  // 잠금이 만료된 채 남은 항목은 새 시도로 취급(카운터 리셋)
  const st = prev && !(prev.lockedUntil !== 0 && prev.lockedUntil < now) ? prev : { count: 0, lockedUntil: 0 };
  st.count += 1;
  if (st.count >= LOGIN_FAIL_LIMIT) st.lockedUntil = now + LOGIN_LOCK_MS;
  loginFails.set(key, st);
  // 무한 성장 방지 — 잠금이 만료됐거나 잠긴 적 없는 항목은 전부 정리 대상
  if (loginFails.size > 10_000) {
    for (const [k, v] of loginFails) {
      if (v.lockedUntil < now) loginFails.delete(k);
    }
  }
}

export function clearLoginFailures(username: string, ip: string | undefined): void {
  loginFails.delete(loginFailKey(username, ip));
}

/** 해당 사용자의 세션을 모두 무효화(현재 세션 sid 는 예외 가능) — 비밀번호 변경·재설정 시 사용 */
export function destroyUserSessions(db: Database.Database, userId: number, exceptSid?: string): void {
  if (exceptSid !== undefined) {
    db.prepare("DELETE FROM session WHERE json_extract(sess, '$.userId') = ? AND sid <> ?").run(userId, exceptSid);
  } else {
    db.prepare("DELETE FROM session WHERE json_extract(sess, '$.userId') = ?").run(userId);
  }
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, '새 비밀번호는 8자 이상이어야 합니다.').max(200),
});

interface LoginUserRow {
  id: number;
  username: string;
  pw_hash: string;
  display_name: string;
  role: AuthUser['role'];
  expires_at: string | null;
  active: number;
}

export function createAuthRouter(db: Database.Database): Router {
  const router = Router();

  router.post('/login', (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const { username, password } = parsed.data;

    const lockMs = loginLockRemaining(username, req.ip);
    if (lockMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(lockMs / 1000)));
      res.status(429).json({
        error: 'too_many_attempts',
        details: `로그인 시도가 너무 많습니다. ${Math.ceil(lockMs / 1000)}초 후 다시 시도하세요.`,
      });
      return;
    }

    const row = db
      .prepare(
        'SELECT id, username, pw_hash, display_name, role, expires_at, active FROM user WHERE username = ?',
      )
      .get(username) as LoginUserRow | undefined;

    const valid =
      row !== undefined &&
      row.active === 1 &&
      (!row.expires_at || row.expires_at > new Date().toISOString()) &&
      bcrypt.compareSync(password, row.pw_hash);

    if (!valid) {
      recordLoginFailure(username, req.ip);
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    clearLoginFailures(username, req.ip);

    // 세션 고정 공격 방지: 로그인 성공 시 세션 재생성
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = row.id;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.json({
          user: {
            id: row.id,
            username: row.username,
            displayName: row.display_name,
            role: row.role,
          },
        });
      });
    });
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('webbinder.sid');
      res.json({ ok: true });
    });
  });

  // 내 비밀번호 변경 — 모든 로그인 사용자. 현재 비밀번호 확인 후 교체(세션 유지).
  router.post('/change-password', requireAuth(db), (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const me = req.user!;
    const row = db.prepare('SELECT pw_hash FROM user WHERE id = ?').get(me.id) as
      | { pw_hash: string }
      | undefined;
    if (!row || !bcrypt.compareSync(parsed.data.currentPassword, row.pw_hash)) {
      res.status(400).json({ error: 'invalid_current_password', details: '현재 비밀번호가 올바르지 않습니다.' });
      return;
    }
    db.prepare('UPDATE user SET pw_hash = ? WHERE id = ?').run(
      bcrypt.hashSync(parsed.data.newPassword, 10),
      me.id,
    );
    // 다른 기기·브라우저에 남아 있던 세션은 모두 무효화 (현재 세션만 유지)
    destroyUserSessions(db, me.id, req.sessionID);
    logChange(db, {
      actorId: me.id,
      actorKind: 'user',
      entity: 'user',
      entityId: me.id,
      action: 'change_password', // 값 미기록
    });
    res.json({ ok: true });
  });

  return router;
}

/** GET /api/me — 미로그인도 접근 가능(user:null), 설정은 항상 반환 */
export function createMeHandler(db: Database.Database): RequestHandler {
  const pwFile = path.join(dataDir, 'initial-admin-password.txt');
  return (req, res) => {
    const user = loadSessionUser(db, req);
    res.json({
      user,
      settings: {
        ...getSettings(db),
        // 초기 비밀번호 파일이 아직 있으면 로그인 화면이 안내 문구를 띄운다 (최초 설치 UX)
        hasInitialAdminPassword: fs.existsSync(pwFile),
      },
    });
  };
}
