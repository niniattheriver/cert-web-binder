// /api/search 옴니 검색 통합 테스트 — pages 그룹(지침서 PDF 본문 ⑤)·docs 그룹 year(④)
// :memory: DB + 실제 업로드 파이프라인(uploadGuideline)으로 page_text/FTS를 실제 경로로 채운다.
// (questions·passages 그룹 계약은 anchors.integration.test.ts 가 검증 — 여기서는 pages/docs만)
import type Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/migrate.js';
import { buildTestPdf } from '../docs/test-pdf-util.js';
import { uploadGuideline } from '../docs/service.js';
import { createSearchRouter } from './search.js';

let db: Database.Database;
let server: Server;
let base: string;
let filesDir: string;
let docId = 0;
let versionId = 0;

beforeAll(async () => {
  db = openDatabase(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('editor1','x','편집자','editor',1)`,
  ).run();
  db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
  db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','보안',1)`).run();
  // 문항 본문에는 PDF 본문 문구가 없다 — pages 그룹이 문항과 무관하게 히트하는지 검증용
  db.prepare(
    `INSERT INTO question (category_id, question_no, sort_key, body, updated_at)
     VALUES (1,'50.100.100',1,'출입 통제 절차가 있는가?',?)`,
  ).run(now);

  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-search-rt-'));
  const pdf = buildTestPdf([
    [
      'Fictional security manual page one.',
      'The zq-marker quarterly firewall inspection log must be retained.',
    ],
  ]);
  const up = await uploadGuideline(db, {
    buffer: pdf,
    fileName: '가상 보안 지침.pdf',
    title: '가상 보안 지침',
    versionLabel: 'v1',
    year: 2030,
    userId: 1,
    filesDir,
  });
  if (up.duplicate) throw new Error('unexpected duplicate');
  docId = up.documentId;
  versionId = up.versionId;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use('/api/search', createSearchRouter(db));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve); // 임시 포트 — 종료 시 반드시 닫음
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

async function search(q: string): Promise<any> {
  const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/search — pages 그룹 (지침서 PDF 본문)', () => {
  it('PDF 본문에만 있는 문구 → pages 히트, questions는 빈 배열', async () => {
    const body = await search('firewall inspection');
    expect(body.questions).toEqual([]);
    expect(body.pages.length).toBe(1);
    expect(body.pages[0]).toMatchObject({
      documentId: docId,
      versionId,
      docTitle: '가상 보안 지침',
      pageNo: 1,
      year: 2030,
    });
    expect(String(body.pages[0].snippet)).toContain('firewall');
  });

  it('3자 미만 → LIKE 폴백으로도 pages 히트', async () => {
    const body = await search('zq');
    expect(body.pages.some((p: any) => p.versionId === versionId)).toBe(true);
  });

  it('일치 없는 질의 → pages 빈 배열 (응답에 그룹은 항상 존재)', async () => {
    const body = await search('존재하지않는문구');
    expect(body.pages).toEqual([]);
  });
});

describe('GET /api/search — docs 그룹에 year(현재 판본)', () => {
  it('제목 일치 문서 행에 year 포함', async () => {
    const body = await search('보안 지침');
    expect(body.docs).toEqual([{ id: docId, title: '가상 보안 지침', year: 2030 }]);
  });
});
