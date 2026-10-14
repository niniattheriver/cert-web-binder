import { describe, expect, it } from 'vitest';
import { OfficeParseError } from '../errors.js';
import { DOC_EXTRACTOR, processDoc } from './doc.js';
import { nfcName } from './doclist.js';
import { buildDoc } from './testdocs.js';
import { writeCfb } from './testkit.js';

describe('doc(Word 97~2003) → 정본 글자 + 흐름 모델 (docx 와 같은 출력 단계)', () => {
  it('문단, 가운데 정렬, 굵게, 쪽 나눔, 표: 쪽 글자와 모델', () => {
    const r = processDoc(
      buildDoc({
        paras: [{ text: '제목 문단', center: true }, { text: '굵게 섞인 둘째 문단', bold: [0, 2] }, { text: '셋째 쪽 문단', pageBreakBefore: true }],
        table: [
          ['가', '나'],
          ['다', '라'],
        ],
      }),
      '지침.doc',
    );
    expect(r.fileKind).toBe('docx');
    expect(r.extractor).toBe(DOC_EXTRACTOR);
    // 요약 정보(쪽 수)가 없는 파일은 docx 처럼 글자 수로 나눈 '구간'
    expect(r.pages.map((p) => [p.label, p.text])).toEqual([
      ['구간 1', '제목 문단\n굵게 섞인 둘째 문단'],
      ['구간 2', '셋째 쪽 문단\n가\t나\n다\t라'],
    ]);
    const m = JSON.parse(r.render.toString('utf8'));
    expect(m.kind).toBe('flow');
    expect(m.defaultTab).toBe(48); // DOP dxaTab 720 twips
    expect([m.pages[0].w, m.pages[0].h]).toEqual([793.7, 1122.5]); // SEPX 의 A4
    const [title, second] = m.pages[0].blocks;
    expect(title.align).toBe('center');
    expect(second.runs.map((x: { t: string; b?: boolean }) => [x.t, x.b ?? false])).toEqual([
      ['굵게', true],
      [' 섞인 둘째 문단', false],
    ]);
    const table = m.pages[1].blocks.find((b: { type: string }) => b.type === 'table');
    expect(table.rows).toHaveLength(2);
    expect(table.colWidths).toEqual([200, 200]);
  });

  it('암호(fEncrypted)와 Word 95 이전(nFib < 0xC1)은 안내와 함께 거부한다', () => {
    expect(() => processDoc(buildDoc({ paras: [{ text: '가' }], encrypted: true }), 'a.doc')).toThrow(/암호/);
    expect(() => processDoc(buildDoc({ paras: [{ text: '가' }], nFib: 0x0065 }), 'a.doc')).toThrow(/Word 95/);
  });

  it('WordDocument 가 없거나 깨졌으면 OfficeParseError', () => {
    expect(() => processDoc(writeCfb([{ path: 'WordDocument', data: Buffer.alloc(100) }]), 'a.doc')).toThrow(OfficeParseError);
    expect(() => processDoc(writeCfb([{ path: 'Other', data: Buffer.alloc(10) }]), 'a.doc')).toThrow(OfficeParseError);
  });

  it('번호 형식 MSONFC → ST_NumberFormat (MS-OSHARED 표: 0x28 은 decimal, 0x29 부터 한국어 형식)', () => {
    expect(nfcName(0x00)).toBe('decimal');
    expect(nfcName(0x18)).toBe('ganada');
    expect(nfcName(0x19)).toBe('chosung');
    expect(nfcName(0x12)).toBe('decimalEnclosedCircle');
    expect(nfcName(0x17)).toBe('bullet');
    expect(nfcName(0x28)).toBe('decimal');
    expect(nfcName(0x29)).toBe('koreanDigital');
    expect(nfcName(0xff)).toBe('none');
  });
});
