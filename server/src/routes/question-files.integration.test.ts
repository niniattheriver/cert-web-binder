// 문항 첨부·링크 라우트 통합 테스트 (v1.5 Phase 2) — :memory: DB + 전체 마이그레이션 + 실제 Express.
// 디스크 스트리밍 저장·내용주소·inline 화이트리스트(pdf/png/jpg)·상한(app_setting)·soft delete·링크 검증.
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createQuestionFilesRouter } from './question-files.js';

let db: Database.Database;
let filesDir: string;
let server: Server;
let base: string;
let questionId: number;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('e','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','개인정보보호',1)`).run();
  const info = db
    .prepare(
      `INSERT INTO question (category_id, question_no, sort_key, body, max_score, allow_na, updated_at)
       VALUES (1,'50.010.010',1,'가상 문항 본문',3,0,?)`,
    )
    .run(now);
  questionId = Number(info.lastInsertRowid);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-qfiles-'));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use('/api', createQuestionFilesRouter(db, { filesDir }));
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

function fileForm(name: string, bytes: Uint8Array, mime = 'application/octet-stream'): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([bytes.slice().buffer], { type: mime }), name);
  return fd;
}

async function uploadFile(name: string, bytes: Uint8Array): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/questions/${questionId}/attachments`, {
    method: 'POST',
    body: fileForm(name, bytes),
  });
  return { status: res.status, body: await res.json() };
}

describe('문항 첨부 (통합)', () => {
  let pdfId: number;
  let txtId: number;

  it('업로드 → 201, 내용주소 저장(attachments/<2>/<62>), change_log 기록', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4 fake little pdf for test');
    const r = await uploadFile('근거자료.pdf', pdfBytes);
    expect(r.status).toBe(201);
    expect(r.body.origName).toBe('근거자료.pdf');
    expect(r.body.mime).toBe('application/pdf'); // 확장자 재판정 (신고 MIME 무시)
    expect(r.body.inlinePreview).toBe(true);
    pdfId = r.body.id;
    const row = db
      .prepare('SELECT sha256 FROM question_attachment WHERE id = ?')
      .get(pdfId) as { sha256: string };
    const stored = path.join(filesDir, 'attachments', row.sha256.slice(0, 2), row.sha256.slice(2));
    expect(fs.existsSync(stored)).toBe(true);
    const log = db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log WHERE entity='question_attachment' AND action='create'`,
      )
      .get() as { n: number };
    expect(log.n).toBe(1);
  });

  it('inline 화이트리스트: pdf → inline, txt → attachment 강제 + nosniff', async () => {
    const r = await uploadFile('메모.txt', new TextEncoder().encode('안전하지 않은 형식'));
    expect(r.status).toBe(201);
    expect(r.body.inlinePreview).toBe(false);
    txtId = r.body.id;

    const pdfRes = await fetch(`${base}/api/questions/attachments/${pdfId}/file`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-disposition')).toContain('inline');
    expect(pdfRes.headers.get('x-content-type-options')).toBe('nosniff');

    const txtRes = await fetch(`${base}/api/questions/attachments/${txtId}/file`);
    expect(txtRes.status).toBe(200);
    expect(txtRes.headers.get('content-disposition')).toContain('attachment');
    expect(txtRes.headers.get('content-disposition')).toContain(encodeURIComponent('메모.txt'));
  });

  it('html 업로드도 octet-stream + attachment (저장형 XSS 차단)', async () => {
    const r = await uploadFile('evil.html', new TextEncoder().encode('<script>alert(1)</script>'));
    expect(r.status).toBe(201);
    expect(r.body.mime).toBe('application/octet-stream');
    expect(r.body.inlinePreview).toBe(false);
  });

  it('상한(app_setting attachmentMaxMB) 초과 → 400 file_too_large', async () => {
    db.prepare("INSERT OR REPLACE INTO app_setting (key, value) VALUES ('attachmentMaxMB','0.001')").run();
    const r = await uploadFile('big.bin', new Uint8Array(4096));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('file_too_large');
    db.prepare("INSERT OR REPLACE INTO app_setting (key, value) VALUES ('attachmentMaxMB','200')").run();
  });

  it('목록 → 첨부 정렬 노출, soft delete → 목록 제외 + 행 보존', async () => {
    const list1 = await fetch(`${base}/api/questions/${questionId}/files`).then((r) => r.json()) as any;
    expect(list1.attachments.length).toBe(3);

    const del = await fetch(`${base}/api/questions/attachments/${txtId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list2 = await fetch(`${base}/api/questions/${questionId}/files`).then((r) => r.json()) as any;
    expect(list2.attachments.length).toBe(2);
    const raw = db
      .prepare('SELECT deleted_at FROM question_attachment WHERE id = ?')
      .get(txtId) as { deleted_at: string | null };
    expect(raw.deleted_at).not.toBeNull(); // soft delete — 하드삭제 아님
    const fileRes = await fetch(`${base}/api/questions/attachments/${txtId}/file`);
    expect(fileRes.status).toBe(404); // 삭제된 첨부는 다운로드 불가
  });
});

describe('문항 하이퍼링크 (통합)', () => {
  let linkId: number;

  it('http(s)만 허용 — javascript: 등은 400', async () => {
    const bad = await fetch(`${base}/api/questions/${questionId}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${base}/api/questions/${questionId}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://intranet.example/docs/1', label: '내부 문서함' }),
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as any;
    expect(body.label).toBe('내부 문서함');
    linkId = body.id;
  });

  it('목록 노출 + soft delete', async () => {
    const list = (await fetch(`${base}/api/questions/${questionId}/files`).then((r) => r.json())) as any;
    expect(list.links).toHaveLength(1);
    const del = await fetch(`${base}/api/questions/links/${linkId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const list2 = (await fetch(`${base}/api/questions/${questionId}/files`).then((r) => r.json())) as any;
    expect(list2.links).toHaveLength(0);
  });
});
