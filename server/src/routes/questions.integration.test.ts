// 문항 PATCH 통합 테스트 — 임시 파일 DB + 실제 라우터로 채점 강제·낙관적 잠금(409)·change_log 보존 검증
// (세션 미들웨어 대신 고정 userId 주입 — 세션 자체는 session-store.test.ts에서 검증)
import type Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { createQuestionsRouter, extractKeywords } from './questions.js';

let tmpDir: string;
let db: Database.Database;
let server: Server;
let base: string;
let questionId: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-q-'));
  db = openDatabase(path.join(tmpDir, 'test.db'));
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('editor1','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','개인정보보호',1)`).run();
  const info = db
    .prepare(
      `INSERT INTO question (category_id, question_no, sort_key, body, max_score, allow_na, updated_at)
       VALUES (1,'50.210.420',1,'개인정보 파기 절차를 수립·이행하고 있는가?',3,0,?)`,
    )
    .run(now);
  questionId = Number(info.lastInsertRowid);

  const app = express();
  app.use(express.json());
  // 테스트용 세션 주입: userId=1 (editor) — 실제 Session 객체 대신 최소 형태
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use('/api', createQuestionsRouter(db));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve); // 임시 포트 — 종료 시 반드시 닫음
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function patch(bodyObj: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/questions/${questionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  return { status: res.status, body: await res.json() };
}

describe('근거 추천 (Phase 5 C-1)', () => {
  it('extractKeywords: 불용어·짧은 토큰 제외, 끝 조사 제거(4자 이상만), 상위 5개', () => {
    const kws = extractKeywords('개인정보 파기 절차를 수립하고 문서화되어 있는가?');
    expect(kws).toContain('개인정보');
    // '절차를'(3자)은 조사를 떼면 2자 — trigram 하한(3자) 미달이라 원형 유지
    expect(kws).toContain('절차를');
    expect(kws).not.toContain('있는가'); // 불용어
    expect(kws.length).toBeLessThanOrEqual(5);
    // 4자 이상 토큰은 끝 조사 제거: '내부정도관리를' → '내부정도관리'
    expect(extractKeywords('내부정도관리를 시행하는가')).toContain('내부정도관리');
    // trigram 최소 길이 — 3자 미만 토큰 없음
    expect(kws.every((k) => k.length >= 3)).toBe(true);
  });

  it('GET /questions/:id/evidence-suggest — 지침서 없으면 hits 빈 배열 (500 아님)', async () => {
    const res = await fetch(`${base}/api/questions/${questionId}/evidence-suggest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keywords: string[]; hits: unknown[] };
    expect(Array.isArray(body.keywords)).toBe(true);
    expect(body.hits).toEqual([]);
  });

  it('없는 문항 → 404', async () => {
    const res = await fetch(`${base}/api/questions/999999/evidence-suggest`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/questions/:id (통합)', () => {
  it('yes + 2.5점 저장 → 갱신본 반환, rowVersion 증가, change_log 기록', async () => {
    const r = await patch({ rowVersion: 1, answerChoice: 'yes', score: 2.5 });
    expect(r.status).toBe(200);
    expect(r.body.answerChoice).toBe('yes');
    expect(r.body.score).toBe(2.5);
    expect(r.body.rowVersion).toBe(2);
    expect(r.body.updatedByName).toBe('편집자');
    const log = db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log WHERE entity='question' AND entity_id=? AND action='update'`,
      )
      .get(questionId) as { n: number };
    expect(log.n).toBe(1);
  });

  it("'no'로 변경 시 클라이언트 점수를 무시하고 0으로 강제", async () => {
    const r = await patch({ rowVersion: 2, answerChoice: 'no', score: 3 });
    expect(r.status).toBe(200);
    expect(r.body.score).toBe(0);
    expect(r.body.rowVersion).toBe(3);
  });

  it('allow_na=0 문항에 na 선택 → 400 (한국어 사유)', async () => {
    const r = await patch({ rowVersion: 3, answerChoice: 'na' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation');
    expect(String(r.body.details)).toContain('해당없음');
  });

  it('구버전 rowVersion → 409 + 서버본 반환 + 지는 쪽 페이로드 change_log 보존', async () => {
    const r = await patch({ rowVersion: 1, findingsText: '충돌하는 편집 내용' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('conflict');
    expect(r.body.server.rowVersion).toBe(3); // 서버 최신본 전체 동봉
    const lost = db
      .prepare(
        `SELECT after_json FROM change_log WHERE entity='question' AND entity_id=? AND action='conflict_lost'`,
      )
      .all(questionId) as { after_json: string }[];
    expect(lost.length).toBe(1);
    expect(lost[0]!.after_json).toContain('충돌하는 편집 내용');
  });

  it('배점 초과 점수 → 400', async () => {
    const r = await patch({ rowVersion: 3, answerChoice: 'yes', score: 3.5 });
    expect(r.status).toBe(400);
  });

  it('예→만점 자동 채움 비트(scoreAutofilled) 저장 (Phase 2)', async () => {
    const r = await patch({ rowVersion: 3, answerChoice: 'yes', score: 3, scoreAutofilled: true });
    expect(r.status).toBe(200);
    expect(r.body.scoreAutofilled).toBe(true);
    expect(r.body.rowVersion).toBe(4);
  });

  it("'예'가 아닌 선택으로 바뀌면 자동 채움 비트 소거", async () => {
    const r = await patch({ rowVersion: 4, answerChoice: 'no' });
    expect(r.status).toBe(200);
    expect(r.body.score).toBe(0);
    expect(r.body.scoreAutofilled).toBe(false);
  });
});

// ── 연도(주기)별 조회 (S1 — ?cycle= + 활성 주기 고정) ─────────────────────────

describe('GET /api/bootstrap ?cycle= (통합)', () => {
  let cycle2027Id: number;

  it('미래 연도 주기를 추가해도 현재 주기는 바뀌지 않는다 (activeCycleId 고정)', async () => {
    // 현재 주기 고정 (운영에서는 시드/가져오기가 심는다)
    db.prepare(
      `INSERT OR REPLACE INTO app_setting (key, value) VALUES ('activeCycleId', '1')`,
    ).run();
    const info = db
      .prepare(`INSERT INTO cycle (name, status, year, created_at) VALUES ('2027년 심사','active',2027,?)`)
      .run(new Date().toISOString());
    cycle2027Id = Number(info.lastInsertRowid);
    db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (?, '60','차기 분야',1)`).run(
      cycle2027Id,
    );

    const res = await fetch(`${base}/api/bootstrap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.activeCycle.id).toBe(1); // 2027 주기가 생겨도 현재 주기 유지
    expect(body.cycle.id).toBe(1); // 미지정 → 현재 주기 범위
    expect(body.categories.map((c: { code: string }) => c.code)).toEqual(['50']);
    // 주기 리스트: 연도 내림차순 + 문항/작성 집계 포함
    expect(body.cycles.map((c: { id: number }) => c.id)).toEqual([cycle2027Id, 1]);
    expect(body.cycles[0]).toMatchObject({ year: 2027, questionCount: 0, answeredCount: 0 });
    expect(body.cycles[1].questionCount).toBe(1);
  });

  it('?cycle= 지정 시 그 주기의 분야를 반환한다 (activeCycle은 그대로)', async () => {
    const res = await fetch(`${base}/api/bootstrap?cycle=${cycle2027Id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.activeCycle.id).toBe(1);
    expect(body.cycle.id).toBe(cycle2027Id);
    expect(body.categories.map((c: { code: string }) => c.code)).toEqual(['60']);
  });

  it('존재하지 않는 주기 → 400 잘못된 주기입니다', async () => {
    const res = await fetch(`${base}/api/bootstrap?cycle=99999`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('잘못된 주기입니다.');
    const bad = await fetch(`${base}/api/bootstrap?cycle=abc`);
    expect(bad.status).toBe(400);
  });
});

// ── 문항 목록: 첨부·링크 개수 필드 (리뷰 확정 결함 C4 — 웹 '근거 없음' 필터가 소비) ──

describe('GET /api/categories/:id/questions — attachmentCount/linkCount', () => {
  it('살아있는 첨부·링크만 센다 (삭제분 제외)', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO question_attachment (question_id, sha256, orig_name, mime, size, sort, uploaded_by, uploaded_at)
       VALUES (?, 'aa', '근거.xlsx', 'application/vnd.ms-excel', 10, 1, 1, ?)`,
    ).run(questionId, now);
    db.prepare(
      `INSERT INTO question_attachment (question_id, sha256, orig_name, mime, size, sort, uploaded_by, uploaded_at, deleted_at)
       VALUES (?, 'bb', '지움.pdf', 'application/pdf', 10, 2, 1, ?, ?)`,
    ).run(questionId, now, now);
    db.prepare(
      `INSERT INTO question_link (question_id, url, label, sort, created_by, created_at)
       VALUES (?, 'http://intranet/문서1', '내부 문서', 1, 1, ?),
              (?, 'http://intranet/문서2', NULL, 2, 1, ?)`,
    ).run(questionId, now, questionId, now);

    const res = await fetch(`${base}/api/categories/1/questions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const q = body.questions.find((x: any) => x.id === questionId);
    expect(q.attachmentCount).toBe(1); // 삭제된 첨부는 제외
    expect(q.linkCount).toBe(2);
  });
});
