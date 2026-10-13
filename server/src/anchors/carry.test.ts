// 앵커 이관(재앵커링)과 앵커 생성 검사의 회귀 시험(검사실 자료 PDF 외 형식을 붙이며 찾은 결함)
// 1) 화면은 판본 글자를 쪽 구분자 없이 이어 붙인 문자열에서 인용을 잘라 보낸다: 쪽 경계를 걸친 앵커도
//    글자가 그대로인 개정에서는 resolved_auto 로 이관돼야 한다(설계서 §3.4 "정규화 그림자에서 quote_exact 전건 탐색").
// 2) PDF 줄바꿈이 Word 문단 안 띄어쓰기가 되는 형식 전환 개정(PDF → docx)도 같은 글자로 본다.
// 3) 과거 판본, 삭제된 문서, 글자 없는 인용에는 앵커를 만들지 않는다(§2 첫 불변식, §3.5 매핑 검증).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { buildShadow, planOne, planReanchor, quoteShadow } from '../docs/reanchor.js';
import { uploadGuideline } from '../docs/service.js';
import { buildTestPdf } from '../docs/test-pdf-util.js';
import { runIntegrityCheck } from '../jobs/integrity.js';
import { LRPB, makeDocx, p, pt, r, sectPr } from '../office/docx/testkit.js';
import { buildPageOffsets, fullTextOf } from '../pdf/offsets.js';
import { createAnchorMapping, type CreateAnchorInput } from './service.js';

const anchorOf = (quoteExact: string, geometryPrimary = false) => ({ anchorId: 1, passageId: 1, quoteExact, geometryPrimary });

describe('planOne: 정규화 그림자에서 정확 일치를 센다', () => {
  it('쪽 구분자 없이 잘린 인용이 구분자를 품은 신판 글자와 1건 일치하면 auto, 범위는 첫 글자부터 끝 글자까지', () => {
    const full = '머리 문단\n제5조 긴급 접근은 \n사후에 승인받는다.\n끝 문단';
    const quote = '긴급 접근은 사후에 승인받는다'; // 화면이 보낸 형태: 쪽 1 끝 '은 ' + 쪽 2 첫 글자
    const d = planOne(anchorOf(quote), full);
    expect(d.kind).toBe('auto');
    if (d.kind !== 'auto') return;
    expect(full.slice(d.startOffset, d.endOffset)).toBe('긴급 접근은 \n사후에 승인받는다');
    expect(quoteShadow(full.slice(d.startOffset, d.endOffset))).toBe(quoteShadow(quote));
  });

  it('PDF 줄바꿈 인용이 Word 문단의 띄어쓰기와 만나도 같은 글자로 본다', () => {
    const full = 'Article 1. The laboratory reviews access rights every quarter and records the result.';
    const d = planOne(anchorOf('reviews access rights\nevery quarter'), full);
    expect(d).toEqual({
      kind: 'auto',
      startOffset: full.indexOf('reviews'),
      endOffset: full.indexOf('quarter') + 'quarter'.length,
    });
  });

  it('인용 앞뒤 공백은 범위에 넣지 않는다, 원문 그대로 1건이면 종전과 같은 오프셋', () => {
    const full = '가나다 라마바 사아자';
    expect(planOne(anchorOf(' 라마바 '), full)).toEqual({ kind: 'auto', startOffset: 4, endOffset: 7 });
    expect(planOne(anchorOf('라마바'), full)).toEqual({ kind: 'auto', startOffset: 4, endOffset: 7 });
  });

  it('띄어쓰기만 다른 같은 글자가 둘이면 ambiguous (원문으로는 1건이어도 자동으로 고르지 않는다)', () => {
    expect(planOne(anchorOf('파기 대장'), '파기 대장을 쓴다. 파기대장은 3년 보관한다.')).toEqual({
      kind: 'needs_review',
      reason: 'ambiguous',
      occurrences: 2,
    });
  });

  it('공백뿐인 인용, 글자가 바뀐 인용은 not_found, 박스 앵커는 언제나 geometry_primary', () => {
    expect(planOne(anchorOf(' \n\t'), '아무 글자').kind).toBe('needs_review');
    expect(planOne(anchorOf('분기마다 검토한다'), '매월 검토한다')).toMatchObject({ reason: 'not_found' });
    expect(planOne(anchorOf('아무 글자', true), '아무 글자')).toMatchObject({ reason: 'geometry_primary' });
  });

  it('NFD 로 들어온 인용도 NFC 정본과 맞춘다, 서로게이트 쌍 뒤의 위치도 정확하다', () => {
    const full = '𠀀 검사실 정보보안';
    const d = planOne(anchorOf('정보보안'.normalize('NFD')), full);
    expect(d).toEqual({ kind: 'auto', startOffset: full.indexOf('정보보안'), endOffset: full.length });
  });

  it('buildShadow: 무시 글자를 빼고 위치 표를 만든다, planReanchor 는 앵커마다 같은 그림자를 쓴다', () => {
    const sh = buildShadow('a b\n\u200Bc');
    expect(sh.shadow).toBe('abc');
    expect([...sh.map]).toEqual([0, 2, 5]);
    const plan = planReanchor([anchorOf('a b'), anchorOf('bc'), anchorOf('x')], 'a b\n\u200Bc');
    expect(plan.map((x) => x.decision.kind)).toEqual(['auto', 'auto', 'needs_review']);
  });
});

