/**
 * 구형 한글(hwp: 한글 문서 파일 형식 5.0, 바이너리) → 정본 쪽 글자 + 흐름(flow) 렌더 모델
 *
 * 레코드를 hwpx(OWPML)와 같은 꼴의 XML 트리로 옮긴 뒤 hwpx 추출기의 renderOwpml 을 그대로 쓴다. 서식, 표, 쪽,
 * 정본 글자 규칙이 hwpx 와 하나라서, 같은 문서를 hwp 와 hwpx 로 저장해 올리면 결과가 같다(시험으로 확인).
 *
 * 읽는 것 (한글과컴퓨터 '한글 문서 파일 형식 5.0' 공개 문서)
 * - FileHeader: 서명, 판, 속성(압축 0x01, 암호 0x02, 배포용 0x04, DRM 0x10). 암호, 배포용, DRM 문서는 거부한다
 *   (배포용 문서는 복사를 막으려고 본문을 암호화한 문서라 풀지 않는다).
 * - DocInfo(압축이면 raw deflate): ID_MAPPINGS(언어별 글꼴 수), FACE_NAME, BORDER_FILL, CHAR_SHAPE, PARA_SHAPE,
 *   BIN_DATA. hwpx 의 hh:head 서식표(글꼴, 테두리/배경, 글자 모양, 문단 모양)로 옮긴다.
 * - BodyText/SectionN: 레코드(태그 10비트, 수준 10비트, 크기 12비트, 0xFFF 면 다음 4바이트) 를 수준으로 나무를 만든다.
 *   PARA_HEADER(문단 모양, 쪽 나눔) → hp:p, PARA_TEXT + PARA_CHAR_SHAPE → hp:run(글자 모양) / hp:t(글자, 탭, 줄 바꿈),
 *   확장 조판 부호 → CTRL_HEADER 차례대로: 구역 정의(secd + PAGE_DEF → hp:secPr/hp:pagePr), 머리말/꼬리말,
 *   표(tbl + TABLE + 칸 LIST_HEADER → hp:tbl/hp:tr/hp:tc), 그리기 개체(gso: 그림, 묶음, 글상자), 덧말, 글자 겹치기.
 *   각주, 미주, 숨은 설명, 필드 부호, 쪽 번호, 수식, OLE 는 hwpx 추출기처럼 싣지 않는다.
 * - 값의 단위: hwp 문단 여백, 고정 줄 간격은 hwpx 의 hp:default(옛 값)처럼 2배로 적혀 있다. 그래서 스위치 없는
 *   직접 자식으로 옮기면 hwpx 추출기가 반으로 읽는다(% 줄 간격은 그대로). 용지 방향 0 은 hwpx 의 WIDELY 다.
 *
 * 그림: BIN_DATA(포함 그림) → 'BinData/BIN0001.png' 경로로 media 에 싣고, 바이트는 hwpbin.ts 의 readHwpBinData 가
 * 꺼낸다.
 *
 * 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
 * (한컴 HWP·OWPML 문서 형식 공개 페이지의 이용 조건: 제품 화면, 설명서, 도움말, 소스 코드에 이 문구를 둔다)
 */
import zlib from 'node:zlib';
import { OfficeParseError } from '../errors.js';
import { imageMimeOf, renderOwpml } from '../hwpx.js';
import type { MediaRef, OfficeExtractResult } from '../model.js';
import { escapeXmlText, type XElement, type XNode } from '../xml.js';
import { Cfb } from './cfb.js';

export const HWP_EXTRACTOR = 'hwp-v1';

const ERR_CORRUPT = '한글(hwp) 파일을 읽을 수 없습니다. 파일이 손상되었을 수 있습니다. 한글에서 다시 저장해 올려 주세요.';
const ERR_ENCRYPTED = '암호(열람 제한)가 걸린 한글(hwp) 파일입니다. 암호를 해제해 저장한 뒤 다시 올려 주세요.';
const ERR_DISTRIBUTION =
  '배포용 문서로 저장된 한글(hwp) 파일은 읽을 수 없습니다. 배포용이 아닌 원본을 올리거나 PDF로 저장해 올려 주세요.';
const ERR_DRM = '문서 보안(DRM)이 걸린 한글(hwp) 파일은 읽을 수 없습니다. 보안을 해제한 파일을 올려 주세요.';
const ERR_OLD = '한글 2002 보다 오래된 형식(hwp 5.0 보다 앞선 판)의 hwp는 읽을 수 없습니다. 한글에서 hwpx 또는 hwp로 다시 저장해 올려 주세요.';
const ERR_TOO_BIG = '한글(hwp) 문서가 너무 커서 미리보기를 만들지 못했습니다. 문서를 나눠 올려 주세요.';

/** 압축 푼 스트림 하나, 합계 상한 */
const MAX_STREAM = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
/** 서식표 목록마다 상한 (hwpx 의 MAX_STYLE_ITEMS 와 같다) */
const MAX_STYLE_ITEMS = 65_536;
/** 레코드 나무 깊이 상한 (표 안 표, 글상자 안 표 …) */
const MAX_REC_DEPTH = 64;

