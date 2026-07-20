/**
 * 인증·권한 미들웨어 (설계서 §5, API 계약)
 * - 미인증 → 401 {error:'unauthorized'}, 권한 부족 → 403 {error:'forbidden'}.
 * - viewer는 열람 전용: GET류만 requireAuth로 통과, 변경류(requireEditor 이상)는 403.
 * - 세션의 userId로 매 요청 사용자 실체를 재검증(비활성·만료 계정 즉시 차단).
 */
import type Database from 'better-sqlite3';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'editor' | 'viewer';
}

declare module 'express-session' {
  interface SessionData {
    userId?: number;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: 'admin' | 'editor' | 'viewer';
  expires_at: string | null;
  active: number;
}

/** 세션 userId → 유효한 사용자 행. 비활성/만료면 null. */
export function loadSessionUser(db: Database.Database, req: Request): AuthUser | null {
  const userId = req.session?.userId;
  if (!userId) return null;
  const row = db
    .prepare('SELECT id, username, display_name, role, expires_at, active FROM user WHERE id = ?')
    .get(userId) as UserRow | undefined;
  if (!row || row.active !== 1) return null;
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return null; // viewer 임시계정 만료
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

function makeGuard(
  db: Database.Database,
  allowed: (role: AuthUser['role']) => boolean,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = loadSessionUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!allowed(user.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    req.user = user;
    next();
  };
}

/** 로그인 필수 (viewer 포함 — GET류 전용으로 사용) */
export function requireAuth(db: Database.Database): RequestHandler {
  return makeGuard(db, () => true);
}

/** editor 이상 (PATCH/POST 변경류) */
export function requireEditor(db: Database.Database): RequestHandler {
  return makeGuard(db, (role) => role === 'editor' || role === 'admin');
}

/** admin 전용 (사용자·주기 동결·정리 등) */
export function requireAdmin(db: Database.Database): RequestHandler {
  return makeGuard(db, (role) => role === 'admin');
}
