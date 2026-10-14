import { describe, expect, it } from 'vitest';
import { OfficeParseError } from '../errors.js';
import { processXls, XLS_EXTRACTOR } from './xls.js';
import { buildXls } from './testdocs.js';
import { writeCfb } from './testkit.js';

describe('xls(BIFF8) → 시트 모델 (xlsx 와 같은 규칙)', () => {
  it('보이는 시트 하나가 한 쪽(이름표 = 시트 이름), 공유 문자열과 숫자, 빈 칸은 글자에 넣지 않는다', () => {
    const r = processXls(
      buildXls([
        { name: '목록', rows: [['구분', '수량'], ['검체', 12], [null, 3.5]] },
        { name: '둘째', rows: [['가운데']] },
      ]),
      '목록.xls',
    );
    expect(r.fileKind).toBe('xlsx');
    expect(r.extractor).toBe(XLS_EXTRACTOR);
    expect(r.pages.map((p) => [p.label, p.text])).toEqual([
      ['목록', '구분\t수량\n검체\t12\n3.5'],
      ['둘째', '가운데'],
    ]);
    const m = JSON.parse(r.render.toString('utf8'));
    expect(m.kind).toBe('sheet');
    expect(m.pages[0].name).toBe('목록');
  });

  it('암호(FILEPASS)는 안내와 함께 거부한다', () => {
    expect(() => processXls(buildXls([{ name: 'a', rows: [['가']] }], { encrypted: true }), 'a.xls')).toThrow(/암호/);
  });

  it('Workbook 스트림이 깨졌으면 OfficeParseError', () => {
    const broken = writeCfb([{ path: 'Workbook', data: Buffer.from([0x09, 0x08, 0xff, 0xff, 1, 2]) }]);
    expect(() => processXls(broken, 'a.xls')).toThrow(OfficeParseError);
  });
});
