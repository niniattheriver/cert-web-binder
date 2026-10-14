// 검사실 자료 PDF 외 형식(설계서 §3.5) 통합 테스트: :memory: DB + 실제 라우터.
// 텍스트 계열(txt, csv)로 형식 공통 경로를 검증한다: 판본 형식·렌더 모델 저장, 원본 스트림 헤더,
// 렌더/그림/메타 API, 원본 첨부 제한, 일괄 업로드의 제목·형식 일치 규칙, 앵커 형식 규칙과 서버 검증,
// 검색·근거 응답의 형식/쪽 이름, 무결성 점검과 백업 매니페스트.
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { contentPath } from '../docs/store.js';
import { buildTestPdf } from '../docs/test-pdf-util.js';
import { buildFileManifest } from '../jobs/backup.js';
import { runIntegrityCheck } from '../jobs/integrity.js';
import { makeDocx, PNG_1X1, pt as docxPara, sectPr, tbl, tc, tr } from '../office/docx/testkit.js';
import { buildDoc, buildHwp, buildXls } from '../office/legacy/testdocs.js';
import { writeCfb } from '../office/legacy/testkit.js';
import { createAnchorsRouter } from './anchors.js';
import { createDocsRouter } from './docs.js';
import { createQuestionsRouter } from './questions.js';
import { createSearchRouter } from './search.js';

let db: Database.Database;
let filesDir: string;
let server: Server;
let base: string;
let qid = 0;

