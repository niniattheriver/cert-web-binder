// 무결성 점검기 단위 검증 — §2 불변식 4종 각각의 통과/위반 케이스.
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { contentPath } from '../docs/store.js';
import {
  getLastIntegrityResult,
  persistIntegrityResult,
  runIntegrityCheck,
} from './integrity.js';

let db: Database.Database;
let filesDir: string;
const NOW = new Date().toISOString();

beforeEach(() => {
  db = openDatabase(':memory:');
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-integrity-'));
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026','active',?)`).run(NOW);
  db.prepare(`INSERT INTO category (cycle_id, code, name) VALUES (1,'50','개인정보')`).run();
});
afterEach(() => {
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function insertQuestion(fields: {
  no: string;
  answerChoice?: 'yes' | 'no' | 'na' | null;
  score?: number | null;
  maxScore?: number | null;
  allowNa?: number;
  deletedAt?: string | null;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO question (category_id, question_no, body, answer_choice, score, max_score, allow_na, deleted_at, updated_at)
         VALUES (1,?,?,?,?,?,?,?,?)`,
      )
      .run(
        fields.no,
        '본문',
        fields.answerChoice ?? null,
        fields.score ?? null,
        fields.maxScore ?? null,
        fields.allowNa ?? 0,
        fields.deletedAt ?? null,
        NOW,
      ).lastInsertRowid,
  );
}

function insertDocVersion(fields: {
  label: string;
  sha256: string;
  status?: string;
  isCurrent?: number;
}): number {
  db.prepare(`INSERT OR IGNORE INTO document (id, code, title) VALUES (1,'D1','지침')`).run();
  return Number(
    db
      .prepare(
        `INSERT INTO document_version
           (document_id, version_label, file_sha256, file_name, file_size, status, is_current, uploaded_at)
         VALUES (1,?,?,?,?,?,?,?)`,
      )
      .run(fields.label, fields.sha256, 'f.pdf', 10, fields.status ?? 'active', fields.isCurrent ?? 0, NOW)
      .lastInsertRowid,
  );
}

function check(result: ReturnType<typeof runIntegrityCheck>, name: string) {
  const c = result.checks.find((x) => x.name.includes(name));
  if (!c) throw new Error(`점검 항목 없음: ${name}`);
  return c;
}

describe('runIntegrityCheck — 깨끗한 DB', () => {
  it('데이터가 없으면 전 항목 통과', () => {
    const r = runIntegrityCheck(db, filesDir);
    expect(r.ok).toBe(true);
  });
});

describe('불변식 1: is_current 정확히 1개', () => {
  it('활성 판본이 있으나 is_current=0 → 위반', () => {
    insertDocVersion({ label: 'v1', sha256: 'a'.repeat(64), status: 'active', isCurrent: 0 });
    // 파일도 배치해 다른 점검 통과시킴
    const p = contentPath(filesDir, 'a'.repeat(64));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    const c = check(runIntegrityCheck(db, filesDir), '현재 판본');
    expect(c.ok).toBe(false);
    expect(c.offenderCount).toBe(1);
  });

  it('is_current=1 판본이 2개 → 위반', () => {
    const sha = 'a'.repeat(64);
    insertDocVersion({ label: 'v1', sha256: sha, isCurrent: 1 });
    insertDocVersion({ label: 'v2', sha256: sha, isCurrent: 1 });
    const p = contentPath(filesDir, sha);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    const c = check(runIntegrityCheck(db, filesDir), '현재 판본');
    expect(c.ok).toBe(false);
  });

  it('정확히 1개면 통과', () => {
    const sha = 'a'.repeat(64);
    insertDocVersion({ label: 'v1', sha256: sha, isCurrent: 1 });
    const p = contentPath(filesDir, sha);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    expect(check(runIntegrityCheck(db, filesDir), '현재 판본').ok).toBe(true);
  });
});

describe('불변식 2: sha256 파일 존재', () => {
  it('파일이 디스크에 없으면 위반, 배치하면 통과', () => {
    const sha = 'c'.repeat(64);
    insertDocVersion({ label: 'v1', sha256: sha, isCurrent: 1 });
    expect(check(runIntegrityCheck(db, filesDir), 'sha256 파일').ok).toBe(false);
    const p = contentPath(filesDir, sha);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'pdf');
    expect(check(runIntegrityCheck(db, filesDir), 'sha256 파일').ok).toBe(true);
  });
});

describe('불변식 3: 채점 정합', () => {
  it("'아니오'인데 score≠0 → 위반", () => {
    insertQuestion({ no: '1', answerChoice: 'no', score: 5 });
    expect(check(runIntegrityCheck(db, filesDir), '채점 정합').ok).toBe(false);
  });
  it("'예'인데 0.5 간격 아님 → 위반", () => {
    insertQuestion({ no: '2', answerChoice: 'yes', score: 0.3, maxScore: 5 });
    expect(check(runIntegrityCheck(db, filesDir), '채점 정합').ok).toBe(false);
  });
  it("'예'인데 max 초과 → 위반", () => {
    insertQuestion({ no: '3', answerChoice: 'yes', score: 6, maxScore: 5 });
    expect(check(runIntegrityCheck(db, filesDir), '채점 정합').ok).toBe(false);
  });
  it("'해당없음'인데 score가 있으면 위반", () => {
    insertQuestion({ no: '4', answerChoice: 'na', score: 1, allowNa: 1 });
    expect(check(runIntegrityCheck(db, filesDir), '채점 정합').ok).toBe(false);
  });
  it('정합적 값들은 통과', () => {
    insertQuestion({ no: '5', answerChoice: 'no', score: 0 });
    insertQuestion({ no: '6', answerChoice: 'yes', score: 2.5, maxScore: 5 });
    insertQuestion({ no: '7', answerChoice: 'na', score: null, allowNa: 1 });
    expect(check(runIntegrityCheck(db, filesDir), '채점 정합').ok).toBe(true);
  });
});

describe('불변식 4: 조인 soft-delete 참조', () => {
  it('soft-delete된 passage를 참조하는 question_passage → 위반', () => {
    const q = insertQuestion({ no: '10' });
    db.prepare(`INSERT OR IGNORE INTO document (id, code, title) VALUES (1,'D1','지침')`).run();
    const p = Number(
      db.prepare(`INSERT INTO passage (document_id, deleted_at) VALUES (1,?)`).run(NOW).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO question_passage (question_id, passage_id, created_at) VALUES (?,?,?)`,
    ).run(q, p, NOW);
    expect(check(runIntegrityCheck(db, filesDir), '조인').ok).toBe(false);
  });

  it('soft-delete된 rich_doc 참조 → 위반', () => {
    const q = insertQuestion({ no: '11' });
    const rd = Number(
      db
        .prepare(
          `INSERT INTO rich_doc (title, content_json, deleted_at, updated_at) VALUES ('문서','{}',?,?)`,
        )
        .run(NOW, NOW).lastInsertRowid,
    );
    db.prepare(`INSERT INTO question_richdoc (question_id, rich_doc_id) VALUES (?,?)`).run(q, rd);
    expect(check(runIntegrityCheck(db, filesDir), '조인').ok).toBe(false);
  });

  it('정상(삭제 안 된) 링크는 통과', () => {
    const q = insertQuestion({ no: '12' });
    db.prepare(`INSERT OR IGNORE INTO document (id, code, title) VALUES (1,'D1','지침')`).run();
    const p = Number(
      db.prepare(`INSERT INTO passage (document_id) VALUES (1)`).run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO question_passage (question_id, passage_id, created_at) VALUES (?,?,?)`,
    ).run(q, p, NOW);
    expect(check(runIntegrityCheck(db, filesDir), '조인').ok).toBe(true);
  });
});

describe('결과 보존', () => {
  it('persist → getLast 왕복', () => {
    const r = runIntegrityCheck(db, filesDir);
    persistIntegrityResult(db, r);
    const loaded = getLastIntegrityResult(db);
    expect(loaded).not.toBeNull();
    expect(loaded!.ok).toBe(r.ok);
    expect(loaded!.checks.length).toBe(r.checks.length);
  });
});

describe('불변식 6: 첨부 저장소 파일 존재 (Phase 2)', () => {
  it('문항 첨부 파일이 디스크에 없으면 위반 — soft delete된 첨부도 검사(파일은 보존 대상)', () => {
    const q = insertQuestion({ no: '13' });
    const sha = 'a'.repeat(64);
    db.prepare(
      `INSERT INTO question_attachment (question_id, sha256, orig_name, mime, size, uploaded_at, deleted_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(q, sha, '근거.pdf', 'application/pdf', 10, NOW, NOW); // soft delete 상태
    const c = check(runIntegrityCheck(db, filesDir), '첨부');
    expect(c.ok).toBe(false);
    expect(c.offenderCount).toBe(1);

    // 파일을 배치하면 통과
    const target = path.join(filesDir, 'attachments', sha.slice(0, 2), sha.slice(2));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x');
    expect(check(runIntegrityCheck(db, filesDir), '첨부').ok).toBe(true);
  });

  it('지침서 원본·에디터 이미지도 대상', () => {
    insertDocVersion({ label: 'v1', sha256: 'b'.repeat(64), isCurrent: 1 });
    db.prepare(
      `UPDATE document_version SET source_sha256 = ?, source_name = '원본.hwp' WHERE version_label = 'v1'`,
    ).run('c'.repeat(64));
    db.prepare(`INSERT INTO attachment (sha256, mime, orig_name, size) VALUES (?,?,?,?)`).run(
      'd'.repeat(64),
      'image/png',
      'img.png',
      5,
    );
    const c = check(runIntegrityCheck(db, filesDir), '첨부');
    expect(c.ok).toBe(false);
    expect(c.offenderCount).toBe(2); // 원본 1 + 이미지 1 (판본 PDF는 불변식 2 담당)
  });
});