const TAG = {
  ID_MAPPINGS: 17,
  BIN_DATA: 18,
  FACE_NAME: 19,
  BORDER_FILL: 20,
  CHAR_SHAPE: 21,
  PARA_SHAPE: 25,
  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  PAGE_DEF: 73,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  SHAPE_LINE: 78,
  SHAPE_RECT: 79,
  SHAPE_ELLIPSE: 80,
  SHAPE_ARC: 81,
  SHAPE_POLYGON: 82,
  SHAPE_CURVE: 83,
  SHAPE_PICTURE: 85,
  SHAPE_CONTAINER: 86,
} as const;

/** 조판 부호: 글자 하나짜리(char), 8글자짜리 인라인(inline), 8글자짜리 확장(extended, CTRL_HEADER 와 짝) */
const CHAR_CTRL = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
const INLINE_CTRL = new Set([4, 5, 6, 7, 8, 9, 19, 20]);
const EXT_CTRL = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);

const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
/** 테두리 선 종류 (0 = 없음) → hwpx 이름 */
const LINE_TYPES = [
  'NONE', 'SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK',
  'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLE_WAVE', 'THICK_3D', 'THICK_3D_REVERSE_LIGHTING', '3D',
  '3D_REVERSE_LIGHTING',
];
/** 테두리 굵기 번호 → mm */
const LINE_WIDTHS = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
const ALIGNS = ['JUSTIFY', 'LEFT', 'RIGHT', 'CENTER', 'DISTRIBUTE', 'DISTRIBUTE_SPACE'];
const LINE_SPACING = ['PERCENT', 'FIXED', 'BETWEEN_LINES', 'AT_LEAST'];
const VERT_REL = ['PAPER', 'PAGE', 'PARA'];
const VERT_ALIGN = ['TOP', 'CENTER', 'BOTTOM', 'INSIDE', 'OUTSIDE'];
const HORZ_REL = ['PAPER', 'PAGE', 'COLUMN', 'PARA'];
const HORZ_ALIGN = ['LEFT', 'CENTER', 'RIGHT', 'INSIDE', 'OUTSIDE'];
const WIDTH_REL = ['PAPER', 'PAGE', 'COLUMN', 'PARA', 'ABSOLUTE'];
const HEIGHT_REL = ['PAPER', 'PAGE', 'ABSOLUTE'];
const CELL_VALIGN = ['TOP', 'CENTER', 'BOTTOM'];
const CAPTION_SIDE = ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'];
const GUTTER = ['LEFT_ONLY', 'LEFT_RIGHT', 'TOP_BOTTOM'];

/** 4글자 조판 부호 id (예: 'tbl ' → 바이트 순서대로 읽은 DWORD) */
function ctrlId(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}
const CTRL = {
  secd: ctrlId('secd'),
  head: ctrlId('head'),
  foot: ctrlId('foot'),
  tbl: ctrlId('tbl '),
  gso: ctrlId('gso '),
  tdut: ctrlId('tdut'),
  tcps: ctrlId('tcps'),
};

// ─────────────────────────────── 레코드 ───────────────────────────────

interface Rec {
  tag: number;
  level: number;
  body: Buffer;
  children: Rec[];
}

/** 스트림 → 레코드 나무 (수준이 하나 깊은 레코드는 바로 앞 레코드의 자식). 잘린 레코드에서 멈춘다 */
function recordTree(b: Buffer): Rec[] {
  const root: Rec[] = [];
  const stack: Rec[] = [];
  let p = 0;
  while (p + 4 <= b.length) {
    const h = b.readUInt32LE(p);
    p += 4;
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = h >>> 20;
    if (size === 0xfff) {
      if (p + 4 > b.length) break;
      size = b.readUInt32LE(p);
      p += 4;
    }
    if (p + size > b.length) break;
    const rec: Rec = { tag, level, body: b.subarray(p, p + size), children: [] };
    p += size;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent && level === parent.level + 1 && stack.length < MAX_REC_DEPTH) parent.children.push(rec);
    else if (!parent) root.push(rec);
    else continue; // 수준이 건너뛴 레코드(손상)는 버린다
    stack.push(rec);
  }
  return root;
}

const u8 = (b: Buffer, o: number): number => (o < b.length ? b[o]! : 0);
const u16 = (b: Buffer, o: number): number => (o + 2 <= b.length ? b.readUInt16LE(o) : 0);
const u32 = (b: Buffer, o: number): number => (o + 4 <= b.length ? b.readUInt32LE(o) : 0);
const i32 = (b: Buffer, o: number): number => (o + 4 <= b.length ? b.readInt32LE(o) : 0);

