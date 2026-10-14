// 엑셀 내보내기: XML 1.0 이 허용하지 않는 글자(U+FFFE, U+FFFF)가 셀에 들어가도 파일이 열려야 한다.
// 텍스트 지침서(UTF-8)의 비문자는 정본 글자(page_text)에 그대로 남고, 그 글자를 품은 근거 인용이 근거요약 열에
// 들어간다. ExcelJS 는 C0 제어 문자는 빼 주지만 U+FFFE, U+FFFF 는 그대로 써서 Excel 이 파일을 손상으로 보고
// ExcelJS 자신도 다시 읽지 못했다(엑셀 왕복 가져오기 불가).
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnchorMapping } from '../anchors/service.js';
import { runMigrations } from '../db/migrate.js';
import { uploadGuideline } from '../docs/service.js';
import { collectExportCategories } from './data.js';
import { buildExportWorkbook, xmlSafe } from './workbook.js';

const NONCHAR_FFFE = String.fromCharCode(0xfffe);
const NONCHAR_FFFF = String.fromCharCode(0xffff);

describe('xmlSafe', () => {
  it('U+FFFE, U+FFFF 만 뺀다: 탭, 줄바꿈, 한글, 서로게이트 쌍은 그대로', () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    expect(xmlSafe(`가${NONCHAR_FFFE}나\t다\n라${NONCHAR_FFFF}${emoji}`)).toBe(`가나\t다\n라${emoji}`);
    const plain = '바꿀 글자가 없는 문장';
    expect(xmlSafe(plain)).toBe(plain);
  });
});

describe('텍스트 지침서의 비문자를 품은 근거 → 전체 내보내기', () => {
  let db: Database.Database;
  let filesDir: string;

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO user (username, pw_hash, display_name, role, active) VALUES ('e','x','편집자','editor',1)`).run();
    db.prepare(`INSERT INTO cycle (name, status, created_at) VALUES ('2026년 심사','active',?)`).run(now);
    db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'60','정보보안',1)`).run();
    db.prepare(
      `INSERT INTO question (category_id, question_no, sort_key, body, updated_at) VALUES (1,'60.010.010',1,?,?)`,
    ).run(`문항 본문${NONCHAR_FFFF}`, now);
    filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-export-chars-'));
  });

  afterAll(() => {
    db.close();
    fs.rmSync(filesDir, { recursive: true, force: true });
  });

  it('근거요약과 문항 열에 U+FFFE, U+FFFF 가 있어도 워크북을 다시 읽을 수 있다', async () => {
    // UTF-8 바이트 EF BF BE = U+FFFE (비문자도 UTF-8 로는 올바른 글자라 디코더가 그대로 둔다)
    const buf = Buffer.concat([
      Buffer.from('접근 권한 검토 ', 'utf8'),
      Buffer.from([0xef, 0xbf, 0xbe]),
      Buffer.from('기록은 3년 보관한다\n둘째 줄', 'utf8'),
    ]);
    const up = await uploadGuideline(db, {
      buffer: buf,
      fileName: '규칙.txt',
      title: '규칙 문서',
      versionLabel: 'v1',
      userId: 1,
      filesDir,
    });
    if (up.duplicate) throw new Error('중복일 수 없음');
    const text = (db.prepare('SELECT text FROM page_text WHERE document_version_id = ?').get(up.versionId) as { text: string }).text;
    const quote = `권한 검토 ${NONCHAR_FFFE}기록은`;
    const start = text.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0); // 정본 글자에 비문자가 남아 있다
    const res = createAnchorMapping(
      db,
      {
        documentVersionId: up.versionId,
        questionIds: [1],
        quoteExact: quote,
        startOffset: start,
        endOffset: start + quote.length,
        pageStart: 1,
        pageEnd: 1,
      },
      1,
    );
    expect(res.kind).toBe('created');

    const wb = buildExportWorkbook(collectExportCategories(db, 1));
    const out = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(out as ArrayBuffer); // 고치기 전: 'disallowed character' 로 실패
    const row = back.getWorksheet('문항')!.getRow(2);
    expect(String(row.getCell(3).value)).toBe('문항 본문');
    expect(String(row.getCell(11).value)).toBe('규칙 문서 구간 1 "권한 검토 기록은"');
  });
});
