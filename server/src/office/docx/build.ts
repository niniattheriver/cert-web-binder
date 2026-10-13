/**
 * 1단계: docx XML → IR
 *
 * Word 의 인쇄 모양(print layout)에 보이는 것만 담는다.
 * - 블록: w:p, w:tbl. w:sdt(w:sdtContent), w:customXml 은 안을 펼친다. mc:AlternateContent 는 한 갈래만
 *   (지원하는 내용이 있으면 Choice, 아니면 Fallback). w:altChunk, 책갈피, 교정 표지, 권한, 메모는 버린다.
 * - 글자: w:t, w:tab('\t'), w:br/w:cr('\n'), w:br type=page(본문 흐름에서 쪽 경계, 표 칸 안 포함. 글상자,
 *   머리말, 각주 안에서는 '\n'),
 *   w:sym, w:noBreakHyphen('-'). w:softHyphen 은 버린다. w:ruby 는 바탕 글자만, 수식(m:oMath)은 m:t 를 이은
 *   기울임 글자로. 숨은 글자(w:vanish, 스타일을 거쳐 해석)는 통째로 뺀다.
 * - 펼치기: w:hyperlink, w:smartTag, w:customXml, 글자 안 w:sdt, w:dir, w:bdo, w:ins, w:moveTo.
 *   버리기: w:del, w:moveFrom, w:delText. 하이퍼링크 대상 주소는 모델에 넣지 않는다.
 * - 필드는 결과 구간만(fields.ts). 각주/미주 참조는 번호를 위첨자 글자로 넣고 위치 표지를 남긴다.
 *   사용자 지정 표지(customMarkFollows) 참조는 번호를 쓰지도 세지도 않는다(뒤따르는 글자가 표지).
 * - 속성 값으로 고정 표를 찾을 때는 표 자신의 키만 본다(units.ts own): 'constructor' 같은 값은 모르는 값이다.
 * - 그림: wp:inline/wp:anchor 의 pic:pic(a:blip r:embed), VML v:imagedata. png/jpeg/gif/bmp/webp 만.
 *   글상자: wps:txbx, v:textbox 의 w:txbxContent → 글상자 블록(기준 문단 뒤).
 * - w:lastRenderedPageBreak(Word 가 마지막 저장 때 쪽이 시작된 자리)는 본문 흐름(표 안 포함, 글상자 제외)에서
 *   쪽 경계 표지로 남긴다. 쪽 나눔은 paginate.ts 가 한다.
 */
import { cropFromSrcRect, cropFromVml } from '../crop.js';
import type { Border, MediaRef } from '../model.js';
import { attr, childEl, childEls, childPath, hasDescendant, localName, unescapeXml, type XElement } from '../xml.js';
import { FieldStack, parsePageField } from './fields.js';
import { singleLinePx } from './fontmetrics.js';
import {
  blockVisible,
  itemVisible,
  type IRBlock,
  type IRCell,
  type IRImage,
  type IRItem,
  type IRPara,
  type IRRow,
  type IRTable,
  type IRText,
  type ParaOut,
  type RunOut,
  type SectInfo,
} from './ir.js';
import {
  MAX_BOX_DEPTH,
  MAX_HEADER_CHARS,
  MAX_HEADER_IMAGES,
  MAX_HEADER_SOURCE,
  MAX_HEADER_UNITS,
  MAX_PARAGRAPHS,
  MAX_TABLE_DEPTH,
  MAX_TEXT,
  TRUNC_PARAS,
  TRUNC_TEXT,
} from './limits.js';
import { NumberingState, type Label, type NumberingDefs } from './numbering.js';
import { MAIN_PART, type DocxPackage, type Rel } from './package.js';
import {
  emptyTbl,
  emptyTc,
  mergePPr,
  mergeTbl,
  mergeTc,
  readPPr,
  readRPr,
  readTblPr,
  readTcPr,
  type BorderSpec,
  type ColorCtx,
  type CondFmt,
  type FontRef,
  type IndSide,
  type PProps,
  type RProps,
  type Styles,
  type TblProps,
} from './styles.js';
import { themeFont, type Theme } from './theme.js';
import {
  canon,
  emuToPx,
  formatNumber,
  hasEastAsian,
  HIGHLIGHT,
  isSymbolFont,
  luminance,
  mapBulletGlyphs,
  num,
  onOff,
  own,
  round1,
  sanitizeFont,
  sliceSafe,
  twipsAttr,
  twipsToPx,
} from './units.js';

// ─────────────────────────────── 설정, 구역 ───────────────────────────────

export interface Settings {
  /** twips */
  defaultTab: number;
  evenAndOdd: boolean;
  clrMap: Record<string, string>;
  eastAsiaLang?: string;
  footStart: number;
  footFmt: string;
  endStart: number;
  endFmt: string;
}

export function readSettings(root: XElement | null): Settings {
  const s: Settings = {
    defaultTab: 720,
    evenAndOdd: false,
    clrMap: {},
    footStart: 1,
    footFmt: 'decimal',
    endStart: 1,
    endFmt: 'lowerRoman',
  };
  if (!root) return s;
  const dt = childEl(root, 'w:defaultTabStop');
  const dtv = dt ? twipsAttr(attr(dt, 'w:val')) : undefined;
  if (dtv !== undefined && dtv > 0) s.defaultTab = dtv;
  s.evenAndOdd = onOff(childEl(root, 'w:evenAndOddHeaders')) ?? false;
  const map = childEl(root, 'w:clrSchemeMapping');
  if (map) {
    const pairs: [string, string][] = [
      ['w:bg1', 'background1'],
      ['w:t1', 'text1'],
      ['w:bg2', 'background2'],
      ['w:t2', 'text2'],
    ];
    for (const [a, name] of pairs) {
      const v = attr(map, a);
      if (v) s.clrMap[name] = v;
    }
  }
  const lang = childEl(root, 'w:themeFontLang');
  const ea = lang ? attr(lang, 'w:eastAsia') : undefined;
  if (ea) s.eastAsiaLang = ea;
  const notePr = (name: string): { start?: number; fmt?: string } => {
    const el = childEl(root, name);
    if (!el) return {};
    const st = childEl(el, 'w:numStart');
    const fm = childEl(el, 'w:numFmt');
    const out: { start?: number; fmt?: string } = {};
    const sv = st ? num(attr(st, 'w:val')) : undefined;
    if (sv !== undefined) out.start = sv;
    const fv = fm ? attr(fm, 'w:val') : undefined;
    if (fv) out.fmt = fv;
    return out;
  };
  const fp = notePr('w:footnotePr');
  const ep = notePr('w:endnotePr');
  if (fp.start !== undefined) s.footStart = fp.start;
  // 각주 번호 서식은 decimal 만 지원한다(사양 범위). 미주는 서식 함수가 아는 형식이면 그대로
  if (ep.start !== undefined) s.endStart = ep.start;
  if (ep.fmt) s.endFmt = ep.fmt;
  return s;
}

const A4 = { w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720 };
const MAX_PAGE_PX = 10_000;
/** 크기를 어디서도 정하지 않은 글자의 Word 기본 크기 pt */
const DEFAULT_PT = 10;
/** 줄을 맞추는 문서 격자 종류 (default 또는 없음 = 격자 없음) */
const GRID_TYPES = new Set(['lines', 'linesAndChars', 'snapToChars']);

/** 본문 최상위 문단의 pPr/sectPr 와 본문 끝 sectPr (build 와 같은 펼치기 규칙) */
function collectSectPrs(body: XElement | undefined): (XElement | undefined)[] {
  const out: (XElement | undefined)[] = [];
  const walk = (el: XElement, depth = 0): void => {
    if (depth > MAX_NESTING) return;
    for (const c of el.children) {
      if (c.type !== 'el') continue;
      if (c.name === 'w:p') {
        const s = childPath(c, 'w:pPr', 'w:sectPr');
        if (s) out.push(s);
      } else if (c.name === 'w:sdt') {
        const sc = childEl(c, 'w:sdtContent');
        if (sc) walk(sc, depth + 1);
      } else if (c.name === 'w:customXml') {
        walk(c, depth + 1);
      } else if (c.name === 'mc:AlternateContent') {
        const br = chooseBranch(c);
        if (br) walk(br, depth + 1);
      }
    }
  };
  if (body) walk(body);
  out.push(body ? childEl(body, 'w:sectPr') : undefined);
  return out;
}