/** COLORREF(0x00BBGGRR) → '#rrggbb' */
function color(v: number): string {
  const r = v & 0xff;
  const g = (v >>> 8) & 0xff;
  const bl = (v >>> 16) & 0xff;
  return `#${[r, g, bl].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** WORD 길이 + UTF-16 글자. [글자, 다음 위치] */
function wstr(b: Buffer, o: number): [string, number] {
  const n = u16(b, o);
  const end = Math.min(b.length, o + 2 + n * 2);
  return [b.toString('utf16le', o + 2, end - ((end - o - 2) % 2)), o + 2 + n * 2];
}

// ─────────────────────────────── XML 트리 만들기 ───────────────────────────────

class TreeBuilder {
  count = 0;
  constructor(private readonly limit: number) {}

  /** 요소 하나. 속성은 해석 캐시(_attrs)에 바로 넣는다 (hwpx 추출기의 attr() 가 그대로 읽는다) */
  el(name: string, attrs: Record<string, string | number> = {}, children: XNode[] = []): XElement {
    this.count += 1;
    if (this.count > this.limit) throw new TooBig();
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(attrs)) m.set(k, String(v));
    return { type: 'el', name, rawAttrs: '', children, selfClosing: children.length === 0, _attrs: m };
  }
}

/** 구역 트리가 상한(요소 수)을 넘었다 */
class TooBig extends Error {}

// ─────────────────────────────── 서식표 (DocInfo → hh:head) ───────────────────────────────

interface BinItem {
  path: string;
}

interface DocInfo {
  head: XElement;
  bins: (BinItem | undefined)[];
}

function readDocInfo(recs: Rec[], tb: TreeBuilder): DocInfo {
  // DocInfo 레코드는 수준 0(ID_MAPPINGS 등) 아래 수준 1 로 이어진다: 평평하게 훑는다
  const flat: Rec[] = [];
  const walk = (list: Rec[]): void => {
    for (const r of list) {
      flat.push(r);
      walk(r.children);
    }
  };
  walk(recs);
  const idm = flat.find((r) => r.tag === TAG.ID_MAPPINGS);
  const fontCounts = LANGS.map((_, k) => (idm ? Math.max(0, i32(idm.body, 4 + k * 4)) : 0));

  // 글꼴: 언어 순서대로 이어진 FACE_NAME
  const faces: string[] = [];
  const borderFills: Rec[] = [];
  const charShapes: Rec[] = [];
  const paraShapes: Rec[] = [];
  const bins: (BinItem | undefined)[] = [];
  for (const r of flat) {
    if (r.tag === TAG.FACE_NAME && faces.length < MAX_STYLE_ITEMS) faces.push(wstr(r.body, 1)[0]);
    else if (r.tag === TAG.BORDER_FILL && borderFills.length < MAX_STYLE_ITEMS) borderFills.push(r);
    else if (r.tag === TAG.CHAR_SHAPE && charShapes.length < MAX_STYLE_ITEMS) charShapes.push(r);
    else if (r.tag === TAG.PARA_SHAPE && paraShapes.length < MAX_STYLE_ITEMS) paraShapes.push(r);
    else if (r.tag === TAG.BIN_DATA && bins.length < MAX_STYLE_ITEMS) bins.push(readBinItem(r.body));
  }

  const fontfaces = tb.el('hh:fontfaces');
  let fi = 0;
  LANGS.forEach((lang, k) => {
    const ff = tb.el('hh:fontface', { lang });
    for (let id = 0; id < fontCounts[k]! && fi < faces.length; id += 1, fi += 1) {
      ff.children.push(tb.el('hh:font', { id, face: faces[fi]! }));
    }
    fontfaces.children.push(ff);
  });

  const fills = tb.el('hh:borderFills');
  borderFills.forEach((r, i) => fills.children.push(borderFill(r.body, i + 1, tb)));
  const chars = tb.el('hh:charProperties');
  charShapes.forEach((r, i) => chars.children.push(charPr(r.body, i, tb)));
  const paras = tb.el('hh:paraProperties');
  paraShapes.forEach((r, i) => paras.children.push(paraPr(r.body, i, tb)));

  const refList = tb.el('hh:refList', {}, [fontfaces, fills, chars, paras]);
  return { head: tb.el('hh:head', {}, [refList]), bins };
}

/** BIN_DATA: 속성(종류 0 연결, 1 포함, 2 저장소), 포함이면 BinData id + 확장자 */
function readBinItem(b: Buffer): BinItem | undefined {
  const attr = u16(b, 0);
  const type = attr & 0x0f;
  if (type !== 1) return undefined; // 연결 그림, OLE 저장소는 싣지 않는다
  const id = u16(b, 2);
  const [ext] = wstr(b, 4);
  if (!/^[A-Za-z0-9]{1,5}$/.test(ext)) return undefined;
  return { path: `BinData/BIN${id.toString(16).toUpperCase().padStart(4, '0')}.${ext.toLowerCase()}` };
}

/** BORDER_FILL: 속성(2), 왼쪽/오른쪽/위/아래/대각선 [종류 1, 굵기 1, 색 4], 채우기 종류(4, 0x01 = 단색) + 바탕색 */
function borderFill(b: Buffer, id: number, tb: TreeBuilder): XElement {
  const out = tb.el('hh:borderFill', { id });
  const sides = ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder'];
  sides.forEach((name, k) => {
    const o = 2 + k * 6;
    out.children.push(
      tb.el(`hh:${name}`, {
        type: LINE_TYPES[u8(b, o)] ?? 'SOLID',
        width: `${LINE_WIDTHS[u8(b, o + 1)] ?? 0.12} mm`,
        color: color(u32(b, o + 2)),
      }),
    );
  });
  const fillType = u32(b, 32);
  if (fillType & 0x01 && b.length >= 40) {
    const face = u32(b, 36);
    out.children.push(
      tb.el('hc:fillBrush', {}, [tb.el('hc:winBrush', { faceColor: face === 0xffffffff ? 'none' : color(face) })]),
    );
  }
  return out;
}

/** CHAR_SHAPE: 언어별 글꼴 id[7], 장평, 자간, 상대 크기[7], 위치, 기준 크기, 속성, 그림자 간격, 글자/밑줄/음영 색 */
function charPr(b: Buffer, id: number, tb: TreeBuilder): XElement {
  const attr = u32(b, 46);
  const shade = u32(b, 60);
  const out = tb.el('hh:charPr', {
    id,
    height: i32(b, 42),
    textColor: color(u32(b, 52)),
    shadeColor: shade === 0xffffffff ? 'none' : color(shade),
  });
  out.children.push(tb.el('hh:fontRef', { hangul: u16(b, 0), latin: u16(b, 2) }));
  out.children.push(tb.el('hh:relSz', { hangul: u8(b, 28) }));
  if (attr & 0x01) out.children.push(tb.el('hh:italic'));
  if (attr & 0x02) out.children.push(tb.el('hh:bold'));
  // 밑줄 위치(비트 2-3): 1 아래, 3 위. 2 는 가운데 선 = 취소선으로 쓰인다(시험 파일: 취소선 글자가 2 + 취소선 비트)
  const ul = (attr >>> 2) & 0x03;
  out.children.push(tb.el('hh:underline', { type: ul === 1 ? 'BOTTOM' : ul === 3 ? 'TOP' : 'NONE' }));
  const strike = ((attr >>> 18) & 0x07) !== 0 || ul === 2;
  out.children.push(tb.el('hh:strikeout', { shape: strike ? 'SOLID' : 'NONE' }));
  if (attr & 0x8000) out.children.push(tb.el('hh:supscript'));
  else if (attr & 0x10000) out.children.push(tb.el('hh:subscript'));
  return out;
}

/**
 * PARA_SHAPE: 속성1(줄 간격 종류 비트 0-1, 정렬 비트 2-4), 왼쪽/오른쪽 여백, 들여쓰기, 위/아래 간격, (옛) 줄 간격,
 * 탭, 번호, 테두리/배경 id, 테두리 간격[4], 속성2, 속성3(줄 간격 종류 비트 0-4, 5.0.2.5 이후), 줄 간격.
 * 여백, 간격, 고정 줄 간격은 2배 값이라 스위치 없는 직접 자식으로 둔다(hwpx 추출기가 반으로 읽는다).
 */
function paraPr(b: Buffer, id: number, tb: TreeBuilder): XElement {
  const attr1 = u32(b, 0);
  const out = tb.el('hh:paraPr', { id });
  out.children.push(tb.el('hh:align', { horizontal: ALIGNS[(attr1 >>> 2) & 0x07] ?? 'JUSTIFY' }));
  const unit = { unit: 'HWPUNIT' };
  out.children.push(
    tb.el('hh:margin', {}, [
      tb.el('hc:intent', { value: i32(b, 12), ...unit }),
      tb.el('hc:left', { value: i32(b, 4), ...unit }),
      tb.el('hc:right', { value: i32(b, 8), ...unit }),
      tb.el('hc:prev', { value: i32(b, 16), ...unit }),
      tb.el('hc:next', { value: i32(b, 20), ...unit }),
    ]),
  );
  const modern = b.length >= 54;
  const lsType = LINE_SPACING[modern ? u32(b, 46) & 0x1f : attr1 & 0x03] ?? 'PERCENT';
  const lsValue = modern ? i32(b, 50) : i32(b, 24);
  out.children.push(tb.el('hh:lineSpacing', { type: lsType, value: lsValue, ...unit }));
  const bf = u16(b, 32);
  if (bf > 0) out.children.push(tb.el('hh:border', { borderFillIDRef: bf }));
  return out;
}

// ─────────────────────────────── 본문 (BodyText → hs:sec) ───────────────────────────────

/** 개체 공통 속성(CTRL_HEADER 의 id 뒤): 속성, 세로/가로 오프셋, 너비, 높이 → hp:sz, hp:pos */
function objectCommon(b: Buffer, tb: TreeBuilder): XElement[] {
  const attr = u32(b, 4);
  return [
    tb.el('hp:sz', {
      width: u32(b, 16),
      widthRelTo: WIDTH_REL[(attr >>> 15) & 0x07] ?? 'ABSOLUTE',
      height: u32(b, 20),
      heightRelTo: HEIGHT_REL[(attr >>> 18) & 0x03] ?? 'ABSOLUTE',
    }),
    tb.el('hp:pos', {
      treatAsChar: attr & 0x01 ? 1 : 0,
      vertRelTo: VERT_REL[(attr >>> 3) & 0x03] ?? 'PARA',
      horzRelTo: HORZ_REL[(attr >>> 8) & 0x03] ?? 'PARA',
      vertAlign: VERT_ALIGN[(attr >>> 5) & 0x07] ?? 'TOP',
      horzAlign: HORZ_ALIGN[(attr >>> 10) & 0x07] ?? 'LEFT',
    }),
  ];
}

class SectionBuilder {
  constructor(private readonly tb: TreeBuilder) {}

  /** 문단 목록 (PARA_HEADER 들만) */
  paras(recs: Rec[], depth: number): XElement[] {
    const out: XElement[] = [];
    for (const r of recs) if (r.tag === TAG.PARA_HEADER) out.push(this.para(r, depth));
    return out;
  }

  subList(recs: Rec[], depth: number, attrs: Record<string, string | number> = {}): XElement {
    return this.tb.el('hp:subList', attrs, this.paras(recs, depth));
  }

  para(rec: Rec, depth: number): XElement {
    const tb = this.tb;
    const h = rec.body;
    const brk = u8(h, 11);
    const p = tb.el('hp:p', {
      paraPrIDRef: u16(h, 8),
      styleIDRef: u8(h, 10),
      pageBreak: brk & 0x04 ? 1 : 0,
      columnBreak: brk & 0x08 ? 1 : 0,
    });
    let text: Buffer | undefined;
    let shapes: Buffer | undefined;
    const ctrls: Rec[] = [];
    for (const c of rec.children) {
      if (c.tag === TAG.PARA_TEXT) text ??= c.body;
      else if (c.tag === TAG.PARA_CHAR_SHAPE) shapes ??= c.body;
      else if (c.tag === TAG.CTRL_HEADER) ctrls.push(c);
    }
    // 글자 모양 바뀌는 자리: (위치, 글자 모양 id) 쌍
    const marks: [number, number][] = [];
    if (shapes) for (let o = 0; o + 8 <= shapes.length; o += 8) marks.push([shapes.readUInt32LE(o), shapes.readUInt32LE(o + 4)]);
    if (marks.length === 0) marks.push([0, 0]);

    let mi = 0;
    let run: XElement | null = null;
    let runShape = -1;
    let t: XElement | null = null;
    let buf: string[] = [];
    const flushText = (): void => {
      if (buf.length === 0) return;
      if (!t) {
        t = tb.el('hp:t');
        run!.children.push(t);
      }
      t.children.push({ type: 'text', raw: escapeXmlText(buf.join('')) });
      t.selfClosing = false;
      buf = [];
    };
    const inline = (name: string): void => {
      flushText();
      if (!t) {
        t = tb.el('hp:t');
        run!.children.push(t);
      }
      t.children.push(tb.el(`hp:${name}`));
      t.selfClosing = false;
    };
    const ensureRun = (pos: number): void => {
      while (mi + 1 < marks.length && marks[mi + 1]![0] <= pos) mi += 1;
      const sid = marks[mi]![1];
      if (run && sid === runShape) return;
      flushText();
      run = tb.el('hp:run', { charPrIDRef: sid });
      runShape = sid;
      t = null;
      p.children.push(run);
    };

    let ci = 0;
    if (text) {
      const n = Math.floor(text.length / 2);
      for (let i = 0; i < n; ) {
        const c = text.readUInt16LE(i * 2);
        if (c >= 32) {
          ensureRun(i);
          buf.push(String.fromCharCode(c));
          i += 1;
          continue;
        }
        if (c === 13) break; // 문단 끝
        if (CHAR_CTRL.has(c)) {
          ensureRun(i);
          if (c === 10) inline('lineBreak');
          else if (c === 24) inline('hyphen');
          else if (c === 30) inline('nbSpace');
          else if (c === 31) inline('fwSpace');
          i += 1;
          continue;
        }
        if (INLINE_CTRL.has(c)) {
          ensureRun(i);
          if (c === 9) inline('tab');
          i += 8;
          continue;
        }
        if (EXT_CTRL.has(c)) {
          ensureRun(i);
          // 확장 부호 안의 id(글자 1-2)와 같은 CTRL_HEADER 를 차례대로 찾는다
          const want = i + 2 < n ? ((text.readUInt16LE((i + 2) * 2) << 16) | text.readUInt16LE((i + 1) * 2)) >>> 0 : -1;
          let k = ci;
          while (k < ctrls.length && u32(ctrls[k]!.body, 0) !== want) k += 1;
          const ctrl = k < ctrls.length ? ctrls[k] : undefined;
          if (ctrl) {
            ci = k + 1;
            const objs = this.control(ctrl, depth);
            if (objs.length > 0) {
              flushText();
              t = null;
              for (const o of objs) run!.children.push(o);
            }
          }
          i += 8;
          continue;
        }
        i += 1;
      }
    }
    flushText();
    if (!run) p.children.push(tb.el('hp:run', { charPrIDRef: marks[0]![1] }));
    return p;
  }

  /** 확장 조판 부호 하나 → run 안에 둘 요소들 */
  control(rec: Rec, depth: number): XElement[] {
    if (depth > MAX_REC_DEPTH) return [];
    const id = u32(rec.body, 0);
    const tb = this.tb;
    switch (id) {
      case CTRL.secd: {
        const pd = rec.children.find((c) => c.tag === TAG.PAGE_DEF);
        if (!pd) return [];
        const b = pd.body;
        const attr = u32(b, 36);
        const pagePr = tb.el(
          'hp:pagePr',
          {
            landscape: attr & 0x01 ? 'NARROWLY' : 'WIDELY',
            width: u32(b, 0),
            height: u32(b, 4),
            gutterType: GUTTER[(attr >>> 1) & 0x03] ?? 'LEFT_ONLY',
          },
          [
            tb.el('hp:margin', {
              header: u32(b, 24),
              footer: u32(b, 28),
              gutter: u32(b, 32),
              left: u32(b, 8),
              right: u32(b, 12),
              top: u32(b, 16),
              bottom: u32(b, 20),
            }),
          ],
        );
        return [tb.el('hp:secPr', {}, [pagePr])];
      }
      case CTRL.head:
      case CTRL.foot: {
        const range = u32(rec.body, 4) & 0x03;
        const kind = id === CTRL.head ? 'hp:header' : 'hp:footer';
        const hf = tb.el(kind, { applyPageType: range === 1 ? 'EVEN' : range === 2 ? 'ODD' : 'BOTH' }, [
          this.subList(rec.children, depth + 1),
        ]);
        return [tb.el('hp:ctrl', {}, [hf])];
      }
      case CTRL.tbl:
        return this.table(rec, depth);
      case CTRL.gso:
        return this.gso(rec, depth);
      case CTRL.tdut: {
        // 덧말: 본말, 덧말 글자 (hwpx 추출기는 본말만 쓴다)
        const [main] = wstr(rec.body, 4);
        return [tb.el('hp:dutmal', {}, [tb.el('hp:mainText', {}, [{ type: 'text', raw: escapeXmlText(main) }])])];
      }
      case CTRL.tcps: {
        // 글자 겹치기: 겹칠 글자
        const [s] = wstr(rec.body, 4);
        return [tb.el('hp:compose', { composeText: s })];
      }
      default:
        return []; // 각주, 미주, 필드, 쪽 번호, 숨은 설명, 수식 등 (hwpx 추출기도 싣지 않는다)
    }
  }

  /** 캡션 LIST_HEADER: 문단 수(2), (2), 속성(4) 뒤 캡션 속성(방향 비트 0-1) */
  private caption(list: Rec, paras: Rec[], depth: number): XElement {
    const side = CAPTION_SIDE[u32(list.body, 8) & 0x03] ?? 'BOTTOM';
    return this.tb.el('hp:caption', { side }, [this.subList(paras, depth + 1)]);
  }

  /**
   * 표: CTRL_HEADER(개체 공통 속성) 아래 [캡션 LIST_HEADER + 문단], TABLE, [칸 LIST_HEADER + 문단]* 이 이어진다.
   * TABLE: 속성(제목 줄 반복 0x04), 행 수, 열 수, 칸 간격, 안쪽 여백[4], 행마다 칸 수, 테두리 id, 영역 수 + 영역들.
   * 칸 LIST_HEADER: 문단 수(2), (2), 속성(4: 세로 정렬 비트 5-6), 열, 행, 열 병합, 행 병합, 너비, 높이, 여백[4], 테두리 id.
   */
  private table(rec: Rec, depth: number): XElement[] {
    const tb = this.tb;
    const tableRec = rec.children.find((c) => c.tag === TAG.TABLE);
    if (!tableRec) return [];
    const T = tableRec.body;
    const attr = u32(T, 0);
    const rows = u16(T, 4);
    const cols = u16(T, 6);
    const pad = { left: u16(T, 10), right: u16(T, 12), top: u16(T, 14), bottom: u16(T, 16) };
    const rowSizes: number[] = [];
    for (let r = 0; r < rows; r += 1) rowSizes.push(u16(T, 18 + r * 2));
    let o = 18 + rows * 2;
    const tableFill = u16(T, o);
    const zoneCount = u16(T, o + 2);
    o += 4;
    const tbl = tb.el('hp:tbl', {
      repeatHeader: attr & 0x04 ? 1 : 0,
      rowCnt: rows,
      colCnt: cols,
      borderFillIDRef: tableFill,
    });
    for (const e of objectCommon(rec.body, tb)) tbl.children.push(e);
    tbl.children.push(tb.el('hp:inMargin', pad));
    if (zoneCount > 0) {
      const zl = tb.el('hp:cellzoneList');
      for (let z = 0; z < zoneCount && o + 10 <= T.length && z < 100; z += 1, o += 10) {
        zl.children.push(
          tb.el('hp:cellzone', {
            startColAddr: u16(T, o),
            startRowAddr: u16(T, o + 2),
            endColAddr: u16(T, o + 4),
            endRowAddr: u16(T, o + 6),
            borderFillIDRef: u16(T, o + 8),
          }),
        );
      }
      tbl.children.push(zl);
    }
    // 레코드 묶기: TABLE 앞 LIST_HEADER 는 캡션, 뒤의 LIST_HEADER 는 칸
    let seenTable = false;
    let capList: Rec | null = null;
    const capParas: Rec[] = [];
    const cells: { list: Rec; paras: Rec[] }[] = [];
    for (const c of rec.children) {
      if (c.tag === TAG.TABLE) seenTable = true;
      else if (c.tag === TAG.LIST_HEADER) {
        if (seenTable) cells.push({ list: c, paras: [] });
        else capList = c;
      } else if (c.tag === TAG.PARA_HEADER) {
        if (seenTable) cells[cells.length - 1]?.paras.push(c);
        else if (capList) capParas.push(c);
      }
    }
    if (capList) tbl.children.push(this.caption(capList, capParas, depth));
    let ci = 0;
    let lastTr: XElement | null = null;
    for (let r = 0; r < rows; r += 1) {
      const tr = tb.el('hp:tr');
      for (let k = 0; k < (rowSizes[r] ?? 0) && ci < cells.length; k += 1, ci += 1) tr.children.push(this.cell(cells[ci]!, pad, depth));
      tbl.children.push(tr);
      lastTr = tr;
    }
    // 행마다 칸 수가 모자라게 적힌 표(손상)는 남은 칸을 마지막 행에 붙인다
    if (lastTr) while (ci < cells.length) lastTr.children.push(this.cell(cells[ci++]!, pad, depth));
    return [tbl];
  }

  private cell(c: { list: Rec; paras: Rec[] }, tablePad: Record<string, number>, depth: number): XElement {
    const tb = this.tb;
    const b = c.list.body;
    const flags = u32(b, 4);
    const m = { left: u16(b, 24), right: u16(b, 26), top: u16(b, 28), bottom: u16(b, 30) };
    // 칸 여백 지정 표지는 레코드에서 찾지 못했다: 표 안쪽 여백과 다르면 칸 여백으로 본다(같으면 결과가 같다)
    const own = m.left !== tablePad.left || m.right !== tablePad.right || m.top !== tablePad.top || m.bottom !== tablePad.bottom;
    return tb.el('hp:tc', { header: 0, hasMargin: own ? 1 : 0, borderFillIDRef: u16(b, 32) }, [
      this.subList(c.paras, depth + 1, { vertAlign: CELL_VALIGN[(flags >>> 5) & 0x03] ?? 'TOP' }),
      tb.el('hp:cellAddr', { colAddr: u16(b, 8), rowAddr: u16(b, 10) }),
      tb.el('hp:cellSpan', { colSpan: u16(b, 12), rowSpan: u16(b, 14) }),
      tb.el('hp:cellSz', { width: u32(b, 16), height: u32(b, 20) }),
      tb.el('hp:cellMargin', m),
    ]);
  }

  /** 그리기 개체: CTRL_HEADER(개체 공통 속성) 아래 SHAPE_COMPONENT 하나, 캡션 LIST_HEADER + 문단 */
  private gso(rec: Rec, depth: number): XElement[] {
    const comp = rec.children.find((c) => c.tag === TAG.SHAPE_COMPONENT);
    if (!comp) return [];
    const shape = this.component(comp, true, depth);
    if (!shape) return [];
    for (const e of objectCommon(rec.body, this.tb)) shape.children.push(e);
    const capIdx = rec.children.findIndex((c) => c.tag === TAG.LIST_HEADER);
    if (capIdx >= 0) {
      const capParas = rec.children.slice(capIdx + 1).filter((c) => c.tag === TAG.PARA_HEADER);
      shape.children.push(this.caption(rec.children[capIdx]!, capParas, depth));
    }
    return [shape];
  }

  /**
   * SHAPE_COMPONENT: id(최상위면 두 번), 묶음 안 위치, 그룹 수준, 판, 원래 너비/높이, 현재 너비/높이, …
   * 자식: 그림(PICTURE), 묶음(CONTAINER + 자식 SHAPE_COMPONENT 들), 글상자(LIST_HEADER + 문단) + 도형 레코드.
   */
  private component(comp: Rec, top: boolean, depth: number): XElement | null {
    if (depth > MAX_REC_DEPTH) return null;
    const tb = this.tb;
    const b = comp.body;
    const base = top ? 8 : 4;
    const sizes = [
      tb.el('hp:orgSz', { width: u32(b, base + 12), height: u32(b, base + 16) }),
      tb.el('hp:curSz', { width: u32(b, base + 20), height: u32(b, base + 24) }),
    ];
    const kids = comp.children;
    const pic = kids.find((c) => c.tag === TAG.SHAPE_PICTURE);
    if (pic) {
      // 그림 개체 속성: 테두리 색, 굵기, 속성, 그림 네 모서리[4], 자르기[4], 안쪽 여백[4], 밝기, 대비, 효과, BinItem id
      const binId = u16(pic.body, 71);
      return tb.el('hp:pic', {}, [tb.el('hc:img', { binaryItemIDRef: `bin${binId}` }), ...sizes]);
    }
    if (kids.some((c) => c.tag === TAG.SHAPE_CONTAINER)) {
      const box = tb.el('hp:container', {}, sizes);
      for (const c of kids) {
        if (c.tag !== TAG.SHAPE_COMPONENT) continue;
        const child = this.component(c, false, depth + 1);
        if (child) box.children.push(child);
      }
      return box;
    }
    const kindTag = kids.find((c) => c.tag >= TAG.SHAPE_LINE && c.tag <= TAG.SHAPE_CURVE)?.tag;
    const name =
      kindTag === TAG.SHAPE_ELLIPSE
        ? 'hp:ellipse'
        : kindTag === TAG.SHAPE_ARC
          ? 'hp:arc'
          : kindTag === TAG.SHAPE_POLYGON
            ? 'hp:polygon'
            : kindTag === TAG.SHAPE_CURVE
              ? 'hp:curve'
              : kindTag === TAG.SHAPE_LINE
                ? 'hp:line'
                : 'hp:rect';
    const shape = tb.el(name, {}, sizes);
    const li = kids.findIndex((c) => c.tag === TAG.LIST_HEADER);
    if (li >= 0) {
      const paras = kids.slice(li + 1).filter((c) => c.tag === TAG.PARA_HEADER);
      shape.children.push(tb.el('hp:drawText', {}, [this.subList(paras, depth + 1)]));
    }
    return shape;
  }
}

// ─────────────────────────────── 진입점 ───────────────────────────────

interface Opened {
  cfb: Cfb;
  compressed: boolean;
}

function open(buf: Buffer): Opened {
  const cfb = Cfb.open(buf);
  if (!cfb) throw new OfficeParseError(ERR_CORRUPT);
  const fh = cfb.read('FileHeader', 4096);
  if (!fh || fh.length < 40 || !fh.subarray(0, 17).equals(Buffer.from('HWP Document File'))) {
    throw new OfficeParseError(ERR_CORRUPT);
  }
  const version = fh.readUInt32LE(32);
  if (version >>> 24 !== 5) throw new OfficeParseError(ERR_OLD);
  const flags = fh.readUInt32LE(36);
  if (flags & 0x02) throw new OfficeParseError(ERR_ENCRYPTED);
  if (flags & 0x04 || cfb.has('ViewText')) throw new OfficeParseError(ERR_DISTRIBUTION);
  if (flags & 0x10 || flags & 0x800) throw new OfficeParseError(ERR_DRM);
  return { cfb, compressed: (flags & 0x01) !== 0 };
}

export function processHwp(buf: Buffer, _fileName: string): OfficeExtractResult {
  try {
    return extract(buf);
  } catch (e) {
    if (e instanceof OfficeParseError) throw e;
    const err = new OfficeParseError(ERR_CORRUPT);
    err.cause = e;
    throw err;
  }
}

function extract(buf: Buffer): OfficeExtractResult {
  const { cfb, compressed } = open(buf);
  let total = 0;
  /** 스트림 읽기 (압축이면 raw deflate 풀기). 상한을 넘으면 'big' */
  const load = (path: string): Buffer | 'big' | null => {
    const room = Math.min(MAX_STREAM, MAX_TOTAL - total);
    if (room <= 0) return 'big';
    const raw = cfb.read(path, compressed ? MAX_STREAM : room);
    if (!raw) return null;
    let b: Buffer;
    if (compressed) {
      try {
        b = zlib.inflateRawSync(raw, { maxOutputLength: room });
      } catch (e) {
        if (e instanceof RangeError || (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') return 'big';
        throw new OfficeParseError(ERR_CORRUPT);
      }
    } else b = raw;
    if (b.length > room) return 'big';
    total += b.length;
    return b;
  };

  const di = load('DocInfo');
  if (di === 'big') throw new OfficeParseError(ERR_TOO_BIG);
  if (!di) throw new OfficeParseError(ERR_CORRUPT);
  const headTb = new TreeBuilder(4_000_000);
  const info = readDocInfo(recordTree(di), headTb);

  const sections = cfb
    .children('BodyText')
    .map((e) => /^Section(\d+)$/i.exec(e.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ n: Number(m[1]), path: `BodyText/${m[0]}` }))
    .sort((a, b) => a.n - b.n);
  if (sections.length === 0) throw new OfficeParseError(ERR_CORRUPT);

  const binary = (id: string): MediaRef | undefined => {
    const m = /^bin(\d+)$/.exec(id);
    const item = m ? info.bins[Number(m[1]) - 1] : undefined;
    if (!item || !cfb.has(item.path)) return undefined;
    const mime = imageMimeOf(item.path);
    return mime ? { path: item.path, mime } : undefined;
  };

  const out = renderOwpml({
    head: info.head,
    sectionCount: sections.length,
    section: (i, maxTags) => {
      const b = load(sections[i]!.path);
      if (b === 'big') return 'big';
      if (!b) return 'broken';
      const tb = new TreeBuilder(maxTags);
      try {
        const sb = new SectionBuilder(tb);
        const root = tb.el('hs:sec', {}, sb.paras(recordTree(b), 0));
        return { root, tags: tb.count };
      } catch (e) {
        if (e instanceof TooBig) return 'big';
        throw e;
      }
    },
    binary,
    label: 'hwp',
  });
  return { fileKind: 'hwpx', extractor: HWP_EXTRACTOR, ...out };
}
