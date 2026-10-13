// 자유양식 근거문서(rich_doc)·첨부 통합 테스트 — 임시 파일 DB + 실제 라우터
// 생성·평문 FTS 투영·문항 링크·낙관적 잠금(409)·soft delete·attachment 내용주소 왕복 검증
// (세션 미들웨어 대신 고정 userId 주입 — 세션 자체는 session-store.test.ts에서 검증)
import type Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { createRichDocsRouter } from './richdocs.js';

let tmpDir: string;
let filesDir: string;
let db: Database.Database;
let server: Server;
let base: string;
let questionId: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-rich-'));
  filesDir = path.join(tmpDir, 'files');
  db = openDatabase(path.join(tmpDir, 'test.db'));
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('editor1','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','개인정보보호',1)`).run();
  const info = db
    .prepare(
      `INSERT INTO question (category_id, question_no, sort_key, body, max_score, allow_na, updated_at)
       VALUES (1,'50.210.420',1,'개인정보 파기 절차를 수립·이행하고 있는가?',3,0,?)`,
    )
    .run(now);
  questionId = Number(info.lastInsertRowid);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use('/api', createRichDocsRouter(db, { filesDir }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve); // 임시 포트 — 종료 시 반드시 닫음
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api(
  method: string,
  urlPath: string,
  bodyObj?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: bodyObj !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function ftsContent(refId: number): string | undefined {
  return (
    db
      .prepare(`SELECT content FROM fts WHERE kind='rich_doc' AND ref_id=?`)
      .get(refId) as { content: string } | undefined
  )?.content;
}

describe('rich_doc CRUD/링크 (통합)', () => {
  let docId: number;

  it('생성 → 201, rowVersion=1, 평문이 FTS(kind=rich_doc)에 투영', async () => {
    const r = await api('POST', '/api/richdocs', {
      title: '파기 절차 근거',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '파기대장 운영' }] }] },
      contentPlain: '파기대장 운영',
    });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe('파기 절차 근거');
    expect(r.body.rowVersion).toBe(1);
    expect(r.body.updatedByName).toBe('편집자');
    expect(r.body.questions).toEqual([]);
    docId = r.body.id;
    const fts = ftsContent(docId);
    expect(fts).toContain('파기 절차 근거');
    expect(fts).toContain('파기대장 운영');
    const log = db
      .prepare(`SELECT COUNT(*) AS n FROM change_log WHERE entity='rich_doc' AND entity_id=? AND action='create'`)
      .get(docId) as { n: number };
    expect(log.n).toBe(1);
  });

  it('수정 → rowVersion 증가, 평문 재투영, change_log update', async () => {
    const r = await api('PATCH', `/api/richdocs/${docId}`, {
      rowVersion: 1,
      title: '파기 절차 근거(개정)',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '파기대장 및 검토서' }] }] },
      contentPlain: '파기대장 및 검토서',
    });
    expect(r.status).toBe(200);
    expect(r.body.rowVersion).toBe(2);
    expect(r.body.title).toBe('파기 절차 근거(개정)');
    const fts = ftsContent(docId);
    expect(fts).toContain('검토서');
    expect(fts).not.toContain('운영');
  });

  it('구버전 rowVersion 수정 → 409 + 서버본 + conflict_lost 보존', async () => {
    const r = await api('PATCH', `/api/richdocs/${docId}`, {
      rowVersion: 1,
      contentPlain: '충돌 편집',
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('conflict');
    expect(r.body.server.rowVersion).toBe(2);
    const lost = db
      .prepare(`SELECT COUNT(*) AS n FROM change_log WHERE entity='rich_doc' AND entity_id=? AND action='conflict_lost'`)
      .get(docId) as { n: number };
    expect(lost.n).toBe(1);
  });

  it('문항 링크 추가 → 201, 상세의 questions에 노출, 중복은 무동작', async () => {
    const r = await api('POST', `/api/richdocs/${docId}/links`, { questionId });
    expect(r.status).toBe(201);
    expect(r.body.sort).toBeGreaterThanOrEqual(1);
    const dup = await api('POST', `/api/richdocs/${docId}/links`, { questionId });
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    const detail = await api('GET', `/api/richdocs/${docId}`);
    expect(detail.body.questions).toHaveLength(1);
    expect(detail.body.questions[0].questionNo).toBe('50.210.420');
  });

  it('생성 시 questionId 지정 → 즉시 링크', async () => {
    const r = await api('POST', '/api/richdocs', {
      title: '보조 근거',
      contentPlain: '보조 설명',
      questionId,
    });
    expect(r.status).toBe(201);
    expect(r.body.questions).toHaveLength(1);
    expect(r.body.questions[0].questionId).toBe(questionId);
    // 통합 sort — 앞 문서 링크(sort=1) 다음이므로 2
    expect(r.body.questions[0].sort).toBe(2);
  });

  it('링크 해제 → 상세 questions 비움', async () => {
    const r = await api('DELETE', `/api/richdocs/${docId}/links/${questionId}`);
    expect(r.status).toBe(200);
    const detail = await api('GET', `/api/richdocs/${docId}`);
    expect(detail.body.questions).toHaveLength(0);
  });

  it('soft delete → GET 404, FTS 제거, deleted_at 설정', async () => {
    const r = await api('DELETE', `/api/richdocs/${docId}`);
    expect(r.status).toBe(200);
    const detail = await api('GET', `/api/richdocs/${docId}`);
    expect(detail.status).toBe(404);
    expect(ftsContent(docId)).toBeUndefined();
    const row = db.prepare('SELECT deleted_at FROM rich_doc WHERE id=?').get(docId) as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
  });

  it('존재하지 않는 문항으로 생성 → 400', async () => {
    const r = await api('POST', '/api/richdocs', { title: '고아', questionId: 999999 });
    expect(r.status).toBe(400);
  });
});

describe('attachment 내용주소 (통합)', () => {
  // 최소 유효 PNG (1x1 투명)
  const pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const pngBuf = Buffer.from(pngB64, 'base64');

  it('업로드 → 201 {sha256,url}, 서빙 GET 왕복, 동일 내용 재업로드는 중복 제거', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([pngBuf], { type: 'image/png' }), 'shot.png');
    const up = await fetch(`${base}/api/attachments`, { method: 'POST', body: fd });
    expect(up.status).toBe(201);
    const info = (await up.json()) as { sha256: string; url: string; mime: string; size: number };
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.url).toBe(`/api/attachments/${info.sha256}`);
    expect(info.mime).toBe('image/png');

    const get = await fetch(`${base}${info.url}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await get.arrayBuffer());
    expect(bytes.equals(pngBuf)).toBe(true);

    // 중복 제거 — attachment 행 1개만
    const fd2 = new FormData();
    fd2.append('file', new Blob([pngBuf], { type: 'image/png' }), 'again.png');
    const up2 = await fetch(`${base}/api/attachments`, { method: 'POST', body: fd2 });
    expect(up2.status).toBe(201);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM attachment WHERE sha256=?')
      .get(info.sha256) as { n: number };
    expect(count.n).toBe(1);
  });

  it('허용되지 않는 MIME → 400', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('<svg/>')], { type: 'image/svg+xml' }), 'x.svg');
    const up = await fetch(`${base}/api/attachments`, { method: 'POST', body: fd });
    expect(up.status).toBe(400);
  });

  it('없는 sha256 조회 → 404', async () => {
    const get = await fetch(`${base}/api/attachments/${'0'.repeat(64)}`);
    expect(get.status).toBe(404);
  });
});
