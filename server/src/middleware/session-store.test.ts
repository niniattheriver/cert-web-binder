// SqliteSessionStore 만료·CRUD 테스트 — 임시 파일 DB 사용 (설계서 §5)
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { SqliteSessionStore } from './session-store.js';

const TTL = 12 * 60 * 60 * 1000;

function makeSession(maxAge: number | null = TTL): import('express-session').SessionData {
  return {
    cookie: { originalMaxAge: maxAge, maxAge: maxAge ?? undefined },
    userId: 7,
  } as unknown as import('express-session').SessionData;
}

describe('SqliteSessionStore', () => {
  let tmpDir: string;
  let db: Database.Database;
  let nowMs: number;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-session-'));
    db = openDatabase(path.join(tmpDir, 'test.db')); // 파일 DB — 마이그레이션 전체 적용
    nowMs = 1_800_000_000_000;
    store = new SqliteSessionStore(db, { cleanupIntervalMs: 0, now: () => nowMs });
  });

  afterEach(() => {
    store.stopCleanup();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const getAsync = (sid: string) =>
    new Promise<import('express-session').SessionData | null | undefined>((resolve, reject) =>
      store.get(sid, (err, sess) => (err ? reject(err) : resolve(sess))),
    );
  const setAsync = (sid: string, sess: import('express-session').SessionData) =>
    new Promise<void>((resolve, reject) =>
      store.set(sid, sess, (err) => (err ? reject(err) : resolve())),
    );

  it('set → get 왕복: 세션 데이터가 보존된다', async () => {
    await setAsync('sid-1', makeSession());
    const got = await getAsync('sid-1');
    expect(got).not.toBeNull();
    expect((got as { userId?: number }).userId).toBe(7);
  });

  it('없는 sid는 null', async () => {
    expect(await getAsync('없는-sid')).toBeNull();
  });

  it('12시간 유휴 경과 시 만료: get이 null을 반환하고 행이 삭제된다', async () => {
    await setAsync('sid-exp', makeSession());
    nowMs += TTL + 1; // 12시간 + 1ms 경과
    expect(await getAsync('sid-exp')).toBeNull();
    const n = (db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('touch가 유휴 만료를 연장한다 (rolling)', async () => {
    await setAsync('sid-roll', makeSession());
    nowMs += TTL - 1000; // 만료 직전
    await new Promise<void>((resolve, reject) =>
      store.touch('sid-roll', makeSession(), (err) => (err ? reject(err) : resolve())),
    );
    nowMs += TTL - 1000; // touch가 없었으면 이미 만료됐을 시점
    expect(await getAsync('sid-roll')).not.toBeNull();
  });

  it('destroy로 세션 삭제', async () => {
    await setAsync('sid-del', makeSession());
    await new Promise<void>((resolve, reject) =>
      store.destroy('sid-del', (err) => (err ? reject(err) : resolve())),
    );
    expect(await getAsync('sid-del')).toBeNull();
  });

  it('cleanupExpired는 만료 행만 물리 삭제한다', async () => {
    await setAsync('sid-a', makeSession());
    nowMs += TTL / 2;
    await setAsync('sid-b', makeSession()); // sid-b는 절반 시점에 생성 → 더 늦게 만료
    nowMs += TTL / 2 + 1; // sid-a만 만료
    const removed = store.cleanupExpired();
    expect(removed).toBe(1);
    expect(await getAsync('sid-a')).toBeNull();
    expect(await getAsync('sid-b')).not.toBeNull();
  });
});
