// 준비도 집계 단위 테스트 — 리뷰 확정 결함 회귀:
//  · C4: noEvidence는 발췌·자유문서·첨부파일·링크 네 종류 모두 없는 문항만 센다
//  · C3: staleOpen(자동배점 재계산 필요)은 요청한 주기로 한정된다 (anchorOpen은 의도적 전역)
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { computeReadiness } from './readiness.js';

let db: Database.Database;
const now = new Date().toISOString();

/** 주기 1개 + 분야 1개 + 문항 n개 시드. 반환: 문항 id 배열 */
function seedCycle(year: number, code: string, questionCount: number): {
  cycleId: number;
  categoryId: number;
  questionIds: number[];
} {
  const cycleId = Number(
    db
      .prepare(`INSERT INTO cycle (name, status, year, created_at) VALUES (?, 'active', ?, ?)`)
      .run(`${year}년 심사`, year, now).lastInsertRowid,
  );
  const categoryId = Number(
    db
      .prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (?, ?, ?, 1)`)
      .run(cycleId, code, `분야 ${code}`).lastInsertRowid,
  );
  const questionIds: number[] = [];
  for (let i = 1; i <= questionCount; i++) {
    questionIds.push(
      Number(
        db
          .prepare(
            `INSERT INTO question (category_id, question_no, sort_key, body, max_score, allow_na, updated_at)
             VALUES (?, ?, ?, ?, 5, 0, ?)`,
          )
          .run(categoryId, `${code}.010.0${i}0`, i, `문항 ${i}`, now).lastInsertRowid,
      ),
    );
  }
  return { cycleId, categoryId, questionIds };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role) VALUES ('t', 'x', '테스터', 'editor')`,
  ).run();
});

afterEach(() => {
  db.close();
});

describe('computeReadiness — noEvidence (C4)', () => {
  it('첨부파일 또는 링크만 있어도 근거 있음 — 네 종류 모두 없어야 근거 없음', () => {
    const { cycleId, questionIds } = seedCycle(2026, '50', 4);
    const [qNone, qAttach, qLink, qDeleted] = questionIds as [number, number, number, number];
    void qNone; // 아무 근거 없음 → 근거 없음으로 집계
    db.prepare(
      `INSERT INTO question_attachment (question_id, sha256, orig_name, mime, size, sort, uploaded_by, uploaded_at)
       VALUES (?, 'aa', '근거.xlsx', 'application/vnd.ms-excel', 10, 1, 1, ?)`,
    ).run(qAttach, now);
    db.prepare(
      `INSERT INTO question_link (question_id, url, label, sort, created_by, created_at)
       VALUES (?, 'http://intranet/문서', '내부 문서', 1, 1, ?)`,
    ).run(qLink, now);
    // 삭제된(soft delete) 첨부·링크는 세지 않는다 → 근거 없음
    db.prepare(
      `INSERT INTO question_attachment (question_id, sha256, orig_name, mime, size, sort, uploaded_by, uploaded_at, deleted_at)
       VALUES (?, 'bb', '지운파일.pdf', 'application/pdf', 10, 1, 1, ?, ?)`,
    ).run(qDeleted, now, now);
    db.prepare(
      `INSERT INTO question_link (question_id, url, label, sort, created_by, created_at, deleted_at)
       VALUES (?, 'http://intranet/지운링크', NULL, 1, 1, ?, ?)`,
    ).run(qDeleted, now, now);

    const r = computeReadiness(db, cycleId);
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0]!.questionCount).toBe(4);
    // qNone + qDeleted(삭제된 첨부·링크뿐) 2건만 근거 없음
    expect(r.categories[0]!.noEvidence).toBe(2);
    expect(r.totals.noEvidence).toBe(2);
  });

  it('자유문서 연결이 있으면 근거 있음 (기존 정의 유지 확인)', () => {
    const { cycleId, questionIds } = seedCycle(2026, '50', 2);
    const richId = Number(
      db
        .prepare(
          `INSERT INTO rich_doc (title, content_json, content_plain, updated_at) VALUES ('절차서', '{}', '', ?)`,
        )
        .run(now).lastInsertRowid,
    );
    db.prepare(`INSERT INTO question_richdoc (question_id, rich_doc_id, sort) VALUES (?, ?, 1)`).run(
      questionIds[0]!,
      richId,
    );
    const r = computeReadiness(db, cycleId);
    expect(r.categories[0]!.noEvidence).toBe(1); // 두 번째 문항만
  });
});

describe('computeReadiness — staleOpen 주기 한정 (C3)', () => {
  it('다른 주기의 자동배점 재계산 필요 문항은 요청 주기 집계에 섞이지 않는다', () => {
    const c2026 = seedCycle(2026, '50', 1);
    const c2027 = seedCycle(2027, '50', 1);
    const mkStale = (questionId: number): void => {
      db.prepare(`UPDATE question SET scoring_mode = 'auto' WHERE id = ?`).run(questionId);
      db.prepare(
        `INSERT INTO auto_score_state (question_id, stale, computed_at) VALUES (?, 1, ?)`,
      ).run(questionId, now);
    };
    mkStale(c2026.questionIds[0]!);
    mkStale(c2027.questionIds[0]!);

    // reviewOpen = anchorOpen(0) + staleOpen + needsRecheck(0) — 주기별로 자기 것만
    const r2026 = computeReadiness(db, c2026.cycleId);
    expect(r2026.totals.reviewOpen).toBe(1); // 종전(전역)이라면 2
    const r2027 = computeReadiness(db, c2027.cycleId);
    expect(r2027.totals.reviewOpen).toBe(1);
    // metricMissing(자동배점 지표 미바인딩)은 주기 스코프 그대로 — 각 주기 1건
    expect(r2026.totals.metricMissing).toBe(1);
    expect(r2027.totals.metricMissing).toBe(1);
  });
});
