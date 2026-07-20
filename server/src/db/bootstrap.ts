/**
 * 최초 기동 부트스트랩 시드 (설계서 §4 화면1, §10 Day 1)
 * - user 0명이면 admin 계정 생성:
 *     비밀번호 = env ADMIN_INITIAL_PASSWORD 있으면 그 값, 없으면 crypto 랜덤 12자 생성 후
 *     콘솔 + dataDir/initial-admin-password.txt(0600)에 기록.
 * - cycle 0개면 현재 연도 기반 active 주기 생성 ("YYYY년 심사").
 * - app_setting 기본값(systemName='우수검사실 인증심사 웹 바인더', orgName='') — 이미 있으면 건드리지 않음.
 * 모든 시드는 change_log(actor_kind='system')에 기록한다.
 */
import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logChange } from './change-log.js';

/** 헷갈리는 문자(0/O, 1/l/I)를 뺀 문자셋으로 랜덤 12자 비밀번호 생성 */
function generatePassword(length = 12): string {
  const charset = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += charset[bytes[i]! % charset.length];
  return out;
}

export function ensureBootstrapData(db: Database.Database, dataDir: string): void {
  const now = new Date().toISOString();

  // 1) admin 시드
  const userCount = (db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n;
  if (userCount === 0) {
    const envPw = process.env.ADMIN_INITIAL_PASSWORD;
    const password = envPw && envPw.length > 0 ? envPw : generatePassword();
    const pwHash = bcrypt.hashSync(password, 10);
    const info = db
      .prepare(
        `INSERT INTO user (username, pw_hash, display_name, role, active)
         VALUES ('admin', ?, '관리자', 'admin', 1)`,
      )
      .run(pwHash);
    logChange(db, {
      actorKind: 'system',
      entity: 'user',
      entityId: Number(info.lastInsertRowid),
      action: 'create',
      after: { username: 'admin', role: 'admin' },
    });
    if (envPw && envPw.length > 0) {
      console.log('[시드] admin 계정 생성 — 비밀번호는 ADMIN_INITIAL_PASSWORD 환경변수 값입니다.');
    } else {
      const pwFile = path.join(dataDir, 'initial-admin-password.txt');
      fs.writeFileSync(
        pwFile,
        `admin 초기 비밀번호: ${password}\n최초 로그인 후 비밀번호를 변경하고 이 파일을 삭제하세요.\n`,
        { mode: 0o600 },
      );
      console.log(`[시드] admin 계정 생성 — 초기 비밀번호: ${password}`);
      console.log(`[시드] 비밀번호를 ${pwFile} 에도 기록했습니다 (권한 0600).`);
    }
  }

  // 2) active 주기 시드
  const cycleCount = (db.prepare('SELECT COUNT(*) AS n FROM cycle').get() as { n: number }).n;
  if (cycleCount === 0) {
    const year = new Date().getFullYear();
    const name = `${year}년 심사`;
    const info = db
      .prepare(`INSERT INTO cycle (name, status, year, created_at) VALUES (?, 'active', ?, ?)`)
      .run(name, year, now);
    logChange(db, {
      actorKind: 'system',
      entity: 'cycle',
      entityId: Number(info.lastInsertRowid),
      action: 'create',
      after: { name, status: 'active', year },
    });
    console.log(`[시드] 감사 주기 생성: ${name}`);
  }
  // 현재 주기 고정 — 미래 연도 주기를 만들어도 현재 주기가 조용히 바뀌지 않도록 id를 설정에 고정
  const activeCycle = db
    .prepare(`SELECT id FROM cycle WHERE status = 'active' ORDER BY id DESC LIMIT 1`)
    .get() as { id: number } | undefined;
  if (activeCycle) {
    db.prepare(`INSERT OR IGNORE INTO app_setting (key, value) VALUES ('activeCycleId', ?)`).run(
      String(activeCycle.id),
    );
  }

  // 3) 기관 설정 기본값 (있으면 무시 — 기관명 하드코딩 금지, 관리 화면에서 수정)
  const insertSetting = db.prepare('INSERT OR IGNORE INTO app_setting (key, value) VALUES (?, ?)');
  insertSetting.run('systemName', '우수검사실 인증심사 웹 바인더');
  insertSetting.run('orgName', '');
  insertSetting.run('attachmentMaxMB', '200'); // 문항 첨부 파일당 상한 (Phase 2 — 재기동 없이 변경 가능)
}
