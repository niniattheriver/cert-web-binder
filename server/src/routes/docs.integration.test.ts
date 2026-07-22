// /api/docs 라우트 계약 테스트 — :memory: DB + 전체 마이그레이션 적용, 실제 Express 기동(임시 포트)
// multipart 업로드·인증(401/403)·목록/상세/파일 스트림/페이지 텍스트/전문 검색(FTS·LIKE 폴백)을 검증한다.
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { buildTestPdf } from '../docs/test-pdf-util.js';
import { createDocsRouter } from './docs.js';

let db: Database.Database;
let filesDir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db); // 004 source_* 컬럼 포함 최신 스키마
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active)
     VALUES ('editor1','x','편집자','editor',1), ('viewer1','x','열람자','viewer',1)`,
  ).run();
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-docs-rt-'));

  const app = express();
  app.use(express.json());
  // 테스트용 세션 주입: x-test-user 헤더의 사용자 id (없으면 미인증)
  app.use((req, _res, next) => {
    const uid = Number(req.headers['x-test-user']);
    (req as unknown as { session: { userId?: number } }).session =
      Number.isInteger(uid) && uid > 0 ? { userId: uid } : {};
    next();
  });
  app.use('/api/docs', createDocsRouter(db, { filesDir }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve); // 임시 포트 — afterAll에서 반드시 종료
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function pdfForm(fields: Record<string, string>, fileName = 'test.pdf', pdf?: Uint8Array): FormData {
  const fd = new FormData();
  const bytes =
    pdf ??
    buildTestPdf([
      [
        'Chapter 1 general provisions of the fictional guideline.',
        'Personal data shall be destroyed without delay after the retention period.',
      ],
      ['Chapter 2 outsourcing rules and quarterly review of records.'],
    ]);
  fd.append('file', new Blob([bytes.slice().buffer], { type: 'application/pdf' }), fileName);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function post(fd: FormData, user?: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: user ? { 'x-test-user': String(user) } : {},
    body: fd,
  });
  return { status: res.status, body: await res.json() };
}

async function get(pathname: string, user?: number): Promise<Response> {
  return fetch(`${base}${pathname}`, { headers: user ? { 'x-test-user': String(user) } : {} });
}

let docId: number;
let versionId: number;

describe('POST /api/docs', () => {
  it('미인증 → 401, viewer → 403', async () => {
    expect((await post(pdfForm({ title: 'x', versionLabel: 'v1' }))).status).toBe(401);
    expect((await post(pdfForm({ title: 'x', versionLabel: 'v1' }), 2)).status).toBe(403);
  });

  it('editor 업로드 → 201 {documentId, versionId, pageCount}', async () => {
    const r = await post(pdfForm({ title: '가상 지침', versionLabel: '2026-1', code: 'T1' }), 1);
    expect(r.status).toBe(201);
    expect(r.body.pageCount).toBe(2);
    expect(r.body.documentId).toBeGreaterThan(0);
    expect(r.body.versionId).toBeGreaterThan(0);
    docId = r.body.documentId;
    versionId = r.body.versionId;
  }, 30000);

  it('versionLabel 누락 → 400 validation / 새 문서인데 title 누락 → 400', async () => {
    expect((await post(pdfForm({ title: 'x' }), 1)).body.error).toBe('validation');
    expect((await post(pdfForm({ versionLabel: 'v9' }), 1)).body.error).toBe('validation');
  }, 30000);

  it('손상 PDF → 400 {error:invalid_pdf}', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new TextEncoder().encode('깨진 파일')], { type: 'application/pdf' }), 'b.pdf');
    fd.append('title', '손상');
    fd.append('versionLabel', 'v1');
    const r = await post(fd, 1);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_pdf');
  });

  it('같은 문서 동일 sha256 재업로드 → {duplicate:true, versionId 기존}', async () => {
    const r = await post(pdfForm({ versionLabel: '2026-2', documentId: String(docId) }), 1);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ duplicate: true, documentId: docId, versionId });
  }, 30000);
});

describe('POST /api/docs/auto — 일괄 업로드용 자동 인입 (v1.5)', () => {
  async function postAuto(fd: FormData, user?: number): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/docs/auto`, {
      method: 'POST',
      headers: user ? { 'x-test-user': String(user) } : {},
      body: fd,
    });
    return { status: res.status, body: await res.json() };
  }
  /** 필드 없이 파일만 담은 폼 */
  function autoForm(fileName: string, pdf?: Uint8Array): FormData {
    return pdfForm({}, fileName, pdf);
  }

  it('미인증 → 401, viewer → 403', async () => {
    expect((await postAuto(autoForm('무제.pdf'))).status).toBe(401);
    expect((await postAuto(autoForm('무제.pdf'), 2)).status).toBe(403);
  });

  it('제목=파일명 stem(NFC), 판본라벨은 오늘 날짜 기본값', async () => {
    const r = await postAuto(autoForm('검체 채취 및 취급 지침.pdf'), 1);
    expect(r.status).toBe(201);
    expect(r.body.title).toBe('검체 채취 및 취급 지침');
    expect(r.body.newVersion).toBe(false);
    const doc = db
      .prepare(`SELECT d.title, dv.version_label FROM document d
                JOIN document_version dv ON dv.document_id = d.id
                WHERE d.id = ?`)
      .get(r.body.documentId) as { title: string; version_label: string };
    expect(doc.title).toBe('검체 채취 및 취급 지침');
    expect(doc.version_label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 30000);

  it('같은 파일명 + 같은 내용 재업로드 → duplicate 무동작 (폴더째 재업로드 멱등)', async () => {
    const r = await postAuto(autoForm('검체 채취 및 취급 지침.pdf'), 1);
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(true);
  }, 30000);

  it('같은 파일명 + 다른 내용 + 다른 라벨 → 기존 문서의 새 판본', async () => {
    const other = buildTestPdf([['Revised fictional guideline content, second edition.']]);
    const fd = autoForm('검체 채취 및 취급 지침.pdf', other);
    fd.append('versionLabel', '개정2판');
    const r = await postAuto(fd, 1);
    expect(r.status).toBe(201);
    expect(r.body.newVersion).toBe(true);
    const versions = db
      .prepare(`SELECT COUNT(*) AS n FROM document_version WHERE document_id = ?`)
      .get(r.body.documentId) as { n: number };
    expect(versions.n).toBe(2);
    // 문서(title) 행이 하나만 존재 — 제목 중복 문서 양산 금지
    const docs = db
      .prepare(`SELECT COUNT(*) AS n FROM document WHERE title = '검체 채취 및 취급 지침'`)
      .get() as { n: number };
    expect(docs.n).toBe(1);
  }, 30000);

  it('NFD(macOS) 파일명도 NFC 제목으로 정규화 — 중복 문서 방지', async () => {
    const nfd = '검체 채취 및 취급 지침.pdf'.normalize('NFD');
    const other = buildTestPdf([['Third edition for NFD filename test.']]);
    const fd = autoForm(nfd, other);
    fd.append('versionLabel', 'NFD판');
    const r = await postAuto(fd, 1);
    expect(r.status).toBe(201);
    expect(r.body.newVersion).toBe(true); // NFC 정규화로 기존 문서에 붙음
  }, 30000);

  it('같은 날 수정본 재업로드(라벨 미지정): 기본 라벨 충돌을 접미사(-2)로 자동 회피 — 409 아님', async () => {
    // 첫 업로드는 오늘 날짜 라벨을 이미 점유(위 테스트) — 내용만 바꿔 라벨 없이 재업로드
    const revised = buildTestPdf([['Same-day revised content, must not 409.']]);
    const r = await postAuto(autoForm('검체 채취 및 취급 지침.pdf', revised), 1);
    expect(r.status).toBe(201); // duplicate_version_label(409)로 죽지 않는다 (리뷰 확정 결함)
    expect(r.body.newVersion).toBe(true);
    const label = db
      .prepare(`SELECT version_label FROM document_version WHERE id = ?`)
      .get(r.body.versionId) as { version_label: string };
    expect(label.version_label).toMatch(/^\d{4}-\d{2}-\d{2}-\d+$/); // 'YYYY-MM-DD-2' 형
  }, 30000);
});

