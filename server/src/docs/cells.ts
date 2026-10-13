/**
 * 표 칸 위치: 렌더 모델이 기록한 칸마다의 글자 범위로 재연결(reanchor.ts)의 칸 경계를 판정한다.
 *
 * - 시트(xlsx, xls, csv, tsv)는 셀, 흐름 문서(docx, hwpx, 구형 doc, hwp)와 슬라이드(pptx)는 표 칸.
 *   칸 안 글자 조각(TextPiece)의 o 는 그 쪽 page_text 안 오프셋이라 쪽 시작 오프셋을 더해 전문 오프셋으로 바꾼다.
 * - 칸의 시작과 끝은 칸 글자 앞뒤 공백을 뺀 자리다(화면이 인용 앞뒤 공백을 떼어 보내는 것과 같다).
 * - 표 밖 글자(문단, 글상자의 문단)는 칸이 아니다. 텍스트(txt, md)와 PDF 에는 칸이 없다.
 */
import type { FlowBlock, RenderModel } from '../office/model.js';

export interface CellIndex {
  /** 칸 시작(앞 공백을 뺀 첫 글자) 오프셋 */
  starts: Set<number>;
  /** 칸 끝(뒤 공백을 뺀 마지막 글자 다음) 오프셋 */
  ends: Set<number>;
  /** 칸 범위 [시작, 끝), 시작 오름차순. 중첩 표의 칸도 따로 든다 */
  ranges: Array<[number, number]>;
  /** 칸 시작과 끝 오프셋 전부(오름차순, 중복 없음): 인용 안쪽의 칸 경계를 찾는 데 쓴다 */
  bounds: number[];
}

/** 옛 인용이 칸과 어떻게 놓였는가 */
export interface QuoteCells {
  /** 앞 끝이 칸 시작에 닿았다 */
  start: boolean;
  /** 뒤 끝이 칸 끝에 닿았다 */
  end: boolean;
  /** 인용 전체가 칸 하나 안에 있다 */
  single: boolean;
  /**
   * 인용 안쪽의 칸 경계(칸 시작이나 끝) 자리. 인용 앞에서부터 센 내용 글자 수(공백, 탭, 줄바꿈, 제로폭 문자는 세지 않는다)라
   * 판본 형식이나 공백이 달라도 같은 자리면 같은 값이다. 칸 하나 안이거나 표 밖이면 빈 배열.
   */
  inner: number[];
}

const WS = /[\s​-‍﻿]/;

interface Piece {
  t?: unknown;
  o?: unknown;
}

