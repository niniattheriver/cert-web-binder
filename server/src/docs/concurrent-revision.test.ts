// 같은 문서의 동시 개정
// 한 업로드가 좌표 계산(비동기)을 하는 사이 같은 문서에 다른 버전이 저장되거나 직전 버전에 근거가 더해져도,
// 현재 버전은 하나이고 근거는 현재 버전에 한 줄씩만 있다. 계속 어긋나면 저장하지 않고 ConcurrentRevisionError.
// 좌표 계산(geometry.ts)만 감싸 멈추거나 끼어들게 하고, 추출, SQLite, 마이그레이션, 재앵커링은 실제 코드를 쓴다.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { buildPageOffsets, fullTextOf } from '../pdf/offsets.js';
import { ConcurrentRevisionError, uploadGuideline } from './service.js';
import { buildTestPdf } from './test-pdf-util.js';

/** hold: 다음 좌표 계산 한 번을 release 까지 멈춘다. onCall: 좌표 계산마다 먼저 부른다(끼어들기) */
const gate = vi.hoisted(() => ({
  hold: null as null | { reached: () => void; release: Promise<void> },
  onCall: null as null | (() => Promise<void>),
  calls: 0,
}));

vi.mock('./geometry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./geometry.js')>();
  return {
    ...real,
    computePageGeometries: async (...args: Parameters<typeof real.computePageGeometries>) => {
      gate.calls += 1;
      const h = gate.hold;
      if (h) {
        gate.hold = null;
        h.reached();
        await h.release;
      }
      if (gate.onCall) await gate.onCall();
      return real.computePageGeometries(...args);
    },
  };
});

const QUOTE = 'The destruction ledger shall be kept by the officer.';
const QUOTE_2 = 'Article 13 outsourcing management.';
const pdfPages = (extra: string): string[][] => [
  ['Article 11 storage of personal data.', extra, QUOTE],
  [QUOTE_2, 'Records shall be reviewed every quarter.'],
];

let db: Database.Database;
let filesDir: string;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('e','x','편집자','editor',1)`,
  ).run();
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-concurrent-'));
});

afterAll(() => {
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

afterEach(() => {
  gate.hold = null;
  gate.onCall = null;
  gate.calls = 0;
});

/** 새 문서를 PDF 첫 버전으로 만들고, 인용 quote 에 손으로 단 근거(발췌+앵커)를 하나 둔다 */
async function docWithAnchor(title: string): Promise<{ docId: number; v1: number; passageId: number }> {
  const r = await uploadGuideline(db, {
    buffer: buildTestPdf(pdfPages('first version line.')),
    fileName: `${title}-v1.pdf`,
    title,
    versionLabel: 'v1',
    userId: 1,
    filesDir,
  });
  if (r.duplicate) throw new Error('중복일 수 없음');
  const passageId = addAnchor(r.documentId, r.versionId, QUOTE);
  return { docId: r.documentId, v1: r.versionId, passageId };
}

/** 그 버전의 전문에서 quote 를 찾아 발췌와 확정 앵커를 만든다 (근거 연결 결과 모사) */
function addAnchor(docId: number, versionId: number, quote: string): number {
  const rows = db
    .prepare('SELECT page_no AS pageNo, text FROM page_text WHERE document_version_id = ? ORDER BY page_no')
    .all(versionId) as { pageNo: number; text: string }[];
  const full = fullTextOf(buildPageOffsets(rows));
  const start = full.indexOf(quote);
  expect(start).toBeGreaterThanOrEqual(0);
  const passageId = Number(
    db.prepare('INSERT INTO passage (document_id, label) VALUES (?, ?)').run(docId, quote.slice(0, 12)).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO passage_anchor
       (passage_id, document_version_id, quote_exact, start_offset, end_offset,
        page_start, page_end, rects_json, geometry_primary, status, method, confidence)
     VALUES (?, ?, ?, ?, ?, 1, 1, '[]', 0, 'resolved', 'manual', 1.0)`,
  ).run(passageId, versionId, quote, start, start + quote.length);
  return passageId;
}

function currentVersions(docId: number): { id: number; version_label: string }[] {
  return db
    .prepare('SELECT id, version_label FROM document_version WHERE document_id = ? AND is_current = 1')
    .all(docId) as { id: number; version_label: string }[];
}

