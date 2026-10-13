// 사본: server/src/office/model.ts 를 그대로 옮긴 파일이다. 서버 파일이 바뀌면 이 줄 아래 전체를 다시 복사해 둘을 같게 유지한다.
/**
 * 검사실 자료(PDF 외 형식) 렌더 모델 계약
 *
 * 서버가 업로드 때 원본(docx, xlsx, pptx, hwpx, txt, csv)을 한 번 해석해 이 JSON 을 만들고 판본에
 * 묶어 불변 저장한다. 화면은 이 JSON 만 그린다: 원본 바이트를 브라우저가 해석하지 않으므로 문서 안의
 * HTML/스크립트가 끼어들 여지가 없다(설계서 §4 첨부 미리보기 원칙 ①, §7 A-7 과 같은 취지).
 * docx 와 hwpx 는 FlowModel, xlsx 와 csv 는 SheetModel, pptx 는 SlidesModel, txt 와 md 는 PlainModel.
 *
 * 정합 원칙 (가장 중요)
 * - 같은 해석 결과에서 page_text(정본, 검색, 앵커 오프셋의 기준)와 이 모델을 함께 만든다.
 * - 글자를 가진 모든 조각(run/cell)은 `t`(글자)와 `o`(그 쪽 page_text 안의 시작 오프셋)를 갖는다.
 *   `pageText.slice(o, o + t.length) === t` 가 항상 성립해야 한다(테스트로 강제).
 *   → 화면 DOM 의 글자 위치를 정본 오프셋으로, 정본 오프셋을 DOM 위치로 퍼지 없이 바꾼다.
 * - pages[i].pageNo === i + 1 이고 page_text 의 page_no 와 1:1 이다.
 *
 * web/src/office/model.ts 가 이 파일의 사본이다. 바꾸면 둘을 함께 바꾼다(RENDER_MODEL_VERSION 증가).
 */

export const RENDER_MODEL_VERSION = 1 as const;

/** document_version.file_kind */
export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'hwpx' | 'text';

/**
 * 그림 잘라 내기: 원본 그림의 왼쪽, 위, 오른쪽, 아래 변에서 잘라 낸 비율. 모두 0 이상이고
 * l + r, t + b 는 1 보다 작다. 그림 틀(w, h)은 잘라 낸 뒤의 크기라서, 화면은 틀 안에서 원본을 가로 1 / (1 - l - r),
 * 세로 1 / (1 - t - b) 배로 키워 (l, t) 만큼 밀어 그린다. 이 필드가 없는 예전 모델은 원본 전체를 틀에 맞춰 그린다.
 */
export interface ImageCrop {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** 렌더 모델 이미지 참조: 화면은 /api/docs/versions/:vid/media/:index 로 받는다 */
export interface MediaRef {
  /** 원본 ZIP 안 경로 (서버 전용 정보) */
  path: string;
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/bmp' | 'image/webp';
}

/** 글자 조각: 모든 모델 공통 */
export interface TextPiece {
  /** 표시 글자 (정본 page_text 의 부분 문자열과 정확히 같다) */
  t: string;
  /** 그 쪽 page_text 안 시작 오프셋 */
  o: number;
}

interface ModelBase {
  v: typeof RENDER_MODEL_VERSION;
  media: MediaRef[];
  /** 상한에 걸려 일부만 색인, 표시한 경우의 안내 문구 (색인과 표시는 같은 범위) */
  truncated: string | null;
}

// ─────────────────────────────── xlsx, csv ───────────────────────────────

export interface Border {
  /** 선 굵기 px */
  w: 1 | 2 | 3;
  style: 'solid' | 'dashed' | 'dotted' | 'double';
  /** #rrggbb */
  color: string;
}

export interface CellStyle {
  b?: true;
  i?: true;
  u?: true;
  strike?: true;
  /** 글자 크기 pt */
  sz?: number;
  font?: string;
  /** 글자색 #rrggbb */
  color?: string;
  /** 채우기 #rrggbb */
  bg?: string;
  ha?: 'left' | 'center' | 'right' | 'justify';
  va?: 'top' | 'middle' | 'bottom';
  wrap?: true;
  /** 들여쓰기 단계 */
  indent?: number;
  bt?: Border;
  br?: Border;
  bb?: Border;
  bl?: Border;
  /** 숫자, 날짜 값(정렬 기본값 오른쪽) */
  num?: true;
}

export interface SheetCell extends Partial<TextPiece> {
  /** 1-기준 열 번호 */
  c: number;
  /** styles 배열 색인 */
  s?: number;
}

export interface SheetRow {
  /** 1-기준 행 번호 */
  r: number;
  /** 행 높이 px (기본값과 다를 때만) */
  h?: number;
  cells: SheetCell[];
}

export interface SheetPage {
  pageNo: number;
  /** 시트 이름 = page_text.label */
  name: string;
  /** 열 너비 px: 색인 0 = A 열, 길이 = maxCol. 숨김 열은 0 */
  colWidths: number[];
  defaultRowHeight: number;
  /** 행 번호 오름차순. 글자나 서식이 있는 행만 */
  rows: SheetRow[];
  /** 병합 [r1, c1, r2, c2] (1-기준, 포함) */
  merges: [number, number, number, number][];
  /** 틀 고정 */
  frozen?: { rows: number; cols: number };
  maxRow: number;
  maxCol: number;
  /** 이 시트가 상한에 걸려 잘렸는가 */
  truncated?: true;
}

export interface SheetModel extends ModelBase {
  kind: 'sheet';
  styles: CellStyle[];
  pages: SheetPage[];
}

// ─────────────────────────────── pptx ───────────────────────────────

export interface RunStyle {
  /** pt */
  sz?: number;
  b?: true;
  i?: true;
  u?: true;
  strike?: true;
  color?: string;
  font?: string;
}

export interface SlideRun extends TextPiece, RunStyle {}

export interface SlidePara {
  align?: 'l' | 'ctr' | 'r' | 'just';
  /** 목록 단계 0.. */
  lvl?: number;
  /** 글머리 기호(표시 전용: 정본 글자 아님) */
  bullet?: string;
  runs: SlideRun[];
}

/** 위치, 크기는 슬라이드 좌표 EMU */
interface SlideBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 회전 도 */
  rot?: number;
}

