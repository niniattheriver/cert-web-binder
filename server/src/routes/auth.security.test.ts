// 로그인 시도 제한 + 비밀번호 변경·재설정 시 세션 무효화 (외부 검토 반영분 계약 테스트)
// :memory: DB + 실제 Express — users.integration.test.ts 와 같은 세션 shim 방식.
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import {
  clearLoginFailures,
  createAuthRouter,
  destroyUserSessions,
  loginLockRemaining,
  recordLoginFailure,
} from './auth.js';

let db: Database.Database;
let server: Server;
let base: string;
let userId: number;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const info = db
    .prepare(
      `INSERT INTO user (username, pw_hash, display_name, role, active)
       VALUES ('locktest', ?, '잠금시험', 'editor', 1)`,
    )
    .run(bcrypt.hashSync('correct-pw-123', 10));
  userId = Number(info.lastInsertRowid);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const session: Record<string, unknown> = {
      regenerate(cb: (e?: unknown) => void) {
        cb();
      },
      save(cb: (e?: unknown) => void) {
        cb();
      },
      destroy(cb: (e?: unknown) => void) {
        cb();
      },
    };
    (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/auth', createAuthRouter(db));
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
});

async function login(username: string, password: string): Promise<{ status: number; retryAfter: string | null }> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  await res.json().catch(() => null);
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

describe('로그인 시도 제한', () => {
  it('연속 5회 실패 → 이후 시도는 429 (올바른 비밀번호여도), Retry-After 포함', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await login('locktest', 'wrong-pw');
      expect(r.status).toBe(401);
    }
    const locked = await login('locktest', 'wrong-pw');
    expect(locked.status).toBe(429);
    expect(Number(locked.retryAfter)).toBeGreaterThan(0);
    // 잠금 중에는 올바른 비밀번호도 거절 (타이밍으로 정답 노출 방지)
    const evenCorrect = await login('locktest', 'correct-pw-123');
    expect(evenCorrect.status).toBe(429);
  });

  it('잠금 해제(초기화) 후 정상 로그인 → 200, 실패 카운터 리셋', async () => {
    clearLoginFailures('locktest', undefined);
    // shim 환경에서는 req.ip 가 실제 소켓 주소 — 키가 다를 수 있으므로 양쪽 다 정리
    clearLoginFailures('locktest', '127.0.0.1');
    clearLoginFailures('locktest', '::1');
    clearLoginFailures('locktest', '::ffff:127.0.0.1');
    const ok = await login('locktest', 'correct-pw-123');
    expect(ok.status).toBe(200);
  });

  it('다른 사용자명은 잠금의 영향을 받지 않는다', async () => {
    const r = await login('someone-else', 'whatever');
    expect(r.status).toBe(401); // 429 아님 — 키가 사용자명+IP 조합
  });

  it('잠금 만료 후 실패 카운터는 리셋된다 — 오타 1회로 즉시 재잠금되지 않는다', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure('expiry-user', '10.0.0.9', t0);
    expect(loginLockRemaining('expiry-user', '10.0.0.9', t0)).toBeGreaterThan(0); // 잠김
    const t1 = t0 + 61_000; // 60초 잠금 만료 후
    expect(loginLockRemaining('expiry-user', '10.0.0.9', t1)).toBe(0);
    recordLoginFailure('expiry-user', '10.0.0.9', t1); // 만료 후 첫 실패 = 1회째
    expect(loginLockRemaining('expiry-user', '10.0.0.9', t1)).toBe(0); // 재잠금 아님
  });
});

describe('세션 무효화 (destroyUserSessions)', () => {
  function insertSession(sid: string, uid: number): void {
    db.prepare('INSERT INTO session (sid, sess, expire) VALUES (?, ?, ?)').run(
      sid,
      JSON.stringify({ cookie: {}, userId: uid }),
      Date.now() + 60_000,
    );
  }
  function count(uid: number): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM session WHERE json_extract(sess, '$.userId') = ?")
        .get(uid) as { n: number }
    ).n;
  }

  it('대상 사용자의 세션만 삭제하고, exceptSid 는 남긴다', () => {
    insertSession('sid-a', userId);
    insertSession('sid-b', userId);
    insertSession('sid-other', userId + 999);
    destroyUserSessions(db, userId, 'sid-a');
    expect(count(userId)).toBe(1); // sid-a 만 생존
    expect(count(userId + 999)).toBe(1); // 다른 사용자 불변
    destroyUserSessions(db, userId);
    expect(count(userId)).toBe(0); // 예외 없이 전부 삭제
  });
});
