import { describe, expect, it } from 'vitest';
import type { PlainModel, SheetModel } from './model.js';
import { buildSheetText, columnLetter } from './sheet-text.js';
import { decodeTextBuffer, paginatePlain, parseDelimited, processText } from './text.js';

/** 정합 불변식: 모든 셀 조각의 t 가 쪽 글자의 o 위치에 그대로 있다 */
function expectSheetInvariant(model: SheetModel, texts: string[]): void {
  model.pages.forEach((pg, i) => {
    const text = texts[i]!;
    for (const row of pg.rows) {
      for (const cell of row.cells) {
        if (cell.t === undefined) continue;
        expect(text.slice(cell.o!, cell.o! + cell.t.length)).toBe(cell.t);
      }
    }
  });
}

describe('buildSheetText', () => {
  it('글자 있는 셀만 탭으로, 행은 줄바꿈으로 잇고 오프셋을 단다', () => {
    const { text, rows } = buildSheetText([
      { r: 1, cells: [{ c: 1, text: '장비명' }, { c: 2, text: '' , s: 3 }, { c: 3, text: '위치' }] },
      { r: 2, cells: [{ c: 2, text: '', s: 1 }] }, // 서식만 있는 행
      { r: 4, cells: [{ c: 1, text: 'PCR' }, { c: 3, text: '분자실' }] },
    ]);
    expect(text).toBe('장비명\t위치\nPCR\t분자실');
    expect(rows.map((r) => r.r)).toEqual([1, 2, 4]);
    expect(rows[0]!.cells).toEqual([
      { c: 1, t: '장비명', o: 0 },
      { c: 2, s: 3 },
      { c: 3, t: '위치', o: 4 },
    ]);
    expect(rows[2]!.cells[1]).toEqual({ c: 3, t: '분자실', o: 11 });
  });

  it('NFD 한글을 NFC 로 정규화한 글자로 오프셋을 계산한다', () => {
    const nfd = '한글'.normalize('NFD');
    const { text, rows } = buildSheetText([{ r: 1, cells: [{ c: 1, text: nfd }, { c: 2, text: 'x' }] }]);
    expect(text).toBe('한글\tx');
    expect(rows[0]!.cells[1]!.o).toBe(3);
  });

  it('열 글자', () => {
    expect([1, 26, 27, 52, 703].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'AAA']);
  });
});

describe('UTF-16 텍스트 파일', () => {
  it('BOM 있는 UTF-16LE tsv(엑셀 유니코드 텍스트)는 칸으로, UTF-16BE txt 는 글자로 읽는다', () => {
    const tsv = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('항목\t결과\nQC\t12\n', 'utf16le')]);
    expect(processText(tsv, 'tsv', '결과.tsv').pages[0]!.text).toBe('항목\t결과\nQC\t12');
    const txt = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('검체 보관 7일', 'utf16le').swap16()]);
    expect(processText(txt, 'txt', '메모.txt').pages[0]!.text).toBe('검체 보관 7일');
  });
});

describe('decodeTextBuffer', () => {
  it('UTF-8(BOM 포함), UTF-16LE, CP949 를 읽는다', () => {
    expect(decodeTextBuffer(Buffer.from('﻿가나', 'utf8'))).toBe('가나');
    expect(decodeTextBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('검사', 'utf16le')]))).toBe('검사');
    // '검사' 를 CP949 로 인코딩한 바이트
    expect(decodeTextBuffer(Buffer.from([0xb0, 0xcb, 0xbb, 0xe7]))).toBe('검사');
  });
});

describe('parseDelimited', () => {
  it('따옴표 안 쉼표, 줄바꿈, 이스케이프된 따옴표', () => {
    expect(parseDelimited('a,"b,c","d\ne","f""g"\n1,2,3,4\n', ',')).toEqual([
      ['a', 'b,c', 'd\ne', 'f"g'],
      ['1', '2', '3', '4'],
    ]);
  });
});

describe('paginatePlain', () => {
  it('60줄마다 쪽을 나누고 빈 글자도 한 쪽은 만든다', () => {
    const text = Array.from({ length: 130 }, (_, i) => `줄${i + 1}`).join('\n');
    const pages = paginatePlain(text);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.split('\n')).toHaveLength(60);
    expect(pages.join('\n')).toBe(text);
    expect(paginatePlain('')).toEqual(['']);
  });
});

describe('processText', () => {
  it('txt: 쪽 글자와 PlainModel 이 같다', () => {
    const r = processText(Buffer.from('첫 줄\r\n둘째 줄'), 'txt', '메모.txt');
    expect(r.fileKind).toBe('text');
    expect(r.pages).toEqual([{ pageNo: 1, text: '첫 줄\n둘째 줄', label: null }]);
    const m = JSON.parse(r.render.toString('utf8')) as PlainModel;
    expect(m.kind).toBe('plain');
    expect(m.pages[0]!.t).toBe(r.pages[0]!.text);
  });

  it('csv: 시트 한 장, 셀 오프셋 불변식, 라벨 = 파일 이름', () => {
    const r = processText(Buffer.from('장비,위치,점검일\nPCR,"분자실, 2층",2026-01-02\n'), 'csv', '장비 목록.csv');
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]!.label).toBe('장비 목록');
    expect(r.pages[0]!.text).toBe('장비\t위치\t점검일\nPCR\t분자실, 2층\t2026-01-02');
    const m = JSON.parse(r.render.toString('utf8')) as SheetModel;
    expect(m.kind).toBe('sheet');
    expect(m.pages[0]!.maxCol).toBe(3);
    expectSheetInvariant(m, r.pages.map((p) => p.text));
  });
});