export interface SlideTextShape extends SlideBox {
  type: 'text';
  fill?: string;
  line?: string;
  anchor?: 't' | 'ctr' | 'b';
  /** 안쪽 여백 [l, t, r, b] EMU */
  inset?: [number, number, number, number];
  paras: SlidePara[];
}

export interface SlidePicShape extends SlideBox {
  type: 'pic';
  /** media 색인 */
  media: number;
  /** 그림 잘라 내기 (a:srcRect) */
  crop?: ImageCrop;
}

export interface SlideTableCell {
  paras: SlidePara[];
  gridSpan?: number;
  rowSpan?: number;
  /** 병합으로 가려진 칸 */
  hidden?: true;
  fill?: string;
}

export interface SlideTableShape extends SlideBox {
  type: 'table';
  /** 열 너비 EMU */
  cols: number[];
  rows: { h: number; cells: SlideTableCell[] }[];
}

/** 차트, SmartArt, OLE 등 그리지 않는 개체: 자리만 표시 */
export interface SlideOtherShape extends SlideBox {
  type: 'other';
  label: string;
}

export type SlideShape = SlideTextShape | SlidePicShape | SlideTableShape | SlideOtherShape;

export interface SlidePage {
  pageNo: number;
  /** 발표 순서 번호(1-기준): page_text.label = '슬라이드 N' */
  no: number;
  bg?: string;
  hidden?: true;
  shapes: SlideShape[];
}

export interface SlidesModel extends ModelBase {
  kind: 'slides';
  /** 슬라이드 크기 EMU */
  slideW: number;
  slideH: number;
  pages: SlidePage[];
}

// ─────────────────────────── docx, hwpx (흐름 문서) ───────────────────────────
// docx 와 hwpx 가 같은 모델을 쓴다. 아래 선택 필드는 docx 용으로 더한 것이고, 없으면 기본값으로 그린다.
// 길이 단위는 전부 px(96dpi). 머리말/꼬리말처럼 정본 글자에 들어가지 않는 표시 전용 글자는
// FlowDisplayRun(o 없음)으로만 담는다.

export interface FlowRun extends TextPiece, RunStyle {
  /** 위/아래 첨자 */
  sup?: true;
  sub?: true;
  /** 글자 바탕색(형광펜, 음영) #rrggbb */
  bg?: string;
  /** 문단 번호/글머리 기호 조각: 정본 글자에 들어가며, 화면은 내어쓰기 자리에 그린다 */
  lbl?: true;
}

/** 표시 전용 글자 조각(머리말, 꼬리말): 정본 글자에 없다 */
export interface FlowDisplayRun extends RunStyle {
  t: string;
  sup?: true;
  sub?: true;
  bg?: string;
  lbl?: true;
}

export interface FlowPara<R extends RunStyle & { t: string } = FlowRun> {
  type: 'p';
  align?: 'left' | 'center' | 'right' | 'justify';
  /** 첫 줄 들여쓰기 px (음수 = 내어쓰기) */
  indent?: number;
  /** 왼쪽 여백 px */
  marginLeft?: number;
  /** 오른쪽 여백 px */
  marginRight?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  /** 줄 간격 배수 (1 = 100%) */
  lineHeight?: number;
  /** 줄 간격 고정값 px (lineHeight 보다 우선, docx exact/atLeast) */
  linePx?: number;
  /** 문단 음영 #rrggbb */
  bg?: string;
  /** 문단 테두리 */
  bt?: Border;
  bb?: Border;
  bl?: Border;
  br?: Border;
  /** 기본 글자 모양(문단 안 조각이 비었을 때도 줄 높이를 맞추기 위함) */
  sz?: number;
  font?: string;
  runs: R[];
}