export function readSections(body: XElement | undefined, pkg: DocxPackage): SectInfo[] {
  const rels = pkg.rels(MAIN_PART);
  const out: SectInfo[] = [];
  let prev: SectInfo | undefined;
  for (const el of collectSectPrs(body)) {
    const pgSz = el ? childEl(el, 'w:pgSz') : undefined;
    const pgMar = el ? childEl(el, 'w:pgMar') : undefined;
    const tw = (e: XElement | undefined, n: string, d: number): number => {
      const v = e ? twipsAttr(attr(e, n)) : undefined;
      return v !== undefined && Number.isFinite(v) ? v : d;
    };
    let w = tw(pgSz, 'w:w', A4.w);
    let h = tw(pgSz, 'w:h', A4.h);
    if (w <= 0 || h <= 0) {
      w = A4.w;
      h = A4.h;
    }
    const W = Math.min(MAX_PAGE_PX, Math.max(96, twipsToPx(w)));
    const H = Math.min(MAX_PAGE_PX, Math.max(96, twipsToPx(h)));
    const m = (n: string, d: number, dim: number): number =>
      Math.min(round1(dim / 2), twipsToPx(Math.abs(tw(pgMar, n, d))));
    const gutter = Math.max(0, tw(pgMar, 'w:gutter', 0));
    const margin: [number, number, number, number] = [
      m('w:top', A4.top, H),
      m('w:right', A4.right, W),
      m('w:bottom', A4.bottom, H),
      Math.min(round1(W / 2), twipsToPx(Math.abs(tw(pgMar, 'w:left', A4.left)) + gutter)),
    ];
    const typeEl = el ? childEl(el, 'w:type') : undefined;
    const sect: SectInfo = {
      w: W,
      h: H,
      margin,
      headerDist: twipsToPx(Math.abs(tw(pgMar, 'w:header', A4.header))),
      footerDist: twipsToPx(Math.abs(tw(pgMar, 'w:footer', A4.footer))),
      type: (typeEl ? attr(typeEl, 'w:val') : undefined) ?? 'nextPage',
      titlePg: el ? (onOff(childEl(el, 'w:titlePg')) ?? false) : false,
      headers: { ...prev?.headers },
      footers: { ...prev?.footers },
    };
    if (el) {
      for (const c of el.children) {
        if (c.type !== 'el' || (c.name !== 'w:headerReference' && c.name !== 'w:footerReference')) continue;
        const kind = attr(c, 'w:type') ?? 'default';
        if (kind !== 'default' && kind !== 'first' && kind !== 'even') continue;
        const rid = attr(c, 'r:id');
        const target = rid ? rels.get(rid)?.target : undefined;
        if (!target || !pkg.has(target)) continue;
        (c.name === 'w:headerReference' ? sect.headers : sect.footers)[kind] = target;
      }
      const pg = childEl(el, 'w:pgNumType');
      if (pg) {
        const st = num(attr(pg, 'w:start'));
        if (st !== undefined) sect.pgStart = st;
        const fm = attr(pg, 'w:fmt');
        if (fm) sect.pgFmt = fm;
      }
      // 문서 격자: type 이 없으면 default(격자 없음)다. linePitch 만 있는 구역(실물 88개 중 84개)은 줄을 맞추지 않는다
      const dg = childEl(el, 'w:docGrid');
      const gt = dg ? attr(dg, 'w:type') : undefined;
      const lp = dg ? twipsAttr(attr(dg, 'w:linePitch')) : undefined;
      if (gt !== undefined && GRID_TYPES.has(gt) && lp !== undefined && lp > 0) {
        sect.grid = { pitch: Math.min(twipsToPx(lp), MAX_PAGE_PX) };
      }
    }
    out.push(sect);
    prev = sect;
  }
  return out;
}

// ─────────────────────────────── 도우미 ───────────────────────────────

/** mc:AlternateContent: 지원하는 내용(그림, 글상자, 글자)이 있으면 Choice, 아니면 Fallback */
export function chooseBranch(ac: XElement): XElement | undefined {
  const choice = childEl(ac, 'mc:Choice');
  const fallback = childEl(ac, 'mc:Fallback');
  if (
    choice &&
    (hasDescendant(choice, 'pic:pic') ||
      hasDescendant(choice, 'w:txbxContent') ||
      hasDescendant(choice, 'w:t') ||
      hasDescendant(choice, 'w:p'))
  ) {
    return choice;
  }
  return fallback ?? undefined;
}

/** w:t 의 글자 (CDATA 포함). 원문에 섞인 줄바꿈은 빈칸으로 본다 */
function textOf(t: XElement): string {
  let s = '';
  for (const c of t.children) {
    if (c.type === 'text') s += unescapeXml(c.raw);
    else if (c.type === 'raw' && c.raw.startsWith('<![CDATA[')) s += c.raw.slice(9, -3);
  }
  return s.replace(/\r\n?|\n/g, ' ');
}

/** 글꼴 선택용: 글자 조각의 w:t 글자만 이어 본다 */
function runText(r: XElement): string {
  let s = '';
  for (const c of r.children) if (c.type === 'el' && c.name === 'w:t') s += textOf(c);
  return s;
}

function upper(s: string): string {
  const u = s.toUpperCase();
  if (u.length === s.length) return u;
  let out = '';
  for (const ch of s) {
    const x = ch.toUpperCase();
    out += x.length === ch.length ? x : ch;
  }
  return out;
}

const ALIGN: Record<string, ParaOut['align']> = {
  center: 'center',
  right: 'right',
  end: 'right',
  both: 'justify',
  distribute: 'justify',
  mediumKashida: 'justify',
  highKashida: 'justify',
  lowKashida: 'justify',
  thaiDistribute: 'justify',
};

/** 테두리 사양 → 모델 테두리. 없음(none, nil)은 undefined */
export function borderModel(b: BorderSpec | undefined): Border | undefined {
  if (!b || b.val === 'none' || b.val === 'nil') return undefined;
  const v = b.val;
  const style: Border['style'] =
    v === 'double' || /^(triple|thinThick|thickThin|thinThickThin|thickThinThin)/.test(v)
      ? 'double'
      : v === 'dotted'
        ? 'dotted'
        : /^(dashed|dashSmallGap|dotDash|dotDotDash|dashDotStroked)/.test(v)
          ? 'dashed'
          : 'solid';
  let w = Math.round(Math.max(1, Math.min(3, (b.sz ?? 4) / 6)));
  if (style === 'double') w = 3;
  return { w: w as Border['w'], style, color: b.color ?? '#000000' };
}

const IMAGE_MIME: Record<string, MediaRef['mime']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  dib: 'image/bmp',
  webp: 'image/webp',
};

/** 펼치기 재귀 깊이 상한 */
const MAX_NESTING = 200;

/**
 * 문단 하나의 글자 조각을 모은다: 같은 모양의 이웃 조각은 합치고, 정규화(canon)는 조각을 닫을 때 한 번.
 * 결합 글자로 시작하는 조각을 앞 조각에 붙이는 일은 여기서 하지 않고 모델 문단을 만들 때(emit.ts settleRuns)
 * 한 번에 한다: 앞으로 옮겨지는 글상자, 떠 있는 그림, 각주 표지, 번호 이름표를 사이에 둔 조각도 쪽 글자에서는
 * 이웃하기 때문이다.
 */
class ParaBuilder {
  readonly items: IRItem[] = [];
  private raw = '';
  private s: RunOut | null = null;
  private key = '';

  constructor(private readonly count: (n: number) => void) {}

  text(raw: string, s: RunOut, key: string): void {
    if (raw === '') return;
    if (this.s && this.key === key) {
      this.raw += raw;
      return;
    }
    this.flush();
    this.raw = raw;
    this.s = s;
    this.key = key;
  }

  flush(): void {
    if (!this.s) return;
    const t = canon(this.raw);
    const s = this.s;
    const key = this.key;
    this.raw = '';
    this.s = null;
    this.key = '';
    if (t === '') return;
    this.count(t.length);
    this.items.push({ k: 't', t, s, key });
  }

  push(it: IRItem): void {
    this.flush();
    this.items.push(it);
  }
}

interface Story {
  part: string;
  rels: Map<string, Rel>;
  kind: 'body' | 'header' | 'note';
  fields: FieldStack;
  numbering: NumberingState;
  /** 각주/미주 이야기: 그 각주 열쇠 ('f:3') */
  noteKey?: string;
  /** 본문: 지금 구역 번호 */
  sect: number;
  /** 머리말/꼬리말: 지금까지 만든 문단 수 (부분 상한 MAX_HEADER_UNITS 를 넘으면 멈춘다) */
  paras: number;
}

interface HeaderBudget {
  chars: number;
  units: number;
  imgs: number;
}

/**
 * 머리말/꼬리말 IR 을 부분 상한까지만 남긴다: 글자(넘치는 조각은 잘라서), 문단과 표 행, 칸, 그림.
 * 표시 전용이라 정본 글자와 무관하고, 쪽마다 되풀이되는 모델 크기를 묶는다.
 */
function clampHeader(blocks: IRBlock[], b: HeaderBudget): IRBlock[] {
  const out: IRBlock[] = [];
  for (const blk of blocks) {
    if (b.units <= 0) break;
    b.units -= 1;
    if (blk.k === 'p') {
      const items: IRItem[] = [];
      for (const it of blk.items) {
        if (it.k === 't') {
          if (b.chars <= 0) continue;
          const t = it.t.length > b.chars ? sliceSafe(it.t, b.chars) : it.t;
          b.chars = t === it.t ? b.chars - t.length : 0;
          if (t !== '') items.push(t === it.t ? it : { ...it, t });
        } else if (it.k === 'img') {
          if (b.imgs <= 0) continue;
          b.imgs -= 1;
          items.push(it);
        } else if (it.k === 'box') {
          const inner = clampHeader(it.blocks, b);
          if (inner.length > 0) items.push({ ...it, blocks: inner });
        } else {
          items.push(it);
        }
      }
      out.push({ ...blk, items });
      continue;
    }
    const rows: IRRow[] = [];
    for (const row of blk.rows) {
      if (b.units <= 0) break;
      b.units -= 1;
      const cells: IRCell[] = [];
      for (const c of row.cells) {
        if (b.units <= 0) break;
        b.units -= 1;
        cells.push({ ...c, blocks: clampHeader(c.blocks, b) });
      }
      rows.push({ ...row, cells });
    }
    if (rows.length > 0) out.push({ ...blk, rows });
  }
  return out;
}

