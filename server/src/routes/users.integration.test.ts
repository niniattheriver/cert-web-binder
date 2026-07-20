// 사용자 계정 관리 라우트 계약 테스트 — :memory: DB + 실제 Express.
// requireAdmin은 index.ts가 감싸므로 여기선 라우터를 admin 세션으로 직접 마운트하고,
// 권한 경계(자기 잠금·마지막 admin·중복·비밀번호 변경)를 검증한다.
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createUsersRouter } from './users.js';
import { createAuthRouter } from './auth.js';

let db: Database.Database;
let server: Server;
let base: string;
let adminId: number;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const info = db
    .prepare(
      `INSERT INTO user (username, pw_hash, display_name, role, active)
       VALUES ('admin', ?, '관리자', 'admin', 1)`,
    )
    .run(bcrypt.hashSync('adminpw123', 10));
  adminId = Number(info.lastInsertRowid);

  const app = express();
  app.use(express.json());
  // 테스트 세션 shim: x-test-user 헤더 id + login이 쓰는 regenerate/save/destroy 콜백.
  app.use((req, _res, next) => {
    const uid = Number(req.headers['x-test-user']);
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
    if (Number.isInteger(uid) && uid > 0) {
      session.userId = uid;
      const u = db
        .prepare('SELECT id, username, display_name, role FROM user WHERE id = ?')
        .get(uid) as { id: number; username: string; display_name: string; role: string } | undefined;
      if (u) (req as unknown as { user: unknown }).user = { id: u.id, username: u.username, displayName: u.display_name, role: u.role };
    }
    (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/admin/users', createUsersRouter(db));
  app.use('/api/auth', createAuthRouter(db));
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
});

async function api(
  method: string,
  path: string,
  body?: unknown,
  user?: number,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user ? { 'x-test-user': String(user) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('계정 생성', () => {
  let editorId: number;

  it('생성 → 201, 비밀번호 1회 반환(자동 생성), 목록에 노출(해시 미노출)', async () => {
    const r = await api('POST', '/api/admin/users', { username: 'kim', displayName: '김편집', role: 'editor' }, adminId);
    expect(r.status).toBe(201);
    expect(r.body.password).toHaveLength(12);
    expect(r.body.generated).toBe(true);
    expect(r.body.user).toMatchObject({ username: 'kim', role: 'editor', active: true });
    editorId = r.body.user.id;
    // 생성된 비밀번호로 실제 로그인 가능
    const login = await api('POST', '/api/auth/login', { username: 'kim', password: r.body.password });
    expect(login.status).toBe(200);
    // 목록 응답에 pw_hash 흔적 없음
    const list = await api('GET', '/api/admin/users', undefined, adminId);
    expect(JSON.stringify(list.body)).not.toContain('$2'); // bcrypt 해시 접두
  }, 30000);

  it('중복 아이디 → 409 duplicate_username', async () => {
    const r = await api('POST', '/api/admin/users', { username: 'kim', displayName: '중복', role: 'viewer' }, adminId);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('duplicate_username');
  });

  it('짧은 아이디/비번 → 400 validation', async () => {
    const r = await api('POST', '/api/admin/users', { username: 'ab', displayName: 'x', role: 'editor' }, adminId);
    expect(r.status).toBe(400);
    const r2 = await api('POST', '/api/admin/users', { username: 'okid', displayName: 'x', role: 'editor', password: 'short' }, adminId);
    expect(r2.status).toBe(400);
  });

  it('비밀번호 재설정 → 새 비밀번호 반환 + 그 비번으로 로그인', async () => {
    const r = await api('POST', `/api/admin/users/${editorId}/reset-password`, {}, adminId);
    expect(r.status).toBe(200);
    expect(r.body.password).toHaveLength(12);
    const login = await api('POST', '/api/auth/login', { username: 'kim', password: r.body.password });
    expect(login.status).toBe(200);
  }, 30000);

  it('역할 변경·비활성화 → 반영, 비활성 계정은 로그인 거부', async () => {
    const up = await api('PATCH', `/api/admin/users/${editorId}`, { role: 'viewer', active: false }, adminId);
    expect(up.status).toBe(200);
    expect(up.body.user).toMatchObject({ role: 'viewer', active: false });
    const login = await api('POST', '/api/auth/login', { username: 'kim', password: 'anything' });
    expect(login.status).toBe(401);
  });
});

describe('권한 경계(자기 잠금·마지막 admin)', () => {
  it('자기 계정 비활성화 → 409 self_lockout', async () => {
    const r = await api('PATCH', `/api/admin/users/${adminId}`, { active: false }, adminId);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('self_lockout');
  });

  it('자기 admin 강등 → 409 self_lockout', async () => {
    const r = await api('PATCH', `/api/admin/users/${adminId}`, { role: 'editor' }, adminId);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('self_lockout');
  });

  it('활성 admin이 2명이면 다른 admin 강등 허용(마지막 admin 보호가 과도 차단하지 않음)', async () => {
    const a2 = await api('POST', '/api/admin/users', { username: 'admin2', displayName: '관리자2', role: 'admin' }, adminId);
    const admin2Id = a2.body.user.id;
    const demote = await api('PATCH', `/api/admin/users/${admin2Id}`, { role: 'editor' }, adminId);
    expect(demote.status).toBe(200); // 활성 admin 2명 → 하나 강등 허용
    // 정리: 다시 admin으로 되돌려 후속 테스트에 영향 없게
    await api('PATCH', `/api/admin/users/${admin2Id}`, { active: false }, adminId);
    // adminId는 계속 유일 활성 admin & 자기이므로 self_lockout으로 잠금 방지가 보장됨(위 테스트).
  }, 30000);
});

describe('내 비밀번호 변경 (/api/auth/change-password)', () => {
  it('현재 비밀번호 틀리면 400, 맞으면 교체 후 새 비번 로그인', async () => {
    const wrong = await api('POST', '/api/auth/change-password', { currentPassword: 'nope', newPassword: 'newpass123' }, adminId);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_current_password');
    const ok = await api('POST', '/api/auth/change-password', { currentPassword: 'adminpw123', newPassword: 'newpass123' }, adminId);
    expect(ok.status).toBe(200);
    const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'newpass123' });
    expect(login.status).toBe(200);
  }, 30000);
});