export interface FlowTableCell<R extends RunStyle & { t: string } = FlowRun> {
  blocks: FlowBlock<R>[];
  colSpan?: number;
  rowSpan?: number;
  /** px */
  w?: number;
  bg?: string;
  /** 테두리 표시 여부(대부분 true). 칸별 테두리(bt..bl)가 있으면 그쪽이 우선 */
  border?: boolean;
  bt?: Border;
  br?: Border;
  bb?: Border;
  bl?: Border;
  va?: 'top' | 'middle' | 'bottom';
  /** 안쪽 여백 [위, 오른쪽, 아래, 왼쪽] px */
  pad?: [number, number, number, number];
}

export interface FlowTableRow<R extends RunStyle & { t: string } = FlowRun> {
  cells: FlowTableCell<R>[];
  /** 행 높이 px 와 규칙 */
  h?: number;
  hRule?: 'exact' | 'atLeast';
  /** 쪽마다 반복되는 머리글 행 */
  header?: true;
}

export interface FlowTable<R extends RunStyle & { t: string } = FlowRun> {
  type: 'table';
  rows: FlowTableRow<R>[];
  /** 열 너비 px (docx tblGrid) */
  colWidths?: number[];
  /** 표 너비 px */
  width?: number;
  align?: 'left' | 'center' | 'right';
  /** 왼쪽 들여쓰기 px */
  indent?: number;
}

export interface FlowImage {
  type: 'img';
  media: number;
  /** px */
  w: number;
  h: number;
  /** 가로 정렬 (그림을 담은 문단의 정렬, 또는 떠 있는 그림의 가로 위치). 없으면 왼쪽 */
  align?: 'left' | 'center' | 'right';
  /** 그림 잘라 내기 (docx a:srcRect, VML crop 값) */
  crop?: ImageCrop;
}

/** 글상자: 안쪽 블록을 테두리 상자로 그린다(글자는 정본에 들어간다) */
export interface FlowBox<R extends RunStyle & { t: string } = FlowRun> {
  type: 'box';
  blocks: FlowBlock<R>[];
  w?: number;
  border?: boolean;
}

export type FlowBlock<R extends RunStyle & { t: string } = FlowRun> =
  | FlowPara<R>
  | FlowTable<R>
  | FlowImage
  | FlowBox<R>;

export interface FlowPage {
  pageNo: number;
  /** 쪽 크기, 여백 px (96dpi). margin = [위, 오른쪽, 아래, 왼쪽] */
  w: number;
  h: number;
  margin: [number, number, number, number];
  blocks: FlowBlock[];
  /** 머리말, 꼬리말 (표시 전용) */
  header?: FlowBlock<FlowDisplayRun>[];
  footer?: FlowBlock<FlowDisplayRun>[];
  /** 종이 위끝에서 머리말까지, 아래끝에서 꼬리말까지 px */
  headerDist?: number;
  footerDist?: number;
}

export interface FlowModel extends ModelBase {
  kind: 'flow';
  /** 기본 탭 간격 px (docx settings defaultTabStop). 없으면 화면 기본값 48px */
  defaultTab?: number;
  /**
   * 배수 줄 간격(FlowPara.lineHeight)을 CSS line-height 로 바꿀 때 곱하는 값. 없으면 1.15(Word 의 '한 줄'이
   * 글자 크기보다 높은 것을 어림). 한글(hwpx)의 % 줄 간격은 글자 크기 기준이라 1 이다.
   */
  lineScale?: number;
  pages: FlowPage[];
}

// ─────────────────────────────── txt ───────────────────────────────

export interface PlainPage {
  pageNo: number;
  /** 그 쪽 page_text 전체 (o = 0) */
  t: string;
}

export interface PlainModel extends ModelBase {
  kind: 'plain';
  pages: PlainPage[];
}

export type RenderModel = SheetModel | SlidesModel | FlowModel | PlainModel;

/** 형식별 해석 결과: 서비스가 page_text 와 렌더 산출물을 한 번에 저장한다 */
export interface OfficeExtractResult {
  fileKind: Exclude<FileKind, 'pdf'>;
  /** 추출기 라벨(document_version.extractor): 규칙이 바뀌면 올린다 */
  extractor: string;
  /** 논리 쪽 (1-기준 연속). text 는 normalizeText 를 거친 정본 */
  pages: { pageNo: number; text: string; label: string | null }[];
  /** 렌더 산출물 바이트 (모든 형식 JSON UTF-8 = RenderModel) */
  render: Buffer;
  renderMime: string;
  /** 상한에 걸린 경우 업로드 응답에 실을 안내 */
  truncated: string | null;
}