// ─────────────────────────────── 업로드 파이프라인 통합 ───────────────────────────────

let db: Database.Database;
let filesDir: string;
let questionId: number;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('e','x','편집자','editor',1)`).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'60','정보보안',1)`).run();
  questionId = Number(
    db
      .prepare(`INSERT INTO question (category_id, question_no, sort_key, body, updated_at) VALUES (1,'60.010.010',1,'본문',?)`)
      .run(now).lastInsertRowid,
  );
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-carry-'));
});

afterAll(() => {
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

interface PageRow {
  pageNo: number;
  startOffset: number;
  text: string;
}

function pagesOf(versionId: number): PageRow[] {
  return db
    .prepare('SELECT page_no AS pageNo, start_offset AS startOffset, text FROM page_text WHERE document_version_id = ? ORDER BY page_no')
    .all(versionId) as PageRow[];
}

/**
 * 화면(OfficeViewerPane, PdfViewerPane)이 만드는 요청과 같은 모양: 쪽 글자를 구분자 없이 이어 붙인
 * 문자열에서 인용을 자르고, 시작과 끝 글자의 쪽 위치를 전역 오프셋으로 바꾼다.
 */
function viewerRequest(versionId: number, needle: string, extra: Partial<CreateAnchorInput> = {}): CreateAnchorInput {
  const pages = pagesOf(versionId);
  const cum: number[] = [];
  let acc = 0;
  for (const pg of pages) {
    cum.push(acc);
    acc += pg.text.length;
  }
  const joined = pages.map((pg) => pg.text).join('');
  const s = joined.indexOf(needle);
  expect(s).toBeGreaterThanOrEqual(0);
  const e = s + needle.length;
  const at = (local: number): number => {
    let i = 0;
    while (i + 1 < pages.length && cum[i + 1]! <= local) i += 1;
    return i;
  };
  const ps = at(s);
  const pe = at(e - 1);
  return {
    documentVersionId: versionId,
    questionIds: [questionId],
    quoteExact: joined.slice(s, e),
    startOffset: pages[ps]!.startOffset + (s - cum[ps]!),
    endOffset: pages[pe]!.startOffset + (e - 1 - cum[pe]!) + 1,
    pageStart: pages[ps]!.pageNo,
    pageEnd: pages[pe]!.pageNo,
    force: true,
    ...extra,
  };
}

function created(res: ReturnType<typeof createAnchorMapping>): number {
  if (res.kind !== 'created') throw new Error(`앵커 생성 실패: ${JSON.stringify(res)}`);
  return res.passageId;
}

interface AnchorRow {
  status: string;
  method: string | null;
  start_offset: number | null;
  end_offset: number | null;
  page_start: number | null;
  page_end: number | null;
  rects_json: string | null;
  geometry_primary: number;
  quote_exact: string;
}

function anchorRow(versionId: number, passageId: number): AnchorRow {
  return db
    .prepare('SELECT * FROM passage_anchor WHERE document_version_id = ? AND passage_id = ?')
    .get(versionId, passageId) as AnchorRow;
}

function fullOf(versionId: number): string {
  return fullTextOf(buildPageOffsets(pagesOf(versionId)));
}

describe('docx 개정: 쪽 경계를 걸친 앵커가 글자 그대로면 resolved_auto', () => {
  const body = (extra: string): string =>
    pt('제1조(목적) 이 절차는 접근 권한 관리 기준을 정한다.') +
    extra +
    p(r('제5조(예외) 긴급 접근은 ') + LRPB + r('사후에 정보보안 책임자의 승인을 받는다.')) +
    pt('제6조(보관) 검토 기록은 3년간 보관한다.') +
    sectPr();

  it('v1 에서 화면 방식으로 만든 쪽 걸침 앵커 → v2 (문단 삽입) 에서 resolved_auto, rects 없음, 쪽 1-2', async () => {
    const v1 = await uploadGuideline(db, {
      buffer: makeDocx({ body: body('') }),
      fileName: '절차.docx',
      title: '접근 권한 절차',
      versionLabel: 'v1',
      userId: 1,
      filesDir,
    });
    if (v1.duplicate) throw new Error('중복일 수 없음');
    expect(pagesOf(v1.versionId).length).toBe(2);
    const req = viewerRequest(v1.versionId, '긴급 접근은 사후에 정보보안 책임자의');
    expect(req.pageStart).toBe(1);
    expect(req.pageEnd).toBe(2);
    expect(req.quoteExact.includes('\n')).toBe(false); // 화면이 보내는 인용에는 쪽 구분자가 없다
    const crossPage = created(createAnchorMapping(db, req, 1));
    const samePage = created(createAnchorMapping(db, viewerRequest(v1.versionId, '검토 기록은 3년간 보관한다.'), 1));

    const v2 = await uploadGuideline(db, {
      buffer: makeDocx({ body: body(pt('제2조(범위) 새로 넣은 문단이다.')) }),
      fileName: '절차.docx',
      versionLabel: 'v2',
      documentId: v1.documentId,
      userId: 1,
      filesDir,
    });
    if (v2.duplicate) throw new Error('중복일 수 없음');
    expect(v2.reanchor).toEqual({ auto: 2, needsReview: 0 });
    const full = fullOf(v2.versionId);
    for (const pid of [crossPage, samePage]) {
      const a = anchorRow(v2.versionId, pid);
      expect(a.status).toBe('resolved_auto');
      expect(a.method).toBe('exact');
      expect(a.rects_json).toBeNull();
      expect(a.geometry_primary).toBe(0);
      expect(quoteShadow(full.slice(a.start_offset!, a.end_offset!))).toBe(quoteShadow(a.quote_exact));
    }
    const a = anchorRow(v2.versionId, crossPage);
    expect([a.page_start, a.page_end]).toEqual([1, 2]);
  });
});

describe('형식 전환 개정 PDF → docx (documentId 로 새 판본)', () => {
  it('줄바꿈 걸친 PDF 인용, 쪽 걸침 인용은 resolved_auto (rects 없음), 박스 앵커는 needs_review 로 남고 박스 표시는 꺼진다', async () => {
    const pdf = await uploadGuideline(db, {
      buffer: buildTestPdf([
        ['Article 1. The laboratory reviews access rights', 'every quarter and records the result.', 'Article 3. The officer keeps the'],
        ['access review log for three years.', 'Article 4. Box anchored row text.'],
      ]),
      fileName: 'policy.pdf',
      title: '형식 전환 시험',
      versionLabel: 'pdf',
      userId: 1,
      filesDir,
    });
    if (pdf.duplicate) throw new Error('중복일 수 없음');
    const rects = (page: number) => [{ page, rects: [[0.1, 0.1, 0.5, 0.12] as [number, number, number, number]] }];
    const wrap = created(createAnchorMapping(db, viewerRequest(pdf.versionId, 'reviews access rights\nevery quarter', { rects: rects(1) }), 1));
    const cross = created(createAnchorMapping(db, viewerRequest(pdf.versionId, 'keeps theaccess review log', { rects: [...rects(1), ...rects(2)] }), 1));
    const box = created(
      createAnchorMapping(db, viewerRequest(pdf.versionId, 'Article 4. Box anchored row text.', { rects: rects(2), geometryPrimary: true }), 1),
    );

    const docx = await uploadGuideline(db, {
      buffer: makeDocx({
        body:
          pt('Article 1. The laboratory reviews access rights every quarter and records the result.') +
          pt('Article 3. The officer keeps the access review log for three years.') +
          pt('Article 4. Box anchored row text.') +
          sectPr(),
      }),
      fileName: 'policy.docx',
      versionLabel: 'docx',
      documentId: pdf.documentId,
      userId: 1,
      filesDir,
    });
    if (docx.duplicate) throw new Error('중복일 수 없음');
    expect(docx.fileKind).toBe('docx');
    expect(docx.reanchor).toEqual({ auto: 2, needsReview: 1 });
    const full = fullOf(docx.versionId);
    for (const pid of [wrap, cross]) {
      const a = anchorRow(docx.versionId, pid);
      expect(a.status).toBe('resolved_auto');
      expect(a.rects_json).toBeNull();
      expect(quoteShadow(full.slice(a.start_offset!, a.end_offset!))).toBe(quoteShadow(a.quote_exact));
    }
    const b = anchorRow(docx.versionId, box);
    expect([b.status, b.geometry_primary, b.start_offset, b.rects_json]).toEqual(['needs_review', 0, null, null]);
  }, 30_000);
});

describe('앵커 생성 검사: 만들지 않는 경우', () => {
  let docId: number;
  let oldVid: number;
  let curVid: number;

  beforeAll(async () => {
    const v1 = await uploadGuideline(db, {
      buffer: Buffer.from('첫 줄 기록 보관 규칙\n둘째 줄 접근 권한 검토', 'utf8'),
      fileName: '규칙.txt',
      title: '규칙 문서',
      versionLabel: 'v1',
      userId: 1,
      filesDir,
    });
    const v2 = await uploadGuideline(db, {
      buffer: Buffer.from('첫 줄 기록 보관 규칙\n둘째 줄 접근 권한 검토\n셋째 줄', 'utf8'),
      fileName: '규칙.txt',
      versionLabel: 'v2',
      documentId: v1.documentId,
      userId: 1,
      filesDir,
    });
    if (v1.duplicate || v2.duplicate) throw new Error('중복일 수 없음');
    docId = v1.documentId;
    oldVid = v1.versionId;
    curVid = v2.versionId;
  });

  const counts = () => ({
    passages: (db.prepare('SELECT COUNT(*) AS n FROM passage WHERE document_id = ?').get(docId) as { n: number }).n,
    links: (db.prepare('SELECT COUNT(*) AS n FROM question_passage').get() as { n: number }).n,
  });

  it('과거(superseded) 판본에는 만들지 않는다: invalid, 아무 행도 생기지 않고 무결성 점검은 그대로 통과', () => {
    const before = counts();
    const res = createAnchorMapping(db, viewerRequest(oldVid, '접근 권한 검토'), 1);
    expect(res.kind).toBe('invalid');
    if (res.kind === 'invalid') expect(res.message).toContain('현재 버전');
    expect(counts()).toEqual(before);
    const check = runIntegrityCheck(db, filesDir).checks.find((c) => c.name.includes('현재 버전의 위치'));
    expect(check?.ok).toBe(true);
    // 현재 판본에는 그대로 만든다
    expect(createAnchorMapping(db, viewerRequest(curVid, '접근 권한 검토'), 1).kind).toBe('created');
  });

  it('삭제된 문서의 판본은 version_not_found', () => {
    const other = db.prepare(`INSERT INTO document (title, deleted_at) VALUES ('삭제 문서', ?)`).run(new Date().toISOString());
    const vid = Number(
      db
        .prepare(
          `INSERT INTO document_version (document_id, version_label, file_sha256, file_name, file_size, page_count,
             status, is_current, uploaded_at, file_kind)
           VALUES (?, 'v1', ?, 'x.txt', 1, 1, 'active', 1, ?, 'text')`,
        )
        .run(Number(other.lastInsertRowid), 'c'.repeat(64), new Date().toISOString()).lastInsertRowid,
    );
    db.prepare('INSERT INTO page_text (document_version_id, page_no, start_offset, text) VALUES (?, 1, 0, ?)').run(vid, '삭제 문서 글자');
    expect(createAnchorMapping(db, viewerRequest(vid, '삭제 문서 글자'), 1).kind).toBe('version_not_found');
  });

  it('공백, 개행뿐인 인용(쪽 안 줄 구분자 위)은 invalid', () => {
    const pages = pagesOf(curVid);
    const nl = pages[0]!.text.indexOf('\n');
    const before = counts();
    const res = createAnchorMapping(
      db,
      {
        documentVersionId: curVid,
        questionIds: [questionId],
        quoteExact: ' ',
        startOffset: nl,
        endOffset: nl + 1,
        pageStart: 1,
        pageEnd: 1,
        force: true,
      },
      1,
    );
    expect(res.kind).toBe('invalid');
    expect(counts()).toEqual(before);
  });
});