interface Scope {
  /** 표 중첩 깊이 */
  depth: number;
  /** 글상자 중첩 깊이 */
  box: number;
  /** 칸의 표 스타일 서식 (문단, 글자) */
  tbl?: { p: PProps; r: RProps };
  /** 글자 뒤 바탕색 (자동 글자색 대비용) */
  bg?: string;
  /** 쓸 수 있는 너비 px (pct 너비 계산용) */
  width: number;
}

interface ParaCtx {
  b: ParaBuilder;
  runBase: RProps;
  story: Story;
  scope: Scope;
}

type Look = { firstRow: boolean; lastRow: boolean; firstCol: boolean; lastCol: boolean; noHBand: boolean; noVBand: boolean };

function readLook(el: XElement | undefined): Look {
  const look: Look = { firstRow: false, lastRow: false, firstCol: false, lastCol: false, noHBand: false, noVBand: false };
  if (!el) return look;
  const names: [keyof Look, string, number][] = [
    ['firstRow', 'w:firstRow', 0x0020],
    ['lastRow', 'w:lastRow', 0x0040],
    ['firstCol', 'w:firstColumn', 0x0080],
    ['lastCol', 'w:lastColumn', 0x0100],
    ['noHBand', 'w:noHBand', 0x0200],
    ['noVBand', 'w:noVBand', 0x0400],
  ];
  const hasAttrs = names.some(([, a]) => attr(el, a) !== undefined);
  if (hasAttrs) {
    for (const [k, a] of names) {
      const v = attr(el, a);
      look[k] = v === '1' || v === 'true' || v === 'on';
    }
    return look;
  }
  const bits = parseInt(attr(el, 'w:val') ?? '0', 16);
  if (Number.isFinite(bits)) for (const [k, , mask] of names) look[k] = (bits & mask) !== 0;
  return look;
}

const ROW_CONDS = new Set(['firstRow', 'lastRow', 'band1Horz', 'band2Horz']);
const COL_CONDS = new Set(['firstCol', 'lastCol', 'band1Vert', 'band2Vert']);

function intVal(el: XElement | undefined, name: string): number {
  const c = el ? childEl(el, name) : undefined;
  const v = c ? num(attr(c, 'w:val')) : undefined;
  return v !== undefined && v > 0 ? Math.min(1000, Math.floor(v)) : 0;
}

/** 표 행 (w:sdt, w:customXml 은 펼치고 변경 추적으로 지운 행은 뺀다) */
function collectRows(tbl: XElement): XElement[] {
  const out: XElement[] = [];
  const walk = (el: XElement): void => {
    for (const c of el.children) {
      if (c.type !== 'el') continue;
      if (c.name === 'w:tr') {
        const trPr = childEl(c, 'w:trPr');
        if (trPr && childEl(trPr, 'w:del')) continue;
        out.push(c);
      } else if (c.name === 'w:sdt') {
        const sc = childEl(c, 'w:sdtContent');
        if (sc) walk(sc);
      } else if (c.name === 'w:customXml') {
        walk(c);
      }
    }
  };
  walk(tbl);
  return out;
}

function collectCells(tr: XElement): XElement[] {
  const out: XElement[] = [];
  const walk = (el: XElement): void => {
    for (const c of el.children) {
      if (c.type !== 'el') continue;
      if (c.name === 'w:tc') out.push(c);
      else if (c.name === 'w:sdt') {
        const sc = childEl(c, 'w:sdtContent');
        if (sc) walk(sc);
      } else if (c.name === 'w:customXml') walk(c);
    }
  };
  walk(tr);
  return out;
}

/** 표, 칸 너비 (dxa = twips, pct = 1/50 퍼센트 또는 'N%') → px */
function widthPx(w: { v: string; type: string } | undefined, base: number): number | undefined {
  if (!w) return undefined;
  if (w.type === 'dxa') {
    const v = twipsAttr(w.v);
    return v !== undefined && v > 0 ? twipsToPx(v) : undefined;
  }
  if (w.type === 'pct') {
    const s = w.v.trim();
    const pct = s.endsWith('%') ? Number(s.slice(0, -1)) : (num(s) ?? NaN) / 50;
    return Number.isFinite(pct) && pct > 0 ? round1((base * pct) / 100) : undefined;
  }
  return undefined;
}

function vmlLen(v: string | undefined, scale: number | null): number {
  if (!v) return 0;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(pt|in|cm|mm|px|pc)?\s*$/.exec(v);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'pt':
      return (n * 96) / 72;
    case 'in':
      return n * 96;
    case 'cm':
      return (n * 96) / 2.54;
    case 'mm':
      return (n * 96) / 25.4;
    case 'pc':
      return n * 16;
    case 'px':
      return n;
    default:
      return scale !== null ? n * scale : n;
  }
}

function vmlStyle(s: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (s ?? '').split(';')) {
    const k = part.indexOf(':');
    if (k > 0) m.set(part.slice(0, k).trim().toLowerCase(), part.slice(k + 1).trim());
  }
  return m;
}

function kid(el: XElement | undefined, local: string): XElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) if (c.type === 'el' && localName(c.name) === local) return c;
  return undefined;
}

function descendantLocal(el: XElement, local: string): XElement | undefined {
  for (const c of el.children) {
    if (c.type !== 'el') continue;
    if (localName(c.name) === local) return c;
    const d = descendantLocal(c, local);
    if (d) return d;
  }
  return undefined;
}

// ─────────────────────────────── 변환기 ───────────────────────────────

export class Builder {
  readonly media: MediaRef[] = [];
  private readonly mediaIndex = new Map<string, number>();
  paras = 0;
  chars = 0;
  stop: string | null = null;
  /** 본문 흐름의 w:lastRenderedPageBreak 수 (0 이면 Word 쪽 정보가 없는 문서) */
  lrpbCount = 0;
  /** 본문이 참조한 각주/미주 id → 번호 (처음 참조한 순서). null = 사용자 지정 표지라 번호가 없다 */
  readonly footNums = new Map<string, number | null>();
  readonly endNums = new Map<string, number | null>();
  private footCount = 0;
  private endCount = 0;
  private readonly headerCache = new Map<string, IRBlock[]>();
  /** 지금까지 풀어 읽은 머리말/꼬리말 부분 바이트 합 */
  private headerBytes = 0;
  /** 펼치기(sdt, customXml, 하이퍼링크 등) 재귀 깊이: 비정상적으로 깊은 문서에서 스택을 지킨다 */
  private nesting = 0;

  constructor(
    private readonly pkg: DocxPackage,
    private readonly styles: Styles,
    private readonly numDefs: NumberingDefs,
    private readonly cc: ColorCtx,
    private readonly theme: Theme,
    private readonly settings: Settings,
    private readonly sections: SectInfo[],
  ) {}

  private story(part: string, kind: Story['kind'], noteKey?: string): Story {
    const st: Story = {
      part,
      rels: this.pkg.rels(part),
      kind,
      fields: new FieldStack(),
      numbering: new NumberingState(this.numDefs),
      sect: 0,
      paras: 0,
    };
    if (noteKey) st.noteKey = noteKey;
    return st;
  }

  private textWidth(sect: number): number {
    const s = this.sections[Math.min(sect, this.sections.length - 1)];
    return s ? Math.max(48, s.w - s.margin[1] - s.margin[3]) : 600;
  }

  /** 본문 → 최상위 블록 */
  body(bodyEl: XElement | undefined): IRBlock[] {
    const story = this.story(MAIN_PART, 'body');
    const out: IRBlock[] = [];
    if (bodyEl) this.blocks(bodyEl, story, { depth: 0, box: 0, width: this.textWidth(0) }, out);
    this.post(out);
    return out;
  }

  /**
   * 머리말/꼬리말 부분 → 블록 (부분마다 한 번). 본문 상한과 따로, 부분마다 MAX_HEADER_* 까지만 남긴다.
   * 구역마다 다른 부분을 가리킬 수 있으므로 풀어 읽는 부분 크기의 합도 MAX_HEADER_SOURCE 로 묶는다.
   */
  header(part: string): IRBlock[] {
    const hit = this.headerCache.get(part);
    if (hit) return hit;
    let out: IRBlock[] = [];
    const size = this.pkg.sizeWithRels(part);
    if (this.headerBytes + size <= MAX_HEADER_SOURCE) {
      this.headerBytes += size;
      const root = this.pkg.xml(part);
      if (root) {
        const story = this.story(part, 'header');
        this.blocks(root, story, { depth: 0, box: 0, width: this.textWidth(0) }, out);
        this.post(out);
        out = clampHeader(out, { chars: MAX_HEADER_CHARS, units: MAX_HEADER_UNITS, imgs: MAX_HEADER_IMAGES });
      }
    }
    this.headerCache.set(part, out);
    return out;
  }

  /** 본문이 참조한 각주(foot) 또는 미주(end) → 열쇠('f:3')별 블록, 번호 순 */
  notes(kind: 'foot' | 'end'): Map<string, IRBlock[]> {
    const out = new Map<string, IRBlock[]>();
    const nums = kind === 'foot' ? this.footNums : this.endNums;
    if (nums.size === 0) return out;
    const part =
      this.pkg.relByType(MAIN_PART, kind === 'foot' ? 'footnotes' : 'endnotes') ??
      (kind === 'foot' ? 'word/footnotes.xml' : 'word/endnotes.xml');
    const root = this.pkg.xml(part);
    if (!root) return out;
    const tag = kind === 'foot' ? 'w:footnote' : 'w:endnote';
    const byId = new Map<string, XElement>();
    for (const c of root.children) {
      if (c.type !== 'el' || c.name !== tag) continue;
      const type = attr(c, 'w:type');
      if (type && type !== 'normal') continue;
      const id = attr(c, 'w:id');
      if (id !== undefined && !byId.has(id)) byId.set(id, c);
    }
    const prefix = kind === 'foot' ? 'f:' : 'e:';
    for (const id of nums.keys()) {
      if (this.stop) break;
      const el = byId.get(id);
      if (!el) continue;
      const story = this.story(part, 'note', prefix + id);
      const blocks: IRBlock[] = [];
      this.blocks(el, story, { depth: 0, box: 0, width: this.textWidth(0) }, blocks);
      this.post(blocks);
      out.set(prefix + id, blocks);
    }
    return out;
  }

