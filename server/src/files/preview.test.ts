// 첨부 미리보기: ZIP 리더 왕복, 렌더 모델(고충실도), 예전 방식 대안, 미지원 형식 안내, 그림과 라우트.
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { closeIdleWorkers, LIMITS, runIsolated } from '../jobs/isolated.js';
import { zipEntries } from '../jobs/zip.js';
import type { FlowBlock, FlowModel, RenderModel, SheetModel, SlidesModel } from '../office/model.js';
import { createQuestionFilesRouter } from '../routes/question-files.js';
import {
  attachmentMedia,
  buildLegacyPreview,
  buildPreview,
  modelPreviewBody,
  type ModelPreview,
  type PreviewResult,
} from './preview.js';
import { PNG_1X1 } from '../office/docx/testkit.js';
import { buildDoc, buildHwp, buildXls } from '../office/legacy/testdocs.js';
import { readZipDirectory, readZipFile } from './unzip.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, data: Buffer | string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
}

// ─────────────────────────────── 고정물(합성 문서) ───────────────────────────────

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const FIXED_DATE = new Date(1980, 0, 1);
/** 1x1 PNG (실제로 열리는 바이트) */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** OLE2 복합 문서 머리: 구형 hwp, doc, xls, ppt 와 암호 걸린 Office 파일 */
const OLE_HEAD = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);

function zip(files: Record<string, string | Buffer>): Buffer {
  return zipEntries(
    Object.entries(files).map(([name, data]) => ({
      name,
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      date: FIXED_DATE,
    })),
  );
}

