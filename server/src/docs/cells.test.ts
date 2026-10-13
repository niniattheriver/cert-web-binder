// 표 칸 색인: 실제 추출기(docx, xlsx)가 만든 렌더 모델과 손으로 만든 슬라이드 모델에서 칸 위치와 인용 관계를 본다
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { processDocx } from '../office/docx/index.js';
import { makeDocx, pt, sectPr, tbl, tc, tr } from '../office/docx/testkit.js';
import type { OfficeExtractResult, RenderModel, SlidesModel } from '../office/model.js';
import { processXlsx } from '../office/xlsx.js';
import { buildPageOffsets, fullTextOf } from '../pdf/offsets.js';
import { buildCellIndex, inOneCell, innerBounds, quoteCells, touchesCell, type CellIndex } from './cells.js';

function indexOf(r: OfficeExtractResult): { full: string; idx: CellIndex } {
  const entries = buildPageOffsets(r.pages.map((p) => ({ pageNo: p.pageNo, text: p.text })));
  const full = fullTextOf(entries);
  const starts = new Map(entries.map((e) => [e.pageNo, e.startOffset]));
  const model = JSON.parse(r.render.toString('utf8')) as RenderModel;
  return { full, idx: buildCellIndex(model, full, (n) => starts.get(n)) };
}
const slices = (full: string, idx: CellIndex): string[] => idx.ranges.map(([s, e]) => full.slice(s, e));

describe('buildCellIndex', () => {
  it('docx: 표 칸만 칸이고 표 밖 문단은 아니다', () => {
    const body =
      pt('검사 건수 관리') +
      tbl([tr([tc(pt('건수')), tc(pt('128450'))]), tr([tc(pt('비고')), tc(pt('정상'))])], [3000, 3000]) +
      pt('끝 문단') +
      sectPr();
    const { full, idx } = indexOf(processDocx(makeDocx({ body }), 't.docx'));
    expect(slices(full, idx)).toEqual(['건수', '128450', '비고', '정상']);
    expect(full).toContain('검사 건수 관리');
  });

  it('xlsx: 글자가 있는 셀마다 칸', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = '항목';
    ws.getCell('B1').value = 12;
    ws.getCell('A2').value = 'QC';
    const r = await processXlsx(Buffer.from(await wb.xlsx.writeBuffer()), 's.xlsx');
    const { full, idx } = indexOf(r);
    expect(slices(full, idx)).toEqual(['항목', '12', 'QC']);
  });

  it('pptx 모델: 표 칸의 문단 조각을 모아 칸 하나로', () => {
    const text = '제목\n가\t나\n다\t라1\n라2';
    const at = (t: string, from = 0) => ({ t, o: text.indexOf(t, from) });
    const model: SlidesModel = {
      v: 1 as SlidesModel['v'],
      kind: 'slides',
      slideW: 10,
      slideH: 10,
      pages: [
        {
          pageNo: 1,
          no: 1,
          shapes: [
            { type: 'text', x: 0, y: 0, w: 1, h: 1, paras: [{ runs: [at('제목')] }] },
            {
              type: 'table',
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              cols: [1, 1],
              rows: [
                { h: 1, cells: [{ paras: [{ runs: [at('가')] }] }, { paras: [{ runs: [at('나')] }] }] },
                { h: 1, cells: [{ paras: [{ runs: [at('다')] }] }, { paras: [{ runs: [at('라1')] }, { runs: [at('라2')] }] }] },
              ],
            },
          ],
        },
      ],
    } as SlidesModel;
    const idx = buildCellIndex(model, text, () => 0);
    expect(slices(text, idx)).toEqual(['가', '나', '다', '라1\n라2']);
  });
});

describe('quoteCells, inOneCell, touchesCell', () => {
  const body =
    tbl([tr([tc(pt('건수')), tc(pt('128450'))]), tr([tc(pt('비고')), tc(pt('정상 운영'))])], [3000, 3000]) + pt('표 밖 문장') + sectPr();
  const { full, idx } = indexOf(processDocx(makeDocx({ body }), 'q.docx'));
  const at = (q: string): [number, number] => [full.indexOf(q), full.indexOf(q) + q.length];

  it('칸 하나 전체, 칸 일부, 여러 칸, 표 밖', () => {
    expect(quoteCells(idx, full, ...at('128450'))).toEqual({ start: true, end: true, single: true, inner: [] });
    expect(quoteCells(idx, full, ...at('운영'))).toEqual({ start: false, end: true, single: true, inner: [] });
    expect(quoteCells(idx, full, ...at('건수\t128450'))).toEqual({ start: true, end: true, single: false, inner: [2] });
    expect(quoteCells(idx, full, ...at('표 밖'))).toEqual({ start: false, end: false, single: false, inner: [] });
  });

  it('innerBounds: 인용 안쪽 칸 경계를 공백을 뺀 글자 수로 센다(행을 걸친 인용 포함)', () => {
    // 건수 끝(2) = 128450 시작, 128450 끝(8) = 비고 시작, 비고 끝(10) = 정상 시작. 양 끝은 넣지 않는다
    expect(innerBounds(idx, full, ...at('건수\t128450\n비고\t정상'))).toEqual([2, 8, 10]);
    // 칸 중간에서 시작한 인용: 128450 끝(4)부터
    expect(innerBounds(idx, full, ...at('50\n비고'))).toEqual([2]);
    expect(innerBounds(idx, full, ...at('정상 운영'))).toEqual([]);
  });

  it('inOneCell 은 칸 하나에 담길 때만, touchesCell 은 칸과 겹치면', () => {
    expect(inOneCell(idx, ...at('정상 운영'))).toBe(true);
    expect(inOneCell(idx, ...at('128450\n비고'))).toBe(false);
    expect(touchesCell(idx, ...at('표 밖 문장'))).toBe(false);
    expect(touchesCell(idx, ...at('운영'))).toBe(true);
  });
});
