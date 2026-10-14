// 마이그레이션 010(그림 파일): document_version 을 새로 만들어 옮겨 file_kind CHECK 에 'image' 를 더한다.
// 행, 외래키 참조, 색인이 그대로인지, 러너가 외래키 강제를 끄고 되돌리는지, 참조를 끊는 변경은 롤백하는지 본다.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 001~009 만 담은 마이그레이션 폴더 (extra: 더 넣을 파일 이름 → 내용) */
function migrationsUpTo009(extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mig009-'));
  tmpDirs.push(dir);
  for (const f of fs.readdirSync(migrationsDir)) {
    if (/^00[1-9]_.*\.sql$/.test(f)) fs.copyFileSync(path.join(migrationsDir, f), path.join(dir, f));
  }
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
  return dir;
}

/** 009 까지 적용하고 판본 둘(pdf, docx)과 그 쪽 글자, 렌더 모델, 발췌 앵커를 넣은 DB (1.6.x 에서 올라온 설치) */
function dbAt009(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsUpTo009());
  expect(db.pragma('user_version', { simple: true })).toBe(9);
  const now = '2026-10-01T00:00:00.000Z';
  db.prepare(`INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('editor1','x','편집자','editor',1)`).run();
  db.prepare(`INSERT INTO document (id, code, title) VALUES (1, 'SOP-1', '검체 관리 지침')`).run();
  const insertVersion = db.prepare(
    `INSERT INTO document_version
       (id, document_id, version_label, file_sha256, file_name, file_size, page_count, extractor, canon_norm,
        status, is_current, text_warning, uploaded_by, uploaded_at, source_sha256, source_name, source_mime,
        source_size, year, file_kind)
     VALUES (?, 1, ?, ?, ?, ?, 1, ?, 'nfc-v1', ?, ?, ?, 1, ?, ?, ?, ?, ?, 2026, ?)`,
  );
  insertVersion.run(7, 'v1', 'a'.repeat(64), '지침.pdf', 100, 'pdfjs-4.10.38', 'superseded', 0, '스캔 의심 1', now, 'b'.repeat(64), '지침.hwp', 'application/x-hwp', 50, 'pdf');
  insertVersion.run(9, 'v2', 'c'.repeat(64), '지침.docx', 200, 'docx-v1', 'active', 1, null, now, null, null, null, null, 'docx');
  db.prepare(`INSERT INTO page_text (document_version_id, page_no, start_offset, text, label) VALUES (7, 1, 0, '제1조 보관', NULL), (9, 1, 0, '제1조 보관', '구간 1')`).run();
  db.prepare(`INSERT INTO document_render (document_version_id, model_version, extractor, json_gz, created_at) VALUES (9, 1, 'docx-v1', x'00', ?)`).run(now);
  db.prepare(`INSERT INTO passage (id, document_id) VALUES (3, 1)`).run();
  db.prepare(
    `INSERT INTO passage_anchor (passage_id, document_version_id, quote_exact, start_offset, end_offset, page_start, page_end, status)
     VALUES (3, 7, '보관', 4, 6, 1, 1, 'resolved'), (3, 9, '보관', 4, 6, 1, 1, 'resolved_auto')`,
  ).run();
  return db;
}

const versionRows = (db: Database.Database): unknown[] => db.prepare('SELECT * FROM document_version ORDER BY id').all();

describe('마이그레이션 010 그림 파일', () => {
  it('행과 열 값, 외래키 참조, 색인을 그대로 두고 file_kind 에 image 를 받는다', () => {
    const db = dbAt009();
    const before = versionRows(db);

    expect(runMigrations(db)).toEqual(['010_image_documents.sql']);
    expect(db.pragma('user_version', { simple: true })).toBe(10);
    expect(versionRows(db)).toEqual(before);
    // 러너가 끈 외래키 강제는 다시 켜져 있다
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    for (const child of ['page_text', 'passage_anchor', 'document_render']) {
      const fks = db.pragma(`foreign_key_list(${child})`) as { table: string; from: string }[];
      expect(fks.find((f) => f.from === 'document_version_id')?.table).toBe('document_version');
    }
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'document_version' ORDER BY name`).all();
    expect(idx).toContainEqual({ name: 'idx_docver_document' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'document_version_new'`).get()).toEqual({ n: 0 });

    // 새 값은 받고, 목록 밖 값과 이어지지 않는 문서는 그대로 막는다
    const insert = db.prepare(
      `INSERT INTO document_version (document_id, version_label, file_sha256, file_name, file_size, uploaded_at, file_kind)
       VALUES (?, ?, 'd', 'x', 1, '2026-10-14', ?)`,
    );
    expect(() => insert.run(1, 'v3', 'image')).not.toThrow();
    expect(() => insert.run(1, 'v4', 'svg')).toThrow(/CHECK constraint/);
    expect(() => insert.run(999, 'v5', 'image')).toThrow(/FOREIGN KEY/);
    expect(() => insert.run(1, 'v3', 'image')).toThrow(/UNIQUE/);
    // 판본을 가리키는 행이 있으면 판본을 지울 수 없다(외래키 강제가 살아 있다)
    expect(() => db.prepare('DELETE FROM document_version WHERE id = 9').run()).toThrow(/FOREIGN KEY/);
  });

  it('적용 전부터 있던 외래키 위반은 기동을 막지 않는다(위반 수가 늘지 않으면 통과)', () => {
    const db = dbAt009();
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO page_text (document_version_id, page_no, start_offset, text) VALUES (404, 1, 0, '고아')`).run();
    db.pragma('foreign_keys = ON');
    expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(1);

    expect(runMigrations(db)).toEqual(['010_image_documents.sql']);
    expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(1);
  });

  it('외래키를 끄고 돌린 파일이 참조를 끊으면 전체를 롤백하고 외래키 강제를 되돌린다', () => {
    const dir = migrationsUpTo009({
      '010_image_documents.sql': fs.readFileSync(path.join(migrationsDir, '010_image_documents.sql'), 'utf8'),
      '011_bad.sql': '-- migrate: foreign_keys=off\nDELETE FROM document;\n',
    });
    const db = dbAt009();
    expect(() => runMigrations(db, dir)).toThrow(/011_bad\.sql: 외래키 참조가 끊겼습니다/);
    expect(db.pragma('user_version', { simple: true })).toBe(10);
    expect(db.prepare('SELECT COUNT(*) AS n FROM document').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('표지가 첫 줄이 아니면 외래키 강제를 끄지 않는다(평소처럼 막힌다)', () => {
    const dir = migrationsUpTo009({
      '010_image_documents.sql': fs.readFileSync(path.join(migrationsDir, '010_image_documents.sql'), 'utf8'),
      '011_note.sql': '-- 설명 줄\n-- migrate: foreign_keys=off\nDELETE FROM document;\n',
    });
    const db = dbAt009();
    expect(() => runMigrations(db, dir)).toThrow(/011_note\.sql: FOREIGN KEY/);
    expect(db.pragma('user_version', { simple: true })).toBe(10);
  });
});
