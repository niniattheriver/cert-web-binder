/**
 * 사용자 계정 관리 (v1.5 — 배포 후 각 기관의 계정 운영)
 * 마운트: index.ts에서 '/api/admin/users' 에 requireAdmin 으로 감싸므로 전 엔드포인트 admin 전용.
 *  - GET    /api/admin/users               계정 목록
 *  - POST   /api/admin/users               계정 생성(초기 비밀번호 발급/지정) → 비밀번호 1회 반환
 *  - PATCH  /api/admin/users/:id           표시명·역할·활성·만료 수정
 *  - POST   /api/admin/users/:id/reset-password  비밀번호 재설정 → 새 비밀번호 1회 반환
 *
 * 원칙(가드레일):
 *  - 하드삭제 금지 → active=0 비활성화(이력 보존). 스키마에 user.deleted_at 없음(active 사용).
 *  - 자기 잠금 방지: 자신을 비활성/강등 불가, 마지막 활성 admin을 비활성/강등 불가.
 *  - 비밀번호는 bcrypt 해시만 저장, 평문·해시를 로그나 목록에 절대 노출하지 않는다.
 *  - 모든 변경 change_log(entity='user') 기록. 비밀번호 값은 after_json에 담지 않는다.
 */
import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { logChange } from '../db/change-log.js';
import { destroyUserSessions } from './auth.js';

const ROLES = ['admin', 'editor', 'viewer'] as const;
type Role = (typeof ROLES)[number];

/** 헷갈리는 글자(0/O/1/l/I) 제외한 12자 임시 비밀번호 */
function generatePassword(length = 12): string {
  const charset = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += charset[bytes[i]! % charset.length];
  return out;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  expires_at: string | null;
  active: number;
}

function toDto(r: UserRow, selfId: number): {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  expiresAt: string | null;
  isSelf: boolean;
} {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    active: r.active === 1,
    expiresAt: r.expires_at,
    isSelf: r.id === selfId,
  };
}

