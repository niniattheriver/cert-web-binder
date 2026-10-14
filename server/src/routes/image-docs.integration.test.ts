// 근거자료 그림 파일(png, jpg, gif, webp, bmp) 통합 테스트: :memory: DB + 실제 라우터.
// 글자는 읽지 않는다(OCR 없음). 판본 형식과 저장 확장자, 그림/원본/렌더 API, 받지 않는 그림 안내,
// 그림 전체 근거 연결(새 발췌, 같은 발췌에 문항 더하기), 글자 선택 연결 거부, 근거 목록,
// 새 버전에서 확인 필요로 넘어간 근거를 그림 전체로 확정, 무결성 점검과 백업 매니페스트.
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
import { buildFileManifest } from '../jobs/backup.js';
import { runIntegrityCheck } from '../jobs/integrity.js';
import { PNG_1X1 } from '../office/docx/testkit.js';
import { createAnchorsRouter } from './anchors.js';
import { createDocsRouter } from './docs.js';
import { createQuestionsRouter } from './questions.js';
import { createSearchRouter } from './search.js';

let db: Database.Database;
let filesDir: string;
let server: Server;
let base: string;
let q1 = 0;
let q2 = 0;

const EDITOR = 1;
/** 앞머리만 갖춘 JPEG (서버는 그림을 풀지 않고 서명만 본다) */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\u0000', 'latin1'),
  Buffer.alloc(64, 7),
  Buffer.from([0xff, 0xd9]),
]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40, 1)]);

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
  const insertQ = db.prepare(
    `INSERT INTO question (category_id, question_no, sort_key, body, updated_at) VALUES (1, ?, ?, ?, ?)`,
  );
  q1 = Number(insertQ.run('70.010.010', 1, '검체 보관 장소를 구분해 표시하는가?', now).lastInsertRowid);
  q2 = Number(insertQ.run('70.010.020', 2, '보관 장비의 위치를 도면으로 관리하는가?', now).lastInsertRowid);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-image-rt-'));

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

interface VersionRow {
  file_kind: string;
  extractor: string;
  page_count: number;
  text_warning: string | null;
  file_sha256: string;
  file_name: string;
}
const versionRow = (vid: number): VersionRow =>
  db
    .prepare('SELECT file_kind, extractor, page_count, text_warning, file_sha256, file_name FROM document_version WHERE id = ?')
    .get(vid) as VersionRow;

let docId = 0;
let ver1 = 0;

