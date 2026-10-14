// 앵커 서비스 단위 테스트 — :memory: DB로 겹침 판정(≥0.6, min 길이 기준)·통합 sort·단어 수 검증
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { countWords, findOverlappingAnchor, nextEvidenceSort } from './service.js';

let db: Database.Database;
let versionId: number;
let passageId: number;
let deletedPassageId: number;
let questionId: number;

beforeAll(() => {
  db = openDatabase(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('e','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','개인정보보호',1)`).run();
  questionId = Number(
    db
      .prepare(
        `INSERT INTO question (category_id, question_no, sort_key, body, updated_at)
         VALUES (1,'50.210.420',1,'본문',?)`,
      )
      .run(now).lastInsertRowid,
  );
  const docId = Number(
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
      .run(docId, '2026-개정1', 'a'.repeat(64), '지침.pdf', 1000, 10, 'active', 1, now).lastInsertRowid,
  );
  // 기존 앵커 [0,100)
  passageId = Number(
    db.prepare(`INSERT INTO passage (document_id) VALUES (?)`).run(docId).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO passage_anchor
       (passage_id, document_version_id, quote_exact, start_offset, end_offset, page_start, page_end, status, method)
     VALUES (?,?,?,0,100,1,1,'resolved','manual')`,
  ).run(passageId, versionId, '기존 발췌 인용문');
  db.prepare(
    `INSERT INTO question_passage (question_id, passage_id, sort, created_at) VALUES (?,?,3,?)`,
  ).run(questionId, passageId, now);
  // soft-delete된 passage의 앵커 [200,300) — 겹침 검사에서 제외돼야 함
  deletedPassageId = Number(
    db.prepare(`INSERT INTO passage (document_id, deleted_at) VALUES (?,?)`).run(docId, now)
      .lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO passage_anchor
       (passage_id, document_version_id, quote_exact, start_offset, end_offset, page_start, page_end, status, method)
     VALUES (?,?,?,200,300,2,2,'resolved','manual')`,
  ).run(deletedPassageId, versionId, '삭제된 발췌');
});

afterAll(() => {
  db.close();
});

describe('findOverlappingAnchor — 교집합/min(길이) ≥ 0.6', () => {
  it('겹침율 정확히 0.6이면 감지한다 (경계 포함)', () => {
    // 기존 [0,100) vs 신규 [40,140): 교집합 60 / min(100,100) = 0.6
    const hit = findOverlappingAnchor(db, versionId, 40, 140);
    expect(hit).not.toBeNull();
    expect(hit!.passageId).toBe(passageId);
    expect(hit!.quote).toBe('기존 발췌 인용문');
    expect(hit!.questions).toEqual([{ id: questionId, questionNo: '50.210.420' }]);
  });

  it('겹침율 0.6 미만이면 null (0.5)', () => {
    // [50,150): 교집합 50 / min(100,100) = 0.5
    expect(findOverlappingAnchor(db, versionId, 50, 150)).toBeNull();
  });

  it('분모는 min(두 길이) — 짧은 신규 선택이 기존 안에 완전히 포함되면 감지', () => {
    // [70,100): 교집합 30 / min(100,30) = 1.0 (기존 대비 30%뿐이어도 겹침)
    const hit = findOverlappingAnchor(db, versionId, 70, 100);
    expect(hit).not.toBeNull();
    expect(hit!.anchorId).toBeGreaterThan(0);
  });

  it('soft-delete된 passage의 앵커는 겹침 검사에서 제외', () => {
    // 삭제된 passage 앵커 [200,300)과 완전히 겹치는 [200,300) → null
    expect(findOverlappingAnchor(db, versionId, 200, 300)).toBeNull();
  });
});

describe('nextEvidenceSort — question_passage ∪ question_richdoc 통합 max+1', () => {
  it('richdoc sort가 더 크면 그 다음 번호를 반환', () => {
    const now = new Date().toISOString();
    const richDocId = Number(
      db
        .prepare(`INSERT INTO rich_doc (title, content_json, updated_at) VALUES ('증적','{}',?)`)
        .run(now).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO question_richdoc (question_id, rich_doc_id, sort) VALUES (?,?,7)`,
    ).run(questionId, richDocId);
    expect(nextEvidenceSort(db, questionId)).toBe(8); // max(qp=3, qr=7)+1
  });

  it('근거가 없는 문항은 1', () => {
    const now = new Date().toISOString();
    const q2 = Number(
      db
        .prepare(
          `INSERT INTO question (category_id, question_no, sort_key, body, updated_at)
           VALUES (1,'50.210.430',2,'본문2',?)`,
        )
        .run(now).lastInsertRowid,
    );
    expect(nextEvidenceSort(db, q2)).toBe(1);
  });
});

describe('countWords — 초단문 넛지 판정', () => {
  it('공백 기준 어절 수를 센다', () => {
    expect(countWords('짧은 문구')).toBe(2);
    expect(countWords('  앞뒤 공백  무시  ')).toBe(3);
    expect(countWords('파기 대장을 작성하고 보존하여야 한다')).toBe(5);
  });
});