  private countChars(story: Story, n: number): void {
    if (story.kind === 'header') return;
    this.chars += n;
    if (this.chars > MAX_TEXT) this.stop ??= TRUNC_TEXT;
  }

  private halted(story: Story): boolean {
    if (story.kind === 'header') return story.paras > MAX_HEADER_UNITS;
    return this.stop !== null;
  }

  // ───────────── 블록 ─────────────

  private blocks(el: XElement, story: Story, scope: Scope, out: IRBlock[]): void {
    if (this.nesting > MAX_NESTING) return;
    this.nesting += 1;
    try {
      this.blockChildren(el, story, scope, out);
    } finally {
      this.nesting -= 1;
    }
  }

  private blockChildren(el: XElement, story: Story, scope: Scope, out: IRBlock[]): void {
    for (const c of el.children) {
      if (this.halted(story)) return;
      if (c.type !== 'el') continue;
      switch (c.name) {
        case 'w:p': {
          const p = this.para(c, story, scope);
          if (p) out.push(p);
          break;
        }
        case 'w:tbl':
          this.table(c, story, scope, out);
          break;
        case 'w:sdt': {
          const sc = childEl(c, 'w:sdtContent');
          if (sc) this.blocks(sc, story, scope, out);
          break;
        }
        case 'w:customXml':
          this.blocks(c, story, scope, out);
          break;
        case 'mc:AlternateContent': {
          const br = chooseBranch(c);
          if (br) this.blocks(br, story, scope, out);
          break;
        }
        default:
          break; // w:sectPr, 책갈피, w:altChunk, 교정/권한/메모 표지
      }
    }
  }