describe('그림 파일 업로드 (글자를 읽지 않는다)', () => {
  it('png: file_kind image, 빈 1쪽, 안내 없음, 그림 모델, .png 저장', async () => {
    const r = await postForm('/api/docs', fileForm({ title: '분자실 배치도', versionLabel: 'v1', year: '2026' }, '분자실 배치도.png', PNG_1X1, 'image/png'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ fileKind: 'image', pageCount: 1, firstPageLabel: null });
    expect(r.body.textWarning).toBeUndefined();
    docId = r.body.documentId;
    ver1 = r.body.versionId;

    const v = versionRow(ver1);
    expect(v).toMatchObject({ file_kind: 'image', extractor: 'image-png-v1', page_count: 1, text_warning: null });
    const pages = db.prepare('SELECT page_no, text, label FROM page_text WHERE document_version_id = ?').all(ver1);
    expect(pages).toEqual([{ page_no: 1, text: '', label: null }]);
    const render = db.prepare('SELECT extractor, json_gz FROM document_render WHERE document_version_id = ?').get(ver1) as {
      extractor: string;
      json_gz: Buffer;
    };
    expect(render.extractor).toBe('image-png-v1');
    expect(JSON.parse(zlib.gunzipSync(render.json_gz).toString('utf8'))).toEqual({
      v: 1,
      kind: 'image',
      media: [{ path: '', mime: 'image/png' }],
      truncated: null,
      pages: [{ pageNo: 1 }],
    });
    expect(fs.existsSync(contentPath(filesDir, v.file_sha256, 'png'))).toBe(true);
  });

  it('그림 라우트는 원본을 그대로 image/png 로, 원본 받기는 attachment, 목록과 메타에 형식', async () => {
    const media = await fetch(`${base}/api/docs/versions/${ver1}/media/0`);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toBe('image/png');
    expect(media.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await media.arrayBuffer()).equals(PNG_1X1)).toBe(true);
    expect((await fetch(`${base}/api/docs/versions/${ver1}/media/1`)).status).toBe(404);

    const file = await fetch(`${base}/api/docs/versions/${ver1}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    await file.arrayBuffer();

    const render = await getJson(`/api/docs/versions/${ver1}/render`);
    expect(render.body.kind).toBe('image');
    const meta = await getJson(`/api/docs/versions/${ver1}/meta`);
    expect(meta.body).toMatchObject({ fileKind: 'image', pageCount: 1, fileName: '분자실 배치도.png' });
    const list = await getJson('/api/docs');
    const d = list.body.docs.find((x: any) => x.id === docId);
    expect(d.currentVersion).toMatchObject({ fileKind: 'image', pageCount: 1, fileName: '분자실 배치도.png', fileSize: PNG_1X1.length });
    // 글자가 없어 본문 검색에는 걸리지 않는다(제목 검색은 그대로)
    const hits = await getJson(`/api/docs/search?q=${encodeURIComponent('배치도')}`);
    expect(hits.body.hits.filter((h: any) => h.versionId === ver1)).toEqual([]);
  });

  it('일괄 업로드: 확장자가 jpg 라도 내용이 gif 면 그림(gif)으로 받고 제목은 확장자를 뗀 이름', async () => {
    const r = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '냉장고 사진.jpg', GIF_BYTES));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ title: '냉장고 사진', fileKind: 'image', newVersion: false });
    const v = versionRow(r.body.versionId);
    expect(v.extractor).toBe('image-gif-v1');
    expect(fs.existsSync(contentPath(filesDir, v.file_sha256, 'gif'))).toBe(true);
    const media = await fetch(`${base}/api/docs/versions/${r.body.versionId}/media/0`);
    expect(media.headers.get('content-type')).toBe('image/gif');
    await media.arrayBuffer();
  });

  it('HEIC, TIFF, SVG 는 400 unsupported_format 과 안내', async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(32)]);
    const r1 = await postForm('/api/docs/auto', fileForm({}, 'IMG_0001.HEIC', heic));
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('unsupported_format');
    expect(String(r1.body.details)).toContain('JPG로 바꿔');
    const r2 = await postForm('/api/docs/auto', fileForm({}, '스캔.tif', Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])));
    expect(String(r2.body.details)).toContain('TIFF');
    const r3 = await postForm('/api/docs/auto', fileForm({}, '도식.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')));
    expect(r3.status).toBe(400);
    expect(String(r3.body.details)).toContain('SVG');
  });
});

describe('그림 전체 근거 연결', () => {
  let passageId = 0;
  let anchorId = 0;

  it('처음 연결하면 발췌와 앵커를 만든다: 인용 없음, 1쪽, 좌표 1쪽 전체, 박스 앵커', async () => {
    const r = await postJson('/api/anchors/image', { documentVersionId: ver1, questionIds: [q1] });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    passageId = r.body.passageId;
    anchorId = r.body.anchorId;
    const a = db.prepare('SELECT * FROM passage_anchor WHERE id = ?').get(anchorId) as Record<string, unknown>;
    expect(a).toMatchObject({
      quote_exact: '',
      start_offset: 0,
      end_offset: 0,
      page_start: 1,
      page_end: 1,
      geometry_primary: 1,
      status: 'resolved',
      method: 'manual',
      resolved_by: EDITOR,
    });
    expect(JSON.parse(String(a.rects_json))).toEqual([{ page: 1, rects: [[0, 0, 1, 1]] }]);
    // 찾을 글자가 없어 발췌 전문 검색에는 넣지 않는다
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fts WHERE kind = 'passage' AND ref_id = ?`).get(passageId)).toEqual({ n: 0 });
  });

  it('다른 문항을 이으면 같은 발췌에 더하고, 이미 이은 문항은 다시 넣지 않는다', async () => {
    const r = await postJson('/api/anchors/image', { documentVersionId: ver1, questionIds: [q2, q1] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ passageId, anchorId, created: false, added: [q2] });
    const again = await postJson('/api/anchors/image', { documentVersionId: ver1, questionIds: [q2] });
    expect(again.body.added).toEqual([]);
    const list = await getJson(`/api/docs/versions/${ver1}/anchors`);
    expect(list.body.fileKind).toBe('image');
    expect(list.body.anchors).toHaveLength(1);
    expect(list.body.anchors[0]).toMatchObject({ anchorId, quote: '', geometryPrimary: true, pageStart: 1, status: 'resolved' });
    expect(list.body.anchors[0].questions.map((q: any) => q.id).sort()).toEqual([q1, q2].sort());
    const docs = await getJson('/api/docs');
    expect(docs.body.docs.find((x: any) => x.id === docId)).toMatchObject({ passageCount: 1, mappedQuestionCount: 2 });
  });

  it('글자 선택 연결(POST /api/anchors)은 그림 버전에서 안내와 함께 거부한다', async () => {
    const r = await postJson('/api/anchors', {
      documentVersionId: ver1,
      questionIds: [q1],
      quoteExact: '배치도',
      startOffset: 0,
      endOffset: 3,
      pageStart: 1,
      pageEnd: 1,
    });
    expect(r.status).toBe(400);
    expect(String(r.body.details)).toContain('이 그림 연결');
  });

  it('그림이 아닌 버전, 없는 문항, 없는 버전은 거부한다', async () => {
    const txt = await postForm('/api/docs', fileForm({ title: '보관 지침', versionLabel: 'v1' }, '보관 지침.txt', Buffer.from('제1조 검체는 냉장 보관한다.', 'utf8')));
    expect(txt.status).toBe(201);
    const r1 = await postJson('/api/anchors/image', { documentVersionId: txt.body.versionId, questionIds: [q1] });
    expect(r1.status).toBe(400);
    expect(String(r1.body.details)).toContain('그림 버전에서만');
    const r2 = await postJson('/api/anchors/image', { documentVersionId: ver1, questionIds: [999999] });
    expect(r2.status).toBe(400);
    const r3 = await postJson('/api/anchors/image', { documentVersionId: 999999, questionIds: [q1] });
    expect(r3.status).toBe(404);
  });

  it('근거 목록: 그림 근거는 형식 image, 1쪽, 인용 없음', async () => {
    const r = await getJson(`/api/questions/${q1}/evidence`);
    const it1 = r.body.items.find((x: any) => x.type === 'passage' && x.passageId === passageId);
    expect(it1).toMatchObject({ fileKind: 'image', pageStart: 1, quote: '', status: 'resolved', versionId: ver1, docTitle: '분자실 배치도' });
  });
});

