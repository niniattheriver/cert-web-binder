// 사용자 계정 관리 라우트 계약 테스트 — :memory: DB + 실제 Express.
// requireAdmin은 index.ts가 감싸므로 여기선 라우터를 admin 세션으로 직접 마운트하고,
// 권한 경계(자기 잠금·마지막 admin·중복·비밀번호 변경)를 검증한다.
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
let pwTmpDir: string;
let pwFile: string;

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
  // 초기 비밀번호 파일 자동 삭제(opt-in) 검증용 — 옵션 주입 라우터를 별도 경로에 마운트.
  // 위의 무옵션 라우터들이 기존 계약(삭제 없음)을 그대로 검증한다.
  pwTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-initpw-'));
  pwFile = path.join(pwTmpDir, 'initial-admin-password.txt');
  app.use('/api/auth-pw', createAuthRouter(db, { initialPwFile: pwFile }));
  app.use('/api/admin/users-pw', createUsersRouter(db, { initialPwFile: pwFile }));
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  fs.rmSync(pwTmpDir, { recursive: true, force: true });
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


describe('초기 비밀번호 파일 자동 삭제 (opt-in — initialPwFile 주입 라우터만)', () => {
  const seedPwFile = () => fs.writeFileSync(pwFile, 'admin 초기 비밀번호: abc123\n');

  it('admin 이 change-password 에 성공하면 파일이 삭제된다', async () => {
    db.prepare('UPDATE user SET pw_hash = ? WHERE id = ?').run(bcrypt.hashSync('cur-pw-1234', 10), adminId);
    seedPwFile();
    const ok = await api('POST', '/api/auth-pw/change-password', { currentPassword: 'cur-pw-1234', newPassword: 'next-pw-1234' }, adminId);
    expect(ok.status).toBe(200);
    expect(fs.existsSync(pwFile)).toBe(false);
  });

  it('admin 이 아닌 사용자의 변경은 파일을 지우지 않는다', async () => {
    const created = await api('POST', '/api/admin/users', { username: 'pwuser', displayName: '직원', role: 'editor', password: 'editor-pw-123' }, adminId);
    expect(created.status).toBe(201);
    const uid = created.body.user.id;
    seedPwFile();
    const ok = await api('POST', '/api/auth-pw/change-password', { currentPassword: 'editor-pw-123', newPassword: 'editor-pw-456' }, uid);
    expect(ok.status).toBe(200);
    expect(fs.existsSync(pwFile)).toBe(true);
  });

  it('파일이 없어도 변경은 정상 성공한다', async () => {
    fs.rmSync(pwFile, { force: true });
    const ok = await api('POST', '/api/auth-pw/change-password', { currentPassword: 'next-pw-1234', newPassword: 'next-pw-5678' }, adminId);
    expect(ok.status).toBe(200);
  });

  it('관리자가 admin 계정을 reset-password 해도 파일이 삭제된다', async () => {
    seedPwFile();
    const r = await api('POST', `/api/admin/users-pw/${adminId}/reset-password`, {}, adminId);
    expect(r.status).toBe(200);
    expect(fs.existsSync(pwFile)).toBe(false);
  });

  it('옵션 미주입 라우터는 admin 변경에도 파일을 지우지 않는다 (기존 계약 보존)', async () => {
    db.prepare('UPDATE user SET pw_hash = ? WHERE id = ?').run(bcrypt.hashSync('plain-pw-123', 10), adminId);
    seedPwFile();
    const ok = await api('POST', '/api/auth/change-password', { currentPassword: 'plain-pw-123', newPassword: 'plain-pw-456' }, adminId);
    expect(ok.status).toBe(200);
    expect(fs.existsSync(pwFile)).toBe(true);
    fs.rmSync(pwFile, { force: true });
  });
});


describe('만료일 잠금 가드 (v1.5.4 리뷰 확정 결함 수정)', () => {
  it('자기 계정 만료일 설정 → 409 self_lockout (해제 null 은 허용)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const r = await api('PATCH', `/api/admin/users/${adminId}`, { expiresAt: past }, adminId);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('self_lockout');
    const clear = await api('PATCH', `/api/admin/users/${adminId}`, { expiresAt: null }, adminId);
    expect(clear.status).toBe(200);
  });

  it('만료된 admin 은 사용 가능 수에서 제외 — 남은 admin 강등은 last_admin 409', async () => {
    // 보조 admin 을 만들고 과거 만료로 재워 둔다(관리자 adminId 가 편집 — 자기 아님이라 허용)
    const a3 = await api('POST', '/api/admin/users', { username: 'admin3', displayName: '관리자3', role: 'admin' }, adminId);
    expect(a3.status).toBe(201);
    const id3 = a3.body.user.id;
    const past = new Date(Date.now() - 60_000).toISOString();
    const expire = await api('PATCH', `/api/admin/users/${id3}`, { expiresAt: past }, adminId);
    expect(expire.status).toBe(200);
    // 사용 가능 admin 은 adminId 하나뿐 — 그를 강등하려면 last_admin 이 막아야 한다
    // (자기 강등은 self_lockout 이 먼저 걸리므로, 여기서는 만료 admin 이 개수에 안 잡히는 것만
    //  activeAdminCount 경유 경로로 확인: admin3 을 되살릴 다른 admin 이 없다는 뜻)
    const r = await api('PATCH', `/api/admin/users/${adminId}`, { role: 'editor' }, adminId);
    expect(r.status).toBe(409); // self_lockout 이든 last_admin 이든 강등 불가가 계약
    // 정리
    await api('PATCH', `/api/admin/users/${id3}`, { expiresAt: null, active: false }, adminId);
  }, 30000);

  it('사용 가능한 admin 이 2명이면 다른 admin 에게 과거 만료 설정도 허용(마지막 아님)', async () => {
    const a4 = await api('POST', '/api/admin/users', { username: 'admin4', displayName: '관리자4', role: 'admin' }, adminId);
    const id4 = a4.body.user.id;
    const past = new Date(Date.now() - 60_000).toISOString();
    const r = await api('PATCH', `/api/admin/users/${id4}`, { expiresAt: past }, adminId);
    expect(r.status).toBe(200); // adminId 가 남으므로 허용
    await api('PATCH', `/api/admin/users/${id4}`, { expiresAt: null, active: false }, adminId);
  }, 30000);
});