const EDITOR = 1;
const TXT_BODY = [
  '제1조(목적) 이 지침은 검체 접수와 보관 절차를 정한다.',
  '제2조(보관) 검체는 접수 후 즉시 냉장 보관하고 7일간 보존한다.',
  '제3조(폐기) 보존 기간이 지난 검체는 의료폐기물로 처리한다.',
].join('\n');
const CSV_BODY = '장비명,위치,점검일\nPCR 장비,분자실,2026-01-02\n원심분리기,검체실,2026-02-03\n';

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('editor1','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'70','검체관리',1)`).run();
  qid = Number(
    db
      .prepare(
        `INSERT INTO question (category_id, question_no, sort_key, body, updated_at) VALUES (1,'70.010.010',1,?,?)`,
      )
      .run('검체 보관 기간을 정하고 준수하는가?', now).lastInsertRowid,
  );
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-office-rt-'));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const uid = Number(req.headers['x-test-user'] ?? EDITOR);
    (req as unknown as { session: { userId?: number } }).session = { userId: uid };
    next();
  });
  app.use('/api/search', createSearchRouter(db));
  app.use('/api/docs', createDocsRouter(db, { filesDir }));
  app.use('/api', createQuestionsRouter(db));
  app.use('/api', createAnchorsRouter(db));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function fileForm(fields: Record<string, string>, fileName: string, bytes: Uint8Array, mime = 'application/octet-stream'): FormData {
  const fd = new FormData();
  // Buffer.slice 는 복사가 아니라 공유 풀을 가리키므로 Uint8Array 로 복사해 정확히 그 바이트만 싣는다
  fd.append('file', new Blob([Uint8Array.from(bytes)], { type: mime }), fileName);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function postForm(url: string, fd: FormData): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${url}`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${url}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let txtDoc = 0;
let txtVer = 0;
let csvDoc = 0;
let csvVer = 0;
let pdfVer = 0;

describe('PDF 외 형식 업로드 (텍스트 계열로 공통 경로 검증)', () => {
  it('txt 업로드: file_kind, 추출기 라벨, 렌더 모델, .txt 저장 경로', async () => {
    const r = await postForm(
      '/api/docs',
      fileForm({ title: '검체 관리 지침', versionLabel: 'v1', year: '2026' }, '검체 관리 지침.txt', Buffer.from(TXT_BODY, 'utf8')),
    );
    expect(r.status).toBe(201);
    expect(r.body.fileKind).toBe('text');
    expect(r.body.pageCount).toBe(1);
    expect(r.body.firstPageLabel).toBeNull();
    expect(r.body.textWarning).toBeUndefined();
    txtDoc = r.body.documentId;
    txtVer = r.body.versionId;

    const v = db
      .prepare('SELECT file_kind, extractor, file_sha256, page_count, text_warning FROM document_version WHERE id = ?')
      .get(txtVer) as { file_kind: string; extractor: string; file_sha256: string; page_count: number; text_warning: string | null };
    expect(v.file_kind).toBe('text');
    expect(v.extractor).toBe('text-v1');
    expect(v.text_warning).toBeNull(); // 스캔 저밀도 경고는 PDF 전용
    expect(fs.existsSync(contentPath(filesDir, v.file_sha256, 'txt'))).toBe(true);

    const render = db
      .prepare('SELECT model_version, extractor, json_gz FROM document_render WHERE document_version_id = ?')
      .get(txtVer) as { model_version: number; extractor: string; json_gz: Buffer };
    expect(render.model_version).toBe(1);
    expect(render.extractor).toBe('text-v1');
    const model = JSON.parse(zlib.gunzipSync(render.json_gz).toString('utf8'));
    expect(model.kind).toBe('plain');
    const pt = db
      .prepare('SELECT text, label FROM page_text WHERE document_version_id = ? AND page_no = 1')
      .get(txtVer) as { text: string; label: string | null };
    expect(model.pages[0].t).toBe(pt.text);
    expect(pt.label).toBeNull();
  });

  it('csv 일괄 업로드: 제목에서 .csv 를 떼고 쪽 이름표를 단다', async () => {
    const r = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '장비 목록.csv', Buffer.from(CSV_BODY, 'utf8')));
    expect(r.status).toBe(201);
    expect(r.body.title).toBe('장비 목록');
    expect(r.body.fileKind).toBe('text');
    expect(r.body.firstPageLabel).toBe('장비 목록');
    expect(r.body.newVersion).toBe(false);
    csvDoc = r.body.documentId;
    csvVer = r.body.versionId;
    const pt = await getJson(`/api/docs/versions/${csvVer}/page-text`);
    expect(pt.status).toBe(200);
    expect(pt.body.fileKind).toBe('text');
    expect(pt.body.pages[0].label).toBe('장비 목록');
    expect(pt.body.pages[0].text).toContain('PCR 장비\t분자실\t2026-01-02');
  });

  it('Word 쪽 정보가 없는 docx: 첫 쪽 이름표 구간 1 을 업로드 응답과 목록에 준다 (쪽 수 단위용)', async () => {
    const docx = makeDocx({ body: docxPara('검체 운반 상자는 매일 소독한다.') + sectPr() });
    const r = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '운반 상자 관리.docx', docx));
    expect(r.status).toBe(201);
    expect(r.body.fileKind).toBe('docx');
    expect(r.body.firstPageLabel).toBe('구간 1');
    const list = await getJson('/api/docs');
    const row = list.body.docs.find((d: any) => d.id === r.body.documentId);
    expect(row.currentVersion.firstPageLabel).toBe('구간 1');
  });

  it('일괄 업로드: 같은 제목이라도 형식이 다르면 별도 문서, 같은 형식이면 새 판본', async () => {
    const pdf = buildTestPdf([['Specimen storage rule for the fictional lab.']]);
    const a = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '보관 규정.pdf', pdf, 'application/pdf'));
    expect(a.status).toBe(201);
    expect(a.body.fileKind).toBe('pdf');
    pdfVer = a.body.versionId;
    const b = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '보관 규정.txt', Buffer.from('보관 규정 본문', 'utf8')));
    expect(b.status).toBe(201);
    expect(b.body.documentId).not.toBe(a.body.documentId); // 형식이 달라 새 문서
    expect(b.body.newVersion).toBe(false);
    const c = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '보관 규정.txt', Buffer.from('보관 규정 본문 개정', 'utf8')));
    expect(c.status).toBe(201);
    expect(c.body.documentId).toBe(b.body.documentId); // 같은 제목, 같은 형식 → 새 판본
    expect(c.body.newVersion).toBe(true);
  }, 30_000);

  it('지원하지 않는 형식은 400 unsupported_format 과 형식별 안내', async () => {
    const ppt = writeCfb([{ path: 'PowerPoint Document', data: Buffer.alloc(16) }]);
    const old = await postForm('/api/docs', fileForm({ title: '구형', versionLabel: 'v1' }, '구형 발표.ppt', ppt));
    expect(old.status).toBe(400);
    expect(old.body.error).toBe('unsupported_format');
    expect(String(old.body.details)).toContain('pptx');
    const png = await postForm('/api/docs/auto', fileForm({}, '그림.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2])));
    expect(png.status).toBe(400);
    expect(png.body.error).toBe('unsupported_format');
  });

  it('구형 hwp, doc, xls 업로드: 같은 계열 file_kind, 구형 추출기, 원래 형식으로 내려받기, hwp 그림', async () => {
    const hwp = await postForm(
      '/api/docs/auto',
      fileForm({ year: '2026' }, '옛 지침.hwp', buildHwp({ paras: [{ text: '한글 옛 형식 본문' }, { picture: true }], png: PNG_1X1 })),
    );
    expect(hwp.status).toBe(201);
    const doc = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '옛 규정.doc', buildDoc({ paras: [{ text: 'Word 옛 형식 본문' }] })));
    expect(doc.status).toBe(201);
    const xls = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '옛 목록.xls', buildXls([{ name: '목록', rows: [['엑셀 옛 형식']] }])));
    expect(xls.status).toBe(201);
    const row = (vid: number): { file_kind: string; extractor: string } =>
      db.prepare('SELECT file_kind, extractor FROM document_version WHERE id = ?').get(vid) as { file_kind: string; extractor: string };
    expect(row(hwp.body.versionId)).toEqual({ file_kind: 'hwpx', extractor: 'hwp-v1' });
    expect(row(doc.body.versionId)).toEqual({ file_kind: 'docx', extractor: 'doc-v1' });
    expect(row(xls.body.versionId)).toEqual({ file_kind: 'xlsx', extractor: 'xls-v1' });
    // 제목은 구형 확장자도 뗀다
    const title = db.prepare('SELECT d.title FROM document d JOIN document_version dv ON dv.document_id = d.id WHERE dv.id = ?');
    expect((title.get(hwp.body.versionId) as { title: string }).title).toBe('옛 지침');
    const mime = async (vid: number): Promise<string | null> => {
      const res = await fetch(`${base}/api/docs/versions/${vid}/file`);
      await res.arrayBuffer();
      return res.headers.get('content-type');
    };
    expect(await mime(hwp.body.versionId)).toBe('application/x-hwp');
    expect(await mime(doc.body.versionId)).toBe('application/msword');
    expect(await mime(xls.body.versionId)).toBe('application/vnd.ms-excel');
    const img = await fetch(`${base}/api/docs/versions/${hwp.body.versionId}/media/0`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG_1X1)).toBe(true);
    const r = await getJson(`/api/docs/versions/${hwp.body.versionId}/render`);
    expect(r.body.kind).toBe('flow');
    expect(JSON.stringify(r.body)).toContain('한글 옛 형식 본문');
  }, 30_000); // 구형 세 형식을 작업 스레드에서 처음 읽는다: 전체 시험이 함께 돌면 5초를 넘길 수 있다

  it('원본 스트림: PDF 외 형식은 언제나 attachment + nosniff, PDF 는 inline (dl=1 이면 attachment)', async () => {
    const t = await fetch(`${base}/api/docs/versions/${txtVer}/file`);
    expect(t.status).toBe(200);
    expect(t.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(t.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(t.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await t.text()).toBe(TXT_BODY);
    const p = await fetch(`${base}/api/docs/versions/${pdfVer}/file`);
    expect(p.headers.get('content-type')).toBe('application/pdf');
    expect(p.headers.get('content-disposition')).toMatch(/^inline/);
    await p.arrayBuffer();
    const pdl = await fetch(`${base}/api/docs/versions/${pdfVer}/file?dl=1`);
    expect(pdl.headers.get('content-disposition')).toMatch(/^attachment/);
    await pdl.arrayBuffer();
  });

  it('렌더 모델 API: PDF 외 형식은 JSON, PDF 는 404 not_applicable', async () => {
    const r = await getJson(`/api/docs/versions/${csvVer}/render`);
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('sheet');
    expect(r.body.pages[0].name).toBe('장비 목록');
    const pdf = await getJson(`/api/docs/versions/${pdfVer}/render`);
    expect(pdf.status).toBe(404);
    expect(pdf.body.error).toBe('not_applicable');
    // gzip 을 받지 않는 요청에도 풀어서 준다
    const raw = await fetch(`${base}/api/docs/versions/${txtVer}/render`, { headers: { 'Accept-Encoding': 'identity' } });
    expect(raw.headers.get('content-encoding')).toBeNull();
    expect(((await raw.json()) as { kind: string }).kind).toBe('plain');
  });

  it('메타 API 와 그림 API', async () => {
    const m = await getJson(`/api/docs/versions/${txtVer}/meta`);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ versionId: txtVer, documentId: txtDoc, fileKind: 'text', isCurrent: true });
    const media = await fetch(`${base}/api/docs/versions/${txtVer}/media/0`);
    expect(media.status).toBe(404); // 텍스트에는 그림이 없다
    await media.text();
    const bad = await fetch(`${base}/api/docs/versions/${txtVer}/media/abc`);
    expect(bad.status).toBe(400);
    await bad.text();
  });

  it('그림 API 는 실제 바이트가 래스터 그림일 때만, 판정한 형식으로 내준다 (이름만 .png 인 HTML 은 404)', async () => {
    const blip = (rid: string): string =>
      `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><a:graphic><a:graphicData uri="x"><pic:pic>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const docx = makeDocx({
      rels: [
        { id: 'rOk', type: 'image', target: 'media/ok.png' },
        { id: 'rFake', type: 'image', target: 'media/fake.png' },
        { id: 'rMis', type: 'image', target: 'media/actually-png.jpg' },
      ],
      files: {
        'word/media/ok.png': PNG_1X1,
        'word/media/fake.png': Buffer.from('<html><body>not an image</body></html>', 'utf8'),
        'word/media/actually-png.jpg': PNG_1X1,
      },
      body: `<w:p>${blip('rOk')}${blip('rFake')}${blip('rMis')}</w:p>` + docxPara('그림 시험 문단') + sectPr(),
    });
    const up = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '그림 시험.docx', docx));
    expect(up.status).toBe(201);
    const get = async (i: number): Promise<{ status: number; type: string | null }> => {
      const res = await fetch(`${base}/api/docs/versions/${up.body.versionId}/media/${i}`);
      await res.arrayBuffer();
      return { status: res.status, type: res.status === 200 ? res.headers.get('content-type') : null };
    };
    expect(await get(0)).toEqual({ status: 200, type: 'image/png' });
    expect(await get(1)).toEqual({ status: 404, type: null }); // 확장자만 png, 실제는 HTML
    expect(await get(2)).toEqual({ status: 200, type: 'image/png' }); // 확장자는 jpg, 실제는 png
  });

  it('목록, 상세 응답에 판본 형식', async () => {
    const list = await getJson('/api/docs?year=2026');
    const row = list.body.docs.find((d: any) => d.id === csvDoc);
    expect(row.currentVersion.fileKind).toBe('text');
    expect(row.yearVersion.fileKind).toBe('text');
    expect(row.currentVersion.firstPageLabel).toBe('장비 목록');
    expect(row.yearVersion.firstPageLabel).toBe('장비 목록');
    const det = await getJson(`/api/docs/${txtDoc}`);
    expect(det.body.versions[0].fileKind).toBe('text');
  });

  it('PDF 외 판본에는 원본 파일(B-2)을 따로 붙일 수 없다: 409', async () => {
    const r = await postForm(
      `/api/docs/versions/${txtVer}/source-file`,
      fileForm({}, '원본.docx', Buffer.from('PK fake', 'utf8')),
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('source_not_applicable');
  });

  it('지침서 전문 검색: 형식과 쪽 이름표, 탭은 빈칸으로', async () => {
    const r = await getJson(`/api/docs/search?q=${encodeURIComponent('원심분리기')}`);
    expect(r.status).toBe(200);
    const hit = r.body.hits.find((h: any) => h.versionId === csvVer);
    expect(hit).toMatchObject({ fileKind: 'text', pageLabel: '장비 목록', pageNo: 1 });
    expect(hit.snippet).not.toContain('\t');
    const omni = await getJson(`/api/search?q=${encodeURIComponent('냉장 보관')}`);
    const page = omni.body.pages.find((p: any) => p.versionId === txtVer);
    expect(page).toMatchObject({ fileKind: 'text', pageLabel: null });
  });
});

