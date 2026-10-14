// 마이그레이션 009(시스템 표시명 기본값): 옛 기본값만 새 이름으로 바꾸고, 직접 정한 이름과 새 DB는 건드리지 않는다
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import { getSettings } from './settings.js';

const OLD_NAME = '우수검사실 인증심사 웹 바인더';
const NEW_NAME = '우수검사실 신임인증 웹 바인더';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 008까지만 적용한 DB (1.5.x에서 올라온 설치와 같은 상태) */
function dbAt008(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mig008-'));
  tmpDirs.push(dir);
  for (const f of fs.readdirSync(migrationsDir)) {
    if (/^00[1-8]_.*\.sql$/.test(f)) fs.copyFileSync(path.join(migrationsDir, f), path.join(dir, f));
  }
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, dir);
  expect(db.pragma('user_version', { simple: true })).toBe(8);
  return db;
}

function settingLogs(db: Database.Database) {
  return db
    .prepare(`SELECT actor_id, actor_kind, entity_id, action, before_json, after_json FROM change_log WHERE entity = 'app_setting'`)
    .all() as Array<{
    actor_id: number | null;
    actor_kind: string;
    entity_id: number;
    action: string;
    before_json: string;
    after_json: string;
  }>;
}

describe('마이그레이션 009 시스템 표시명', () => {
  it('옛 기본값이면 새 이름으로 바꾸고 change_log에 system 변경으로 남긴다', () => {
    const db = dbAt008();
    db.prepare(`INSERT INTO app_setting (key, value) VALUES ('orgName', '가상기관'), ('systemName', ?)`).run(OLD_NAME);

    expect(runMigrations(db)[0]).toBe('009_system_name.sql'); // 뒤 번호(010 등)도 이어서 적용된다
    expect(getSettings(db)).toEqual({ orgName: '가상기관', systemName: NEW_NAME });
    const logs = settingLogs(db);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_id: null, actor_kind: 'system', entity_id: 0, action: 'update' });
    expect(JSON.parse(logs[0]!.before_json)).toEqual({ orgName: '가상기관', systemName: OLD_NAME });
    expect(JSON.parse(logs[0]!.after_json)).toEqual({ orgName: '가상기관', systemName: NEW_NAME });
  });

  it('기관 정보 화면에서 직접 정한 이름은 그대로 두고 기록도 남기지 않는다', () => {
    const db = dbAt008();
    db.prepare(`INSERT INTO app_setting (key, value) VALUES ('systemName', '가상기관 웹 바인더')`).run();

    runMigrations(db);
    expect(getSettings(db).systemName).toBe('가상기관 웹 바인더');
    expect(settingLogs(db)).toHaveLength(0);
  });

  it('새 DB에서는 아무것도 바꾸지 않고, 설정이 없을 때의 기본 이름은 새 이름이다', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(10);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM app_setting WHERE key = 'systemName'`).get()).toEqual({ n: 0 });
    expect(settingLogs(db)).toHaveLength(0);
    expect(getSettings(db).systemName).toBe(NEW_NAME);
  });
});
