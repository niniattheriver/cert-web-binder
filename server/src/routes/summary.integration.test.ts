// 결과 요약·검수 큐 집계 통합 테스트 (v1.5 Phase 1) — 임시 파일 DB + 실제 라우터.
// 감점/지적 분류 규칙(미채점·해당없음 제외)과 needs_review 전역 집계를 검증한다.
import type Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { createReviewRouter } from './review.js';
import { createSummaryRouter } from './summary.js';

let tmpDir: string;
let db: Database.Database;
let server: Server;
let base: string;

function seedQuestion(
  no: string,
  fields: {
    choice?: 'yes' | 'no' | 'na' | null;
    score?: number | null;
    findings?: string | null;
    autofilled?: boolean;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO question (category_id, question_no, sort_key, body, max_score, allow_na,
                           answer_choice, score, score_autofilled, findings_text, updated_at)
     VALUES (1, ?, 0, '본문', 4, 1, ?, ?, ?, ?, ?)`,
  ).run(
    no,
    fields.choice ?? null,
    fields.score ?? null,
    fields.autofilled ? 1 : 0,
    fields.findings ?? null,
    now,
  );
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-sum-'));
  db = openDatabase(path.join(tmpDir, 'test.db'));
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('viewer1','x','열람자','viewer',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','개인정보보호',1)`).run();

  seedQuestion('50.010.010', { choice: 'no', score: 0 }); // 감점 (아니오)
  seedQuestion('50.010.020', { choice: 'yes', score: 2 }); // 감점 (예 & 2<4)
  seedQuestion('50.010.030', { choice: 'yes', score: 4 }); // 만점 — 대상 아님
  seedQuestion('50.010.040', { choice: 'yes', score: null }); // 미채점 — 감점 아님
  seedQuestion('50.010.050', { choice: 'na' }); // 해당없음 — 대상 아님
  seedQuestion('50.010.060', { choice: 'yes', score: 4, findings: '문서 서명 누락 지적' }); // 지적만
  seedQuestion('50.010.070', { choice: null, findings: '   ' }); // 공백 지적 — 대상 아님
  seedQuestion('50.010.080', { choice: null, findings: '\n\t' }); // 개행/탭만 — 대상 아님 (SQLite TRIM 기본은 스페이스만 제거)
  seedQuestion('50.010.090', { choice: 'yes', score: 4, autofilled: true }); // 자동 채움 후 미확인 (만점 — 감점 아님)

  // 검수 큐 집계용: 현재 판본에 needs_review 1건 + resolved 1건
  db.prepare(`INSERT INTO document (code, title, kind) VALUES ('SOP-1','검사 지침서','manual')`).run();
  db.prepare(
    `INSERT INTO document_version (document_id, version_label, file_sha256, file_name, file_size,
                                   status, is_current, uploaded_at)
     VALUES (1, '2026-개정1', 'abc', 'sop.pdf', 100, 'active', 1, ?)`,
  ).run(now);
  db.prepare(`INSERT INTO passage (document_id, label) VALUES (1, '제12조'), (1, '제13조')`).run();
  db.prepare(
    `INSERT INTO passage_anchor (passage_id, document_version_id, quote_exact, status)
     VALUES (1, 1, '인용문', 'needs_review'), (2, 1, '인용문2', 'resolved')`,
  ).run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use('/api', createSummaryRouter(db));
  app.use('/api', createReviewRouter(db));
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

describe('GET /api/summary (통합)', () => {
  it('감점·지적·자동채움 문항만, 분야별 그룹 + 총계', async () => {
    const res = await fetch(`${base}/api/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.totals).toEqual({ total: 4, deducted: 2, findings: 1, autofilled: 1 });
    expect(body.categories).toHaveLength(1);
    const nos = body.categories[0].items.map((i: { questionNo: string }) => i.questionNo);
    expect(nos).toEqual(['50.010.010', '50.010.020', '50.010.060', '50.010.090']);
    const first = body.categories[0].items[0];
    expect(first.deducted).toBe(true);
    expect(first.hasFindings).toBe(false);
    const auto = body.categories[0].items[3];
    expect(auto.autofilled).toBe(true);
    expect(auto.deducted).toBe(false);
  });

  it('viewer 열람 가능 (읽기 전용 집계)', async () => {
    const res = await fetch(`${base}/api/summary`);
    expect(res.status).toBe(200); // 시드 사용자 role=viewer
  });
});

describe('GET /api/review/summary (통합)', () => {
  it('현재 판본의 needs_review/unresolved만 문서별 집계', async () => {
    const res = await fetch(`${base}/api/review/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total).toBe(1);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]).toMatchObject({
      documentId: 1,
      title: '검사 지침서',
      versionLabel: '2026-개정1',
      needsReview: 1,
    });
  });
});