/** 활성 admin 수 (자기 잠금·마지막 admin 강등 방지 판정용) */
function activeAdminCount(db: Database.Database): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM user WHERE role = 'admin' AND active = 1`)
      .get() as { n: number }
  ).n;
}

const usernameSchema = z
  .string()
  .trim()
  .min(3, '아이디는 3자 이상이어야 합니다.')
  .max(50)
  .regex(/^[A-Za-z0-9._-]+$/, '아이디는 영문·숫자·. _ - 만 사용할 수 있습니다.');
const passwordSchema = z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(200);

const createSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1, '이름을 입력하세요.').max(100),
  role: z.enum(ROLES),
  password: passwordSchema.optional(), // 미지정 시 자동 생성해 1회 반환
  expiresAt: z.string().datetime().optional(), // viewer 임시계정 만료(ISO)
});

const patchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    role: z.enum(ROLES).optional(),
    active: z.boolean().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '변경할 항목이 없습니다.' });

export function createUsersRouter(db: Database.Database): Router {
  const router = Router();

  // ── 목록 ──
  router.get('/', (req, res) => {
    const rows = db
      .prepare(
        `SELECT id, username, display_name, role, expires_at, active FROM user ORDER BY active DESC, id`,
      )
      .all() as UserRow[];
    res.json({ users: rows.map((r) => toDto(r, req.user!.id)) });
  });

  // ── 생성 ──
  router.post('/', (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const { username, displayName, role, expiresAt } = parsed.data;
    const dup = db.prepare('SELECT id FROM user WHERE username = ?').get(username);
    if (dup) {
      res.status(409).json({ error: 'duplicate_username', details: '이미 존재하는 아이디입니다.' });
      return;
    }
    const password = parsed.data.password ?? generatePassword();
    const generated = parsed.data.password == null;
    const pwHash = bcrypt.hashSync(password, 10);
    const info = db
      .prepare(
        `INSERT INTO user (username, pw_hash, display_name, role, expires_at, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run(username, pwHash, displayName, role, expiresAt ?? null);
    const id = Number(info.lastInsertRowid);
    logChange(db, {
      actorId: req.user!.id,
      actorKind: 'user',
      entity: 'user',
      entityId: id,
      action: 'create',
      after: { username, displayName, role, expiresAt: expiresAt ?? null }, // 비밀번호 미기록
    });
    res.status(201).json({
      user: toDto(
        { id, username, display_name: displayName, role, expires_at: expiresAt ?? null, active: 1 },
        req.user!.id,
      ),
      // 관리자에게 1회만 전달(재조회 불가) — 직원에게 안전한 경로로 전달하도록 안내
      password,
      generated,
    });
  });

  // ── 수정(표시명·역할·활성·만료) ──
  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '사용자 ID가 올바르지 않습니다.' });
      return;
    }
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', details: parsed.error.issues });
      return;
    }
    const cur = db
      .prepare(`SELECT id, username, display_name, role, expires_at, active FROM user WHERE id = ?`)
      .get(id) as UserRow | undefined;
    if (!cur) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const p = parsed.data;
    const isSelf = id === req.user!.id;
    // 자기 잠금 방지
    if (isSelf && p.active === false) {
      res.status(409).json({ error: 'self_lockout', details: '자기 계정은 비활성화할 수 없습니다.' });
      return;
    }
    if (isSelf && p.role != null && p.role !== 'admin') {
      res.status(409).json({ error: 'self_lockout', details: '자기 계정의 관리자 권한은 스스로 내릴 수 없습니다.' });
      return;
    }
    // 마지막 활성 admin 보호: 강등/비활성으로 활성 admin이 0이 되면 차단
    const willDropAdmin =
      cur.role === 'admin' &&
      cur.active === 1 &&
      ((p.role != null && p.role !== 'admin') || p.active === false);
    if (willDropAdmin && activeAdminCount(db) <= 1) {
      res
        .status(409)
        .json({ error: 'last_admin', details: '마지막 활성 관리자는 강등·비활성화할 수 없습니다.' });
      return;
    }

    const next = {
      display_name: p.displayName ?? cur.display_name,
      role: p.role ?? cur.role,
      active: p.active == null ? cur.active : p.active ? 1 : 0,
      expires_at: p.expiresAt === undefined ? cur.expires_at : p.expiresAt,
    };
    db.prepare(
      `UPDATE user SET display_name = ?, role = ?, active = ?, expires_at = ? WHERE id = ?`,
    ).run(next.display_name, next.role, next.active, next.expires_at, id);
    logChange(db, {
      actorId: req.user!.id,
      actorKind: 'user',
      entity: 'user',
      entityId: id,
      action: 'update',
      before: {
        displayName: cur.display_name,
        role: cur.role,
        active: cur.active === 1,
        expiresAt: cur.expires_at,
      },
      after: {
        displayName: next.display_name,
        role: next.role,
        active: next.active === 1,
        expiresAt: next.expires_at,
      },
    });
    res.json({
      user: toDto(
        { id, username: cur.username, display_name: next.display_name, role: next.role as Role, expires_at: next.expires_at, active: next.active },
        req.user!.id,
      ),
    });
  });

  // ── 비밀번호 재설정(관리자 권한 — 대상의 현재 비밀번호 불요) ──
  router.post('/:id/reset-password', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'validation', details: '사용자 ID가 올바르지 않습니다.' });
      return;
    }
    const cur = db.prepare(`SELECT id, username FROM user WHERE id = ?`).get(id) as
      | { id: number; username: string }
      | undefined;
    if (!cur) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const bodyPw = typeof req.body?.password === 'string' ? req.body.password : undefined;
    if (bodyPw !== undefined) {
      const ok = passwordSchema.safeParse(bodyPw);
      if (!ok.success) {
        res.status(400).json({ error: 'validation', details: ok.error.issues });
        return;
      }
    }
    const password = bodyPw ?? generatePassword();
    const generated = bodyPw === undefined;
    db.prepare(`UPDATE user SET pw_hash = ? WHERE id = ?`).run(bcrypt.hashSync(password, 10), id);
    // 대상 사용자의 기존 세션 전부 무효화 — 재설정 후 이전 로그인 상태가 남지 않게.
    // 관리자가 자기 자신을 재설정하는 경우에는 현재 세션만 유지(조용한 로그아웃 방지).
    destroyUserSessions(db, id, id === req.user!.id ? req.sessionID : undefined);
    logChange(db, {
      actorId: req.user!.id,
      actorKind: 'user',
      entity: 'user',
      entityId: id,
      action: 'reset_password', // 값 미기록 — 사실만 남긴다
    });
    res.json({ password, generated });
  });

  return router;
}