function rels(list: [string, string, string][]): string {
  const items = list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${RT}/${type}" Target="${target}"/>`);
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

/** 문단 몇 개짜리 Word 문서 (글자 조각은 XML 그대로 넣는다: 엔티티 확인용) */
function docxBytes(paragraphsXml: string[]): Buffer {
  const body = paragraphsXml.map((p) => `<w:p>${p}</w:p>`).join('');
  return zip({
    '[Content_Types].xml':
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml':
      `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
      `xmlns:r="${RT}"><w:body>${body}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>',
    'word/_rels/document.xml.rels': rels([]),
  });
}

const run = (t: string): string => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

async function xlsxBytes(rows: (string | number)[][], sheetName = '결과'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  `xmlns:r="${RT}" ` +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** 슬라이드 한 장(글상자 + 그림 한 장)짜리 PowerPoint */
function pptxBytes(title: string): Buffer {
  const tree =
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="제목"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR"/><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
    '<p:pic><p:nvPicPr><p:cNvPr id="3" name="그림"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="457200" y="2286000"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  return zip({
    '[Content_Types].xml':
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      '</Types>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml':
      `${XML_HEAD}<p:presentation ${P_NS}><p:sldIdLst><p:sldId id="256" r:id="rId10"/></p:sldIdLst>` +
      '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels([['rId10', 'slide', 'slides/slide1.xml']]),
    'ppt/slides/slide1.xml': `${XML_HEAD}<p:sld ${P_NS}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId2', 'image', '../media/image1.png']]),
    'ppt/media/image1.png': PNG_1PX,
  });
}

/** 렌더 모델 미리보기임을 확인하고 모델을 해석해 돌려준다 */
function modelOf(r: PreviewResult): RenderModel {
  expect(r.kind).toBe('model');
  return JSON.parse((r as ModelPreview).render.toString('utf8')) as RenderModel;
}

/** 흐름 문서의 정본 글자 조각을 문단마다 이어 붙인다 (표, 글상자 안도 순서대로) */
function flowParagraphs(blocks: FlowBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'p') out.push(b.runs.map((r) => r.t).join(''));
    else if (b.type === 'table') for (const row of b.rows) for (const c of row.cells) out.push(...flowParagraphs(c.blocks));
    else if (b.type === 'box') out.push(...flowParagraphs(b.blocks));
  }
  return out;
}

function sheetTexts(m: SheetModel, pageIdx = 0): string[][] {
  return (m.pages[pageIdx]?.rows ?? []).map((row) => row.cells.map((c) => c.t ?? ''));
}

// ─────────────────────────────── ZIP 리더 ───────────────────────────────

describe('unzip', () => {
  it('작성기(zipEntries)가 만든 ZIP 을 중앙 디렉토리로 되읽는다', () => {
    // 압축이 듣는 큰 엔트리(deflate)와 짧은 엔트리를 섞는다
    const big = Buffer.from('가나다라마바사'.repeat(500), 'utf8');
    const small = Buffer.from('{"a":1}', 'utf8');
    const z = zipEntries([
      { name: 'word/document.xml', data: big },
      { name: 'meta.json', data: small },
    ]);

    const dir = readZipDirectory(z);
    expect(dir?.map((e) => e.name)).toEqual(['word/document.xml', 'meta.json']);
    expect(readZipFile(z, 'word/document.xml')).toEqual(big);
    expect(readZipFile(z, 'meta.json')).toEqual(small);
    expect(readZipFile(z, '없는파일.xml')).toBeNull();
  });

  it('ZIP 이 아니면 null 을 돌려준다(형식 오판 방지)', () => {
    expect(readZipDirectory(Buffer.from('그냥 텍스트입니다', 'utf8'))).toBeNull();
  });

  it('상한을 넘는 엔트리는 풀지 않는다', () => {
    const z = zipEntries([{ name: 'big.bin', data: Buffer.alloc(4096, 7) }]);
    expect(readZipFile(z, 'big.bin', 1024)).toBeNull();
  });
});

// ─────────────────────────────── 렌더 모델 (고충실도) ───────────────────────────────

describe('buildPreview: 렌더 모델', () => {
  it('docx 는 지침서 뷰어와 같은 흐름 모델(flow)로 준다', async () => {
    const p = write('a.docx', docxBytes([run('첫 문단'), run('A &amp; B') + run(' 이어짐')]));
    const r = await buildPreview(p, 'a.docx');
    const m = modelOf(r) as FlowModel;
    expect(r.kind === 'model' && r.fileKind).toBe('docx');
    expect(m.kind).toBe('flow');
    const paras = m.pages.flatMap((pg) => flowParagraphs(pg.blocks)).filter((t) => t !== '');
    expect(paras).toEqual(['첫 문단', 'A & B 이어짐']);
  });

  it('xlsx 는 시트 모델로 준다(시트 이름, 칸 글자)', async () => {
    const p = write('a.xlsx', await xlsxBytes([['유전자', '판정'], ['BRCA1', 'VUS']]));
    const r = await buildPreview(p, 'a.xlsx');
    const m = modelOf(r) as SheetModel;
    expect(r.kind === 'model' && r.fileKind).toBe('xlsx');
    expect(m.kind).toBe('sheet');
    expect(m.pages[0]?.name).toBe('결과');
    expect(sheetTexts(m)).toEqual([
      ['유전자', '판정'],
      ['BRCA1', 'VUS'],
    ]);
  });

  it('pptx 는 슬라이드 모델로 주고, 그림은 모델의 media 색인으로만 꺼낸다', async () => {
    const p = write('a.pptx', pptxBytes('정도관리 결과'));
    const r = await buildPreview(p, 'a.pptx', { sha256: 'sha-pptx-media' });
    const m = modelOf(r) as SlidesModel;
    expect(m.kind).toBe('slides');
    expect(m.media).toEqual([{ path: 'ppt/media/image1.png', mime: 'image/png' }]);
    expect(m.pages[0]?.shapes.some((s) => s.type === 'pic' && s.media === 0)).toBe(true);

    const img = await attachmentMedia(p, 'a.pptx', 'sha-pptx-media', 0);
    expect(img?.mime).toBe('image/png');
    expect(img?.bytes.equals(PNG_1PX)).toBe(true);
    expect(await attachmentMedia(p, 'a.pptx', 'sha-pptx-media', 1)).toBeNull(); // 없는 색인
    expect(await attachmentMedia(p, 'a.pptx', 'sha-pptx-media', -1)).toBeNull();
  });

  it('그림 요청은 캐시가 비어도(서버 재기동 뒤) 모델을 다시 만들어 찾는다', async () => {
    const p = write('b.pptx', pptxBytes('두 번째'));
    const img = await attachmentMedia(p, 'b.pptx', 'sha-pptx-cold', 0);
    expect(img?.bytes.equals(PNG_1PX)).toBe(true);
  });

  it('렌더 모델이 없는 형식의 그림 요청은 null (pdf, 이미지, 텍스트)', async () => {
    const txt = write('m.txt', '글자만 있는 파일');
    expect(await attachmentMedia(txt, 'm.txt', 'sha-txt-media', 0)).toBeNull();
    const pdf = write('m.pdf', '%PDF-1.4 가짜');
    expect(await attachmentMedia(pdf, 'm.pdf', 'sha-pdf-media', 0)).toBeNull();
  });

  it('UTF-8, CP949(EUC-KR), BOM 텍스트를 글 모델(plain)로 바르게 읽는다', async () => {
    const utf8 = modelOf(await buildPreview(write('utf8.txt', '정도관리 기록\n두 번째 줄\n'), 'utf8.txt'));
    expect(utf8.kind).toBe('plain');
    expect(utf8.kind === 'plain' && utf8.pages[0]?.t).toContain('정도관리 기록');

    // 한글 윈도우에서 저장한 메모장 파일이 이 인코딩으로 들어온다
    const cp949 = modelOf(await buildPreview(write('cp949.txt', Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a])), 'cp949.txt'));
    expect(cp949.kind === 'plain' && cp949.pages[0]?.t.trim()).toBe('한글');

    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('제목', 'utf8')]);
    const withBom = modelOf(await buildPreview(write('bom.txt', bom), 'bom.txt'));
    expect(withBom.kind === 'plain' && withBom.pages[0]?.t).toBe('제목');
  });

  it('같은 바이트라도 이름이 csv 면 시트, txt 면 글 모델 (캐시도 섞지 않는다)', async () => {
    const bytes = '유전자,판정\nBRCA1,VUS\n';
    const csv = await buildPreview(write('같은.csv', bytes), '같은.csv', { sha256: 'sha-same-bytes' });
    const txt = await buildPreview(write('같은.txt', bytes), '같은.txt', { sha256: 'sha-same-bytes' });
    const sheet = modelOf(csv) as SheetModel;
    expect(sheet.kind).toBe('sheet');
    expect(sheet.pages[0]?.name).toBe('같은'); // csv 는 파일 이름이 시트 이름
    expect(sheetTexts(sheet)).toEqual([
      ['유전자', '판정'],
      ['BRCA1', 'VUS'],
    ]);
    expect(modelOf(txt).kind).toBe('plain');
  });

  it('sha256 을 주면 같은 첨부를 다시 해석하지 않고, 9번째 첨부가 들어오면 가장 오래된 것을 버린다(LRU 8개)', async () => {
    const p = write('lru.xlsx', await xlsxBytes([['값'], [1]]));
    const first = (await buildPreview(p, 'lru.xlsx', { sha256: 'lru-0' })) as ModelPreview;
    const again = (await buildPreview(p, 'lru.xlsx', { sha256: 'lru-0' })) as ModelPreview;
    expect(again.render).toBe(first.render); // 같은 Buffer = 캐시에서 꺼냈다

    // 다른 첨부 8개를 더 열면 lru-0 은 밀려난다
    for (let i = 1; i <= 8; i += 1) await buildPreview(p, 'lru.xlsx', { sha256: `lru-${i}` });
    const afterEviction = (await buildPreview(p, 'lru.xlsx', { sha256: 'lru-0' })) as ModelPreview;
    expect(afterEviction.kind).toBe('model');
    expect(afterEviction.render).not.toBe(first.render);
    expect(afterEviction.render.equals(first.render)).toBe(true); // 다시 만들어도 내용은 같다
  });

  it('동시에 같은 첨부를 열면 한 번만 해석한다', async () => {
    const p = write('same-time.xlsx', await xlsxBytes([['동시']]));
    const [a, b] = await Promise.all([
      buildPreview(p, 'same-time.xlsx', { sha256: 'sha-concurrent' }),
      buildPreview(p, 'same-time.xlsx', { sha256: 'sha-concurrent' }),
    ]);
    expect((a as ModelPreview).render).toBe((b as ModelPreview).render);
  });

  it('modelPreviewBody: 모델 바이트를 그대로 이어 붙인 올바른 JSON', async () => {
    const r = (await buildPreview(write('body.xlsx', await xlsxBytes([['칸']])), 'body.xlsx')) as ModelPreview;
    const meta = { id: 7, origName: '본문 "따옴표".xlsx', size: 123, mime: 'application/x' };
    const parsed = JSON.parse(modelPreviewBody(meta, r).toString('utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({
      ...meta,
      preview: { kind: 'model', fileKind: 'xlsx', model: JSON.parse(r.render.toString('utf8')) },
    });
  });
});

// ─────────────────────────────── 예전 방식으로 돌아가기 ───────────────────────────────

describe('buildPreview: 렌더 모델을 못 만들면 예전 방식', () => {
  it('추출기가 실패하면(손상된 presentation.xml) 슬라이드 글자만 뽑아 보여준다', async () => {
    const broken = zip({
      'ppt/presentation.xml': '<<<손상',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:t>첫 슬라이드</a:t></a:p></p:sld>',
    });
    const r = await buildPreview(write('broken.pptx', broken), 'broken.pptx', { sha256: 'sha-broken-pptx' });
    expect(r.kind).toBe('slides');
    if (r.kind === 'slides') expect(r.slides).toEqual([{ no: 1, lines: ['첫 슬라이드'] }]);
  });

  it('렌더 모델 형식이 아닌 텍스트(json, log)는 예전 텍스트 미리보기 (CP949 도 읽는다)', async () => {
    const json = await buildPreview(write('설정.json', '{"키": "값"}'), '설정.json');
    expect(json).toEqual({ kind: 'text', text: '{"키": "값"}', truncated: false });
    const log = await buildPreview(write('cp949.log', Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])), 'cp949.log');
    expect(log.kind === 'text' && log.text).toBe('한글');
  });

  it('예전 방식 docx: <w:p> 를 문단으로 뽑고 XML 엔티티를 되돌린다', async () => {
    const xml =
      '<?xml version="1.0"?><w:document><w:body>' +
      '<w:p><w:r><w:t>첫 문단</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>A &amp; B</w:t></w:r><w:r><w:t xml:space="preserve"> 이어짐</w:t></w:r></w:p>' +
      '<w:p></w:p>' + // 빈 문단은 버린다
      '</w:body></w:document>';
    const r = await buildLegacyPreview(zipEntries([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf8') }]), 'a.docx');
    expect(r).toEqual({ kind: 'doc', paragraphs: ['첫 문단', 'A & B 이어짐'], truncated: false });
  });

  it('예전 방식 pptx: 슬라이드를 번호순으로 뽑는다(slide10 이 slide2 보다 뒤)', async () => {
    const slide = (t: string) => Buffer.from(`<p:sld><a:p><a:t>${t}</a:t></a:p></p:sld>`, 'utf8');
    const r = await buildLegacyPreview(
      zipEntries([
        { name: 'ppt/slides/slide10.xml', data: slide('열번째') },
        { name: 'ppt/slides/slide2.xml', data: slide('두번째') },
      ]),
      'a.pptx',
    );
    expect(r.kind).toBe('slides');
    if (r.kind === 'slides') {
      expect(r.slides.map((s) => s.no)).toEqual([2, 10]);
      expect(r.slides[0]?.lines).toEqual(['두번째']);
    }
  });

  it('예전 방식 xlsx: 시트별 표로 뽑는다', async () => {
    const r = await buildLegacyPreview(await xlsxBytes([['유전자', '판정'], ['BRCA1', 'VUS']]), 'a.xlsx');
    expect(r.kind).toBe('sheet');
    if (r.kind === 'sheet') {
      expect(r.sheets[0]?.name).toBe('결과');
      expect(r.sheets[0]?.rows).toEqual([
        ['유전자', '판정'],
        ['BRCA1', 'VUS'],
      ]);
    }
  });
});

// ─────────────────────────────── 직접 렌더, 미지원 ───────────────────────────────

describe('buildPreview: 해석 상한', () => {
  const FIXTURE = new URL(import.meta.url.replace(/files\/preview\.test\.(ts|js)$/, 'jobs/isolated.fixture.$1'));

  it('작업 스레드 상한(대기 줄)에 걸리면 예전 방식으로 다시 읽지 않고 미리보기 안내로 끝낸다, 그림 요청은 null', async () => {
    const p = write('limit.pptx', pptxBytes('상한 시험'));
    const saved = { ...LIMITS };
    closeIdleWorkers();
    Object.assign(LIMITS, { maxWorkers: 1, maxWaiting: 0 });
    // 하나뿐인 스레드를 다른 작업이 붙잡고 있고, 기다리는 줄은 0 개
    const busy = runIsolated<number>(FIXTURE, 'spin', [2_000], { timeoutMs: 20_000 });
    try {
      const r = await buildPreview(p, 'limit.pptx');
      // 예전 방식(슬라이드 글자 뽑기)으로 넘어갔다면 kind 가 text 다
      expect(r).toEqual({
        kind: 'none',
        reason: '지금 다른 파일을 여럿 읽고 있어 미리보기를 만들지 못했습니다. 잠시 뒤 다시 열어 주세요.',
      });
      expect(await attachmentMedia(p, 'limit.pptx', 'sha-limit-media', 0)).toBeNull();
    } finally {
      await busy;
      Object.assign(LIMITS, saved);
    }
    // 상한이 풀리면 같은 파일을 렌더 모델로 본다(상한 오류는 캐시하지 않는다)
    expect((await buildPreview(p, 'limit.pptx')).kind).toBe('model');
  }, 60_000);
});

describe('buildPreview: 직접 렌더, 미지원', () => {
  it('pdf·이미지는 파일 URL 로 직접 그린다(서버가 내용을 뽑지 않는다)', async () => {
    expect((await buildPreview(write('x.pdf', 'ignored'), 'x.pdf')).kind).toBe('pdf');
    expect((await buildPreview(write('x.png', 'ignored'), 'x.png')).kind).toBe('image');
  });

  it('읽지 못한 구형 hwp, doc, xls 와 구형 ppt 는 안내를 준다: 조용히 빈 화면이 되지 않게', async () => {
    const reasons: Record<string, string> = {};
    for (const ext of ['hwp', 'doc', 'xls', 'ppt']) {
      const r = await buildPreview(write(`legacy.${ext}`, OLE_HEAD), `legacy.${ext}`, { sha256: `sha-ole-${ext}` });
      expect(r.kind).toBe('none');
      if (r.kind === 'none') reasons[ext] = r.reason;
    }
    expect(reasons.hwp).toContain('hwp 파일을 읽지 못했습니다');
    expect(reasons.doc).toContain('doc 파일을 읽지 못했습니다');
    expect(reasons.xls).toContain('xls 파일을 읽지 못했습니다');
    expect(reasons.ppt).toContain('구형 ppt');
    // OLE 머리가 아닌 hwp 도 같은 안내
    const plain = await buildPreview(write('x.hwp', 'binary'), 'x.hwp');
    expect(plain.kind === 'none' && plain.reason).toContain('hwp');
  });

  it('깨진 docx 는 예외 대신 안내를 돌려준다', async () => {
    const r = await buildPreview(write('broken.docx', 'ZIP 아님'), 'broken.docx');
    expect(r.kind).toBe('none');
  });

  it('저장 파일이 없으면 안내를 돌려준다', async () => {
    const r = await buildPreview(path.join(tmp, '없는파일.docx'), '없는파일.docx');
    expect(r).toEqual({ kind: 'none', reason: '저장 파일을 찾지 못했습니다.' });
  });
});

// ─────────────────────────────── 라우트 (preview, media, file 머리) ───────────────────────────────

describe('미리보기 라우트 (통합)', () => {
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
    db.prepare(`INSERT INTO category (cycle_id, code, name, sort) VALUES (1,'50','가상 분야',1)`).run();
    const info = db
      .prepare(
        `INSERT INTO question (category_id, question_no, sort_key, body, max_score, allow_na, updated_at)
         VALUES (1,'50.010.010',1,'가상 문항 본문',3,0,?)`,
      )
      .run(now);
    questionId = Number(info.lastInsertRowid);
    filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webbinder-preview-route-'));

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

  async function upload(name: string, bytes: Uint8Array): Promise<number> {
    // 정확한 크기의 사본: 작은 Buffer 는 공용 풀의 한 조각이라 .buffer 가 풀 전체를 가리킨다
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const fd = new FormData();
    fd.append('file', new Blob([copy.buffer], { type: 'application/octet-stream' }), name);
    const res = await fetch(`${base}/api/questions/${questionId}/attachments`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: number }).id;
  }

  it('xlsx 미리보기는 렌더 모델 payload (큰 모델은 gzip)', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [`행 ${i + 1}`, `정도관리 기록 ${i + 1}`]);
    const id = await upload('큰 표.xlsx', await xlsxBytes(rows));
    const res = await fetch(`${base}/api/questions/attachments/${id}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-encoding')).toBe('gzip'); // fetch 는 풀어서 준다
    const body = (await res.json()) as { id: number; origName: string; preview: { kind: string; fileKind: string; model: SheetModel } };
    expect(body.id).toBe(id);
    expect(body.origName).toBe('큰 표.xlsx');
    expect(body.preview.kind).toBe('model');
    expect(body.preview.fileKind).toBe('xlsx');
    expect(body.preview.model.kind).toBe('sheet');
    expect(body.preview.model.pages[0]?.rows.length).toBe(2000);
  });

  it('pptx 그림 라우트: 모델 media 색인 → 첨부 ZIP 안 그림 (nosniff), 없는 색인 404, 잘못된 번호 400', async () => {
    const id = await upload('발표.pptx', pptxBytes('라우트'));
    const pre = (await (await fetch(`${base}/api/questions/attachments/${id}/preview`)).json()) as {
      preview: { kind: string; model: SlidesModel };
    };
    expect(pre.preview.kind).toBe('model');
    expect(pre.preview.model.media.length).toBe(1);

    const img = await fetch(`${base}/api/questions/attachments/${id}/media/0`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG_1PX)).toBe(true);

    expect((await fetch(`${base}/api/questions/attachments/${id}/media/1`)).status).toBe(404);
    expect((await fetch(`${base}/api/questions/attachments/${id}/media/abc`)).status).toBe(400);
    expect((await fetch(`${base}/api/questions/attachments/${id}/media/..%2F..%2Fx`)).status).toBe(400);
    expect((await fetch(`${base}/api/questions/attachments/999999/media/0`)).status).toBe(404);
  });

  it('읽지 못한 hwp 는 none 안내, 렌더 모델이 아닌 첨부의 그림 요청은 404', async () => {
    const id = await upload('옛 문서.hwp', OLE_HEAD);
    const body = (await (await fetch(`${base}/api/questions/attachments/${id}/preview`)).json()) as {
      preview: { kind: string; reason?: string };
    };
    expect(body.preview.kind).toBe('none');
    expect(body.preview.reason).toContain('hwp 파일을 읽지 못했습니다');
    expect((await fetch(`${base}/api/questions/attachments/${id}/media/0`)).status).toBe(404);
  });

  it('구형 hwp, doc, xls 첨부도 렌더 모델로 미리 보고, hwp 그림은 복합 문서 스트림에서 꺼낸다', async () => {
    const hwpId = await upload('옛 지침.hwp', buildHwp({ paras: [{ text: '한글 옛 형식 본문' }, { picture: true }], png: PNG_1X1 }));
    const hwp = (await (await fetch(`${base}/api/questions/attachments/${hwpId}/preview`)).json()) as {
      preview: { kind: string; fileKind: string; model: FlowModel };
    };
    expect(hwp.preview).toMatchObject({ kind: 'model', fileKind: 'hwpx' });
    expect(JSON.stringify(hwp.preview.model)).toContain('한글 옛 형식 본문');
    const img = await fetch(`${base}/api/questions/attachments/${hwpId}/media/0`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG_1X1)).toBe(true);

    const docId = await upload('옛 규정.doc', buildDoc({ paras: [{ text: 'Word 옛 형식 본문' }] }));
    const doc = (await (await fetch(`${base}/api/questions/attachments/${docId}/preview`)).json()) as {
      preview: { kind: string; fileKind: string };
    };
    expect(doc.preview).toMatchObject({ kind: 'model', fileKind: 'docx' });
    const xlsId = await upload('옛 목록.xls', buildXls([{ name: '목록', rows: [['엑셀 옛 형식']] }]));
    const xls = (await (await fetch(`${base}/api/questions/attachments/${xlsId}/preview`)).json()) as {
      preview: { kind: string; fileKind: string };
    };
    expect(xls.preview).toMatchObject({ kind: 'model', fileKind: 'xlsx' });
  });

  it('inline PDF 만 같은 출처 frame 을 허용한다(미리보기 창 iframe), 내려받기와 다른 형식은 그대로', async () => {
    const pdfId = await upload('근거.pdf', new TextEncoder().encode('%PDF-1.4 가짜 pdf'));
    const inline = await fetch(`${base}/api/questions/attachments/${pdfId}/file`);
    expect(inline.headers.get('content-disposition')).toContain('inline');
    expect(inline.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(inline.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");

    const dl = await fetch(`${base}/api/questions/attachments/${pdfId}/file?dl=1`);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(dl.headers.get('x-frame-options')).toBeNull();
    expect(dl.headers.get('content-security-policy')).toBeNull();

    const docxId = await upload('문서.docx', docxBytes([run('본문')]));
    const docxFile = await fetch(`${base}/api/questions/attachments/${docxId}/file`);
    expect(docxFile.headers.get('content-disposition')).toContain('attachment');
    expect(docxFile.headers.get('x-frame-options')).toBeNull();
  });
});