/** 렌더 모델 → 칸 색인. pageStart 는 그 쪽의 전문 시작 오프셋(없는 쪽은 건너뛴다) */
export function buildCellIndex(
  model: RenderModel,
  full: string,
  pageStart: (pageNo: number) => number | undefined,
): CellIndex {
  const raw: Array<[number, number]> = [];
  const addCell = (base: number, pieces: Piece[]): void => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pieces) {
      if (typeof p.t !== 'string' || typeof p.o !== 'number' || p.t.length === 0) continue;
      lo = Math.min(lo, base + p.o);
      hi = Math.max(hi, base + p.o + p.t.length);
    }
    if (lo < hi) raw.push([lo, hi]);
  };
  /** 흐름 블록 안의 모든 글자 조각 (칸 안 문단, 중첩 표, 글상자) */
  const flowPieces = (blocks: FlowBlock[], out: Piece[]): Piece[] => {
    for (const b of blocks) {
      if (b.type === 'p') out.push(...b.runs);
      else if (b.type === 'table') for (const row of b.rows) for (const cell of row.cells) flowPieces(cell.blocks, out);
      else if (b.type === 'box') flowPieces(b.blocks, out);
    }
    return out;
  };
  const flowCells = (base: number, blocks: FlowBlock[]): void => {
    for (const b of blocks) {
      if (b.type === 'table') {
        for (const row of b.rows) {
          for (const cell of row.cells) {
            addCell(base, flowPieces(cell.blocks, []));
            flowCells(base, cell.blocks); // 칸 안의 표
          }
        }
      } else if (b.type === 'box') flowCells(base, b.blocks);
    }
  };

  if (model.kind === 'sheet') {
    for (const page of model.pages) {
      const base = pageStart(page.pageNo);
      if (base === undefined) continue;
      for (const row of page.rows) for (const cell of row.cells) addCell(base, [cell]);
    }
  } else if (model.kind === 'slides') {
    for (const page of model.pages) {
      const base = pageStart(page.pageNo);
      if (base === undefined) continue;
      for (const shape of page.shapes) {
        if (shape.type !== 'table') continue;
        for (const row of shape.rows) for (const cell of row.cells) addCell(base, cell.paras.flatMap((p) => p.runs));
      }
    }
  } else if (model.kind === 'flow') {
    for (const page of model.pages) {
      const base = pageStart(page.pageNo);
      if (base !== undefined) flowCells(base, page.blocks);
    }
  }

  const starts = new Set<number>();
  const ends = new Set<number>();
  const ranges: Array<[number, number]> = [];
  for (let [lo, hi] of raw) {
    while (lo < hi && WS.test(full.charAt(lo))) lo += 1;
    while (hi > lo && WS.test(full.charAt(hi - 1))) hi -= 1;
    if (lo >= hi) continue;
    starts.add(lo);
    ends.add(hi);
    ranges.push([lo, hi]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const bounds = [...new Set([...starts, ...ends])].sort((a, b) => a - b);
  return { starts, ends, ranges, bounds };
}

/** [s, e) 를 통째로 담는 칸이 있는가 (s 이하에서 시작하는 칸을 가까운 것부터 본다) */
export function inOneCell(idx: CellIndex, s: number, e: number): boolean {
  let lo = 0;
  let hi = idx.ranges.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx.ranges[mid]![0] <= s) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // 칸은 서로 겹치지 않거나 안에 들어 있다(표 안의 표): 가까운 몇 개만 보면 된다
  for (let i = last, n = 0; i >= 0 && n < 1000; i -= 1, n += 1) if (idx.ranges[i]![1] >= e) return true;
  return false;
}

/** [s, e) 가 어느 칸과든 겹치는가 */
export function touchesCell(idx: CellIndex, s: number, e: number): boolean {
  // s 이전에 시작해 s 를 넘는 칸, 또는 [s, e) 안에서 시작하는 칸
  let lo = 0;
  let hi = idx.ranges.length - 1;
  let first = idx.ranges.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx.ranges[mid]![0] >= s) {
      first = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (first < idx.ranges.length && idx.ranges[first]![0] < e) return true;
  return inOneCell(idx, s, s + 1) || inOneCell(idx, e - 1, e);
}

/** 옛 판본의 인용 [start, end) 가 칸과 어떻게 놓였는가 (앞뒤 공백은 떼고 본다) */
export function quoteCells(idx: CellIndex, full: string, start: number, end: number): QuoteCells {
  let s = start;
  let e = end;
  while (s < e && WS.test(full.charAt(s))) s += 1;
  while (e > s && WS.test(full.charAt(e - 1))) e -= 1;
  return { start: idx.starts.has(s), end: idx.ends.has(e), single: inOneCell(idx, s, e), inner: innerBounds(idx, full, s, e) };
}

/** [s, e) 안쪽(양 끝 제외)의 칸 경계 자리를 s 부터 센 내용 글자 수로 (QuoteCells.inner 와 같은 잣대) */
export function innerBounds(idx: CellIndex, full: string, s: number, e: number): number[] {
  const out: number[] = [];
  let lo = 0;
  let hi = idx.bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx.bounds[mid]! <= s) lo = mid + 1;
    else hi = mid;
  }
  let count = 0;
  let pos = s;
  for (let i = lo; i < idx.bounds.length && idx.bounds[i]! < e; i += 1) {
    const b = idx.bounds[i]!;
    for (; pos < b; pos += 1) if (!WS.test(full.charAt(pos))) count += 1;
    if (out[out.length - 1] !== count) out.push(count);
  }
  return out;
}
