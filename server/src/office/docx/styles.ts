/**
 * 서식 해석: docDefaults, 스타일(basedOn 사슬), 표 스타일(조건부 서식 포함)
 *
 * 속성 한 겹(layer)은 '이 겹이 정한 값만 키로 가진 객체'다. 겹을 앞에서부터 Object.assign 으로 덮으면
 * 해석 결과가 된다. 그래서 사슬은 '바탕 스타일 먼저, 파생 스타일이 덮어쓰기'가 저절로 성립한다.
 *
 * 켜고 끄는 속성(b, i, strike, caps, vanish ...): 사양은 스타일 사슬 안에서 XOR(뒤집기)로 정하지만
 * 여기서는 단순하게 마지막으로 정한 값이 이긴다. 실물 문서에서 스타일 사슬로 뒤집는 경우는 드물다.
 *
 * 들여쓰기와 문단 간격: twips 값과 글자(줄) 단위 값은 따로 물려받는다(Word 안에서 서로 다른 속성이다).
 * 그래서 한 겹이 leftChars="0" 만 정하면 글자 단위 값만 0 이 되고 twips 값은 아래 겹(번호 단계, 스타일)의
 * 것을 그대로 쓴다. 실물 docx 88개에서 직접 서식 <w:ind w:leftChars="0"/> 만 있는 문단이 3,860개였고, 그 쪽을
 * 통째로 바꾸면 번호 단계의 왼쪽 들여쓰기(800 twips)가 사라져 번호 문단이 Word 보다 53px 왼쪽에 그려졌다(PDF 짝 대조).
 * 첫 줄 들여쓰기는 firstLine(+)과 hanging(-)이 한 속성이다(둘 다 있으면 hanging, 사양 17.3.1.12).
 * 글자 단위 값이 0 이 아니면 그것이 twips 값보다 우선한다(사양 17.3.1.12). 겹 합치기는 mergePPr.
 */
import { attr, childEl, type XElement } from '../xml.js';
import { themeColor, type Theme } from './theme.js';
import { hexColor, mix, num, onOff, own, twipsAttr } from './units.js';

/** 테두리 한 변. val 이 'none'/'nil' 이면 '테두리 없음'을 명시한 것 */
export interface BorderSpec {
  val: string;
  /** 1/8 pt */
  sz?: number;
  /** '#rrggbb' (auto 는 undefined) */
  color?: string;
}

export type FontRef = { name: string } | { theme: string };

export interface RProps {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  dstrike?: boolean;
  caps?: boolean;
  vanish?: boolean;
  /** 반 포인트 */
  sz?: number;
  /** '#rrggbb' 또는 'auto' */
  color?: string;
  /** '#rrggbb' 또는 'none' */
  highlight?: string;
  /** 글자 음영 '#rrggbb' 또는 'none' */
  shd?: string;
  vertAlign?: string;
  fAscii?: FontRef;
  fHAnsi?: FontRef;
  fEastAsia?: FontRef;
}

export interface IndSide {
  twips?: number;
  chars?: number;
}

export interface PProps {
  jc?: string;
  indLeft?: IndSide;
  indRight?: IndSide;
  /** 첫 줄 들여쓰기: firstLine 은 +, hanging 은 - (twips, 글자 단위 1/100 각각) */
  indFirst?: IndSide;
  /**
   * 쪽 나눔 어림(estimate.ts)용 들여쓰기: 한 겹이 그 쪽의 값을 하나라도 정하면 그 겹 값으로 통째로 바꾼다
   * (예전 규칙). 어림은 이 값으로 맞춰져 있어, 바로잡은 값을 넣으면 실물 88개 중 11개의 쪽 경계가
   * 바뀌었다(쪽 수는 같았고, PDF 짝 1개는 경계가 Word 와 더 어긋났다). 화면에는 indLeft 등 바로잡은 값을 쓴다
   */
  indLeftL?: IndSide;
  indRightL?: IndSide;
  indFirstL?: IndSide;
  spBefore?: { twips?: number; lines?: number };
  spAfter?: { twips?: number; lines?: number };
  spBeforeAuto?: boolean;
  spAfterAuto?: boolean;
  line?: { val: number; rule: string };
  /** '#rrggbb' 또는 'none' */
  shd?: string;
  bdrTop?: BorderSpec;
  bdrBottom?: BorderSpec;
  bdrLeft?: BorderSpec;
  bdrRight?: BorderSpec;
  bdrBetween?: BorderSpec;
  pageBreakBefore?: boolean;
  keepNext?: boolean;
  contextual?: boolean;
  /** w:snapToGrid: 문서 격자(docGrid)에 줄을 맞추는가. 정하지 않으면 맞춘다(사양 17.3.1.32) */
  snap?: boolean;
  numId?: string;
  ilvl?: number;
}