describe('FTS content 컬럼 한정 — kind 값 오매치 회귀 (리뷰 확정 결함)', () => {
  it("질의 'page'가 kind='page_text' 컬럼 값과 매치되어 전체 페이지를 반환하지 않는다", async () => {
    // 픽스처 PDF 본문에는 'page' 문자열이 없다 — content 한정 시 0건이 정답.
    // (비한정 MATCH는 색인된 kind 컬럼의 'page_text'와 trigram 매치해 전 페이지가 히트됐다)
    const r = await get('/api/docs/search?q=page', 1);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { hits: unknown[] };
    expect(body.hits).toEqual([]);
  });
});

describe('GET /api/docs (목록) · /api/docs/:id (상세)', () => {
  it('목록: currentVersion·passageCount·mappedQuestionCount', async () => {
    const r = await get('/api/docs', 2); // viewer도 열람 가능
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    const doc = body.docs.find((d: any) => d.id === docId);
    expect(doc).toMatchObject({
      code: 'T1',
      title: '가상 지침',
      kind: 'manual',
      passageCount: 0,
      mappedQuestionCount: 0,
    });
    expect(doc.currentVersion).toMatchObject({ id: versionId, versionLabel: '2026-1', pageCount: 2 });
  });

  it('상세: versions[] + needsReviewCount, 없는 문서 404', async () => {
    const r = await get(`/api/docs/${docId}`, 1);
    const body = (await r.json()) as any;
    expect(body.doc.id).toBe(docId);
    expect(body.versions.length).toBe(1);
    expect(body.versions[0]).toMatchObject({ id: versionId, isCurrent: true, status: 'active' });
    expect(body.needsReviewCount).toBe(0);
    expect((await get('/api/docs/999999', 1)).status).toBe(404);
  });
});