describe('새 그림 버전: 근거는 확인 필요로 넘어가고 [이 그림으로 확인]으로 확정', () => {
  let ver2 = 0;
  let newAnchor = 0;

  it('새 버전(jpg)을 올리면 그림 전체 근거는 자동으로 옮기지 않고 확인 필요(박스 앵커 유지)', async () => {
    const r = await postForm(
      '/api/docs',
      fileForm({ documentId: String(docId), versionLabel: 'v2', year: '2026' }, '분자실 배치도 2026.jpg', JPEG_BYTES, 'image/jpeg'),
    );
    expect(r.status).toBe(201);
    expect(r.body.reanchor).toEqual({ auto: 0, needsReview: 1 });
    ver2 = r.body.versionId;
    const v = versionRow(ver2);
    expect(v.extractor).toBe('image-jpeg-v1');
    expect(fs.existsSync(contentPath(filesDir, v.file_sha256, 'jpg'))).toBe(true);
    const a = db
      .prepare('SELECT id, status, geometry_primary, rects_json, page_start FROM passage_anchor WHERE document_version_id = ?')
      .get(ver2) as { id: number; status: string; geometry_primary: number; rects_json: string | null; page_start: number | null };
    expect(a).toMatchObject({ status: 'needs_review', geometry_primary: 1, rects_json: null, page_start: null });
    newAnchor = a.id;
    const detail = await getJson(`/api/docs/${docId}`);
    expect(detail.body.needsReviewCount).toBe(1);
  });

  it('[이 그림으로 확인]: 그림 전체 근거로 확정하고 change_log 에 이전 상태를 남긴다', async () => {
    const r = await postJson(`/api/anchors/${newAnchor}/confirm-image`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, anchorId: newAnchor });
    const a = db.prepare('SELECT * FROM passage_anchor WHERE id = ?').get(newAnchor) as Record<string, unknown>;
    expect(a).toMatchObject({ status: 'resolved', method: 'manual', geometry_primary: 1, page_start: 1, quote_exact: '', resolved_by: EDITOR });
    expect(JSON.parse(String(a.rects_json))).toEqual([{ page: 1, rects: [[0, 0, 1, 1]] }]);
    const log = db
      .prepare(`SELECT before_json, after_json FROM change_log WHERE entity = 'passage_anchor' AND entity_id = ? AND action = 'confirm'`)
      .get(newAnchor) as { before_json: string; after_json: string };
    expect(JSON.parse(log.before_json)).toMatchObject({ status: 'needs_review' });
    expect(JSON.parse(log.after_json)).toMatchObject({ status: 'resolved', wholeImage: true });
    const detail = await getJson(`/api/docs/${docId}`);
    expect(detail.body.needsReviewCount).toBe(0);
    // 다시 누르면 이미 확인됨
    const again = await postJson(`/api/anchors/${newAnchor}/confirm-image`, {});
    expect(again.status).toBe(400);
    expect(String(again.body.details)).toContain('이미 확인된');
  });

  it('과거 버전의 근거와 그림이 아닌 버전의 근거는 확인할 수 없다', async () => {
    const old = db.prepare('SELECT id FROM passage_anchor WHERE document_version_id = ?').get(ver1) as { id: number };
    const r1 = await postJson(`/api/anchors/${old.id}/confirm-image`, {});
    expect(r1.status).toBe(400);
    expect((await postJson('/api/anchors/999999/confirm-image', {})).status).toBe(404);
  });

  it('글자 문서의 근거는 그림 새 버전에서 확인 필요가 되고, 그림 전체로 확정하면 옛 글자 검색 항목이 지워진다', async () => {
    const body = '제1조 검체 냉장고는 분자실 북쪽 벽에 둔다.';
    const up = await postForm('/api/docs/auto', fileForm({ year: '2026' }, '냉장고 위치.txt', Buffer.from(body, 'utf8')));
    expect(up.status).toBe(201);
    const quote = '분자실 북쪽 벽에 둔다';
    const start = body.indexOf(quote);
    const made = await postJson('/api/anchors', {
      documentVersionId: up.body.versionId,
      questionIds: [q2],
      quoteExact: quote,
      startOffset: start,
      endOffset: start + quote.length,
      pageStart: 1,
      pageEnd: 1,
    });
    expect(made.status).toBe(201);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fts WHERE kind = 'passage' AND ref_id = ?`).get(made.body.passageId)).toEqual({ n: 1 });
    const v2 = await postForm(
      '/api/docs',
      fileForm({ documentId: String(up.body.documentId), versionLabel: '사진' }, '냉장고 위치.png', PNG_1X1, 'image/png'),
    );
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ fileKind: 'image', reanchor: { auto: 0, needsReview: 1 } });
    const a = db
      .prepare('SELECT id, status, geometry_primary, quote_exact FROM passage_anchor WHERE document_version_id = ?')
      .get(v2.body.versionId) as { id: number; status: string; geometry_primary: number; quote_exact: string };
    expect(a).toMatchObject({ status: 'needs_review', geometry_primary: 0, quote_exact: quote });
    const r = await postJson(`/api/anchors/${a.id}/confirm-image`, {});
    expect(r.status).toBe(200);
    const after = db.prepare('SELECT status, geometry_primary, quote_exact FROM passage_anchor WHERE id = ?').get(a.id);
    expect(after).toEqual({ status: 'resolved', geometry_primary: 1, quote_exact: '' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fts WHERE kind = 'passage' AND ref_id = ?`).get(made.body.passageId)).toEqual({ n: 0 });
    // 옛 글자 버전의 앵커 행은 그대로 남는다(지난 버전에서 연 근거)
    const oldRow = db.prepare('SELECT quote_exact FROM passage_anchor WHERE document_version_id = ?').get(up.body.versionId);
    expect(oldRow).toEqual({ quote_exact: quote });
  });
});

describe('무결성 점검, 백업 매니페스트', () => {
  it('그림 버전의 원본 파일(.png, .jpg, .gif)과 화면용 데이터를 찾는다', () => {
    const r = runIntegrityCheck(db, filesDir);
    expect(r.checks.find((c) => c.name.includes('버전의 원본 파일'))?.ok).toBe(true);
    expect(r.checks.find((c) => c.name.includes('화면용 데이터'))?.ok).toBe(true);
    expect(r.checks.find((c) => c.name.includes('현재 버전'))?.ok).toBe(true);
  });

  it('백업 매니페스트는 그림의 실제 형식 확장자로 적는다', () => {
    const m = buildFileManifest(db, filesDir);
    expect(m.missingCount).toBe(0);
    for (const ext of ['.png', '.jpg', '.gif']) expect(m.files.some((f) => f.relPath.endsWith(ext))).toBe(true);
  });
});