/** 한 쪽 들여쓰기(또는 간격) 겹치기: 정한 값만 덮는다 */
function mergeSide<T extends object>(base: T | undefined, layer: T | undefined): T | undefined {
  if (!layer) return base;
  return base ? { ...base, ...layer } : { ...layer };
}

/**
 * 문단 속성 겹을 아래(앞)부터 덮는다. 들여쓰기와 문단 간격은 twips 값과 글자(줄) 단위 값을 따로 덮는다
 * (머리 주석). 나머지는 그 겹이 정한 속성이 통째로 이긴다.
 */
export function mergePPr(...layers: (PProps | undefined)[]): PProps {
  const out: PProps = {};
  for (const l of layers) {
    if (!l) continue;
    const { indLeft, indRight, indFirst, spBefore, spAfter, ...rest } = l;
    Object.assign(out, rest);
    const left = mergeSide(out.indLeft, indLeft);
    const right = mergeSide(out.indRight, indRight);
    const first = mergeSide(out.indFirst, indFirst);
    const before = mergeSide(out.spBefore, spBefore);
    const after = mergeSide(out.spAfter, spAfter);
    if (left) out.indLeft = left;
    if (right) out.indRight = right;
    if (first) out.indFirst = first;
    if (before) out.spBefore = before;
    if (after) out.spAfter = after;
  }
  return out;
}

export type Side = 'top' | 'left' | 'bottom' | 'right' | 'insideH' | 'insideV';
export type MarSide = 'top' | 'left' | 'bottom' | 'right';

export interface TblProps {
  borders: Partial<Record<Side, BorderSpec>>;
  /** 칸 안쪽 여백 twips */
  cellMar: Partial<Record<MarSide, number>>;
  jc?: string;
  /** twips */
  ind?: number;
  w?: { v: string; type: string };
  rowBand?: number;
  colBand?: number;
}

export interface TcProps {
  borders: Partial<Record<Side, BorderSpec>>;
  /** '#rrggbb' 또는 'none' */
  shd?: string;
  vAlign?: string;
  mar: Partial<Record<MarSide, number>>;
}

/** 표 스타일의 한 조건(전체 또는 firstRow 등)이 정한 서식 */
export interface CondFmt {
  p: PProps;
  r: RProps;
  tc: TcProps;
  tbl: TblProps;
}

export interface TableStyle {
  whole: CondFmt;
  cond: Map<string, CondFmt>;
}

export interface ColorCtx {
  theme: Theme;
  clrMap: Readonly<Record<string, string>>;
}

export function emptyTbl(): TblProps {
  return { borders: {}, cellMar: {} };
}

export function emptyTc(): TcProps {
  return { borders: {}, mar: {} };
}

function emptyCond(): CondFmt {
  return { p: {}, r: {}, tc: emptyTc(), tbl: emptyTbl() };
}

// ─────────────────────────────── 값 읽기 ───────────────────────────────

/** w:color 같은 색 요소: themeColor 가 있으면 테마에서, 아니면 w:val. 'auto' 는 'auto' */
export function colorOf(el: XElement, cc: ColorCtx, valAttr = 'w:val', prefix = 'w:theme'): string | undefined {
  const val = attr(el, valAttr);
  const tc = attr(el, `${prefix}Color`);
  const fallback = val === 'auto' ? 'auto' : hexColor(val);
  if (tc) {
    return themeColor(cc.theme, cc.clrMap, tc, attr(el, `${prefix}Tint`), attr(el, `${prefix}Shade`), fallback);
  }
  return fallback;
}