describe('GET /api/docs/versions/:vid/*', () => {
  it('file: application/pdf 스트림', async () => {
    const r = await get(`/api/docs/versions/${versionId}/file`, 1);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    const buf = new Uint8Array(await r.arrayBuffer());
    expect(new TextDecoder().decode(buf.slice(0, 5))).toBe('%PDF-');
  });

  it('page-text: {pages:[{pageNo,startOffset,text}]} 오프셋 연속', async () => {
    const r = await get(`/api/docs/versions/${versionId}/page-text`, 1);
    const body = (await r.json()) as any;
    expect(body.pages.length).toBe(2);
    expect(body.pages[0].pageNo).toBe(1);
    expect(body.pages[0].startOffset).toBe(0);
    expect(body.pages[1].startOffset).toBe(body.pages[0].text.length + 1);
  });

  // 판본 앵커 목록(GET /versions/:vid/anchors)은 routes/anchors.ts 소유 — anchors.integration.test.ts 에서 검증.
});

describe('GET /api/docs/search — 통합 지침서 전문 검색', () => {
  it('3자 이상 → FTS trigram, {versionId,docTitle,pageNo,snippet}', async () => {
    const r = await get(`/api/docs/search?q=${encodeURIComponent('destroyed')}`, 1);
    const body = (await r.json()) as any;
    expect(body.hits.length).toBeGreaterThanOrEqual(1);
    expect(body.hits[0]).toMatchObject({ versionId, docTitle: '가상 지침', pageNo: 1 });
    expect(body.hits[0].snippet).toContain('destroyed');
  });

  it('3자 미만 → LIKE 폴백', async () => {
    const r = await get(`/api/docs/search?q=${encodeURIComponent('Ch')}`, 1);
    const body = (await r.json()) as any;
    expect(body.hits.length).toBeGreaterThanOrEqual(1);
    expect(body.hits[0].snippet).toContain('Ch');
  });

  it('빈 질의 → {hits:[]}, 미인증 → 401', async () => {
    expect(((await (await get('/api/docs/search?q=', 1)).json()) as any).hits).toEqual([]);
    expect((await get('/api/docs/search?q=abc')).status).toBe(401);
  });
});