describe('PDF 외 판본의 앵커 (좌표 없이 오프셋, 서버 검증)', () => {
  function textAnchor(over: Record<string, unknown>) {
    const pt = db.prepare('SELECT text FROM page_text WHERE document_version_id = ? AND page_no = 1').get(txtVer) as { text: string };
    const quote = '냉장 보관하고 7일간 보존한다';
    const start = pt.text.indexOf(quote);
    return {
      documentVersionId: txtVer,
      questionIds: [qid],
      quoteExact: quote,
      quotePrefix: pt.text.slice(Math.max(0, start - 64), start),
      quoteSuffix: pt.text.slice(start + quote.length, start + quote.length + 64),
      startOffset: start,
      endOffset: start + quote.length,
      pageStart: 1,
      pageEnd: 1,
      ...over,
    };
  }

  it('좌표를 보내면 거부한다', async () => {
    const r = await postJson('/api/anchors', textAnchor({ rects: [{ page: 1, rects: [[0, 0, 1, 1]] }] }));
    expect(r.status).toBe(400);
    expect(String(r.body.details)).toContain('좌표');
  });

  it('인용과 오프셋 구간 글자가 다르면 거부한다', async () => {
    const r = await postJson('/api/anchors', textAnchor({ quoteExact: '전혀 다른 문장' }));
    expect(r.status).toBe(400);
    expect(String(r.body.details)).toContain('일치하지 않습니다');
  });

  it('쪽 범위가 오프셋과 맞지 않으면 거부한다', async () => {
    const r = await postJson('/api/anchors', textAnchor({ pageStart: 2, pageEnd: 2 }));
    expect(r.status).toBe(400);
  });

  it('정상: rects 없이 만들어지고 rects_json 은 NULL, 목록은 오프셋을 준다', async () => {
    const r = await postJson('/api/anchors', textAnchor({}));
    expect(r.status).toBe(201);
    const row = db.prepare('SELECT rects_json, geometry_primary FROM passage_anchor WHERE id = ?').get(r.body.anchorId) as {
      rects_json: string | null;
      geometry_primary: number;
    };
    expect(row.rects_json).toBeNull();
    expect(row.geometry_primary).toBe(0);
    const list = await getJson(`/api/docs/versions/${txtVer}/anchors`);
    expect(list.body.fileKind).toBe('text');
    const a = list.body.anchors.find((x: any) => x.anchorId === r.body.anchorId);
    expect(a.rects).toBeNull();
    expect(typeof a.startOffset).toBe('number');
    expect(a.endOffset - a.startOffset).toBe('냉장 보관하고 7일간 보존한다'.length);
    expect(a.quotePrefix).toContain('검체는 접수 후 즉시');
  });

  it('PDF 판본은 여전히 rects 가 필요하다', async () => {
    const r = await postJson('/api/anchors', {
      documentVersionId: pdfVer,
      questionIds: [qid],
      quoteExact: 'Specimen storage rule',
      startOffset: 0,
      endOffset: 21,
      pageStart: 1,
      pageEnd: 1,
    });
    expect(r.status).toBe(400);
    expect(String(r.body.details)).toContain('rects');
  });

  it('근거 목록에 판본 형식과 쪽 이름표', async () => {
    const r = await getJson(`/api/questions/${qid}/evidence`);
    expect(r.status).toBe(200);
    const item = r.body.items.find((i: any) => i.type === 'passage');
    expect(item).toMatchObject({ fileKind: 'text', pageLabel: null, pageStart: 1 });
  });
});