  /** 문맥 간격(contextualSpacing)과 문단 테두리 묶음 */
  private post(blocks: IRBlock[]): void {
    let prev: IRPara | undefined;
    for (const b of blocks) {
      if (b.k !== 'p') {
        prev = undefined;
        continue;
      }
      if (prev && prev.styleId === b.styleId) {
        if (prev.contextual) delete prev.props.spaceAfter;
        if (b.contextual) delete b.props.spaceBefore;
      }
      prev = b;
    }
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i]!;
      if (b.k !== 'p' || !b.bdrKey) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < blocks.length) {
        const n = blocks[j]!;
        if (n.k !== 'p' || n.bdrKey !== b.bdrKey) break;
        j += 1;
      }
      if (j - i > 1) {
        for (let k = i; k < j; k += 1) {
          const p = blocks[k] as IRPara;
          if (k > i) delete p.props.bt;
          if (k < j - 1) {
            if (p.between) p.props.bb = p.between;
            else delete p.props.bb;
          }
        }
      }
      i = j;
    }
  }

  // ───────────── 문단 ─────────────

  private para(p: XElement, story: Story, scope: Scope): IRPara | null {
    if (story.kind === 'header') {
      story.paras += 1;
      if (story.paras > MAX_HEADER_UNITS) return null;
    } else {
      this.paras += 1;
      if (this.paras > MAX_PARAGRAPHS) {
        this.stop ??= TRUNC_PARAS;
        return null;
      }
    }
    const pPr = childEl(p, 'w:pPr');
    const pStyleEl = pPr ? childEl(pPr, 'w:pStyle') : undefined;
    const ps = this.styles.para(pStyleEl ? attr(pStyleEl, 'w:val') : undefined);
    const direct = readPPr(pPr, this.cc);
    const numId = direct.numId ?? ps.p.numId;
    let ilvl = direct.ilvl ?? ps.p.ilvl;
    const res = numId !== undefined && numId !== '0' ? this.numDefs.resolve(numId) : null;
    if (res && ilvl === undefined && direct.numId === undefined && ps.id) {
      for (const lv of res.levels.values()) {
        if (lv.pStyle === ps.id) {
          ilvl = lv.ilvl;
          break;
        }
      }
    }
    const lvlDef = res?.levels.get(ilvl ?? 0);
    const lvlP = lvlDef?.pPr ? readPPr(lvlDef.pPr, this.cc) : {};
    const P: PProps = mergePPr(this.styles.defaultsP, scope.tbl?.p, ps.p, lvlP, direct);
    const runBase: RProps = { ...this.styles.defaultsR, ...scope.tbl?.r, ...ps.r };
    const markRPr = pPr ? childEl(pPr, 'w:rPr') : undefined;
    const markRs = markRPr ? childEl(markRPr, 'w:rStyle') : undefined;
    const markR: RProps = {
      ...runBase,
      ...(markRs ? this.styles.char(attr(markRs, 'w:val')) : {}),
      ...readRPr(markRPr, this.cc),
    };

    // 번호는 문서 순서대로 센다: 글상자 안 문단보다 기준 문단이 먼저
    let label: Label | null = null;
    if (res && numId !== undefined && !markR.vanish) label = story.numbering.next(numId, ilvl ?? 0);

    const b = new ParaBuilder((n) => this.countChars(story, n));
    const pc: ParaCtx = { b, runBase, story, scope };
    this.inline(p, pc);
    b.flush();
    const items = b.items;
    const top = story.kind === 'body' && scope.depth === 0 && scope.box === 0;
    const sectEnd = top && pPr !== undefined && childEl(pPr, 'w:sectPr') !== undefined;

    if (markR.vanish && !items.some((it) => itemVisible(it)) && !sectEnd) {
      // 문단 표지까지 숨긴 빈 문단: Word 에 아무것도 보이지 않는다. 쪽 경계 표지만은 남긴다
      const marks = items.filter((it) => it.k === 'lrpb' || it.k === 'pb' || it.k === 'note');
      if (marks.length === 0) return null;
      return { k: 'p', props: {}, items: marks, sect: story.sect, hidden: true };
    }
    if (label) this.addLabel(items, label, markR, scope);

    const props = this.paraOut(P, markR);
    const para: IRPara = { k: 'p', props, items, sect: story.sect };
    // 화면 값: 바로잡은 들여쓰기와 Word 식 줄 높이 (emit.ts 가 모델에 싣는다)
    const [ml, mr, ind] = this.indentPx(P, markR, false);
    const render: NonNullable<IRPara['render']> = { marginLeft: ml, marginRight: mr, indent: ind };
    const line = this.lineBox(props, P, items, markR, story.sect);
    if (line !== undefined) render.linePx = line;
    para.render = render;
    if (ps.id !== undefined) para.styleId = ps.id;
    if (P.contextual) para.contextual = true;
    if (P.keepNext) para.keepNext = true;
    if (top && P.pageBreakBefore) para.pbb = true;
    if (props.bt || props.bb || props.bl || props.br) {
      const between = borderModel(P.bdrBetween);
      para.bdrKey = JSON.stringify([props.bt, props.bb, props.bl, props.br, between, ml, mr]);
      if (between) para.between = between;
    }
    if (sectEnd) {
      para.sectEnd = true;
      story.sect += 1;
    }
    return para;
  }

  private addLabel(items: IRItem[], label: Label, markR: RProps, scope: Scope): void {
    const lvlR = readRPr(label.level.rPr, this.cc);
    const LR: RProps = { ...markR, ...lvlR };
    if (LR.vanish) return;
    const symbol = label.level.numFmt === 'bullet' && isSymbolFont(this.fontName(LR.fAscii));
    const mapped = mapBulletGlyphs(label.text, symbol);
    const t = canon(mapped.text);
    if (t === '') return;
    const s: RunOut = { ...this.runStyle(LR, t.replace(/[\t ]/g, ''), scope.bg).s };
    if (mapped.changed && isSymbolFont(s.font)) delete s.font;
    const it: IRText = { k: 't', t, s, key: `${JSON.stringify(s)}|lbl`, lbl: true };
    items.unshift(it);
    this.chars += t.length;
  }

  /**
   * 들여쓰기 px [왼쪽, 오른쪽, 첫 줄(+ 들여쓰기, - 내어쓰기)]. legacy 면 쪽 나눔 어림용 옛 규칙 값(styles.ts
   * PProps.indLeftL), 아니면 바로잡은 값(화면). 글자 단위 값이 0 이 아니면 그것이 twips 값보다 우선한다
   */
  private indentPx(P: PProps, markR: RProps, legacy: boolean): [number, number, number] {
    const charPx = ((markR.sz ?? 20) / 2) * (96 / 72);
    const sidePx = (s: IndSide | undefined): number => {
      if (!s) return 0;
      if (s.chars) return round1((s.chars / 100) * charPx);
      return twipsToPx(s.twips ?? 0);
    };
    return legacy
      ? [sidePx(P.indLeftL), sidePx(P.indRightL), sidePx(P.indFirstL)]
      : [sidePx(P.indLeft), sidePx(P.indRight), sidePx(P.indFirst)];
  }

  private paraOut(P: PProps, markR: RProps): ParaOut {
    const o: ParaOut = {};
    const al = own(ALIGN, P.jc);
    if (al) o.align = al;
    // IR 의 들여쓰기는 쪽 나눔 어림용 옛 규칙 값이다. 화면 값은 IRPara.render 로 따로 싣는다(para)
    const [ml, mr, ind] = this.indentPx(P, markR, true);
    if (ml) o.marginLeft = ml;
    if (mr) o.marginRight = mr;
    if (ind) o.indent = ind;
    const space = (sp: { twips?: number; lines?: number } | undefined): number => {
      if (!sp) return 0;
      const v = sp.lines ? round1((sp.lines / 100) * 16) : twipsToPx(sp.twips ?? 0);
      return Math.max(0, v);
    };
    const sb = P.spBeforeAuto ? 14 : space(P.spBefore);
    if (sb) o.spaceBefore = sb;
    const sa = P.spAfterAuto ? 14 : space(P.spAfter);
    if (sa) o.spaceAfter = sa;
    // 줄 간격: auto 는 배수, exact 와 atLeast 는 지정 값 px. 쪽 나눔 어림(estimate.ts)이 이 값으로 높이를 잰다.
    // 화면에 그리는 줄 높이는 글자를 다 모은 뒤 lineBox 가 따로 정한다(IRPara.render.linePx → 모델 linePx)
    if (P.line) {
      if (P.line.rule === 'exact' || P.line.rule === 'atLeast') {
        const v = twipsToPx(P.line.val);
        if (v > 0) o.linePx = Math.min(v, 2000);
      } else {
        const v = Math.round((P.line.val / 240) * 100) / 100;
        if (v > 0) o.lineHeight = Math.min(v, 20);
      }
    }
    if (P.shd && P.shd !== 'none') o.bg = P.shd;
    const bt = borderModel(P.bdrTop);
    const bb = borderModel(P.bdrBottom);
    const bl = borderModel(P.bdrLeft);
    const br = borderModel(P.bdrRight);
    if (bt) o.bt = bt;
    if (bb) o.bb = bb;
    if (bl) o.bl = bl;
    if (br) o.br = br;
    if (markR.sz) o.sz = markR.sz / 2;
    const f = this.fontName(markR.fEastAsia) ?? this.fontName(markR.fAscii);
    if (f) o.font = f;
    return o;
  }

  /**
   * 화면에 그리는 줄 높이 px (IRPara.render.linePx → 모델 linePx): Word 처럼 문단 글자의 글꼴, 크기에서 '한 줄'
   * (fontmetrics.ts)을 구해 줄 간격 규칙을 적용한다. 화면은 CSS line-height 를 글자 크기의 배수로만 줄 수 있어
   * 글꼴마다 다른 Word 의 '한 줄'(맑은 고딕 1.73배, Arial 1.15배)을 나타낼 수 없으므로 px 로 싣는다.
   * - '한 줄' = 글자 조각(번호 이름표 포함)마다 '한 줄' 높이의 최댓값. 글자가 없으면 문단 표지 글꼴, 크기
   *   (표지 글꼴은 동아시아, 영문 글꼴 중 큰 쪽).
   * - auto: 배수 x '한 줄'. atLeast: max(지정 값, '한 줄'). exact: 지정 값(paraOut 의 linePx).
   *   atLeast 를 지정 값으로만 그리면 실물 1,160곳의 atLeast 5pt 줄(10pt 글자)이 6.7px 로 눌렸다.
   * - 문서 격자(구역 docGrid type 이 lines, linesAndChars, snapToChars)가 있고 문단이 snapToGrid 를 끄지 않았으면
   *   '한 줄'을 격자 간격의 정수배로 올린다(사양 17.6.5, 17.3.1.32. 배수는 그 위에 곱한다). 실물 docx 88개는
   *   모두 type 이 없어(= 격자 없음, linePitch 만 있음) 이 갈래를 Word 출력과 대조하지는 못했다.
   * 쪽 나눔 어림은 이 값을 쓰지 않는다(props 의 배수와 지정 값으로 잰다): 어림은 그 높이로 맞춰져 있어, 이 값으로
   * 바꾸면 PDF 짝 7개 중 2개의 쪽 경계가 Word 와 어긋났다(쪽 수는 같았다).
   */
  private lineBox(o: ParaOut, P: PProps, items: IRItem[], markR: RProps, sect: number): number | undefined {
    const rule = P.line?.rule ?? 'auto';
    if (rule === 'exact' && o.linePx !== undefined) return o.linePx;
    let single = 0;
    for (const it of items) {
      if (it.k !== 't') continue;
      single = Math.max(single, singleLinePx(it.s.font, it.s.sz ?? DEFAULT_PT, hasEastAsian(it.t)));
    }
    if (single === 0) {
      const sz = (markR.sz ?? DEFAULT_PT * 2) / 2;
      single = Math.max(
        singleLinePx(this.fontName(markR.fEastAsia), sz, true),
        singleLinePx(this.fontName(markR.fAscii) ?? this.fontName(markR.fEastAsia), sz, false),
      );
    }
    const grid = this.sections[Math.min(sect, this.sections.length - 1)]?.grid;
    const pitch = grid && P.snap !== false ? grid.pitch : 0;
    if (pitch > 0) single = pitch * Math.max(1, Math.ceil(single / pitch - 1e-6));
    let h: number;
    if (rule === 'atLeast') h = Math.max(P.line ? twipsToPx(P.line.val) : 0, single);
    else h = (P.line && P.line.val > 0 ? P.line.val / 240 : 1) * single;
    return h > 0 ? round1(Math.min(h, 2000)) : undefined;
  }

  // ───────────── 글자 모양 ─────────────

  private fontName(f: FontRef | undefined): string | undefined {
    if (!f) return undefined;
    return 'name' in f ? sanitizeFont(f.name) : themeFont(this.theme, f.theme);
  }

  private runStyle(R: RProps, text: string, under: string | undefined): { s: RunOut; key: string } {
    const s: RunOut = {};
    // 크기를 어디서도 정하지 않은 글자는 비워 둔다(쪽 나눔 어림은 문단 표지 크기로 잰다). 모델에는 Word 기본
    // 10pt 를 채운다(emit.ts)
    if (R.sz !== undefined) s.sz = R.sz / 2;
    if (R.b) s.b = true;
    if (R.i) s.i = true;
    if (R.u) s.u = true;
    if (R.strike || R.dstrike) s.strike = true;
    // 모르는 형광펜 이름(Object.prototype 키 포함)은 형광펜 없음으로 본다
    const hl = R.highlight && R.highlight !== 'none' ? own(HIGHLIGHT, R.highlight) : undefined;
    const back = hl ?? (R.shd && R.shd !== 'none' ? R.shd : undefined);
    let color = R.color && R.color !== 'auto' ? R.color : undefined;
    if (!color) {
      const bg = back ?? under;
      if (bg && luminance(bg) < 0.4) color = '#ffffff';
    }
    if (color && color !== '#000000') s.color = color;
    const ea = hasEastAsian(text);
    const font = ea
      ? (this.fontName(R.fEastAsia) ?? this.fontName(R.fAscii))
      : (this.fontName(R.fAscii) ?? this.fontName(R.fHAnsi) ?? this.fontName(R.fEastAsia));
    if (font) s.font = font;
    if (R.vertAlign === 'superscript') s.sup = true;
    else if (R.vertAlign === 'subscript') s.sub = true;
    if (back) s.bg = back;
    return { s, key: JSON.stringify(s) };
  }

  private resolveRun(r: XElement, runBase: RProps): RProps {
    const rPr = childEl(r, 'w:rPr');
    const rs = rPr ? childEl(rPr, 'w:rStyle') : undefined;
    return { ...runBase, ...this.styles.char(rs ? attr(rs, 'w:val') : undefined), ...readRPr(rPr, this.cc) };
  }

  // ───────────── 글자 안 ─────────────

  private inline(el: XElement, pc: ParaCtx): void {
    if (this.nesting > MAX_NESTING) return;
    this.nesting += 1;
    try {
      this.inlineChildren(el, pc);
    } finally {
      this.nesting -= 1;
    }
  }

  private inlineChildren(el: XElement, pc: ParaCtx): void {
    for (const c of el.children) {
      if (c.type !== 'el') continue;
      switch (c.name) {
        case 'w:r':
          this.run(c, pc);
          break;
        case 'w:hyperlink':
        case 'w:smartTag':
        case 'w:customXml':
        case 'w:dir':
        case 'w:bdo':
        case 'w:ins':
        case 'w:moveTo':
          this.inline(c, pc);
          break;
        case 'w:sdt': {
          const sc = childEl(c, 'w:sdtContent');
          if (sc) this.inline(sc, pc);
          break;
        }
        case 'w:fldSimple':
          this.fldSimple(c, pc);
          break;
        case 'm:oMath':
        case 'm:oMathPara':
          this.math(c, pc);
          break;
        case 'mc:AlternateContent': {
          const br = chooseBranch(c);
          if (br) this.inline(br, pc);
          break;
        }
        default:
          break; // w:pPr, w:del, w:moveFrom, 책갈피, 교정/권한/메모 표지
      }
    }
  }

  private pagePlaceholder(pc: ParaCtx, R: RProps, field: NonNullable<IRText['pf']>): void {
    const st = this.runStyle(R, '1', pc.scope.bg);
    pc.b.push({ k: 't', t: '#', s: st.s, key: 'pf', pf: field });
  }

  private fldSimple(el: XElement, pc: ParaCtx): void {
    const pf = pc.story.kind === 'header' ? parsePageField(attr(el, 'w:instr') ?? '') : undefined;
    if (pf) {
      if (!pc.story.fields.visible()) return;
      const r0 = childEl(el, 'w:r');
      this.pagePlaceholder(pc, r0 ? this.resolveRun(r0, pc.runBase) : pc.runBase, pf);
      return;
    }
    this.inline(el, pc);
  }

  private math(el: XElement, pc: ParaCtx): void {
    if (!pc.story.fields.visible()) return;
    const parts: string[] = [];
    const walk = (e: XElement, depth: number): void => {
      if (depth > MAX_NESTING) return;
      for (const c of e.children) {
        if (c.type !== 'el') continue;
        if (c.name === 'm:t') parts.push(textOf(c));
        else walk(c, depth + 1);
      }
    };
    walk(el, 0);
    const t = parts.join('');
    if (t === '') return;
    const st = this.runStyle({ ...pc.runBase, i: true }, t, pc.scope.bg);
    pc.b.text(t, st.s, st.key);
  }

  private run(r: XElement, pc: ParaCtx): void {
    const R = this.resolveRun(r, pc.runBase);
    let style: { s: RunOut; key: string } | undefined;
    const getStyle = (): { s: RunOut; key: string } => {
      style ??= this.runStyle(R, runText(r), pc.scope.bg);
      return style;
    };
    this.runChildren(r, R, getStyle, pc);
  }

  private runChildren(
    container: XElement,
    R: RProps,
    getStyle: () => { s: RunOut; key: string },
    pc: ParaCtx,
  ): void {
    const { b, story, scope } = pc;
    const fields = story.fields;
    const hidden = R.vanish === true;
    const shown = (): boolean => !hidden && fields.visible();
    const emit = (text: string): void => {
      if (!shown()) return;
      if (story.kind === 'header') {
        const pr = fields.pageResult();
        if (pr === 'skip') return;
        if (pr) {
          this.pagePlaceholder(pc, R, pr);
          return;
        }
      }
      const st = getStyle();
      b.text(R.caps ? upper(text) : text, st.s, st.key);
    };
    for (const c of container.children) {
      if (c.type !== 'el') continue;
      switch (c.name) {
        case 'w:t':
          emit(textOf(c));
          break;
        case 'w:tab':
          emit('\t');
          break;
        case 'w:ptab': {
          // 머리말/꼬리말의 위치 탭(가운데, 오른쪽 정렬): 뒤 글자를 그 정렬로 따로 그리도록 표지를 단다(emit.ts
          // HeaderPart). 글자는 그대로 '\t' 라 쪽 나눔 어림의 머리말 높이는 바뀌지 않는다. 본문은 '\t' 그대로
          const al = attr(c, 'w:alignment');
          if (story.kind === 'header' && fields.depth() === 0 && shown() && (al === 'center' || al === 'right')) {
            const st = getStyle();
            b.push({ k: 't', t: '\t', s: st.s, key: `${st.key}|ptab`, ptab: al });
          } else {
            emit('\t');
          }
          break;
        }
        case 'w:br': {
          const type = attr(c, 'w:type');
          // 쪽 나눔은 본문 흐름(표 칸 안 포함)에서 쪽 경계. 표 칸 안의 쪽 나눔도 Word 는 그 행 앞에서 새 쪽을
          // 시작한다(실물 docx/PDF 짝에서 확인: 칸 내용 맨 앞의 쪽 나눔 68건, 그중 51건은 Word 가 lrpb 도 적음)
          if (type === 'page' && story.kind === 'body' && scope.box === 0) {
            if (shown()) b.push({ k: 'pb' });
          } else {
            emit('\n');
          }
          break;
        }
        case 'w:cr':
          emit('\n');
          break;
        case 'w:sym': {
          const code = parseInt(attr(c, 'w:char') ?? '', 16);
          if (!Number.isFinite(code) || code <= 0 || code > 0xffff || !shown()) break;
          const st = getStyle();
          const font = sanitizeFont(attr(c, 'w:font'));
          const s: RunOut = font ? { ...st.s, font } : st.s;
          b.text(String.fromCharCode(code), s, font ? JSON.stringify(s) : st.key);
          break;
        }
        case 'w:noBreakHyphen':
          emit('-');
          break;
        case 'w:fldChar': {
          const t = attr(c, 'w:fldCharType');
          if (t === 'begin') fields.begin();
          else if (t === 'separate') fields.separate();
          else if (t === 'end') {
            const pf = fields.end();
            if (pf && story.kind === 'header' && !hidden) this.pagePlaceholder(pc, R, pf);
          }
          break;
        }
        case 'w:instrText':
          fields.instr(textOf(c));
          break;
        case 'w:lastRenderedPageBreak':
          if (story.kind === 'body' && scope.box === 0) {
            b.push({ k: 'lrpb' });
            this.lrpbCount += 1;
          }
          break;
        case 'w:footnoteReference':
        case 'w:endnoteReference':
          if (shown()) this.noteRef(c, pc, getStyle);
          break;
        case 'w:footnoteRef':
        case 'w:endnoteRef': {
          if (!shown() || !story.noteKey) break;
          const id = story.noteKey.slice(2);
          const foot = story.noteKey.startsWith('f:');
          const n = (foot ? this.footNums : this.endNums).get(id);
          if (n === undefined || n === null) break; // 사용자 지정 표지 각주: 각주 글에 표지를 직접 적는다
          const st = getStyle();
          const s: RunOut = { ...st.s, sup: true };
          delete s.sub;
          b.text(formatNumber(n, foot ? this.settings.footFmt : this.settings.endFmt), s, JSON.stringify(s));
          break;
        }
        case 'w:drawing':
          if (shown()) this.drawing(c, pc);
          break;
        case 'w:pict':
        case 'w:object':
          if (shown()) this.vml(c, pc, 0, null);
          break;
        case 'mc:AlternateContent': {
          const br = chooseBranch(c);
          if (br && this.nesting <= MAX_NESTING) {
            this.nesting += 1;
            try {
              this.runChildren(br, R, getStyle, pc);
            } finally {
              this.nesting -= 1;
            }
          }
          break;
        }
        case 'w:ruby': {
          const base = childEl(c, 'w:rubyBase');
          if (base) this.inline(base, pc);
          break;
        }
        case 'w:pgNum':
          if (story.kind === 'header' && shown()) this.pagePlaceholder(pc, R, { kind: 'PAGE' });
          break;
        default:
          break; // w:rPr, w:delText, w:delInstrText, w:softHyphen, 메모 참조 등
      }
    }
  }

  private noteRef(c: XElement, pc: ParaCtx, getStyle: () => { s: RunOut; key: string }): void {
    if (pc.story.kind !== 'body') return;
    const id = attr(c, 'w:id');
    if (id === undefined) return;
    const foot = c.name === 'w:footnoteReference';
    const map = foot ? this.footNums : this.endNums;
    pc.b.push({ k: 'note', key: (foot ? 'f:' : 'e:') + id });
    // 사용자 지정 표지(customMarkFollows) 참조는 번호를 쓰지도 세지도 않는다: 뒤따르는 글자가 표지다.
    // ECMA-376 Part 4 footnoteReference@customMarkFollows: '... shall not increment the numbering ...
    // the first footnote shall be I, the second is suppressed, and the third is II'
    const custom = attr(c, 'w:customMarkFollows');
    if (custom === '1' || custom === 'true' || custom === 'on') {
      if (!map.has(id)) map.set(id, null);
      return;
    }
    let n = map.get(id) ?? undefined;
    if (n === undefined) {
      if (foot) {
        n = this.settings.footStart + this.footCount;
        this.footCount += 1;
      } else {
        n = this.settings.endStart + this.endCount;
        this.endCount += 1;
      }
      map.set(id, n);
    }
    const st = getStyle();
    const s: RunOut = { ...st.s, sup: true };
    delete s.sub;
    pc.b.text(formatNumber(n, foot ? this.settings.footFmt : this.settings.endFmt), s, JSON.stringify(s));
  }

  // ───────────── 그림, 글상자 ─────────────

  private mediaFor(story: Story, rid: string | undefined): number | undefined {
    if (!rid) return undefined;
    const rel = story.rels.get(rid);
    if (!rel || !this.pkg.has(rel.target)) return undefined;
    const ext = /\.([^./]+)$/.exec(rel.target)?.[1]?.toLowerCase();
    const mime = own(IMAGE_MIME, ext);
    if (!mime) return undefined;
    let idx = this.mediaIndex.get(rel.target);
    if (idx === undefined) {
      idx = this.media.length;
      this.media.push({ path: rel.target, mime });
      this.mediaIndex.set(rel.target, idx);
    }
    return idx;
  }

  private drawing(d: XElement, pc: ParaCtx): void {
    for (const c of d.children) {
      if (c.type !== 'el' || (c.name !== 'wp:inline' && c.name !== 'wp:anchor')) continue;
      const ext = childEl(c, 'wp:extent');
      const size = { cx: num(ext ? attr(ext, 'cx') : undefined) ?? 0, cy: num(ext ? attr(ext, 'cy') : undefined) ?? 0 };
      const gd = childPath(c, 'a:graphic', 'a:graphicData');
      const inline = c.name === 'wp:inline';
      // 떠 있는 그림은 '위아래 배치'일 때만 본문을 밀어낸다(정사각형, 빽빽하게, 글 앞/뒤는 글자가 옆으로 흐른다)
      const flow = inline || childEl(c, 'wp:wrapTopAndBottom') !== undefined;
      if (gd) this.graphic(gd, size, inline, flow, pc, 0);
    }
  }

  private graphic(
    container: XElement,
    size: { cx: number; cy: number },
    inline: boolean,
    flow: boolean,
    pc: ParaCtx,
    depth: number,
  ): void {
    if (depth > 8) return;
    for (const g of container.children) {
      if (g.type !== 'el') continue;
      const ln = localName(g.name);
      if (ln === 'pic') this.picture(g, size, inline, flow, pc);
      else if (ln === 'wsp') this.shape(g, size, pc);
      else if (ln === 'wgp' || ln === 'grpSp' || ln === 'wpc' || ln === 'lockedCanvas') {
        this.group(g, size, inline, flow, pc, depth + 1);
      }
    }
  }

  /** 묶음 개체: 자식 크기는 묶음의 화면 크기 / 자식 좌표계 크기(chExt) 비율로 맞춘다 */
  private group(
    g: XElement,
    size: { cx: number; cy: number },
    inline: boolean,
    flow: boolean,
    pc: ParaCtx,
    depth: number,
  ): void {
    if (depth > 8) return;
    const xfrm = kid(kid(g, 'grpSpPr'), 'xfrm');
    const chExt = kid(xfrm, 'chExt');
    const chx = num(chExt ? attr(chExt, 'cx') : undefined) ?? 0;
    const chy = num(chExt ? attr(chExt, 'cy') : undefined) ?? 0;
    const sx = chx > 0 && size.cx > 0 ? size.cx / chx : 1;
    const sy = chy > 0 && size.cy > 0 ? size.cy / chy : 1;
    for (const c of g.children) {
      if (c.type !== 'el') continue;
      const ln = localName(c.name);
      if (ln !== 'pic' && ln !== 'wsp' && ln !== 'grpSp' && ln !== 'wgp') continue;
      const cx = kid(kid(c, ln === 'grpSp' || ln === 'wgp' ? 'grpSpPr' : 'spPr'), 'xfrm');
      const ext = kid(cx, 'ext');
      const child = {
        cx: (num(ext ? attr(ext, 'cx') : undefined) ?? 0) * sx,
        cy: (num(ext ? attr(ext, 'cy') : undefined) ?? 0) * sy,
      };
      if (ln === 'pic') this.picture(c, child, inline, flow, pc);
      else if (ln === 'wsp') this.shape(c, child, pc);
      else this.group(c, child, inline, flow, pc, depth + 1);
    }
  }

  private picture(pic: XElement, size: { cx: number; cy: number }, inline: boolean, flow: boolean, pc: ParaCtx): void {
    const blip = descendantLocal(pic, 'blip');
    const idx = blip ? this.mediaFor(pc.story, attr(blip, 'r:embed')) : undefined;
    if (idx === undefined) return;
    let { cx, cy } = size;
    if (cx <= 0 || cy <= 0) {
      const ext = kid(kid(kid(pic, 'spPr'), 'xfrm'), 'ext');
      cx = num(ext ? attr(ext, 'cx') : undefined) ?? 0;
      cy = num(ext ? attr(ext, 'cy') : undefined) ?? 0;
    }
    if (cx <= 0 || cy <= 0) return;
    const img: IRImage = { k: 'img', media: idx, w: Math.max(1, emuToPx(cx)), h: Math.max(1, emuToPx(cy)), inline, flow };
    // 잘라 낸 그림: 틀(cx, cy)은 잘라 낸 뒤 크기다. 잘라 낸 값을 두어 화면이 원본을 눌러 넣지 않게 한다(../crop.ts)
    const crop = cropFromSrcRect(descendantLocal(pic, 'srcRect'));
    if (crop) img.crop = crop;
    pc.b.push(img);
  }

  private shape(wsp: XElement, size: { cx: number; cy: number }, pc: ParaCtx): void {
    const content = childEl(kid(wsp, 'txbx') ?? wsp, 'w:txbxContent');
    if (!content || !kid(wsp, 'txbx')) return;
    const ln = kid(kid(wsp, 'spPr'), 'ln');
    let border: boolean;
    if (ln) border = !kid(ln, 'noFill');
    else {
      const lnRef = kid(kid(wsp, 'style'), 'lnRef');
      border = (num(lnRef ? attr(lnRef, 'idx') : undefined) ?? 0) > 0;
    }
    this.textBox(content, size.cx > 0 ? emuToPx(size.cx) : undefined, border, pc);
  }

  private textBox(content: XElement, w: number | undefined, border: boolean, pc: ParaCtx): void {
    if (pc.scope.box >= MAX_BOX_DEPTH) return;
    const blocks: IRBlock[] = [];
    const scope: Scope = { depth: pc.scope.depth, box: pc.scope.box + 1, width: w ?? pc.scope.width };
    if (pc.scope.bg) scope.bg = pc.scope.bg;
    // 글상자 안 문단의 번호, 필드는 같은 이야기에서 문서 순서대로
    this.blocks(content, pc.story, scope, blocks);
    this.post(blocks);
    if (!blocks.some(blockVisible)) return;
    const box: IRItem = { k: 'box', blocks, border };
    if (w !== undefined && w > 0) box.w = w;
    pc.b.push(box);
  }

  private vml(el: XElement, pc: ParaCtx, depth: number, scale: { sx: number; sy: number } | null): void {
    if (depth > 8) return;
    for (const c of el.children) {
      if (c.type !== 'el') continue;
      if (c.name === 'v:group') {
        const st = vmlStyle(attr(c, 'style'));
        const gw = vmlLen(st.get('width'), scale ? scale.sx : null);
        const gh = vmlLen(st.get('height'), scale ? scale.sy : null);
        const [csw, csh] = (attr(c, 'coordsize') ?? '1000,1000').split(',').map((v) => Number(v));
        const sx = csw && csw > 0 && gw > 0 ? gw / csw : 1;
        const sy = csh && csh > 0 && gh > 0 ? gh / csh : 1;
        this.vml(c, pc, depth + 1, { sx, sy });
      } else if (
        c.name === 'v:shape' ||
        c.name === 'v:rect' ||
        c.name === 'v:roundrect' ||
        c.name === 'v:oval' ||
        c.name === 'v:image'
      ) {
        const st = vmlStyle(attr(c, 'style'));
        const w = vmlLen(st.get('width'), scale ? scale.sx : null);
        const h = vmlLen(st.get('height'), scale ? scale.sy : null);
        const imagedata = childEl(c, 'v:imagedata');
        if (imagedata) {
          const idx = this.mediaFor(pc.story, attr(imagedata, 'r:id') ?? attr(imagedata, 'o:relid'));
          if (idx !== undefined && w > 0 && h > 0) {
            const inline = (st.get('position') ?? '') !== 'absolute';
            const wrap = childEl(c, 'w10:wrap');
            const flow = inline || (wrap !== undefined && attr(wrap, 'type') === 'topAndBottom');
            const img: IRImage = { k: 'img', media: idx, w: Math.max(1, round1(w)), h: Math.max(1, round1(h)), inline, flow };
            const crop = cropFromVml(imagedata);
            if (crop) img.crop = crop;
            pc.b.push(img);
          }
        }
        const tb = childEl(c, 'v:textbox');
        const content = tb ? childEl(tb, 'w:txbxContent') : undefined;
        if (content) {
          const stroked = attr(c, 'stroked');
          const stroke = childEl(c, 'v:stroke');
          const on = stroke ? attr(stroke, 'on') : undefined;
          const border = !(stroked === 'f' || stroked === 'false') && !(on === 'f' || on === 'false');
          this.textBox(content, w > 0 ? round1(w) : undefined, border, pc);
        }
      } else if (c.name === 'w:drawing') {
        this.drawing(c, pc);
      }
    }
  }

  // ───────────── 표 ─────────────

  private table(tbl: XElement, story: Story, scope: Scope, out: IRBlock[]): void {
    const rowsEl = collectRows(tbl);
    if (scope.depth >= MAX_TABLE_DEPTH) {
      // 너무 깊은 중첩 표: 칸 안 내용을 문단으로 펼친다
      for (const tr of rowsEl) for (const tc of collectCells(tr)) this.blocks(tc, story, scope, out);
      return;
    }
    const top = story.kind === 'body' && scope.depth === 0 && scope.box === 0;
    const avail = top ? this.textWidth(story.sect) : scope.width;
    const tblPr = childEl(tbl, 'w:tblPr');
    const tsEl = tblPr ? childEl(tblPr, 'w:tblStyle') : undefined;
    const ts = this.styles.table(tsEl ? attr(tsEl, 'w:val') : undefined);
    const tp = mergeTbl(mergeTbl(emptyTbl(), ts.whole.tbl), readTblPr(tblPr, this.cc));
    const look = readLook(tblPr ? childEl(tblPr, 'w:tblLook') : undefined);
    const gridEl = childEl(tbl, 'w:tblGrid');
    const grid = (gridEl ? childEls(gridEl, 'w:gridCol') : []).map((g) => Math.max(0, twipsAttr(attr(g, 'w:w')) ?? 0));
    const width = widthPx(tp.w, avail);
    const gridSum = grid.reduce((a, b) => a + b, 0);
    const tableW = width ?? (gridSum > 0 ? twipsToPx(gridSum) : avail);
    const nRows = rowsEl.length;
    const rows: IRRow[] = [];
    const rowBand = tp.rowBand ?? 1;
    const colBand = tp.colBand ?? 1;

    for (let r = 0; r < nRows; r += 1) {
      if (this.halted(story)) break;
      const tr = rowsEl[r]!;
      const trPr = childEl(tr, 'w:trPr');
      const ex = childEl(tr, 'w:tblPrEx');
      const rt: TblProps = ex ? mergeTbl(mergeTbl(emptyTbl(), tp), readTblPr(ex, this.cc)) : tp;
      const tcs = collectCells(tr);
      const nCells = tcs.length;
      const cells: IRCell[] = [];
      let col = 0;
      const gridBefore = intVal(trPr, 'w:gridBefore');
      const gridAfter = intVal(trPr, 'w:gridAfter');
      if (gridBefore > 0) {
        const filler: IRCell = { blocks: [], col, span: gridBefore, filler: true };
        const wb = widthPx(this.wAttr(trPr, 'w:wBefore'), tableW);
        if (wb) filler.w = wb;
        cells.push(filler);
        col += gridBefore;
      }
      for (let ci = 0; ci < nCells; ci += 1) {
        if (this.halted(story)) break;
        const tc = tcs[ci]!;
        const tcPr = childEl(tc, 'w:tcPr');
        const span = Math.max(1, intVal(tcPr, 'w:gridSpan') || 1);
        const conds = this.condsFor(r, ci, nRows, nCells, look, rowBand, colBand, ts.cond);
        const cellP: PProps = mergePPr(ts.whole.p, ...conds.map(([, c]) => c.p));
        const cellR: RProps = Object.assign({}, ts.whole.r, ...conds.map(([, c]) => c.r));
        const styleTc = conds.reduce((acc, [, c]) => mergeTc(acc, c.tc), mergeTc(emptyTc(), ts.whole.tc));
        const direct = readTcPr(tcPr, this.cc);
        const shd = direct.shd ?? styleTc.shd;
        const bg = shd && shd !== 'none' ? shd : undefined;
        const cw = tcPr ? childEl(tcPr, 'w:tcW') : undefined;
        const w = cw ? widthPx({ v: attr(cw, 'w:w') ?? '', type: attr(cw, 'w:type') ?? 'dxa' }, tableW) : undefined;
        const cellScope: Scope = { depth: scope.depth + 1, box: scope.box, tbl: { p: cellP, r: cellR }, width: w ?? tableW };
        const under = bg ?? scope.bg;
        if (under) cellScope.bg = under;
        const blocks: IRBlock[] = [];
        this.blocks(tc, story, cellScope, blocks);
        this.post(blocks);

        const hm = tcPr ? childEl(tcPr, 'w:hMerge') : undefined;
        const prevCell = cells[cells.length - 1];
        if (hm && attr(hm, 'w:val') !== 'restart' && prevCell && !prevCell.filler) {
          // 옛 가로 병합: 앞 칸에 합친다
          prevCell.span += span;
          for (const b of blocks) if (blockVisible(b)) prevCell.blocks.push(b);
          col += span;
          continue;
        }

        const cell: IRCell = { blocks, col, span };
        const vmEl = tcPr ? childEl(tcPr, 'w:vMerge') : undefined;
        if (vmEl) cell.vm = attr(vmEl, 'w:val') === 'restart' ? 'restart' : 'continue';
        if (w) cell.w = w;
        if (bg) cell.bg = bg;
        const va = direct.vAlign ?? styleTc.vAlign;
        if (va === 'center') cell.va = 'middle';
        else if (va === 'bottom') cell.va = 'bottom';
        const mar = { top: 0, right: 108, bottom: 0, left: 108, ...rt.cellMar, ...styleTc.mar, ...direct.mar };
        const pad: [number, number, number, number] = [
          twipsToPx(mar.top),
          twipsToPx(mar.right),
          twipsToPx(mar.bottom),
          twipsToPx(mar.left),
        ];
        cell.pad = pad;
        this.cellBorders(cell, rt, ts.whole.tc.borders, conds, direct.borders, r === 0, r === nRows - 1, ci === 0, ci === nCells - 1);
        cells.push(cell);
        col += span;
      }
      if (gridAfter > 0) {
        const filler: IRCell = { blocks: [], col, span: gridAfter, filler: true };
        const wa = widthPx(this.wAttr(trPr, 'w:wAfter'), tableW);
        if (wa) filler.w = wa;
        cells.push(filler);
      }
      const row: IRRow = { cells };
      const th = trPr ? childEl(trPr, 'w:trHeight') : undefined;
      if (th) {
        const v = twipsAttr(attr(th, 'w:val'));
        const rule = attr(th, 'w:hRule') ?? 'atLeast';
        if (v !== undefined && v > 0 && rule !== 'auto') {
          row.h = twipsToPx(v);
          row.hRule = rule === 'exact' ? 'exact' : 'atLeast';
        }
      }
      if (trPr && onOff(childEl(trPr, 'w:tblHeader'))) row.header = true;
      if (trPr && onOff(childEl(trPr, 'w:cantSplit'))) row.cantSplit = true;
      rows.push(row);
    }
    if (rows.length === 0) return;
    const t: IRTable = { k: 'tbl', rows, sect: story.sect };
    if (grid.length > 0) t.colWidths = grid.map((g) => twipsToPx(g));
    if (width) t.width = width;
    if (tp.jc === 'center') t.align = 'center';
    else if (tp.jc === 'right' || tp.jc === 'end') t.align = 'right';
    if (tp.ind) {
      const ind = twipsToPx(tp.ind);
      if (ind) t.indent = ind;
    }
    out.push(t);
  }

  private wAttr(trPr: XElement | undefined, name: string): { v: string; type: string } | undefined {
    const el = trPr ? childEl(trPr, name) : undefined;
    return el ? { v: attr(el, 'w:w') ?? '', type: attr(el, 'w:type') ?? 'dxa' } : undefined;
  }

  /** 이 칸에 적용되는 표 스타일 조건부 서식 (낮은 우선순위부터) */
  private condsFor(
    r: number,
    ci: number,
    nRows: number,
    nCells: number,
    look: Look,
    rowBand: number,
    colBand: number,
    cond: Map<string, CondFmt>,
  ): [string, CondFmt][] {
    const names: string[] = [];
    const lastRow = look.lastRow && r === nRows - 1;
    const lastCol = look.lastCol && ci === nCells - 1;
    if (!look.noVBand) {
      const idx = ci - (look.firstCol ? 1 : 0);
      if (idx >= 0 && !lastCol) names.push(Math.floor(idx / colBand) % 2 === 0 ? 'band1Vert' : 'band2Vert');
    }
    if (!look.noHBand) {
      const idx = r - (look.firstRow ? 1 : 0);
      if (idx >= 0 && !lastRow) names.push(Math.floor(idx / rowBand) % 2 === 0 ? 'band1Horz' : 'band2Horz');
    }
    if (look.firstCol && ci === 0) names.push('firstCol');
    if (lastCol) names.push('lastCol');
    if (look.firstRow && r === 0) names.push('firstRow');
    if (lastRow) names.push('lastRow');
    if (look.firstRow && r === 0 && look.firstCol && ci === 0) names.push('nwCell');
    if (look.firstRow && r === 0 && lastCol) names.push('neCell');
    if (lastRow && look.firstCol && ci === 0) names.push('swCell');
    if (lastRow && lastCol) names.push('seCell');
    const out: [string, CondFmt][] = [];
    for (const n of names) {
      const c = cond.get(n);
      if (c) out.push([n, c]);
    }
    return out;
  }

  /** 칸 네 변: 표 테두리(위치에 따라 바깥/안쪽) → 표 스타일 칸 테두리 → 조건부 → 칸 직접 */
  private cellBorders(
    cell: IRCell,
    tp: TblProps,
    whole: TblProps['borders'],
    conds: [string, CondFmt][],
    direct: TblProps['borders'],
    firstRow: boolean,
    lastRow: boolean,
    firstCell: boolean,
    lastCell: boolean,
  ): void {
    const T = tp.borders;
    let top = firstRow ? T.top : T.insideH;
    let bottom = lastRow ? T.bottom : T.insideH;
    let left = firstCell ? T.left : T.insideV;
    let right = lastCell ? T.right : T.insideV;
    top = whole.top ?? top;
    bottom = whole.bottom ?? bottom;
    left = whole.left ?? left;
    right = whole.right ?? right;
    for (const [name, c] of conds) {
      const B = c.tc.borders;
      if (ROW_CONDS.has(name)) {
        top = B.top ?? top;
        bottom = B.bottom ?? bottom;
        left = (firstCell ? B.left : B.insideV) ?? left;
        right = (lastCell ? B.right : B.insideV) ?? right;
      } else if (COL_CONDS.has(name)) {
        left = B.left ?? left;
        right = B.right ?? right;
        top = (firstRow ? B.top : B.insideH) ?? top;
        bottom = (lastRow ? B.bottom : B.insideH) ?? bottom;
      } else {
        top = B.top ?? top;
        bottom = B.bottom ?? bottom;
        left = B.left ?? left;
        right = B.right ?? right;
      }
    }
    top = direct.top ?? top;
    bottom = direct.bottom ?? bottom;
    left = direct.left ?? left;
    right = direct.right ?? right;
    const bt = borderModel(top);
    const bb = borderModel(bottom);
    const bl = borderModel(left);
    const br = borderModel(right);
    if (bt) cell.bt = bt;
    if (bb) cell.bb = bb;
    if (bl) cell.bl = bl;
    if (br) cell.br = br;
  }
}