describe('판본 연도 태그(④) + ?year= 필터', () => {
  const thisYear = new Date().getFullYear();
  let doc2030 = 0;
  let v2030 = 0;

  it('year 미지정 업로드 → 업로드한 해가 기본값', () => {
    const row = db.prepare('SELECT year FROM document_version WHERE id = ?').get(versionId) as {
      year: number;
    };
    expect(row.year).toBe(thisYear);
  });

  it('year 지정 업로드 → 저장, 범위 밖(1999) → 400 validation', async () => {
    const r = await post(pdfForm({ title: '연도 지침', versionLabel: 'y1', year: '2030' }), 1);
    expect(r.status).toBe(201);
    doc2030 = r.body.documentId;
    v2030 = r.body.versionId;
    const row = db.prepare('SELECT year FROM document_version WHERE id = ?').get(v2030) as {
      year: number;
    };
    expect(row.year).toBe(2030);
    const bad = await post(pdfForm({ title: '범위밖', versionLabel: 'y2', year: '1999' }), 1);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('validation');
  }, 30000);

  it('GET /api/docs — currentVersion.year 항상 포함, ?year= 필터는 yearVersion 동봉', async () => {
    const all = (await (await get('/api/docs', 1)).json()) as any;
    const d = all.docs.find((x: any) => x.id === docId);
    expect(d.currentVersion.year).toBe(thisYear);
    expect(d.yearVersion).toBeUndefined(); // 필터 없으면 기존 응답 유지

    const filtered = (await (await get('/api/docs?year=2030', 1)).json()) as any;
    expect(filtered.docs.some((x: any) => x.id === docId)).toBe(false); // 2030 판본 없는 문서 제외
    const f = filtered.docs.find((x: any) => x.id === doc2030);
    expect(f.yearVersion).toMatchObject({ id: v2030, versionLabel: 'y1', year: 2030, pageCount: 2 });
    expect((await get('/api/docs?year=abc', 1)).status).toBe(400);
  });

  it('GET /api/docs/:id — versions[] 각 행에 year', async () => {
    const detail = (await (await get(`/api/docs/${doc2030}`, 1)).json()) as any;
    expect(detail.versions[0].year).toBe(2030);
  });

  it('GET /api/docs/search — 히트에 year 포함, ?year= 필터', async () => {
    const r = (await (await get('/api/docs/search?q=destroyed', 1)).json()) as any;
    const hit = r.hits.find((h: any) => h.versionId === v2030);
    expect(hit.year).toBe(2030);
    const r30 = (await (await get('/api/docs/search?q=destroyed&year=2030', 1)).json()) as any;
    expect(r30.hits.some((h: any) => h.versionId === v2030)).toBe(true);
    expect(r30.hits.some((h: any) => h.versionId === versionId)).toBe(false); // 다른 연도 제외
    expect(r30.hits.every((h: any) => h.year === 2030)).toBe(true);
  });

  it('구판이 된 연도 판본도 그 연도 필터로 검색된다 (리뷰 확정 결함 C5)', async () => {
    // 2026 판본(v1) → 2027 판본(v2)로 대체된 문서: is_current는 v2뿐이지만
    // ?year=2026 검색은 v1(그 연도의 최신 비실패 판본)의 본문을 찾아야 한다.
    const v1pdf = buildTestPdf([['Yearly guideline first edition keyword styrofoam retention.']]);
    const r1 = await post(
      pdfForm({ title: '연도검색 지침', versionLabel: 'v2026', year: '2026' }, 'ys1.pdf', v1pdf),
      1,
    );
    expect(r1.status).toBe(201);
    const dId = r1.body.documentId;
    const v1 = r1.body.versionId;
    const v2pdf = buildTestPdf([['Yearly guideline second edition keyword porcelain archive.']]);
    const r2 = await post(
      pdfForm({ versionLabel: 'v2027', year: '2027', documentId: String(dId) }, 'ys2.pdf', v2pdf),
      1,
    );
    expect(r2.status).toBe(201);
    const v2 = r2.body.versionId;

    // FTS: v1에만 있는 단어가 ?year=2026 으로 검색된다 (종전 is_current 조인이면 0건)
    const hit26 = (await (await get('/api/docs/search?q=styrofoam&year=2026', 1)).json()) as any;
    expect(hit26.hits.some((h: any) => h.versionId === v1)).toBe(true);
    // 미필터 검색은 현재 판본(v2)만 — v1 전용 단어는 안 나온다
    const cur = (await (await get('/api/docs/search?q=styrofoam', 1)).json()) as any;
    expect(cur.hits.some((h: any) => h.versionId === v1)).toBe(false);
    const cur2 = (await (await get('/api/docs/search?q=porcelain', 1)).json()) as any;
    expect(cur2.hits.some((h: any) => h.versionId === v2)).toBe(true);
    // ?year=2027 은 v2
    const hit27 = (await (await get('/api/docs/search?q=porcelain&year=2027', 1)).json()) as any;
    expect(hit27.hits.some((h: any) => h.versionId === v2)).toBe(true);
    expect(hit27.hits.some((h: any) => h.versionId === v1)).toBe(false);
    // LIKE 폴백(3자 미만)도 동일: 'yr'은 styrofoam(v1)에만 존재
    const like26 = (await (await get('/api/docs/search?q=yr&year=2026', 1)).json()) as any;
    expect(like26.hits.some((h: any) => h.versionId === v1)).toBe(true);
    const likeCur = (await (await get('/api/docs/search?q=yr', 1)).json()) as any;
    expect(likeCur.hits.some((h: any) => h.versionId === v1)).toBe(false);
  }, 60000);

  it('POST /api/docs/auto — year 전달·응답 포함', async () => {
    const fd = pdfForm({}, '연도자동.pdf');
    fd.append('year', '2031');
    const res = await fetch(`${base}/api/docs/auto`, {
      method: 'POST',
      headers: { 'x-test-user': '1' },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.year).toBe(2031);
    const row = db.prepare('SELECT year FROM document_version WHERE id = ?').get(body.versionId) as {
      year: number;
    };
    expect(row.year).toBe(2031);
  }, 30000);
});

describe('원본 파일 첨부 (B-2 — Phase 2)', () => {
  it('허용 외 확장자 → 400, editor만 첨부 가능(403)', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new TextEncoder().encode('x')]), 'evil.html');
    const bad = await fetch(`${base}/api/docs/versions/${versionId}/source-file`, {
      method: 'POST',
      headers: { 'x-test-user': '1' },
      body: fd,
    });
    expect(bad.status).toBe(400);

    const fd2 = new FormData();
    fd2.append('file', new Blob([new TextEncoder().encode('x')]), '지침.hwp');
    const viewer = await fetch(`${base}/api/docs/versions/${versionId}/source-file`, {
      method: 'POST',
      headers: { 'x-test-user': '2' },
      body: fd2,
    });
    expect(viewer.status).toBe(403);
  });

  it('hwp 첨부 → 201, 상세 versions에 sourceName 노출, change_log 기록', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new TextEncoder().encode('가상 HWP 원본 내용')]), '가상지침_원본.hwp');
    const r = await fetch(`${base}/api/docs/versions/${versionId}/source-file`, {
      method: 'POST',
      headers: { 'x-test-user': '1' },
      body: fd,
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as any;
    expect(body.sourceName).toBe('가상지침_원본.hwp');

    const detail = (await (await get(`/api/docs/${docId}`, 2)).json()) as any;
    const v = detail.versions.find((x: any) => x.id === versionId);
    expect(v.sourceName).toBe('가상지침_원본.hwp');
    const log = db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log WHERE entity='document_version' AND action='source_attach'`,
      )
      .get() as { n: number };
    expect(log.n).toBe(1);
  });

  it('원본 다운로드 → 항상 attachment + nosniff, 없는 판본 404', async () => {
    const r = await fetch(`${base}/api/docs/versions/${versionId}/source-file`, {
      headers: { 'x-test-user': '2' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('attachment');
    expect(r.headers.get('content-disposition')).toContain(encodeURIComponent('가상지침_원본.hwp'));
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await r.text()).toBe('가상 HWP 원본 내용');

    const none = await fetch(`${base}/api/docs/versions/999999/source-file`, {
      headers: { 'x-test-user': '2' },
    });
    expect(none.status).toBe(404);
  });

  it('재첨부(교체) → source_replace 기록', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new TextEncoder().encode('개정된 원본')]), '가상지침_원본_v2.docx');
    const r = await fetch(`${base}/api/docs/versions/${versionId}/source-file`, {
      method: 'POST',
      headers: { 'x-test-user': '1' },
      body: fd,
    });
    expect(r.status).toBe(201);
    const log = db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log WHERE entity='document_version' AND action='source_replace'`,
      )
      .get() as { n: number };
    expect(log.n).toBe(1);
  });
});