describe('UTF-16 텍스트 업로드 (BOM 있음)', () => {
  it('UTF-16LE txt, UTF-16BE csv 를 이진 파일로 거부하지 않고 글자로 읽는다', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('항목\t결과\nQC\t12\n', 'utf16le')]);
    const a = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '유니코드 결과.txt', le));
    expect(a.status).toBe(201);
    expect(a.body.fileKind).toBe('text');
    const ptA = await getJson(`/api/docs/versions/${a.body.versionId}/page-text`);
    expect(ptA.body.pages[0].text).toContain('항목\t결과\nQC\t12');
    expect(ptA.body.pages[0].text).not.toContain('\u0000');
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('장비,위치\nPCR,분자실\n', 'utf16le').swap16()]);
    const b = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '유니코드 장비.csv', be));
    expect(b.status).toBe(201);
    const ptB = await getJson(`/api/docs/versions/${b.body.versionId}/page-text`);
    expect(ptB.body.pages[0].text).toBe('장비\t위치\nPCR\t분자실');
  });
});

describe('새 판본 재연결: 표 칸 경계 (csv 개정)', () => {
  async function csvVersion(name: string, body: string): Promise<{ versionId: number; newVersion: boolean }> {
    const r = await postForm('/api/docs/auto', fileForm({ year: '2026' }, name, Buffer.from(body, 'utf8')));
    expect(r.status).toBe(201);
    return r.body;
  }
  async function anchorOn(versionId: number, quote: string): Promise<number> {
    const pt = db.prepare('SELECT text FROM page_text WHERE document_version_id = ? AND page_no = 1').get(versionId) as {
      text: string;
    };
    const start = pt.text.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);
    const r = await postJson('/api/anchors', {
      documentVersionId: versionId,
      questionIds: [qid],
      quoteExact: quote,
      startOffset: start,
      endOffset: start + quote.length,
      pageStart: 1,
      pageEnd: 1,
    });
    expect(r.status).toBe(201);
    return r.body.passageId;
  }
  const statusOn = (passageId: number, versionId: number): string =>
    (
      db.prepare('SELECT status FROM passage_anchor WHERE passage_id = ? AND document_version_id = ?').get(passageId, versionId) as {
        status: string;
      }
    ).status;

  it('셀 값이 바뀐 행(QC,1,23 → QC,12,3)은 확인 필요로 두고, 그대로인 칸은 자동으로 옮긴다', async () => {
    const v1 = await csvVersion('정도관리 결과.csv', '항목,1회,2회\nQC,1,23\n');
    const row = await anchorOn(v1.versionId, 'QC\t1\t23');
    const head = await anchorOn(v1.versionId, '항목');
    const v2 = await csvVersion('정도관리 결과.csv', '항목,1회,2회\nQC,12,3\n');
    expect(v2.newVersion).toBe(true);
    expect(statusOn(row, v2.versionId)).toBe('needs_review');
    expect(statusOn(head, v2.versionId)).toBe('resolved_auto');
  });

  it('칸 하나였던 값이 다른 값의 일부가 되면(128450 → 1284500) 확인 필요', async () => {
    const v1 = await csvVersion('연간 검사 건수.csv', '구분,건수\n외래,128450\n');
    const cell = await anchorOn(v1.versionId, '128450');
    const v2 = await csvVersion('연간 검사 건수.csv', '구분,건수\n외래,1284500\n');
    expect(statusOn(cell, v2.versionId)).toBe('needs_review');
  });

  async function docxVersion(name: string, rows: string[][]): Promise<{ versionId: number; newVersion: boolean }> {
    const table = tbl(
      rows.map((r) => tr(r.map((c) => tc(docxPara(c))))),
      rows[0]!.map(() => 3000),
    );
    const docx = makeDocx({ body: docxPara('표 머리 문단') + table + sectPr() });
    const r = await postForm('/api/docs/auto', fileForm({ year: '2026' }, name, docx));
    expect(r.status).toBe(201);
    return r.body;
  }

  it('Word 표의 행 끝 칸: 값이 바뀌면(128450 → 1284500) 확인 필요, 그대로인 칸은 자동', async () => {
    const v1 = await docxVersion('검사 건수 표.docx', [['건수', '128450'], ['비고', '정상']]);
    const cell = await anchorOn(v1.versionId, '128450');
    const head = await anchorOn(v1.versionId, '비고');
    const v2 = await docxVersion('검사 건수 표.docx', [['건수', '1284500'], ['비고', '정상']]);
    expect(v2.newVersion).toBe(true);
    expect(statusOn(cell, v2.versionId)).toBe('needs_review');
    expect(statusOn(head, v2.versionId)).toBe('resolved_auto');
  });

  it('Word 표의 여러 칸 인용: 행이 갈라지면(건수|128450 → 건수|128, 450|OK) 확인 필요, 칸이 그대로인 행은 자동', async () => {
    const v1 = await docxVersion('검사 건수 행.docx', [['건수', '128450'], ['비고', '정상']]);
    const row = await anchorOn(v1.versionId, '건수\t128450');
    const v2 = await docxVersion('검사 건수 행.docx', [['건수', '128'], ['450', 'OK']]);
    expect(v2.newVersion).toBe(true);
    expect(statusOn(row, v2.versionId)).toBe('needs_review');

    const w1 = await docxVersion('검사 건수 행 2.docx', [['건수', '128450'], ['비고', '정상']]);
    const same = await anchorOn(w1.versionId, '건수\t128450');
    const w2 = await docxVersion('검사 건수 행 2.docx', [['건수', '128450'], ['비고', '재검']]);
    expect(w2.newVersion).toBe(true);
    expect(statusOn(same, w2.versionId)).toBe('resolved_auto');
  });

  it('확인 필요를 거친 근거도 칸 조건을 지킨다(5% → 15% 다음 개정에서 15% 안의 5% 에 자동 연결하지 않는다)', async () => {
    const v1 = await docxVersion('정도관리 기준표.docx', [['허용 오차', '5%'], ['비고', '없음']]);
    const cell = await anchorOn(v1.versionId, '5%');
    const v2 = await docxVersion('정도관리 기준표.docx', [['허용 오차', '15%'], ['비고', '없음']]);
    expect(statusOn(cell, v2.versionId)).toBe('needs_review');
    const v3 = await docxVersion('정도관리 기준표.docx', [['허용 오차', '15%'], ['비고', '있음']]);
    expect(v3.newVersion).toBe(true);
    expect(statusOn(cell, v3.versionId)).toBe('needs_review');
  });
});

