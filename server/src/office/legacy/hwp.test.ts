import { describe, expect, it } from 'vitest';
import { PNG_1X1 } from '../docx/testkit.js';
import { OfficeParseError } from '../errors.js';
import { HWP_EXTRACTOR, processHwp } from './hwp.js';
import { readHwpBinData } from './hwpbin.js';
import { buildHwp, type HwpPara } from './testdocs.js';
import { writeCfb } from './testkit.js';

const PARAS: HwpPara[] = [
  { text: '첫 문단' },
  { text: '굵게 섞인 문단', bold: [0, 2] },
  { table: [['가', '나'], ['다', '라']] },
  { text: '둘째 쪽', pageBreak: true, center: true },
];

interface Run {
  t: string;
  o: number;
  b?: boolean;
  sz?: number;
  font?: string;
}
interface Para {
  type: 'p';
  align?: string;
  marginLeft?: number;
  runs: Run[];
}

function model(buf: Buffer): { pages: { w: number; h: number; margin: number[]; blocks: any[] }[]; media: { path: string; mime: string }[]; lineScale?: number } {
  return JSON.parse(processHwp(buf, '지침.hwp').render.toString('utf8'));
}

describe('hwp 5.0 → 정본 글자 + 흐름 모델 (hwpx 와 같은 변환)', () => {
  it('문단, 굵게, 표, 쪽 나눔: 쪽 글자와 모델', () => {
    const r = processHwp(buildHwp({ paras: PARAS }), '지침.hwp');
    expect(r.fileKind).toBe('hwpx');
    expect(r.extractor).toBe(HWP_EXTRACTOR);
    expect(r.truncated).toBeNull();
    expect(r.pages.map((p) => p.text)).toEqual(['첫 문단\n굵게 섞인 문단\n가\t나\n다\t라', '둘째 쪽']);
    expect(r.pages.every((p) => p.label === null)).toBe(true);
    const m = model(buildHwp({ paras: PARAS }));
    expect(m.lineScale).toBe(1);
    const [p0, p1, table] = m.pages[0]!.blocks as [Para, Para, any];
    expect(p0.runs[0]).toMatchObject({ t: '첫 문단', o: 0, sz: 10, font: '함초롬바탕' });
    expect(p1.runs.map((x) => [x.t, x.b ?? false])).toEqual([
      ['굵게', true],
      [' 섞인 문단', false],
    ]);
    expect(table.type).toBe('table');
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells[0]).toMatchObject({ va: 'middle', border: true, w: 80 });
    expect(table.rows[0].cells[0].bt).toEqual({ w: 1, style: 'solid', color: '#000000' });
    expect(table.rows[0].cells[0].pad).toEqual([1.9, 6.8, 1.9, 6.8]);
  });

  it('쪽 크기와 여백, 문단 여백은 2배로 적힌 값을 반으로 (가운데 정렬 문단의 왼쪽 여백 10pt)', () => {
    const m = model(buildHwp({ paras: PARAS }));
    const pg = m.pages[0]!;
    expect([pg.w, pg.h]).toEqual([793.7, 1122.5]);
    // 위 = 위 여백 + 머리말, 아래 = 아래 여백 + 꼬리말 (hwpx 와 같다)
    expect(pg.margin).toEqual([132.3, 113.4, 113.4, 113.4]);
    const p = m.pages[1]!.blocks[0] as Para;
    expect(p).toMatchObject({ align: 'center', marginLeft: 13.3 });
  });

  it('가로 용지(용지 방향 1)는 가로로 돌린다, 압축하지 않은 문서도 읽는다', () => {
    const land = model(buildHwp({ paras: [{ text: '가로' }], landscape: true }));
    expect(land.pages[0]!.w).toBeGreaterThan(land.pages[0]!.h);
    const plain = processHwp(buildHwp({ paras: [{ text: '압축 안 함' }], compressed: false }), 'a.hwp');
    expect(plain.pages[0]!.text).toBe('압축 안 함');
  });

  it('그림: media 에 BinData 경로, 바이트는 readHwpBinData 가 꺼낸다 (항목을 압축했든 안 했든)', () => {
    for (const compressPicture of [false, true]) {
      const buf = buildHwp({ paras: [{ text: '그림 앞' }, { picture: true }], png: PNG_1X1, compressPicture });
      const m = model(buf);
      expect(m.media).toEqual([{ path: 'BinData/BIN0001.png', mime: 'image/png' }]);
      const img = m.pages[0]!.blocks.find((b) => b.type === 'img');
      expect(img).toMatchObject({ type: 'img', media: 0, w: 60, h: 30 });
      expect(readHwpBinData(buf, 'BinData/BIN0001.png', 1 << 20)?.equals(PNG_1X1)).toBe(true);
    }
  });

  it('readHwpBinData 는 BinData 경로 꼴만 받고, 그림이 아니면 null', () => {
    const buf = buildHwp({ paras: [{ text: '가' }, { picture: true }], png: Buffer.from('<html>not image</html>') });
    expect(readHwpBinData(buf, 'BinData/BIN0001.png', 1 << 20)).toBeNull();
    expect(readHwpBinData(buf, 'FileHeader', 1 << 20)).toBeNull();
    expect(readHwpBinData(buf, '../BinData/BIN0001.png', 1 << 20)).toBeNull();
    expect(readHwpBinData(Buffer.from('not cfb'), 'BinData/BIN0001.png', 1 << 20)).toBeNull();
  });

  it('암호, 배포용, 5.0 이전 판은 안내와 함께 거부한다', () => {
    const p: HwpPara[] = [{ text: '가' }];
    expect(() => processHwp(buildHwp({ paras: p, header: { encrypted: true } }), 'a.hwp')).toThrow(/암호/);
    expect(() => processHwp(buildHwp({ paras: p, header: { distribution: true } }), 'a.hwp')).toThrow(/배포용/);
    expect(() => processHwp(buildHwp({ paras: p, viewText: true }), 'a.hwp')).toThrow(/배포용/);
    expect(() => processHwp(buildHwp({ paras: p, header: { version: 0x03000000 } }), 'a.hwp')).toThrow(/5\.0/);
  });

  it('손상: 서명이 없거나 본문 압축이 깨졌으면 OfficeParseError', () => {
    const noSig = writeCfb([
      { path: 'FileHeader', data: Buffer.alloc(256) },
      { path: 'DocInfo', data: Buffer.alloc(4) },
    ]);
    expect(() => processHwp(noSig, 'a.hwp')).toThrow(OfficeParseError);
    const good = buildHwp({ paras: [{ text: '가' }] });
    expect(() => processHwp(good.subarray(0, 600), 'a.hwp')).toThrow(OfficeParseError);
  });
});