/** 그 발췌의 앵커 중 현재 버전에 있는 것 (근거 목록이 한 발췌를 몇 줄로 보이는지와 같다) */
function anchorsOnCurrent(passageId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM passage_anchor pa
         JOIN document_version dv ON dv.id = pa.document_version_id AND dv.is_current = 1
         WHERE pa.passage_id = ?`,
      )
      .get(passageId) as { n: number }
  ).n;
}

describe('같은 문서의 동시 개정 (R2)', () => {
  it('PDF 새 버전이 좌표를 계산하는 사이 다른 버전이 저장돼도 현재 버전은 하나, 근거는 한 줄', async () => {
    const { docId, passageId } = await docWithAnchor('동시 개정 시험');
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    gate.hold = { reached, release: new Promise<void>((r) => (release = r)) };

    const slow = uploadGuideline(db, {
      buffer: buildTestPdf(pdfPages('slow pdf revision line.')),
      fileName: '동시-v2.pdf',
      versionLabel: 'v2',
      documentId: docId,
      userId: 1,
      filesDir,
    });
    await reachedP; // v2 가 v1 을 직전 버전으로 계획하고 좌표 계산에서 멈췄다
    const fast = await uploadGuideline(db, {
      buffer: buildTestPdf(pdfPages('fast pdf revision line.')),
      fileName: '동시-v3.pdf',
      versionLabel: 'v3',
      documentId: docId,
      userId: 1,
      filesDir,
    });
    if (fast.duplicate) throw new Error('중복일 수 없음');
    release();
    const late = await slow;
    if (late.duplicate) throw new Error('중복일 수 없음');

    // 늦게 끝난 v2 가 v3 를 직전 버전으로 다시 계획해 그 뒤에 이어졌다: v1 → v3 → v2
    expect(currentVersions(docId)).toEqual([{ id: late.versionId, version_label: 'v2' }]);
    const v3 = db.prepare('SELECT status, is_current FROM document_version WHERE id = ?').get(fast.versionId);
    expect(v3).toEqual({ status: 'superseded', is_current: 0 });
    expect(anchorsOnCurrent(passageId)).toBe(1);
    expect(late.reanchor).toEqual({ auto: 1, needsReview: 0 });
    // 버려진 첫 시도는 아무것도 남기지 않았다: v2 판본 행과 그 생성 기록은 하나
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM document_version WHERE document_id = ? AND version_label = 'v2'").get(docId) as { n: number }).n,
    ).toBe(1);
    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'document_version' AND action = 'create' AND entity_id = ?")
        .get(late.versionId) as { n: number }).n,
    ).toBe(1);
  }, 60000);

  it('좌표를 계산하는 사이 직전 버전에 근거가 더해지면 그 근거도 새 버전으로 옮긴다', async () => {
    const { docId, v1, passageId } = await docWithAnchor('계산 중 근거 추가 시험');
    let added: number | null = null;
    gate.onCall = async () => {
      if (added == null) added = addAnchor(docId, v1, QUOTE_2); // 사용자가 그 사이 v1 에 근거를 하나 더 연결
    };
    const r = await uploadGuideline(db, {
      buffer: buildTestPdf(pdfPages('second version line.')),
      fileName: '추가-v2.pdf',
      versionLabel: 'v2',
      documentId: docId,
      userId: 1,
      filesDir,
    });
    if (r.duplicate) throw new Error('중복일 수 없음');
    expect(currentVersions(docId)).toEqual([{ id: r.versionId, version_label: 'v2' }]);
    expect(anchorsOnCurrent(passageId)).toBe(1);
    expect(added).not.toBeNull();
    expect(anchorsOnCurrent(added!)).toBe(1); // 예전에는 v1 에만 남아 현재 버전에서 사라졌다
    expect(r.reanchor).toEqual({ auto: 2, needsReview: 0 });
  }, 60000);

  it('저장 직전마다 다른 버전이 끼어들면 세 번 다시 해 보고 저장하지 않는다 (ConcurrentRevisionError)', async () => {
    const { docId } = await docWithAnchor('계속 끼어드는 시험');
    let n = 0;
    gate.onCall = async () => {
      // 텍스트 버전은 좌표를 계산하지 않으므로 이 끼어들기가 다시 끼어들지 않는다
      n += 1;
      const text = ['Article 11 storage of personal data.', `interleaved text revision ${n}.`, QUOTE].join('\n');
      await uploadGuideline(db, {
        buffer: Buffer.from(text, 'utf8'),
        fileName: `끼어들기-${n}.txt`,
        versionLabel: `t${n}`,
        documentId: docId,
        userId: 1,
        filesDir,
      });
    };
    await expect(
      uploadGuideline(db, {
        buffer: buildTestPdf(pdfPages('never committed line.')),
        fileName: '끼어들기-v2.pdf',
        versionLabel: 'v2',
        documentId: docId,
        userId: 1,
        filesDir,
      }),
    ).rejects.toBeInstanceOf(ConcurrentRevisionError);
    expect(gate.calls).toBe(3);
    expect(currentVersions(docId)).toEqual([expect.objectContaining({ version_label: 't3' })]);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM document_version WHERE document_id = ? AND version_label = 'v2'").get(docId) as { n: number }).n,
    ).toBe(0);
  }, 60000);
});
