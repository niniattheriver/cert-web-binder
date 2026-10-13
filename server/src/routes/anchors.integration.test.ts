// 앵커/매핑/근거 API 통합 테스트 (:memory: DB + 실제 라우터)
// 계약: POST /api/anchors(트랜잭션·겹침60%·force·nudge) / passages links(중복 무시·last_link 확인 흐름)
//       GET /api/docs/versions/:vid/anchors(문항 조인) / GET·PATCH /api/questions/:id/evidence(통합 정렬)
//       GET /api/search passages·docs 그룹.
// (세션 미들웨어 대신 고정 userId 주입 — questions.integration.test.ts와 동일 방식)
import type Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { createAnchorsRouter } from './anchors.js';
import { createQuestionsRouter } from './questions.js';
import { createSearchRouter } from './search.js';

let db: Database.Database;
let server: Server;
let base: string;

let docId: number;
let versionId: number;
let q1 = 0;
let q2 = 0;
let q3 = 0;
let richDocId: number;

// 테스트 흐름 간 공유 상태 (파일 내 순차 실행)
let passageA = 0; // q1(+나중에 q2) — [100,200)
let anchorA = 0;
let passageB = 0; // q2,q3 — [300,400), 마지막 링크 해제로 soft-delete됨
let passageD = 0; // 초단문(넛지) — [500,520)

const QUOTE_A = '개인정보 파기 대장을 작성하고 보존하여야 한다';
const QUOTE_B = '위탁 계약 종료 시 개인정보를 즉시 파기한다';
const QUOTE_C = '보존 기간이 경과한 문서는 지체 없이 폐기한다';
const RECTS_A = [{ page: 1, rects: [[0.1, 0.2, 0.9, 0.25], [0.1, 0.26, 0.5, 0.3]] }];

const Q1_BODY =
  '개인정보의 보유 기간이 경과하거나 처리 목적이 달성된 경우 지체 없이 해당 개인정보를 파기하는 절차를 수립하여 이행하고 있는가? 파기 대장 작성 여부를 포함하여 점검한다.';
const Q1_ANSWER =
  '개인정보 파기 절차서를 수립하여 운영 중이며, 파기 대장을 작성하여 5년간 보존하고 있음. 관련 증적은 첨부 문서와 같이 관리하고 있음.';

beforeAll(async () => {
  db = openDatabase(':memory:');
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('editor1','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','개인정보보호',1)`).run();

  const insertQ = db.prepare(
    `INSERT INTO question (category_id, question_no, sort_key, body, answer_plain, updated_at)
     VALUES (1,?,?,?,?,?)`,
  );
  q1 = Number(insertQ.run('50.210.420', 1, Q1_BODY, Q1_ANSWER, now).lastInsertRowid);
  q2 = Number(insertQ.run('50.210.430', 2, '위탁 종료 시 자료 처리 절차가 있는가?', null, now).lastInsertRowid);
  q3 = Number(insertQ.run('50.504.100', 3, '문서 보존 기간을 준수하는가?', null, now).lastInsertRowid);

  docId = Number(
    db.prepare(`INSERT INTO document (code, title) VALUES ('PIP-01','개인정보보호 지침')`).run()
      .lastInsertRowid,
  );
  versionId = Number(
    db
      .prepare(
        `INSERT INTO document_version
           (document_id, version_label, file_sha256, file_name, file_size, page_count, status, is_current, uploaded_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(docId, '2026-개정1', 'b'.repeat(64), '지침.pdf', 2048, 40, 'active', 1, now).lastInsertRowid,
  );

  // q1 근거 선점: richdoc sort=1 → 이후 passage 연결은 통합 max+1=2가 돼야 함
  richDocId = Number(
    db
      .prepare(`INSERT INTO rich_doc (title, content_json, updated_at) VALUES ('증적 캡처 모음','{}',?)`)
      .run(now).lastInsertRowid,
  );
  db.prepare(`INSERT INTO question_richdoc (question_id, rich_doc_id, sort) VALUES (?,?,1)`).run(
    q1,
    richDocId,
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use('/api/search', createSearchRouter(db));
  app.use('/api', createQuestionsRouter(db));
  app.use('/api', createAnchorsRouter(db));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve); // 임시 포트 — 종료 시 반드시 닫음
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
});

async function call(
  method: string,
  path: string,
  bodyObj?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: bodyObj === undefined ? {} : { 'Content-Type': 'application/json' },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
  return { status: res.status, body: await res.json() };
}

function anchorPayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    documentVersionId: versionId,
    quotePrefix: '앞 문맥',
    quoteSuffix: '뒤 문맥',
    pageStart: 1,
    pageEnd: 1,
    rects: RECTS_A,
    ...overrides,
  };
}

describe('앵커/매핑/근거 API (통합)', () => {
  it('POST /api/anchors — 한 트랜잭션으로 passage+anchor+question_passage+FTS+change_log 생성', async () => {
    const r = await call('POST', '/api/anchors', anchorPayload({
      questionIds: [q1],
      quoteExact: QUOTE_A,
      startOffset: 100,
      endOffset: 200,
      label: '제12조 파기',
    }));
    expect(r.status).toBe(201);
    expect(r.body.passageId).toBeGreaterThan(0);
    expect(r.body.anchorId).toBeGreaterThan(0);
    expect(r.body.nudge).toBeUndefined(); // 5어절 — 넛지 없음
    passageA = r.body.passageId;
    anchorA = r.body.anchorId;

    const p = db.prepare('SELECT * FROM passage WHERE id = ?').get(passageA) as any;
    expect(p.document_id).toBe(docId);
    expect(p.label).toBe('제12조 파기');
    expect(p.color).toBe('yellow');
    const a = db.prepare('SELECT * FROM passage_anchor WHERE id = ?').get(anchorA) as any;
    expect(a.status).toBe('resolved');
    expect(a.method).toBe('manual');
    expect(a.quote_exact).toBe(QUOTE_A);
    expect(JSON.parse(a.rects_json)).toEqual(RECTS_A);
    const link = db
      .prepare('SELECT sort FROM question_passage WHERE question_id = ? AND passage_id = ?')
      .get(q1, passageA) as any;
    expect(link.sort).toBe(2); // richdoc sort=1 다음 (통합 max+1)
    const fts = db
      .prepare(`SELECT content FROM fts WHERE kind='passage' AND ref_id = ?`)
      .get(passageA) as any;
    expect(fts.content).toBe(QUOTE_A);
    const logs = db
      .prepare(
        `SELECT entity, action FROM change_log WHERE
           (entity='passage' AND entity_id=? AND action='create')
        OR (entity='passage_anchor' AND entity_id=? AND action='create')
        OR (entity='question' AND entity_id=? AND action='link')`,
      )
      .all(passageA, anchorA, q1);
    expect(logs.length).toBe(3);
  });

  it('POST /api/anchors — 다중 문항 동시 연결 (문항별 sort는 각자 max+1)', async () => {
    const r = await call('POST', '/api/anchors', anchorPayload({
      questionIds: [q2, q3],
      quoteExact: QUOTE_B,
      startOffset: 300,
      endOffset: 400,
      pageStart: 2,
      pageEnd: 2,
      rects: [{ page: 2, rects: [[0.1, 0.4, 0.9, 0.45]] }],
    }));
    expect(r.status).toBe(201);
    passageB = r.body.passageId;
    const s2 = (db
      .prepare('SELECT sort FROM question_passage WHERE question_id=? AND passage_id=?')
      .get(q2, passageB) as any).sort;
    const s3 = (db
      .prepare('SELECT sort FROM question_passage WHERE question_id=? AND passage_id=?')
      .get(q3, passageB) as any).sort;
    expect(s2).toBe(1); // q2 첫 근거
    expect(s3).toBe(1); // q3 첫 근거
  });

  it('POST /api/anchors — ≥60% 겹침이면 생성 없이 200 {overlap} (기존 하이라이트 제안)', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM passage').get() as any).n;
    const r = await call('POST', '/api/anchors', anchorPayload({
      questionIds: [q3],
      quoteExact: QUOTE_C,
      startOffset: 120,
      endOffset: 190, // [100,200)과 교집합 70/min(100,70)=1.0
    }));
    expect(r.status).toBe(200);
    expect(r.body.overlap.passageId).toBe(passageA);
    expect(r.body.overlap.anchorId).toBe(anchorA);
    expect(r.body.overlap.quote).toBe(QUOTE_A);
    expect(r.body.overlap.questions).toEqual([{ id: q1, questionNo: '50.210.420' }]);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM passage').get() as any).n;
    expect(after).toBe(before); // 아무것도 생성 안 함
  });

  it('POST /api/anchors — force:true면 겹쳐도 새로 생성', async () => {
    const r = await call('POST', '/api/anchors', anchorPayload({
      questionIds: [q3],
      quoteExact: QUOTE_C,
      startOffset: 120,
      endOffset: 190,
      force: true,
    }));
    expect(r.status).toBe(201);
    expect(r.body.passageId).not.toBe(passageA);
  });

  it('POST /api/passages/:id/links — 기존 passage에 문항 추가, 중복은 무시', async () => {
    const r1 = await call('POST', `/api/passages/${passageA}/links`, { questionId: q2 });
    expect(r1.status).toBe(201);
    expect(r1.body.sort).toBe(2); // q2는 passageB(sort 1) 다음
    const r2 = await call('POST', `/api/passages/${passageA}/links`, { questionId: q2 });
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);
    const n = (db
      .prepare('SELECT COUNT(*) AS n FROM question_passage WHERE question_id=? AND passage_id=?')
      .get(q2, passageA) as any).n;
    expect(n).toBe(1);
  });

  it('DELETE links — 마지막 링크는 409 last_link, ?confirm=1이면 해제+passage soft-delete(앵커·이력 잔존)', async () => {
    // q2 해제 → 아직 q3 남음
    const r1 = await call('DELETE', `/api/passages/${passageB}/links/${q2}`);
    expect(r1.status).toBe(200);
    expect(r1.body.passageDeleted).toBe(false);

    // 마지막 링크(q3) → 확인 요구
    const r2 = await call('DELETE', `/api/passages/${passageB}/links/${q3}`);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('last_link');
    expect(r2.body.requiresConfirm).toBe(true);
    const still = db
      .prepare('SELECT 1 FROM question_passage WHERE question_id=? AND passage_id=?')
      .get(q3, passageB);
    expect(still).toBeTruthy(); // 아무것도 변하지 않음

    // 확인 → 해제 + soft-delete
    const r3 = await call('DELETE', `/api/passages/${passageB}/links/${q3}?confirm=1`);
    expect(r3.status).toBe(200);
    expect(r3.body.passageDeleted).toBe(true);

    const p = db.prepare('SELECT deleted_at FROM passage WHERE id = ?').get(passageB) as any;
    expect(p.deleted_at).not.toBeNull(); // soft-delete (하드삭제 아님)
    const anchors = db
      .prepare('SELECT COUNT(*) AS n FROM passage_anchor WHERE passage_id = ?')
      .get(passageB) as any;
    expect(anchors.n).toBe(1); // 앵커 행 잔존
    const logs = db
      .prepare(
        `SELECT action FROM change_log WHERE entity='passage' AND entity_id=? AND action='delete'`,
      )
      .all(passageB);
    expect(logs.length).toBe(1); // 이력 잔존
    const fts = db
      .prepare(`SELECT COUNT(*) AS n FROM fts WHERE kind='passage' AND ref_id = ?`)
      .get(passageB) as any;
    expect(fts.n).toBe(0); // 검색 색인에서는 제거
  });

  it("POST /api/anchors — 3단어 미만 quote는 생성하되 nudge:'짧은 선택' 포함", async () => {
    const r = await call('POST', '/api/anchors', anchorPayload({
      questionIds: [q1],
      quoteExact: '짧은 문구',
      startOffset: 500,
      endOffset: 520,
      pageStart: 3,
      pageEnd: 3,
      rects: [{ page: 3, rects: [[0.2, 0.1, 0.6, 0.15]] }],
    }));
    expect(r.status).toBe(201);
    expect(r.body.nudge).toBe('짧은 선택');
    passageD = r.body.passageId;
  });

  it('GET /api/docs/versions/:vid/anchors — soft-delete passage 제외, 문항 조인·미리보기·rects 파싱', async () => {
    const r = await call('GET', `/api/docs/versions/${versionId}/anchors`);
    expect(r.status).toBe(200);
    const anchors = r.body.anchors as any[];
    // A(1p) + force C(1p) + D(3p) — soft-delete된 B 제외
    expect(anchors.length).toBe(3);
    expect(anchors.some((a) => a.passageId === passageB)).toBe(false);

    const a = anchors.find((x) => x.anchorId === anchorA);
    expect(a.quote).toBe(QUOTE_A);
    expect(a.label).toBe('제12조 파기');
    expect(a.color).toBe('yellow');
    expect(a.status).toBe('resolved');
    expect(a.method).toBe('manual');
    expect(a.geometryPrimary).toBe(false);
    expect(a.pageStart).toBe(1);
    expect(a.rects).toEqual(RECTS_A); // JSON 파싱된 형태
    // 연결 문항: q1(sort2) → q2(sort2, 번호 뒷순)
    expect(a.questions.map((qq: any) => qq.id)).toEqual([q1, q2]);
    const q1Entry = a.questions[0];
    expect(q1Entry.questionNo).toBe('50.210.420');
    expect(q1Entry.bodyPreview.length).toBeLessThanOrEqual(60);
    expect(q1Entry.bodyPreview.endsWith('…')).toBe(true);
    expect(q1Entry.answerPreview.length).toBeLessThanOrEqual(60);
  });

  it('GET /api/docs/versions/:vid/anchors — 없는 판본은 404', async () => {
    const r = await call('GET', '/api/docs/versions/99999/anchors');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('GET /api/questions/:id/evidence — passage ∪ richdoc 통합 sort 정렬', async () => {
    const r = await call('GET', `/api/questions/${q1}/evidence`);
    expect(r.status).toBe(200);
    const items = r.body.items as any[];
    // richdoc(1) → passageA(2) → passageD(3)
    expect(items.map((it) => it.type)).toEqual(['richdoc', 'passage', 'passage']);
    expect(items[0].richDocId).toBe(richDocId);
    expect(items[0].title).toBe('증적 캡처 모음');
    const itemA = items[1];
    expect(itemA.passageId).toBe(passageA);
    expect(itemA.anchorId).toBe(anchorA);
    expect(itemA.documentId).toBe(docId);
    expect(itemA.versionId).toBe(versionId);
    expect(itemA.quote).toBe(QUOTE_A);
    expect(itemA.docTitle).toBe('개인정보보호 지침');
    expect(itemA.versionLabel).toBe('2026-개정1');
    expect(itemA.pageStart).toBe(1);
    expect(itemA.status).toBe('resolved');
    expect(items[2].passageId).toBe(passageD);
  });

  it('PATCH /api/questions/:id/evidence — 순서/메모 갱신, note 미전송이면 기존 값 유지', async () => {
    const r = await call('PATCH', `/api/questions/${q1}/evidence`, {
      items: [
        { type: 'passage', passageId: passageA, sort: 1, note: '제12조 본문' },
        { type: 'passage', passageId: passageD, sort: 2 },
        { type: 'richdoc', richDocId, sort: 3 },
      ],
    });
    expect(r.status).toBe(200);
    const items = r.body.items as any[];
    expect(items.map((it) => it.type)).toEqual(['passage', 'passage', 'richdoc']);
    expect(items[0].passageId).toBe(passageA);
    expect(items[0].note).toBe('제12조 본문');

    // note 키 없이 sort만 변경 → 메모 유지
    const r2 = await call('PATCH', `/api/questions/${q1}/evidence`, {
      items: [{ type: 'passage', passageId: passageA, sort: 1 }],
    });
    expect(r2.status).toBe(200);
    const kept = (r2.body.items as any[]).find((it) => it.passageId === passageA);
    expect(kept.note).toBe('제12조 본문');

    const logs = db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log WHERE entity='question' AND entity_id=? AND action='evidence_update'`,
      )
      .get(q1) as any;
    expect(logs.n).toBe(2);
  });

  it('PATCH evidence — 연결되지 않은 passage 참조는 400', async () => {
    const r = await call('PATCH', `/api/questions/${q1}/evidence`, {
      items: [{ type: 'passage', passageId: 99999, sort: 1 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation');
  });

  it('GET /api/search — passages 그룹(FTS)·docs 그룹(제목) 채움, soft-delete 발췌 제외', async () => {
    // FTS 경로 (3자 이상)
    const r1 = await call('GET', `/api/search?q=${encodeURIComponent('파기 대장')}`);
    expect(r1.status).toBe(200);
    const hit = (r1.body.passages as any[]).find((p) => p.passageId === passageA);
    expect(hit).toBeTruthy();
    expect(hit.docTitle).toBe('개인정보보호 지침');
    expect(hit.questionNos).toContain('50.210.420');
    expect(hit.questionNos).toContain('50.210.430'); // links로 추가된 q2
    expect(String(hit.quote)).toContain('파기');

    // soft-delete된 passageB의 인용문은 검색되지 않음 (FTS 제거 확인)
    const r2 = await call('GET', `/api/search?q=${encodeURIComponent('즉시 파기한다')}`);
    expect((r2.body.passages as any[]).length).toBe(0);

    // docs 그룹 (2자 — LIKE 경로)
    const r3 = await call('GET', `/api/search?q=${encodeURIComponent('지침')}`);
    expect(r3.body.docs).toEqual([{ id: docId, title: '개인정보보호 지침', year: null }]);

    // passages LIKE 폴백 (3자 미만)
    const r4 = await call('GET', `/api/search?q=${encodeURIComponent('대장')}`);
    expect((r4.body.passages as any[]).some((p) => p.passageId === passageA)).toBe(true);
  });
});
