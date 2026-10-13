import { describe, expect, it } from 'vitest';
import { zipEntries } from '../jobs/zip.js';
import { detectFileKind, downloadMime, LEGACY_EXTRACTOR_MIME, UnsupportedFormatError } from './detect.js';
import { DOC_EXTRACTOR } from './legacy/doc.js';
import { HWP_EXTRACTOR } from './legacy/hwp.js';
import { buildDoc, buildHwp, buildXls } from './legacy/testdocs.js';
import { writeCfb } from './legacy/testkit.js';
import { XLS_EXTRACTOR } from './legacy/xls.js';

const zipOf = (names: Record<string, string>): Buffer =>
  zipEntries(Object.entries(names).map(([name, body]) => ({ name, data: Buffer.from(body, 'utf8') })));

describe('detectFileKind', () => {
  it('PDF 는 머리(%PDF-)로 판정한다: 확장자와 무관', () => {
    expect(detectFileKind(Buffer.from('%PDF-1.7\n...'), 'a.bin').kind).toBe('pdf');
    expect(detectFileKind(Buffer.from('\n\n%PDF-1.4'), 'a.pdf').kind).toBe('pdf');
  });

  it('확장자가 pdf 인데 머리가 없으면 PDF 경로로 넘긴다(기존 손상 PDF 안내 유지)', () => {
    expect(detectFileKind(Buffer.from('not a pdf'), '깨진.pdf').kind).toBe('pdf');
  });

  it('ZIP 목차로 docx, xlsx, pptx, hwpx 를 가른다', () => {
    expect(detectFileKind(zipOf({ '[Content_Types].xml': '<x/>', 'word/document.xml': '<w/>' }), 'a.docx').kind).toBe('docx');
    expect(detectFileKind(zipOf({ 'xl/workbook.xml': '<w/>' }), 'b.xlsx').kind).toBe('xlsx');
    expect(detectFileKind(zipOf({ 'ppt/presentation.xml': '<p/>' }), 'c.pptx').kind).toBe('pptx');
    expect(detectFileKind(zipOf({ mimetype: 'application/hwp+zip', 'Contents/section0.xml': '<s/>' }), 'd.hwpx').kind).toBe('hwpx');
    expect(detectFileKind(zipOf({ 'Contents/content.hpf': '<o/>' }), 'e.hwpx').kind).toBe('hwpx');
    // 확장자가 달라도 내용이 docx 면 docx
    expect(detectFileKind(zipOf({ 'word/document.xml': '<w/>' }), '이름만zip.zip').kind).toBe('docx');
  });

  it('Office 가 아닌 ZIP 은 거부한다', () => {
    expect(() => detectFileKind(zipOf({ 'readme.txt': 'hi' }), 'x.zip')).toThrow(UnsupportedFormatError);
  });

  it('OLE2 복합 문서는 스트림 목록으로 가린다: doc, xls, hwp 는 같은 계열 새 형식 + legacy (확장자와 무관)', () => {
    const doc = buildDoc({ paras: [{ text: '가' }] });
    const xls = buildXls([{ name: '목록', rows: [['가']] }]);
    const hwp = buildHwp({ paras: [{ text: '가' }] });
    expect(detectFileKind(doc, '지침.doc')).toMatchObject({ kind: 'docx', legacy: 'doc' });
    expect(detectFileKind(xls, '목록.xls')).toMatchObject({ kind: 'xlsx', legacy: 'xls' });
    expect(detectFileKind(hwp, '지침.hwp')).toMatchObject({ kind: 'hwpx', legacy: 'hwp' });
    expect(detectFileKind(doc, '이름만바뀐.hwp')).toMatchObject({ kind: 'docx', legacy: 'doc' });
  });

  it('OLE2 가운데 암호 Office, 구형 ppt, Excel 95, 모르는 복합 문서, 깨진 머리, 한글 97 이전은 안내와 함께 거부한다', () => {
    const cfb = (name: string): Buffer => writeCfb([{ path: name, data: Buffer.alloc(16) }]);
    expect(() => detectFileKind(writeCfb([{ path: 'EncryptionInfo', data: Buffer.alloc(8) }, { path: 'EncryptedPackage', data: Buffer.alloc(8) }]), '잠김.docx')).toThrow(/암호/);
    expect(() => detectFileKind(cfb('PowerPoint Document'), '발표.ppt')).toThrow(/pptx/);
    expect(() => detectFileKind(cfb('Book'), '옛.xls')).toThrow(/Excel 95/);
    expect(() => detectFileKind(cfb('Other'), '무엇.doc')).toThrow(/복합 문서/);
    const head = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(() => detectFileKind(head, '지침.hwp')).toThrow(UnsupportedFormatError);
    const hwp3 = Buffer.concat([Buffer.from('HWP Document File V3.00 ', 'latin1'), Buffer.alloc(200)]);
    expect(() => detectFileKind(hwp3, '옛 지침.hwp')).toThrow(/hwp 3\.0/);
  });

  it('구형 형식의 내려받기 형식은 추출기 라벨로 고른다 (라벨은 추출기 상수와 같다)', () => {
    expect(Object.keys(LEGACY_EXTRACTOR_MIME).sort()).toEqual([DOC_EXTRACTOR, HWP_EXTRACTOR, XLS_EXTRACTOR].sort());
    expect(downloadMime('docx', DOC_EXTRACTOR)).toBe('application/msword');
    expect(downloadMime('xlsx', XLS_EXTRACTOR)).toBe('application/vnd.ms-excel');
    expect(downloadMime('hwpx', HWP_EXTRACTOR)).toBe('application/x-hwp');
    expect(downloadMime('docx', 'docx-v1')).toMatch(/wordprocessingml/);
    expect(downloadMime('hwpx', null)).toBe('application/hwp+zip');
  });

  it('텍스트는 확장자 + NUL 없음일 때만', () => {
    const d = detectFileKind(Buffer.from('a,b\n1,2\n'), '목록.csv');
    expect(d.kind).toBe('text');
    expect(d.textFormat).toBe('csv');
    expect(() => detectFileKind(Buffer.from([0x41, 0x00, 0x42]), 'x.txt')).toThrow(UnsupportedFormatError);
  });

  it('BOM 있는 UTF-16 텍스트(메모장 유니코드, 엑셀 유니코드 텍스트)는 바이트의 0 이 아니라 해독한 글자로 판정한다', () => {
    const le = (s: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
    const be = (s: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]);
    expect(detectFileKind(le('항목\tQC\n결과\t12\n'), '결과.txt')).toMatchObject({ kind: 'text', textFormat: 'txt' });
    expect(detectFileKind(le('항목\tQC\n'), '결과.tsv')).toMatchObject({ kind: 'text', textFormat: 'tsv' });
    expect(detectFileKind(be('a,b\n1,2\n'), '목록.csv')).toMatchObject({ kind: 'text', textFormat: 'csv' });
    // 해독한 글자에 NUL 이 있거나 짝 없는 대리 글자(깨진 UTF-16)가 있으면 이진 파일로 본다
    expect(() => detectFileKind(le('a\u0000b'), 'x.txt')).toThrow(UnsupportedFormatError);
    expect(() => detectFileKind(Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]), 'x.txt')).toThrow(UnsupportedFormatError);
  });

  it('빈 파일, 모르는 형식은 거부한다', () => {
    expect(() => detectFileKind(Buffer.alloc(0), 'a.docx')).toThrow(/빈 파일/);
    expect(() => detectFileKind(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'img.png')).toThrow(UnsupportedFormatError);
  });
});
