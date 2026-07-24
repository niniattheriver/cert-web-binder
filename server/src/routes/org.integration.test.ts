// 기관 정보 라우트 통합 테스트 (v1.5 Phase 1) — 임시 파일 DB + 실제 라우터.
// 지표 생성/값 검증/낙관적 잠금(409)/soft delete/키 복원/설정 갱신·change_log 를 검증한다.
import type Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { createOrgRouter } from './org.js';

let tmpDir: string;
let db: Database.Database;
let server: Server;
let base: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-org-'));
  db = openDatabase(path.join(tmpDir, 'test.db'));
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('editor1','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO app_setting (key, value) VALUES ('orgName','테스트기관'),('systemName','웹 바인더')`).run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use('/api', createOrgRouter(db));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  p: string,
  bodyObj?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
  return { status: res.status, body: await res.json() };
}

describe('기관 지표 (통합)', () => {
  let metricId: number;

  it('지표 생성 → 201, 목록에 노출, change_log 기록', async () => {
    const r = await call('POST', '/api/org/metrics', {
      metricKey: 'annual_test_count',
      label: '전년도 검사 건수',
      unit: '건',
      valueType: 'integer',
      value: 12345,
    });
    expect(r.status).toBe(201);
    expect(r.body.value).toBe('12345');
    expect(r.body.rowVersion).toBe(1);
    metricId = r.body.id;
    const list = await call('GET', '/api/org');
    expect(list.body.metrics).toHaveLength(1);
    expect(list.body.metrics[0].metricKey).toBe('annual_test_count');
    const log = db
      .prepare(`SELECT COUNT(*) AS n FROM change_log WHERE entity='org_metric' AND action='create'`)
      .get() as { n: number };
    expect(log.n).toBe(1);
  });

  it('중복 키 생성 → 400, 잘못된 키 형식 → 400', async () => {
    const dup = await call('POST', '/api/org/metrics', { metricKey: 'annual_test_count', label: 'x' });
    expect(dup.status).toBe(400);
    const bad = await call('POST', '/api/org/metrics', { metricKey: '한글키', label: 'x' });
    expect(bad.status).toBe(400);
  });

  it('integer 지표에 소수 입력 → 400 (한국어 사유)', async () => {
    const r = await call('PATCH', `/api/org/metrics/${metricId}`, { rowVersion: 1, value: '1.5' });
    expect(r.status).toBe(400);
    expect(String(r.body.details)).toContain('정수');
  });

  it('빈 문자열 값 → NULL(입력값 없음, 0 아님)', async () => {
    const r = await call('PATCH', `/api/org/metrics/${metricId}`, { rowVersion: 1, value: '' });
    expect(r.status).toBe(200);
    expect(r.body.value).toBeNull();
    expect(r.body.rowVersion).toBe(2);
  });

  it('구버전 rowVersion → 409 + 서버본 + conflict_lost 기록', async () => {
    const r = await call('PATCH', `/api/org/metrics/${metricId}`, { rowVersion: 1, value: '99' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('conflict');
    expect(r.body.server.rowVersion).toBe(2);
    const lost = db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log WHERE entity='org_metric' AND action='conflict_lost'`,
      )
      .get() as { n: number };
    expect(lost.n).toBe(1);
  });

  it('soft delete → 목록 제외 + 하드삭제 아님, 같은 키 재생성 시 행 복원', async () => {
    const del = await call('DELETE', `/api/org/metrics/${metricId}`);
    expect(del.status).toBe(200);
    const list = await call('GET', '/api/org');
    expect(list.body.metrics).toHaveLength(0);
    const raw = db.prepare('SELECT deleted_at FROM org_metric WHERE id = ?').get(metricId) as {
      deleted_at: string | null;
    };
    expect(raw.deleted_at).not.toBeNull();

    const re = await call('POST', '/api/org/metrics', {
      metricKey: 'annual_test_count',
      label: '전년도 검사 건수(복원)',
      value: 777,
    });
    expect(re.status).toBe(201);
    expect(re.body.id).toBe(metricId); // 새 행이 아니라 기존 행 복원
    expect(re.body.value).toBe('777');
  });
});

describe('기관 설정 (통합)', () => {
  it('PATCH /api/org/settings → 갱신 + change_log', async () => {
    const r = await call('PATCH', '/api/org/settings', { orgName: '부산기관' });
    expect(r.status).toBe(200);
    expect(r.body.settings.orgName).toBe('부산기관');
    expect(r.body.settings.systemName).toBe('웹 바인더'); // 미전송 필드 유지
    const log = db
      .prepare(`SELECT COUNT(*) AS n FROM change_log WHERE entity='app_setting' AND action='update'`)
      .get() as { n: number };
    expect(log.n).toBe(1);
  });

  it('변경 항목 없음 → 400', async () => {
    const r = await call('PATCH', '/api/org/settings', {});
    expect(r.status).toBe(400);
  });
});