/** w:shd → 바탕색. 'none' = 음영 없음을 명시, undefined = 이 겹은 정하지 않음 */
export function shadingOf(el: XElement, cc: ColorCtx): string | undefined {
  const val = attr(el, 'w:val') ?? 'clear';
  if (val === 'nil') return 'none';
  let fill: string | undefined;
  const fillAttr = attr(el, 'w:fill');
  const themeFill = attr(el, 'w:themeFill');
  if (themeFill) {
    fill = themeColor(cc.theme, cc.clrMap, themeFill, attr(el, 'w:themeFillTint'), attr(el, 'w:themeFillShade'), hexColor(fillAttr));
  } else {
    fill = hexColor(fillAttr);
  }
  const pattern = colorOf(el, cc, 'w:color', 'w:theme');
  const patternHex = pattern && pattern !== 'auto' ? pattern : '#000000';
  if (val === 'solid') return patternHex;
  const pct = /^pct(\d+)$/.exec(val);
  if (pct) return mix(patternHex, fill ?? '#ffffff', Number(pct[1]));
  return fill ?? 'none';
}

export function borderOf(el: XElement | undefined, cc: ColorCtx): BorderSpec | undefined {
  if (!el) return undefined;
  const val = attr(el, 'w:val');
  if (!val) return undefined;
  const b: BorderSpec = { val };
  const sz = num(attr(el, 'w:sz'));
  if (sz !== undefined) b.sz = sz;
  const color = colorOf(el, cc, 'w:color', 'w:theme');
  if (color && color !== 'auto') b.color = color;
  return b;
}

function fontRef(el: XElement, kind: 'ascii' | 'hAnsi' | 'eastAsia'): FontRef | undefined {
  const th = attr(el, `w:${kind}Theme`);
  if (th) return { theme: th };
  const name = attr(el, `w:${kind}`);
  return name ? { name } : undefined;
}

