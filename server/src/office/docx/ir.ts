/**
 * docx 중간 표현(IR): XML 을 읽은 결과이자 쪽 나눔의 재료
 *
 * 1단계(build.ts)가 XML 을 IR 로 바꾸고, 2단계(paginate.ts)가 쪽 경계 표지(lrpb, pb)로 IR 을 쪽으로 나누고,
 * 3단계(emit.ts)가 쪽마다 모델 블록과 정본 글자, 오프셋을 만든다. IR 의 글자 조각(t)은 이미 정규화(units.ts
 * canon: normalizeText 포함)를 거친 값이라 3단계는 결합 글자로 시작하는 조각의 이음매만 다시 정규화하고 잇는다.
 */
import type { Border, FlowPara, FlowRun, ImageCrop } from '../model.js';
import type { PageField } from './fields.js';

/** 모델 글자 모양 (FlowRun 에서 글자와 오프셋을 뺀 것) */
export type RunOut = Omit<FlowRun, 't' | 'o'>;

/** 글자 조각 */
export interface IRText {
  k: 't';
  t: string;
  s: RunOut;
  /** 모양 비교 열쇠 (JSON.stringify(s)) */
  key: string;
  lbl?: true;
  /** 머리말/꼬리말 쪽 번호 자리표시 (t 는 무시하고 쪽마다 값으로 바꾼다) */
  pf?: PageField;
  /** 머리말/꼬리말의 위치 탭(w:ptab, t = '\t'): 뒤 글자의 정렬 (emit.ts HeaderPart 가 칸으로 나눠 그린다) */
  ptab?: 'center' | 'right';
}

/** 쪽 경계 표지: lrpb = w:lastRenderedPageBreak, pb = w:br type="page" */
export interface IRMark {
  k: 'lrpb' | 'pb';
}

/** 각주/미주 참조 위치 ('f:3', 'e:1'). 쪽 끝에 그 각주를 붙이는 데 쓴다 */
export interface IRNoteRef {
  k: 'note';
  key: string;
}

/** 그림. inline 이면 문단 그 자리에서, 떠 있는 그림(anchor)이면 문단 뒤에 블록으로 놓는다 */
export interface IRImage {
  k: 'img';
  media: number;
  w: number;
  h: number;
  inline: boolean;
  /** 본문 흐름에서 세로 자리를 차지하는가 (글자 안 그림, 위아래 배치 떠 있는 그림). 쪽 나눔 어림에만 쓴다 */
  flow: boolean;
  /** 그림 잘라 내기 (w, h 는 잘라 낸 뒤의 틀 크기) */
  crop?: ImageCrop;
}

/** 글상자: 기준 문단 뒤에 블록으로 놓는다 */
export interface IRBox {
  k: 'box';
  blocks: IRBlock[];
  w?: number;
  border: boolean;
}

export type IRItem = IRText | IRMark | IRNoteRef | IRImage | IRBox;

export type ParaOut = Omit<FlowPara, 'type' | 'runs'>;

export interface IRPara {
  k: 'p';
  props: ParaOut;
  items: IRItem[];
  /**
   * 화면 값 (emit.ts 가 모델 문단에 덮어 싣는다): 바로잡은 들여쓰기 px(0 = 없음)와 Word 식 줄 높이 px
   * (build.ts lineBox). props 의 들여쓰기, 줄 간격은 쪽 나눔 어림(estimate.ts)용 값이다: 어림이 그 값으로 맞춰져 있다
   */
  render?: { marginLeft: number; marginRight: number; indent: number; linePx?: number };
  /** 본문 최상위 블록의 구역 번호 (0-기준) */
  sect: number;
  /** 실제로 쓴 문단 스타일 (문맥 간격 비교) */
  styleId?: string;
  /** 쪽 나눔 앞(pageBreakBefore, 스타일을 거쳐 해석한 값) */
  pbb?: true;
  /** 이 문단이 구역을 끝낸다(pPr/sectPr) */
  sectEnd?: true;
  contextual?: true;
  keepNext?: true;
  /** 문단 테두리 묶음 열쇠와 묶음 사이 선(w:between) */
  bdrKey?: string;
  between?: Border;
  /** 쪽 경계로 잘린 뒷부분 */
  cont?: true;
  /** 문단 표지까지 숨긴 문단: 쪽 경계, 각주 표지만 남기고 그리지 않는다 */
  hidden?: true;
  /** 쪽 경계로 가른 조각의 원래 문단 (다시 이을 때 쓴다) */
  src?: IRPara;
}

export interface IRCell {
  blocks: IRBlock[];
  /** 0-기준 격자 열 시작 */
  col: number;
  span: number;
  vm?: 'restart' | 'continue';
  w?: number;
  bg?: string;
  bt?: Border;
  br?: Border;
  bb?: Border;
  bl?: Border;
  va?: 'middle' | 'bottom';
  pad?: [number, number, number, number];
  /** gridBefore/gridAfter 자리 채움 칸 (테두리 없음) */
  filler?: true;
}

export interface IRRow {
  cells: IRCell[];
  h?: number;
  hRule?: 'exact' | 'atLeast';
  header?: true;
  cantSplit?: true;
  /** 쪽 경계로 가른 행 조각의 원래 행 */
  src?: IRRow;
  /** 갈라진 표 조각 머리에 되풀이한 머리글 행 */
  copy?: true;
}

export interface IRTable {
  k: 'tbl';
  /** 쪽 경계로 가른 표 조각의 원래 표 */
  src?: IRTable;
  rows: IRRow[];
  colWidths?: number[];
  width?: number;
  align?: 'center' | 'right';
  indent?: number;
  sect: number;
}

export type IRBlock = IRPara | IRTable;

/** 구역 설정 (px) */
export interface SectInfo {
  w: number;
  h: number;
  /** [위, 오른쪽, 아래, 왼쪽] */
  margin: [number, number, number, number];
  headerDist: number;
  footerDist: number;
  /** 이 구역이 앞 구역과 어떻게 이어지는가 */
  type: string;
  titlePg: boolean;
  headers: { default?: string; first?: string; even?: string };
  footers: { default?: string; first?: string; even?: string };
  pgStart?: number;
  pgFmt?: string;
  /** 줄을 맞추는 문서 격자(docGrid type lines, linesAndChars, snapToChars): 격자 간격 px */
  grid?: { pitch: number };
}

export function isText(it: IRItem): it is IRText {
  return it.k === 't';
}

const VISIBLE_RE = /\S/;

/** 보이는 내용이 있는가: 빈칸이 아닌 글자, 그림, 내용 있는 글상자, 행이 있는 표 */
export function itemVisible(it: IRItem, includeLabels = true): boolean {
  if (it.k === 't') return (includeLabels || !it.lbl) && (it.pf !== undefined || VISIBLE_RE.test(it.t));
  if (it.k === 'img') return true;
  if (it.k === 'box') return it.blocks.some(blockVisible);
  return false;
}

export function blockVisible(b: IRBlock): boolean {
  if (b.k === 'p') return b.items.some((it) => itemVisible(it));
  return b.rows.length > 0;
}
