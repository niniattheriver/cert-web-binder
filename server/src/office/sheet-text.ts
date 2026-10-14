/**
 * 시트(xlsx 한 장, csv 한 파일) → 정본 쪽 글자 + 셀별 오프셋
 *
 * 규칙 (xlsx·csv 공용이라 한 곳에 둔다)
 * - 한 행 = 한 줄. 줄 사이 구분자는 '\n'.
 * - 한 행 안에서는 **글자가 있는 셀만** 열 순서대로 '\t' 로 잇는다. 빈 셀은 글자에 들어가지 않는다.
 * - 글자가 있는 셀이 하나도 없는 행은 줄을 만들지 않는다(서식만 있는 행은 모델에만 남는다).
 * - 셀 글자는 normalizeText(NFC, 제로폭 제거, 줄끝 통일)를 거친 값이다.
 * - 각 셀의 `o` = 그 셀 글자가 쪽 글자에서 시작하는 위치. `text.slice(o, o + t.length) === t`.
 */
import { normalizeText } from '../pdf/normalize.js';
import { stripControls } from './controls.js';
import type { SheetCell, SheetRow } from './model.js';

export interface RawSheetCell {
  /** 1-기준 열 */
  c: number;
  /** 표시 글자 (정규화 전) */
  text: string;
  /** 스타일 색인 */
  s?: number;
}

export interface RawSheetRow {
  /** 1-기준 행 */
  r: number;
  /** px, 기본값과 다를 때만 */
  h?: number;
  cells: RawSheetCell[];
}

/** 행 목록(행 번호 오름차순, 셀은 열 오름차순) → 쪽 글자 + 모델 행 */
export function buildSheetText(rawRows: RawSheetRow[]): { text: string; rows: SheetRow[] } {
  const lines: string[] = [];
  const rows: SheetRow[] = [];
  let offset = 0; // 지금까지 만든 글자 길이 (다음 줄의 시작 = offset + 1 구분자)
  for (const raw of rawRows) {
    const cells: SheetCell[] = [];
    let line = '';
    let lineHasText = false;
    const lineStart = lines.length === 0 ? 0 : offset + 1;
    for (const cell of raw.cells) {
      const t = normalizeText(stripControls(cell.text));
      const out: SheetCell = { c: cell.c };
      if (cell.s !== undefined) out.s = cell.s;
      if (t.length > 0) {
        if (lineHasText) line += '\t';
        out.t = t;
        out.o = lineStart + line.length;
        line += t;
        lineHasText = true;
      }
      if (out.t !== undefined || out.s !== undefined) cells.push(out);
    }
    if (lineHasText) {
      lines.push(line);
      offset = lineStart + line.length;
    }
    if (cells.length > 0 || raw.h !== undefined) {
      const row: SheetRow = { r: raw.r, cells };
      if (raw.h !== undefined) row.h = raw.h;
      rows.push(row);
    }
  }
  return { text: lines.join('\n'), rows };
}

/** 열 글자(A, B, …, AA) */
export function columnLetter(c: number): string {
  let s = '';
  let n = c;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