/** rPr 한 겹 읽기 (w:rPrChange 같은 변경 기록은 무시) */
export function readRPr(rPr: XElement | undefined, cc: ColorCtx, out: RProps = {}): RProps {
  if (!rPr) return out;
  for (const c of rPr.children) {
    if (c.type !== 'el') continue;
    switch (c.name) {
      case 'w:b':
        out.b = onOff(c);
        break;
      case 'w:i':
        out.i = onOff(c);
        break;
      case 'w:u': {
        const v = attr(c, 'w:val');
        out.u = v === undefined || (v !== 'none' && v !== '0' && v !== 'false');
        break;
      }
      case 'w:strike':
        out.strike = onOff(c);
        break;
      case 'w:dstrike':
        out.dstrike = onOff(c);
        break;
      case 'w:caps':
        out.caps = onOff(c);
        break;
      case 'w:vanish':
        out.vanish = onOff(c);
        break;
      case 'w:sz': {
        const v = num(attr(c, 'w:val'));
        if (v !== undefined && v > 0) out.sz = v;
        break;
      }
      case 'w:color': {
        const v = colorOf(c, cc);
        if (v) out.color = v;
        break;
      }
      case 'w:highlight': {
        const v = attr(c, 'w:val');
        if (v) out.highlight = v === 'none' ? 'none' : v;
        break;
      }
      case 'w:shd': {
        const v = shadingOf(c, cc);
        if (v) out.shd = v;
        break;
      }
      case 'w:vertAlign': {
        const v = attr(c, 'w:val');
        if (v) out.vertAlign = v;
        break;
      }
      case 'w:rFonts': {
        const a = fontRef(c, 'ascii');
        const h = fontRef(c, 'hAnsi');
        const e = fontRef(c, 'eastAsia');
        if (a) out.fAscii = a;
        if (h) out.fHAnsi = h;
        if (e) out.fEastAsia = e;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function indSide(el: XElement, names: string[]): IndSide | undefined {
  let twips: number | undefined;
  let chars: number | undefined;
  let seen = false;
  for (const n of names) {
    const tw = twipsAttr(attr(el, `w:${n}`));
    if (tw !== undefined) {
      twips = tw;
      seen = true;
    }
    const ch = num(attr(el, `w:${n}Chars`));
    if (ch !== undefined) {
      chars = ch;
      seen = true;
    }
  }
  if (!seen) return undefined;
  const out: IndSide = {};
  if (twips !== undefined) out.twips = twips;
  if (chars !== undefined) out.chars = chars;
  return out;
}

/** pPr 한 겹 읽기 (w:pPrChange, w:rPr, w:sectPr 는 여기서 다루지 않는다) */
export function readPPr(pPr: XElement | undefined, cc: ColorCtx, out: PProps = {}): PProps {
  if (!pPr) return out;
  for (const c of pPr.children) {
    if (c.type !== 'el') continue;
    switch (c.name) {
      case 'w:jc': {
        const v = attr(c, 'w:val');
        if (v) out.jc = v;
        break;
      }
      case 'w:ind': {
        // 정한 값만 덮는다(겹을 쌓아 읽을 때도 아래 겹의 나머지 값이 남는다). *L 은 어림용 옛 규칙(통째로)
        const ls = indSide(c, ['left', 'start']);
        const rs = indSide(c, ['right', 'end']);
        const l = mergeSide(out.indLeft, ls);
        const r = mergeSide(out.indRight, rs);
        if (l) out.indLeft = l;
        if (r) out.indRight = r;
        if (ls) out.indLeftL = ls;
        if (rs) out.indRightL = rs;
        const hang = twipsAttr(attr(c, 'w:hanging'));
        const hangCh = num(attr(c, 'w:hangingChars'));
        const first = twipsAttr(attr(c, 'w:firstLine'));
        const firstCh = num(attr(c, 'w:firstLineChars'));
        const f: IndSide = {};
        if (hang !== undefined) f.twips = -hang;
        else if (first !== undefined) f.twips = first;
        if (hangCh !== undefined) f.chars = -hangCh;
        else if (firstCh !== undefined) f.chars = firstCh;
        if (f.twips !== undefined || f.chars !== undefined) out.indFirst = { ...out.indFirst, ...f };
        // 옛 규칙: hanging 쪽 값이 하나라도 있으면 hanging 두 값만, 아니면 firstLine 두 값
        if (hang !== undefined || hangCh !== undefined) {
          const fl: IndSide = {};
          if (hang !== undefined) fl.twips = -hang;
          if (hangCh !== undefined) fl.chars = -hangCh;
          out.indFirstL = fl;
        } else if (first !== undefined || firstCh !== undefined) {
          const fl: IndSide = {};
          if (first !== undefined) fl.twips = first;
          if (firstCh !== undefined) fl.chars = firstCh;
          out.indFirstL = fl;
        }
        break;
      }
      case 'w:spacing': {
        const before = twipsAttr(attr(c, 'w:before'));
        const beforeLines = num(attr(c, 'w:beforeLines'));
        if (before !== undefined || beforeLines !== undefined) {
          out.spBefore = { ...out.spBefore };
          if (before !== undefined) out.spBefore.twips = before;
          if (beforeLines !== undefined) out.spBefore.lines = beforeLines;
        }
        const after = twipsAttr(attr(c, 'w:after'));
        const afterLines = num(attr(c, 'w:afterLines'));
        if (after !== undefined || afterLines !== undefined) {
          out.spAfter = { ...out.spAfter };
          if (after !== undefined) out.spAfter.twips = after;
          if (afterLines !== undefined) out.spAfter.lines = afterLines;
        }
        const ba = attr(c, 'w:beforeAutospacing');
        if (ba !== undefined) out.spBeforeAuto = onOff(c, 'w:beforeAutospacing');
        const aa = attr(c, 'w:afterAutospacing');
        if (aa !== undefined) out.spAfterAuto = onOff(c, 'w:afterAutospacing');
        const line = twipsAttr(attr(c, 'w:line'));
        if (line !== undefined) out.line = { val: line, rule: attr(c, 'w:lineRule') ?? 'auto' };
        break;
      }
      case 'w:shd': {
        const v = shadingOf(c, cc);
        if (v) out.shd = v;
        break;
      }
      case 'w:pBdr': {
        for (const b of c.children) {
          if (b.type !== 'el') continue;
          const spec = borderOf(b, cc);
          if (!spec) continue;
          if (b.name === 'w:top') out.bdrTop = spec;
          else if (b.name === 'w:bottom') out.bdrBottom = spec;
          else if (b.name === 'w:left' || b.name === 'w:start') out.bdrLeft = spec;
          else if (b.name === 'w:right' || b.name === 'w:end') out.bdrRight = spec;
          else if (b.name === 'w:between') out.bdrBetween = spec;
        }
        break;
      }
      case 'w:pageBreakBefore':
        out.pageBreakBefore = onOff(c);
        break;
      case 'w:keepNext':
        out.keepNext = onOff(c);
        break;
      case 'w:contextualSpacing':
        out.contextual = onOff(c);
        break;
      case 'w:snapToGrid':
        out.snap = onOff(c);
        break;
      case 'w:numPr': {
        const id = childEl(c, 'w:numId');
        const lv = childEl(c, 'w:ilvl');
        const idv = id ? attr(id, 'w:val') : undefined;
        const lvv = lv ? num(attr(lv, 'w:val')) : undefined;
        if (idv !== undefined) out.numId = idv;
        if (lvv !== undefined) out.ilvl = Math.max(0, Math.min(8, Math.floor(lvv)));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const SIDE_NAMES: Record<string, Side> = {
  'w:top': 'top',
  'w:left': 'left',
  'w:start': 'left',
  'w:bottom': 'bottom',
  'w:right': 'right',
  'w:end': 'right',
  'w:insideH': 'insideH',
  'w:insideV': 'insideV',
};

function readMargins(el: XElement, out: Partial<Record<MarSide, number>>): void {
  for (const c of el.children) {
    if (c.type !== 'el') continue;
    const side = own(SIDE_NAMES, c.name);
    if (!side || side === 'insideH' || side === 'insideV') continue;
    const type = attr(c, 'w:type') ?? 'dxa';
    const w = twipsAttr(attr(c, 'w:w'));
    if (w !== undefined && (type === 'dxa' || type === 'nil')) out[side] = type === 'nil' ? 0 : w;
  }
}

export function readTblPr(tblPr: XElement | undefined, cc: ColorCtx, out: TblProps = emptyTbl()): TblProps {
  if (!tblPr) return out;
  for (const c of tblPr.children) {
    if (c.type !== 'el') continue;
    switch (c.name) {
      case 'w:tblBorders':
        for (const b of c.children) {
          if (b.type !== 'el') continue;
          const side = own(SIDE_NAMES, b.name);
          const spec = borderOf(b, cc);
          if (side && spec) out.borders[side] = spec;
        }
        break;
      case 'w:tblCellMar':
        readMargins(c, out.cellMar);
        break;
      case 'w:jc': {
        const v = attr(c, 'w:val');
        if (v) out.jc = v;
        break;
      }
      case 'w:tblInd': {
        const w = twipsAttr(attr(c, 'w:w'));
        const type = attr(c, 'w:type') ?? 'dxa';
        if (w !== undefined && type === 'dxa') out.ind = w;
        break;
      }
      case 'w:tblW': {
        const v = attr(c, 'w:w');
        if (v !== undefined) out.w = { v, type: attr(c, 'w:type') ?? 'dxa' };
        break;
      }
      case 'w:tblStyleRowBandSize': {
        const v = num(attr(c, 'w:val'));
        if (v !== undefined && v > 0) out.rowBand = v;
        break;
      }
      case 'w:tblStyleColBandSize': {
        const v = num(attr(c, 'w:val'));
        if (v !== undefined && v > 0) out.colBand = v;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function readTcPr(tcPr: XElement | undefined, cc: ColorCtx, out: TcProps = emptyTc()): TcProps {
  if (!tcPr) return out;
  for (const c of tcPr.children) {
    if (c.type !== 'el') continue;
    switch (c.name) {
      case 'w:tcBorders':
        for (const b of c.children) {
          if (b.type !== 'el') continue;
          const side = own(SIDE_NAMES, b.name);
          const spec = borderOf(b, cc);
          if (side && spec) out.borders[side] = spec;
        }
        break;
      case 'w:shd': {
        const v = shadingOf(c, cc);
        if (v) out.shd = v;
        break;
      }
      case 'w:vAlign': {
        const v = attr(c, 'w:val');
        if (v) out.vAlign = v;
        break;
      }
      case 'w:tcMar':
        readMargins(c, out.mar);
        break;
      default:
        break;
    }
  }
  return out;
}

export function mergeTbl(into: TblProps, from: TblProps): TblProps {
  Object.assign(into.borders, from.borders);
  Object.assign(into.cellMar, from.cellMar);
  if (from.jc !== undefined) into.jc = from.jc;
  if (from.ind !== undefined) into.ind = from.ind;
  if (from.w !== undefined) into.w = from.w;
  if (from.rowBand !== undefined) into.rowBand = from.rowBand;
  if (from.colBand !== undefined) into.colBand = from.colBand;
  return into;
}

export function mergeTc(into: TcProps, from: TcProps): TcProps {
  Object.assign(into.borders, from.borders);
  Object.assign(into.mar, from.mar);
  if (from.shd !== undefined) into.shd = from.shd;
  if (from.vAlign !== undefined) into.vAlign = from.vAlign;
  return into;
}

function mergeCond(into: CondFmt, from: CondFmt): CondFmt {
  into.p = mergePPr(into.p, from.p);
  Object.assign(into.r, from.r);
  mergeTc(into.tc, from.tc);
  mergeTbl(into.tbl, from.tbl);
  return into;
}

// ─────────────────────────────── 스타일표 ───────────────────────────────

interface StyleDef {
  id: string;
  type: string;
  basedOn?: string;
  pPr?: XElement;
  rPr?: XElement;
  tblPr?: XElement;
  tcPr?: XElement;
  cond: Map<string, { pPr?: XElement; rPr?: XElement; tblPr?: XElement; tcPr?: XElement }>;
}

const MAX_CHAIN = 24;

export class Styles {
  readonly defaultsR: RProps;
  readonly defaultsP: PProps;
  private readonly byId = new Map<string, StyleDef>();
  private readonly defaults = new Map<string, string>();
  private readonly paraCache = new Map<string, { p: PProps; r: RProps }>();
  private readonly charCache = new Map<string, RProps>();
  private readonly tableCache = new Map<string, TableStyle>();

  constructor(root: XElement | null, private readonly cc: ColorCtx) {
    const dd = root ? childEl(root, 'w:docDefaults') : undefined;
    this.defaultsR = readRPr(dd ? childEl(childEl(dd, 'w:rPrDefault') ?? dd, 'w:rPr') : undefined, cc);
    this.defaultsP = readPPr(dd ? childEl(childEl(dd, 'w:pPrDefault') ?? dd, 'w:pPr') : undefined, cc);
    if (!root) return;
    for (const s of root.children) {
      if (s.type !== 'el' || s.name !== 'w:style') continue;
      const id = attr(s, 'w:styleId');
      if (id === undefined || this.byId.has(id)) continue;
      const type = attr(s, 'w:type') ?? 'paragraph';
      const def: StyleDef = { id, type, cond: new Map() };
      for (const c of s.children) {
        if (c.type !== 'el') continue;
        if (c.name === 'w:basedOn') {
          const v = attr(c, 'w:val');
          if (v !== undefined && v !== id) def.basedOn = v;
        } else if (c.name === 'w:pPr') def.pPr = c;
        else if (c.name === 'w:rPr') def.rPr = c;
        else if (c.name === 'w:tblPr') def.tblPr = c;
        else if (c.name === 'w:tcPr') def.tcPr = c;
        else if (c.name === 'w:tblStylePr') {
          const t = attr(c, 'w:type');
          if (!t) continue;
          def.cond.set(t, {
            pPr: childEl(c, 'w:pPr'),
            rPr: childEl(c, 'w:rPr'),
            tblPr: childEl(c, 'w:tblPr'),
            tcPr: childEl(c, 'w:tcPr'),
          });
        }
      }
      this.byId.set(id, def);
      const isDefault = attr(s, 'w:default');
      if ((isDefault === '1' || isDefault === 'true' || isDefault === 'on') && !this.defaults.has(type)) {
        this.defaults.set(type, id);
      }
    }
  }

  /** 종류별 기본 스타일 id (w:default="1") */
  defaultId(type: 'paragraph' | 'character' | 'table' | 'numbering'): string | undefined {
    return this.defaults.get(type);
  }

  /** 스타일 정의의 pPr 원본(번호 스타일의 numPr 을 찾을 때) */
  pPrOf(id: string): XElement | undefined {
    return this.byId.get(id)?.pPr;
  }

  exists(id: string): boolean {
    return this.byId.has(id);
  }

  /** basedOn 사슬: 바탕 먼저. 순환과 지나친 깊이는 끊는다 */
  private chain(id: string | undefined): StyleDef[] {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = id;
    while (cur !== undefined && !seen.has(cur) && out.length < MAX_CHAIN) {
      const def = this.byId.get(cur);
      if (!def) break;
      seen.add(cur);
      out.push(def);
      cur = def.basedOn;
    }
    return out.reverse();
  }

  /**
   * 문단 스타일 사슬이 정한 pPr, rPr (docDefaults 제외). styleId 가 없거나 모르는 id 면 기본 문단 스타일.
   * 돌려준 id 는 실제로 쓴 스타일(문맥 간격 비교용).
   */
  para(styleId: string | undefined): { p: PProps; r: RProps; id: string | undefined } {
    const id = styleId !== undefined && this.byId.has(styleId) ? styleId : this.defaults.get('paragraph');
    const key = id ?? '';
    let hit = this.paraCache.get(key);
    if (!hit) {
      const p: PProps = {};
      const r: RProps = {};
      for (const def of this.chain(id)) {
        readPPr(def.pPr, this.cc, p);
        readRPr(def.rPr, this.cc, r);
      }
      hit = { p, r };
      this.paraCache.set(key, hit);
    }
    return { p: hit.p, r: hit.r, id };
  }

  /** 글자 스타일 사슬이 정한 rPr. rStyle 이 없으면 기본 글자 스타일 */
  char(styleId: string | undefined): RProps {
    const id = styleId !== undefined && this.byId.has(styleId) ? styleId : this.defaults.get('character');
    const key = id ?? '';
    let hit = this.charCache.get(key);
    if (!hit) {
      hit = {};
      for (const def of this.chain(id)) readRPr(def.rPr, this.cc, hit);
      this.charCache.set(key, hit);
    }
    return hit;
  }

  /** 표 스타일 사슬: 전체 서식과 조건부 서식(firstRow 등). tblStyle 이 없으면 기본 표 스타일 */
  table(styleId: string | undefined): TableStyle {
    const id = styleId !== undefined && this.byId.has(styleId) ? styleId : this.defaults.get('table');
    const key = id ?? '';
    let hit = this.tableCache.get(key);
    if (!hit) {
      const whole = emptyCond();
      const cond = new Map<string, CondFmt>();
      for (const def of this.chain(id)) {
        readPPr(def.pPr, this.cc, whole.p);
        readRPr(def.rPr, this.cc, whole.r);
        readTcPr(def.tcPr, this.cc, whole.tc);
        readTblPr(def.tblPr, this.cc, whole.tbl);
        for (const [t, c] of def.cond) {
          const one: CondFmt = {
            p: readPPr(c.pPr, this.cc),
            r: readRPr(c.rPr, this.cc),
            tc: readTcPr(c.tcPr, this.cc),
            tbl: readTblPr(c.tblPr, this.cc),
          };
          const prev = cond.get(t);
          cond.set(t, prev ? mergeCond(prev, one) : one);
        }
      }
      hit = { whole, cond };
      this.tableCache.set(key, hit);
    }
    return hit;
  }
}
