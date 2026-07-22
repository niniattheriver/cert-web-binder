// 통합 채점 라우트 통합 테스트 (v1.5 Phase 3a) — :memory: DB + 전체 마이그레이션 + 실제 Express.
// 모드 전환·합산 재계산(리프 합)·구간표 검증(겹침/구멍)·자동 계산 스냅샷·지표 변경 stale·
// override(사유 필수)·simple PATCH 차단을 검증한다.
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createOrgRouter } from './org.js';
import { createQuestionsRouter } from './questions.js';
import { createReviewRouter } from './review.js';
import { createScoringRouter } from './scoring.js';

let db: Database.Database;
let server: Server;
let base: string;
let qComposite: number;
let qAuto: number;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('e','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','개인정보보호',1)`).run();
  const ins = db.prepare(
    `INSERT INTO question (category_id, question_no, sort_key, body, max_score, allow_na,
                           answer_choice, score, updated_at)
     VALUES (1,?,?,?,?,0,?,?,?)`,
  );
  qComposite = Number(ins.run('50.010.010', 1, '합산 문항 본문', 10, 'yes', 3, now).lastInsertRowid);
  qAuto = Number(ins.run('50.010.020', 2, '자동배점 문항 본문', 5, null, null, now).lastInsertRowid);
  db.prepare(
    `INSERT INTO org_metric (cycle_id, metric_key, label, value, value_type, updated_at)
     VALUES (1,'annual_test_count','전년도 검사 건수','12000','integer',?)`,
  ).run(now);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use('/api', createScoringRouter(db));
  app.use('/api', createQuestionsRouter(db));
  app.use('/api', createOrgRouter(db));
  app.use('/api', createReviewRouter(db));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
});

async function call(method: string, p: string, bodyObj?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
  return { status: res.status, body: await res.json() };
}

describe('합산(composite) 모드', () => {
  it('모드 전환 → 선택·자동채움 초기화, 항목 없으면 총점 NULL (기존 점수는 change_log 보존)', async () => {
    const r = await call('PATCH', `/api/questions/${qComposite}/scoring-mode`, { mode: 'composite' });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('composite');
    expect(r.body.score).toBeNull();
    const row = db
      .prepare('SELECT answer_choice, score_autofilled FROM question WHERE id = ?')
      .get(qComposite) as { answer_choice: string | null; score_autofilled: number };
    expect(row.answer_choice).toBeNull();
    const log = db
      .prepare(`SELECT COUNT(*) AS n FROM change_log WHERE entity='question' AND action='scoring_mode'`)
      .get() as { n: number };
    expect(log.n).toBe(1);
  });

  it('세부항목 추가·채점 → 총점 = 리프 합 (서버 파생)', async () => {
    const c1 = await call('POST', `/api/questions/${qComposite}/criteria`, {
      label: '문서화 여부',
      maxScore: 6,
    });
    expect(c1.status).toBe(201);
    const c2 = await call('POST', `/api/questions/${qComposite}/criteria`, {
      label: '이행 기록',
      maxScore: 4,
    });
    const [id1, id2] = c2.body.criteria.map((c: { id: number }) => c.id);
    expect(c2.body.criteriaTotal).toEqual({ score: null, maxScore: 10 });

    const s1 = await call('PATCH', `/api/questions/criteria/${id1}`, { score: 4.5 });
    expect(s1.status).toBe(200);
    expect(s1.body.score).toBe(4.5); // 일부 채점 — 부분 합
    const s2 = await call('PATCH', `/api/questions/criteria/${id2}`, { score: 4 });
    expect(s2.body.score).toBe(8.5);
    expect(s2.body.criteriaTotal).toEqual({ score: 8.5, maxScore: 10 });
  });

  it('취득점 검증: 배점 초과·0.5 간격 위반 → 400', async () => {
    const list = (await call('GET', `/api/questions/${qComposite}/scoring`)).body;
    const cid = list.criteria[0].id;
    expect((await call('PATCH', `/api/questions/criteria/${cid}`, { score: 7 })).status).toBe(400);
    expect((await call('PATCH', `/api/questions/criteria/${cid}`, { score: 1.3 })).status).toBe(400);
  });

  it('항목 배점도 생성·수정 모두 0.5 간격 강제 (검토 반영 — 생성만 느슨하면 이후 PATCH 불능)', async () => {
    const bad = await call('POST', `/api/questions/${qComposite}/criteria`, {
      label: '비규격 배점',
      maxScore: 1.3,
    });
    expect(bad.status).toBe(400);
  });

  it('2단 계층까지만 — 자식 항목 밑에 또 자식 생성 → 400 (검토 반영)', async () => {
    const list = (await call('GET', `/api/questions/${qComposite}/scoring`)).body;
    const rootId = list.criteria[0].id;
    const child = await call('POST', `/api/questions/${qComposite}/criteria`, {
      label: '하위 항목',
      maxScore: 1,
      parentId: rootId,
    });
    expect(child.status).toBe(201);
    const childId = child.body.criteria.find((c: { parentId: number | null }) => c.parentId === rootId).id;
    const grand = await call('POST', `/api/questions/${qComposite}/criteria`, {
      label: '3단 시도',
      maxScore: 0.5,
      parentId: childId,
    });
    expect(grand.status).toBe(400);
    // 정리 — 이후 테스트의 합산 기대값 보호
    await call('DELETE', `/api/questions/criteria/${childId}`);
  });

  it('모드 전환 change_log 는 이전 answer_choice 실제값을 보존 (검토 반영)', async () => {
    const log = db
      .prepare(
        `SELECT before_json FROM change_log
         WHERE entity='question' AND entity_id=? AND action='scoring_mode' ORDER BY id LIMIT 1`,
      )
      .get(qComposite) as { before_json: string };
    expect(JSON.parse(log.before_json).answerChoice).toBe('yes'); // 시드의 이전 선택값
  });

  it('합산 모드에서 simple PATCH 로 점수 쓰기 → 400, 지적사항 저장은 총점 불변', async () => {
    const rv = (db.prepare('SELECT row_version FROM question WHERE id = ?').get(qComposite) as {
      row_version: number;
    }).row_version;
    const blocked = await call('PATCH', `/api/questions/${qComposite}`, {
      rowVersion: rv,
      answerChoice: 'yes',
      score: 10,
    });
    expect(blocked.status).toBe(400);

    const findings = await call('PATCH', `/api/questions/${qComposite}`, {
      rowVersion: rv,
      findingsText: '지적 메모',
    });
    expect(findings.status).toBe(200);
    expect(findings.body.score).toBe(8.5); // validateScoring 의 NULL 강제를 타지 않음
  });

  it('항목 soft delete → 재계산, 행은 보존', async () => {
    const list = (await call('GET', `/api/questions/${qComposite}/scoring`)).body;
    const cid = list.criteria[1].id;
    const r = await call('DELETE', `/api/questions/criteria/${cid}`);
    expect(r.status).toBe(200);
    expect(r.body.score).toBe(4.5);
    const raw = db
      .prepare('SELECT deleted_at FROM question_criterion WHERE id = ?')
      .get(cid) as { deleted_at: string | null };
    expect(raw.deleted_at).not.toBeNull();
  });
});

describe('자동배점(auto) 모드', () => {
  it('구간표 검증: 구멍/겹침/미커버 → 400', async () => {
    await call('PATCH', `/api/questions/${qAuto}/scoring-mode`, { mode: 'auto' });
    const gap = await call('PUT', `/api/questions/${qAuto}/auto-rule`, {
      sourceMetricKey: 'annual_test_count',
      bands: [
        { lower: null, upper: 10000, score: 3 },
        { lower: 20000, upper: null, score: 5 }, // 구멍
      ],
    });
    expect(gap.status).toBe(400);
    const uncovered = await call('PUT', `/api/questions/${qAuto}/auto-rule`, {
      sourceMetricKey: 'annual_test_count',
      bands: [{ lower: 0, upper: 10000, score: 3 }], // −∞/+∞ 미커버
    });
    expect(uncovered.status).toBe(400);
    const overMax = await call('PUT', `/api/questions/${qAuto}/auto-rule`, {
      sourceMetricKey: 'annual_test_count',
      bands: [{ lower: null, upper: null, score: 6 }], // 배점(5) 초과
    });
    expect(overMax.status).toBe(400);
  });

  it('바인딩 저장 → 계산 → 스냅샷·총점 기록', async () => {
    const put = await call('PUT', `/api/questions/${qAuto}/auto-rule`, {
      sourceMetricKey: 'annual_test_count',
      bands: [
        { lower: null, upper: 10000, score: 3 },
        { lower: 10000, upper: 50000, score: 4 },
        { lower: 50000, upper: null, score: 5 },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.autoRule.metric.value).toBe('12000');

    const computed = await call('POST', `/api/questions/${qAuto}/auto-rule/compute`);
    expect(computed.status).toBe(200);
    expect(computed.body.score).toBe(4); // 12000 → [10000,50000)
    expect(computed.body.autoRule.state.stale).toBe(false);
    const state = db
      .prepare('SELECT metric_snapshot_json FROM auto_score_state WHERE question_id = ?')
      .get(qAuto) as { metric_snapshot_json: string };
    expect(JSON.parse(state.metric_snapshot_json).value).toBe('12000'); // 입력 동결 보관
  });

  it('지표 값 변경 → stale=1 + 검수 큐에 X→Y diff, 재계산(원클릭 확정)으로 해소', async () => {
    const metric = db
      .prepare(`SELECT id, row_version FROM org_metric WHERE metric_key = 'annual_test_count'`)
      .get() as { id: number; row_version: number };
    const upd = await call('PATCH', `/api/org/metrics/${metric.id}`, {
      rowVersion: metric.row_version,
      value: '60000',
    });
    expect(upd.status).toBe(200);
    const stale = db
      .prepare('SELECT stale FROM auto_score_state WHERE question_id = ?')
      .get(qAuto) as { stale: number };
    expect(stale.stale).toBe(1); // 조용한 재계산 금지 — 검수 대상 표시

    const review = (await call('GET', '/api/review/summary')).body;
    expect(review.autoStale).toHaveLength(1);
    expect(review.autoStale[0]).toMatchObject({ currentScore: 4, newScore: 5 });
    expect(review.total).toBe(1);

    const confirm = await call('POST', `/api/questions/${qAuto}/auto-rule/compute`);
    expect(confirm.body.score).toBe(5);
    expect((await call('GET', '/api/review/summary')).body.autoStale).toHaveLength(0);
  });

  it('지표 미입력 → 계산 결과 "입력값 없음"(NULL) — 0점/만점 아님', async () => {
    const metric = db
      .prepare(`SELECT id, row_version FROM org_metric WHERE metric_key = 'annual_test_count'`)
      .get() as { id: number; row_version: number };
    await call('PATCH', `/api/org/metrics/${metric.id}`, { rowVersion: metric.row_version, value: '' });
    const computed = await call('POST', `/api/questions/${qAuto}/auto-rule/compute`);
    expect(computed.status).toBe(200);
    expect(computed.body.score).toBeNull();
    // 복원
    const m2 = db
      .prepare(`SELECT id, row_version FROM org_metric WHERE metric_key = 'annual_test_count'`)
      .get() as { id: number; row_version: number };
    await call('PATCH', `/api/org/metrics/${m2.id}`, { rowVersion: m2.row_version, value: '60000' });
    await call('POST', `/api/questions/${qAuto}/auto-rule/compute`);
  });

  it('지표 soft delete → stale, 같은 키 복원 → 다시 stale (조용한 무경로 방지 — 검토 반영)', async () => {
    const metric = db
      .prepare(`SELECT id FROM org_metric WHERE metric_key = 'annual_test_count'`)
      .get() as { id: number };
    await call('DELETE', `/api/org/metrics/${metric.id}`);
    expect(
      (db.prepare('SELECT stale FROM auto_score_state WHERE question_id = ?').get(qAuto) as {
        stale: number;
      }).stale,
    ).toBe(1);
    // '입력값 없음'으로 확정
    const confirm = await call('POST', `/api/questions/${qAuto}/auto-rule/compute`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.score).toBeNull();
    // 같은 키로 복원(값 60000) → 확정 상태가 조용히 남지 않고 다시 stale
    const re = await call('POST', '/api/org/metrics', {
      metricKey: 'annual_test_count',
      label: '전년도 검사 건수',
      valueType: 'integer',
      value: 60000,
    });
    expect(re.status).toBe(201);
    expect(
      (db.prepare('SELECT stale FROM auto_score_state WHERE question_id = ?').get(qAuto) as {
        stale: number;
      }).stale,
    ).toBe(1);
    await call('POST', `/api/questions/${qAuto}/auto-rule/compute`); // 60000 → 5점 복원
  });

  it('미바인딩 stale 도 확정 가능 — 키 해제 후 compute 가 "입력값 없음"으로 확정 (영구 큐 잔류 방지)', async () => {
    const unbind = await call('PUT', `/api/questions/${qAuto}/auto-rule`, {
      sourceMetricKey: null,
      bands: [{ lower: null, upper: null, score: 0 }],
    });
    expect(unbind.status).toBe(200);
    const confirm = await call('POST', `/api/questions/${qAuto}/auto-rule/compute`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.score).toBeNull();
    expect((await call('GET', '/api/review/summary')).body.autoStale).toHaveLength(0);
    // 재바인딩 + 재계산 (후속 테스트 전제 복구)
    await call('PUT', `/api/questions/${qAuto}/auto-rule`, {
      sourceMetricKey: 'annual_test_count',
      bands: [
        { lower: null, upper: 10000, score: 3 },
        { lower: 10000, upper: 50000, score: 4 },
        { lower: 50000, upper: null, score: 5 },
      ],
    });
    await call('POST', `/api/questions/${qAuto}/auto-rule/compute`);
  });

  it('override: 사유 필수, score_overridden=1 + change_log 사유 보존, 재계산 시 해제', async () => {
    const noReason = await call('POST', `/api/questions/${qAuto}/scoring-override`, { score: 3 });
    expect(noReason.status).toBe(400);
    const r = await call('POST', `/api/questions/${qAuto}/scoring-override`, {
      score: 3,
      reason: '현장 실사 결과 반영',
    });
    expect(r.status).toBe(200);
    expect(r.body.score).toBe(3);
    expect(r.body.scoreOverridden).toBe(true);
    const log = db
      .prepare(
        `SELECT after_json FROM change_log WHERE entity='question' AND entity_id=? ORDER BY id DESC LIMIT 1`,
      )
      .get(qAuto) as { after_json: string };
    expect(log.after_json).toContain('현장 실사 결과 반영');

    const recompute = await call('POST', `/api/questions/${qAuto}/auto-rule/compute`);
    expect(recompute.body.score).toBe(5);
    expect(recompute.body.scoreOverridden).toBe(false);
  });
});