describe('무결성 점검, 백업 매니페스트', () => {
  it('렌더 모델이 없는 PDF 외 판본은 점검 8 에서 잡힌다', () => {
    const ok = runIntegrityCheck(db, filesDir);
    const render = ok.checks.find((c) => c.name.includes('화면용 데이터'));
    expect(render?.ok).toBe(true);
    const files = ok.checks.find((c) => c.name.includes('버전의 원본 파일'));
    expect(files?.ok).toBe(true); // .txt 경로도 형식에 맞게 찾는다

    const saved = db.prepare('SELECT * FROM document_render WHERE document_version_id = ?').get(csvVer) as Record<string, unknown>;
    db.prepare('DELETE FROM document_render WHERE document_version_id = ?').run(csvVer);
    try {
      const bad = runIntegrityCheck(db, filesDir);
      const c = bad.checks.find((x) => x.name.includes('화면용 데이터'));
      expect(c?.ok).toBe(false);
      expect(c?.offenderCount).toBe(1);
    } finally {
      db.prepare(
        `INSERT INTO document_render (document_version_id, model_version, extractor, json_gz, created_at)
         VALUES (@document_version_id, @model_version, @extractor, @json_gz, @created_at)`,
      ).run(saved);
    }
  });

  it('백업 매니페스트는 형식별 확장자 경로를 쓴다', () => {
    const m = buildFileManifest(db, filesDir);
    expect(m.missingCount).toBe(0);
    expect(m.files.some((f) => f.relPath.endsWith('.txt'))).toBe(true);
    expect(m.files.some((f) => f.relPath.endsWith('.pdf'))).toBe(true);
  });
});
