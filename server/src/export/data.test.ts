// 엑셀 내보내기 자료: 근거 유무(hasEvidence)는 화면 목록과 같이 첨부, 링크까지 세고, 지운 것은 세지 않는다
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { collectExportCategories } from './data.js';
import { statusText } from './workbook.js';

function makeDb(): { db: Database.Database; cycleId: number; qid: (no: string) => number } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = '2026-10-12T00:00:00.000Z';
  const cycleId = Number(
    db.prepare(`INSERT INTO cycle (name, status, year, created_at) VALUES ('2026년 심사', 'active', 2026, ?)`).run(now)
      .lastInsertRowid,
  );
  const catId = Number(
    db.prepare(`INSERT INTO category (cycle_id, code, name) VALUES (?, '50', '개인정보보호')`).run(cycleId).lastInsertRowid,
  );
  const insertQ = db.prepare(
    `INSERT INTO question (category_id, question_no, sort_key, body, max_score, answer_choice, score, updated_at)
     VALUES (?, ?, ?, '문항 본문', 3, ?, ?, ?)`,
  );
  const rows: Array<[string, 'yes' | null, number | null]> = [
    ['50.010.010', 'yes', 3], // 첨부만 있음
    ['50.010.020', 'yes', 3], // 링크만 있음
    ['50.010.030', 'yes', 3], // 지운 링크만 있음
    ['50.010.040', null, null], // 링크만 있고 채점 전
  ];
  rows.forEach(([no, choice, score], i) => insertQ.run(catId, no, i, choice, score, now));
  const qid = (no: string): number =>
    (db.prepare('SELECT id FROM question WHERE question_no = ?').get(no) as { id: number }).id;
  db.prepare(
    `INSERT INTO question_attachment (question_id, sha256, orig_name, mime, size, uploaded_at)
     VALUES (?, ?, '정도관리 기록.pdf', 'application/pdf', 10, ?)`,
  ).run(qid('50.010.010'), 'a'.repeat(64), now);
  const insertLink = db.prepare(
    `INSERT INTO question_link (question_id, url, created_at, deleted_at) VALUES (?, 'https://example.org', ?, ?)`,
  );
  insertLink.run(qid('50.010.020'), now, null);
  insertLink.run(qid('50.010.030'), now, now);
  insertLink.run(qid('50.010.040'), now, null);
  return { db, cycleId, qid };
}

describe('collectExportCategories: 근거 유무와 상태', () => {
  it('첨부나 링크만 있어도 근거가 있고, 지운 링크는 세지 않는다', () => {
    const { db, cycleId } = makeDb();
    const [cat] = collectExportCategories(db, cycleId);
    const byNo = new Map(cat!.questions.map((q) => [q.questionNo, q]));
    expect(byNo.get('50.010.010')!.hasEvidence).toBe(true);
    expect(byNo.get('50.010.020')!.hasEvidence).toBe(true);
    expect(byNo.get('50.010.030')!.hasEvidence).toBe(false);
    expect(byNo.get('50.010.040')!.hasEvidence).toBe(true);
    expect(cat!.questions.map((q) => statusText(q))).toEqual(['완료', '완료', '진행 중', '진행 중']);
  });
});
