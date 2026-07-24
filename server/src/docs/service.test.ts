// 지침서 업로드 파이프라인 + 재앵커링 v1 통합 테스트 — :memory: DB에 전체 마이그레이션 적용
// 데모 지침서 PDF 실물(seed/demo-pdfs)로 page_text 행수·오프셋 연속성·FTS를 검증하고,
// 자체 생성 초소형 PDF(v1→문구 1건만 바꾼 v2)로 재앵커링 auto/needs_review 분류를 검증한다.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { InvalidPdfError } from '../pdf/extract.js';
import { buildPageOffsets, fullTextOf } from '../pdf/offsets.js';
import {
  DuplicateVersionLabelError,
  LOW_DENSITY_MIN_CHARS,
  uploadGuideline,
} from './service.js';
import { contentPath, sha256Hex } from './store.js';
import { buildTestPdf } from './test-pdf-util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_GUIDELINE = path.join(
  here, '..', '..', '..', 'seed', 'demo-pdfs', '가상지침서-개인정보처리지침.pdf',
);

let db: Database.Database;
let filesDir: string;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db); // year 컬럼(007) 포함 최신 스키마
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('e','x','편집자','editor',1)`,
  ).run();
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-files-'));
});

afterAll(() => {
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

interface PageTextRow {
  page_no: number;
  start_offset: number;
  text: string;
}

function pageRows(versionId: number): PageTextRow[] {
  return db
    .prepare('SELECT page_no, start_offset, text FROM page_text WHERE document_version_id = ? ORDER BY page_no')
    .all(versionId) as PageTextRow[];
}

describe('업로드 파이프라인 (데모 지침서 PDF 실물)', () => {
  let demoBuf: Uint8Array;
  let docId: number;
  let versionId: number;

  beforeAll(async () => {
    demoBuf = new Uint8Array(fs.readFileSync(DEMO_GUIDELINE));
    const res = await uploadGuideline(db, {
      buffer: demoBuf,
      fileName: '가상지침서-개인정보처리지침.pdf',
      title: '가상기관 개인정보 처리지침',
      versionLabel: '2026-1',
      code: 'PRIV',
      userId: 1,
      filesDir,
    });
    if (res.duplicate) throw new Error('중복일 수 없음');
    docId = res.documentId;
    versionId = res.versionId;
    expect(res.pageCount).toBe(8); // README: 8쪽
    expect(res.textWarning).toBeNull(); // 텍스트 PDF — 저밀도 페이지 없음
  }, 60000);

  it('page_text 행수 == page_count, 판본 메타 저장', () => {
    const rows = pageRows(versionId);
    expect(rows.length).toBe(8);
    const v = db
      .prepare('SELECT page_count, status, is_current, extractor, canon_norm FROM document_version WHERE id = ?')
      .get(versionId) as Record<string, unknown>;
    expect(v.page_count).toBe(8);
    expect(v.status).toBe('active');
    expect(v.is_current).toBe(1);
    expect(String(v.extractor)).toMatch(/^pdfjs-/);
    expect(v.canon_norm).toBe('nfc-v1');
  });

  it('start_offset 연속성: 첫 페이지 0, 이후 = 직전 시작 + 직전 길이 + 1(구분자)', () => {
    const rows = pageRows(versionId);
    expect(rows[0]!.start_offset).toBe(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.start_offset).toBe(rows[i - 1]!.start_offset + rows[i - 1]!.text.length + 1);
    }
    // 모든 페이지 텍스트는 NFC (한글 NFC/NFD 혼입 방지 — §3.1-3)
    for (const r of rows) expect(r.text).toBe(r.text.normalize('NFC'));
  });

  it("FTS(kind='page_text') 인덱싱 — '개인정보' 검색 1건 이상, ref_id=page_text rowid 조인 성립", () => {
    const hits = db
      .prepare(
        `SELECT pt.document_version_id AS vid, pt.page_no
         FROM fts JOIN page_text pt ON pt.rowid = fts.ref_id
         WHERE fts.kind = 'page_text' AND fts MATCH '"개인정보"'`,
      )
      .all() as { vid: number; page_no: number }[];
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((h) => h.vid === versionId)).toBe(true);
  });

  it('파일이 내용주소 경로(sha256/<2자>/<나머지>.pdf)에 저장된다', () => {
    const sha = sha256Hex(demoBuf);
    const p = contentPath(filesDir, sha);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBe(demoBuf.byteLength);
  });

  it('동일 (documentId, sha256) 재업로드 → duplicate:true, 기존 versionId, 판본 수 불변', async () => {
    const res = await uploadGuideline(db, {
      buffer: demoBuf,
      fileName: '다시올림.pdf',
      versionLabel: '2026-2',
      documentId: docId,
      userId: 1,
      filesDir,
    });
    expect(res).toEqual({ duplicate: true, documentId: docId, versionId });
    const n = (db
      .prepare('SELECT COUNT(*) AS n FROM document_version WHERE document_id = ?')
      .get(docId) as { n: number }).n;
    expect(n).toBe(1);
  }, 60000);

  it('같은 문서에 같은 판 라벨 재사용 → DuplicateVersionLabelError', async () => {
    const other = buildTestPdf([['Different content so sha256 differs completely for label test.']]);
    await expect(
      uploadGuideline(db, {
        buffer: other,
        fileName: 'x.pdf',
        versionLabel: '2026-1',
        documentId: docId,
        userId: 1,
        filesDir,
      }),
    ).rejects.toBeInstanceOf(DuplicateVersionLabelError);
  }, 30000);

  it('손상 파일 → InvalidPdfError', async () => {
    await expect(
      uploadGuideline(db, {
        buffer: new TextEncoder().encode('PDF 아님'),
        fileName: 'broken.pdf',
        title: '손상',
        versionLabel: 'v1',
        userId: 1,
        filesDir,
      }),
    ).rejects.toBeInstanceOf(InvalidPdfError);
  });
});

describe('저밀도 페이지 경고 (§3.1-5)', () => {
  it(`공백 제외 ${LOW_DENSITY_MIN_CHARS}자 미만 페이지를 text_warning에 기록`, async () => {
    const buf = buildTestPdf([
      [
        'This first page carries a sufficiently long body of text so that it',
        'clearly exceeds the low density threshold used by the hygiene check.',
      ],
      ['tiny page'], // 8자(공백 제외) < 40
    ]);
    const res = await uploadGuideline(db, {
      buffer: buf,
      fileName: 'low.pdf',
      title: '저밀도 테스트',
      versionLabel: 'v1',
      userId: 1,
      filesDir,
    });
    if (res.duplicate) throw new Error('중복일 수 없음');
    expect(res.textWarning).toContain('2');
    const v = db
      .prepare('SELECT text_warning FROM document_version WHERE id = ?')
      .get(res.versionId) as { text_warning: string | null };
    expect(v.text_warning).toBe(res.textWarning);
  }, 30000);
});

describe('재앵커링 v1 — 문구 1건만 바꾼 v2 업로드', () => {
  const QUOTE_KEPT = 'The destruction ledger shall be kept by the officer.';
  const QUOTE_CHANGED = 'Records shall be reviewed every quarter.';
  const QUOTE_GEOMETRY = 'Article 11 storage of personal data.';

  const V1_PAGES = [
    [
      'Article 11 storage of personal data.',
      'Article 12 destruction of personal data.',
      QUOTE_KEPT,
    ],
    ['Article 13 outsourcing management.', QUOTE_CHANGED],
  ];
  // v2: 문구 1건만 변경(quarter→month) + 줄 1개 삽입 — QUOTE_KEPT는 위치만 이동
  const V2_PAGES = [
    [
      'Article 11 storage of personal data.',
      'Article 12 destruction of personal data.',
      'An introductory sentence was inserted here in revision two.',
      QUOTE_KEPT,
    ],
    ['Article 13 outsourcing management.', 'Records shall be reviewed every month.'],
  ];

  let docId: number;
  let v1Id: number;
  let v2Id: number;
  let passageKept: number;
  let passageChanged: number;
  let passageGeom: number;
  let reanchorSummary: { auto: number; needsReview: number } | null;

  beforeAll(async () => {
    const v1 = await uploadGuideline(db, {
      buffer: buildTestPdf(V1_PAGES),
      fileName: 'guide-v1.pdf',
      title: '재앵커링 테스트 지침',
      versionLabel: 'v1',
      userId: 1,
      filesDir,
    });
    if (v1.duplicate) throw new Error('중복일 수 없음');
    docId = v1.documentId;
    v1Id = v1.versionId;
    expect(v1.reanchor).toBeNull(); // 첫 판본 — 이관 없음

    // v1 전문에서 인용문 오프셋 계산 → 수동 앵커 3건 시드 (§3.2 매핑 트랜잭션의 결과 모사)
    const entries = buildPageOffsets(
      pageRows(v1Id).map((r) => ({ pageNo: r.page_no, text: r.text })),
    );
    const full = fullTextOf(entries);
    const mkPassage = (label: string): number =>
      Number(db.prepare("INSERT INTO passage (document_id, label) VALUES (?, ?)").run(docId, label).lastInsertRowid);
    const mkAnchor = (passageId: number, quote: string, geometryPrimary: number): void => {
      const start = full.indexOf(quote);
      expect(start).toBeGreaterThanOrEqual(0);
      db.prepare(
        `INSERT INTO passage_anchor
           (passage_id, document_version_id, quote_exact, start_offset, end_offset,
            page_start, page_end, rects_json, geometry_primary, status, method, confidence)
         VALUES (?, ?, ?, ?, ?, 1, 1, '[]', ?, 'resolved', 'manual', 1.0)`,
      ).run(passageId, v1Id, quote, start, start + quote.length, geometryPrimary);
    };
    passageKept = mkPassage('유지 인용');
    passageChanged = mkPassage('변경 인용');
    passageGeom = mkPassage('박스 앵커');
    mkAnchor(passageKept, QUOTE_KEPT, 0);
    mkAnchor(passageChanged, QUOTE_CHANGED, 0);
    mkAnchor(passageGeom, QUOTE_GEOMETRY, 1);

    const v2 = await uploadGuideline(db, {
      buffer: buildTestPdf(V2_PAGES),
      fileName: 'guide-v2.pdf',
      versionLabel: 'v2',
      documentId: docId,
      userId: 1,
      filesDir,
    });
    if (v2.duplicate) throw new Error('중복일 수 없음');
    v2Id = v2.versionId;
    reanchorSummary = v2.reanchor;
  }, 60000);

  it('이관 요약: auto 1 · needsReview 2 (조용히 넘어가지 않기 — 전부 추적)', () => {
    expect(reanchorSummary).toEqual({ auto: 1, needsReview: 2 });
  });

  it('판본 전이: v1 superseded/is_current=0, v2 active/is_current=1', () => {
    const v1 = db.prepare('SELECT status, is_current FROM document_version WHERE id = ?').get(v1Id) as Record<string, unknown>;
    const v2 = db.prepare('SELECT status, is_current FROM document_version WHERE id = ?').get(v2Id) as Record<string, unknown>;
    expect([v1.status, v1.is_current]).toEqual(['superseded', 0]);
    expect([v2.status, v2.is_current]).toEqual(['active', 1]);
  });

  it('정확 1건 → resolved_auto: 오프셋/페이지 재계산 + rects 캐시', () => {
    const a = db
      .prepare(
        `SELECT * FROM passage_anchor WHERE document_version_id = ? AND passage_id = ?`,
      )
      .get(v2Id, passageKept) as Record<string, unknown>;
    expect(a.status).toBe('resolved_auto');
    expect(a.method).toBe('exact');
    expect(a.confidence).toBe(1);
    const entries = buildPageOffsets(pageRows(v2Id).map((r) => ({ pageNo: r.page_no, text: r.text })));
    const full = fullTextOf(entries);
    const expectedStart = full.indexOf(QUOTE_KEPT);
    expect(a.start_offset).toBe(expectedStart);
    expect(a.end_offset).toBe(expectedStart + QUOTE_KEPT.length);
    expect(full.slice(a.start_offset as number, a.end_offset as number)).toBe(QUOTE_KEPT);
    expect(a.page_start).toBe(1);
    expect(a.page_end).toBe(1);
    // rects 재계산: [{page, rects:[[x0,y0,x1,y1],…]}] 0..1 정규화
    expect(a.rects_json).not.toBeNull();
    const rects = JSON.parse(a.rects_json as string) as { page: number; rects: number[][] }[];
    expect(rects.length).toBe(1);
    expect(rects[0]!.page).toBe(1);
    expect(rects[0]!.rects.length).toBeGreaterThanOrEqual(1);
    for (const r of rects[0]!.rects) {
      expect(r.length).toBe(4);
      for (const v of r) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(r[0]!).toBeLessThan(r[2]!); // x0 < x1
      expect(r[1]!).toBeLessThan(r[3]!); // y0 < y1
    }
  });

  it('문구 변경(0건) → needs_review, rects/오프셋 NULL', () => {
    const a = db
      .prepare('SELECT * FROM passage_anchor WHERE document_version_id = ? AND passage_id = ?')
      .get(v2Id, passageChanged) as Record<string, unknown>;
    expect(a.status).toBe('needs_review');
    expect(a.method).toBeNull();
    expect(a.start_offset).toBeNull();
    expect(a.end_offset).toBeNull();
    expect(a.rects_json).toBeNull();
    expect(a.quote_exact).toBe(QUOTE_CHANGED); // 구 인용문 보존 — 검수 화면 프리필용
  });

  it('박스 앵커(geometry_primary)는 문구가 남아 있어도 무조건 needs_review', () => {
    const a = db
      .prepare('SELECT * FROM passage_anchor WHERE document_version_id = ? AND passage_id = ?')
      .get(v2Id, passageGeom) as Record<string, unknown>;
    expect(a.status).toBe('needs_review');
    expect(a.geometry_primary).toBe(1);
    expect(a.rects_json).toBeNull();
  });

  it('historical 보존: 구판(v1) 앵커 행 3건은 그대로(resolved) 남는다', () => {
    const olds = db
      .prepare("SELECT status, method FROM passage_anchor WHERE document_version_id = ? ORDER BY id")
      .all(v1Id) as { status: string; method: string }[];
    expect(olds.length).toBe(3);
    expect(olds.every((o) => o.status === 'resolved' && o.method === 'manual')).toBe(true);
  });

  it('전이는 전부 change_log(action=reanchor)에 기록된다', () => {
    const n = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log
         WHERE entity = 'passage_anchor' AND action = 'reanchor'
           AND entity_id IN (SELECT id FROM passage_anchor WHERE document_version_id = ?)`,
      )
      .get(v2Id) as { n: number }).n;
    expect(n).toBe(3);
  });

  it('같은 파일을 다른 연도로 재업로드 → 중복 아님: 새 판본 + is_current 이관 + 앵커 자동 이관 (리뷰 확정 결함 C6)', async () => {
    const buf = buildTestPdf([
      [
        'Annual policy statement kept identical across the certification years.',
        'The quoted sentence for the anchor carry test lives right here.',
      ],
    ]);
    const r1 = await uploadGuideline(db, {
      buffer: buf,
      fileName: 'year-dup.pdf',
      title: '연도 중복 판정 테스트',
      versionLabel: '2026판',
      year: 2026,
      userId: 1,
      filesDir,
    });
    if (r1.duplicate) throw new Error('중복일 수 없음');

    // v1에 수동 앵커 1건 시드 (연도만 다른 재업로드 시 resolved_auto 이관 확인용)
    const quote = 'The quoted sentence for the anchor carry test lives right here.';
    const entries = buildPageOffsets(
      pageRows(r1.versionId).map((r) => ({ pageNo: r.page_no, text: r.text })),
    );
    const full = fullTextOf(entries);
    const start = full.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);
    const passageId = Number(
      db
        .prepare(`INSERT INTO passage (document_id, label) VALUES (?, '연도 이관 인용')`)
        .run(r1.documentId).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO passage_anchor
         (passage_id, document_version_id, quote_exact, start_offset, end_offset,
          page_start, page_end, rects_json, geometry_primary, status, method, confidence)
       VALUES (?, ?, ?, ?, ?, 1, 1, '[]', 0, 'resolved', 'manual', 1.0)`,
    ).run(passageId, r1.versionId, quote, start, start + quote.length);

    // 같은 파일 + 같은 연도(2026) → duplicate 무동작 (멱등 재업로드)
    const dup = await uploadGuideline(db, {
      buffer: buf,
      fileName: 'year-dup.pdf',
      versionLabel: '2026-재',
      year: 2026,
      documentId: r1.documentId,
      userId: 1,
      filesDir,
    });
    expect(dup).toEqual({ duplicate: true, documentId: r1.documentId, versionId: r1.versionId });

    // 같은 파일 + 다른 연도(2027) → 중복 아님: 2027 판본이 새로 생긴다 (연도 탭 노출)
    const r2 = await uploadGuideline(db, {
      buffer: buf,
      fileName: 'year-dup.pdf',
      versionLabel: '2027판',
      year: 2027,
      documentId: r1.documentId,
      userId: 1,
      filesDir,
    });
    if (r2.duplicate) throw new Error('연도가 다르면 중복이 아니어야 한다');
    expect(r2.year).toBe(2027);
    expect(r2.versionId).not.toBe(r1.versionId);

    // is_current 이관: 2026판 superseded, 2027판 current
    const v1row = db
      .prepare('SELECT status, is_current, year FROM document_version WHERE id = ?')
      .get(r1.versionId) as Record<string, unknown>;
    const v2row = db
      .prepare('SELECT status, is_current, year FROM document_version WHERE id = ?')
      .get(r2.versionId) as Record<string, unknown>;
    expect([v1row.status, v1row.is_current]).toEqual(['superseded', 0]);
    expect([v2row.status, v2row.is_current, v2row.year]).toEqual(['active', 1, 2027]);

    // 내용이 같으니 앵커는 정확 일치 → 전건 resolved_auto 이관
    expect(r2.reanchor).toEqual({ auto: 1, needsReview: 0 });
    const carried = db
      .prepare(
        'SELECT status, method FROM passage_anchor WHERE document_version_id = ? AND passage_id = ?',
      )
      .get(r2.versionId, passageId) as { status: string; method: string };
    expect(carried).toEqual({ status: 'resolved_auto', method: 'exact' });
  }, 60000);

  it(
    '연속 개정(v3): 미해결 앵커도 이관 — 문구 복원 시 자동 복구, 아니면 needs_review 유지(검수 큐 소실 방지)',
    async () => {
      // v3: v2에서 변경됐던 문구(QUOTE_CHANGED)를 원문으로 복원 + 문장 1개 추가(sha 상이)
      const V3_PAGES = [
        [
          'Article 11 storage of personal data.',
          'Article 12 destruction of personal data.',
          QUOTE_KEPT,
        ],
        ['Article 13 outsourcing management.', QUOTE_CHANGED, 'A closing sentence for revision three.'],
      ];
      const v3 = await uploadGuideline(db, {
        buffer: buildTestPdf(V3_PAGES),
        fileName: 'guide-v3.pdf',
        versionLabel: 'v3',
        documentId: docId,
        userId: 1,
        filesDir,
      });
      if (v3.duplicate) throw new Error('중복일 수 없음');
      // v2의 needs_review 2건 포함 3건 전부 이관: 유지 1 + 복원 1 = auto 2, 박스 앵커 = needs_review 1
      expect(v3.reanchor).toEqual({ auto: 2, needsReview: 1 });

      const statusOf = (passageId: number): string =>
        (db
          .prepare('SELECT status FROM passage_anchor WHERE document_version_id = ? AND passage_id = ?')
          .get(v3.versionId, passageId) as { status: string }).status;
      expect(statusOf(passageChanged)).toBe('resolved_auto'); // 미해결이었다가 문구 복원으로 자동 복구
      expect(statusOf(passageGeom)).toBe('needs_review'); // 박스 앵커 — 추적 유지(조용한 소실 없음)
      expect(statusOf(passageKept)).toBe('resolved_auto');

      // 전역 검수 큐 집계 관점: 현재 판본(v3)에 미처리 1건이 남는다 — 배지에서 사라지지 않음
      const open = (db
        .prepare(
          `SELECT COUNT(*) AS n FROM passage_anchor pa
           JOIN document_version dv ON dv.id = pa.document_version_id AND dv.is_current = 1
           WHERE dv.document_id = ? AND pa.status IN ('needs_review','unresolved')`,
        )
        .get(docId) as { n: number }).n;
      expect(open).toBe(1);
    },
    60000,
  );
});
