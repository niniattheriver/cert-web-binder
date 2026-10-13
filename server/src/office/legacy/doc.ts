/**
 * 구형 Word(doc: Word 97~2003 바이너리) → 정본 쪽 글자 + 흐름(flow) 렌더 모델
 *
 * docx 추출기와 같은 중간 표현(docx/ir.ts)으로 바꾼 뒤 docx 의 쪽 나눔과 출력 단계(flow.ts)를 그대로 쓴다.
 * 그래서 같은 문서를 doc 과 docx 로 저장해 올리면 정본 글자가 같다(시험으로 확인).
 *
 * 읽는 것 (MS-DOC)
 * - WordDocument 스트림의 FIB: 서명 0xA5EC, nFib(Word 97 이상 = 0x00C1 이상), 암호/난독화 표지(거부), 어느 표
 *   스트림(0Table/1Table)인지, 본문 글자 수 ccpText, 표 스트림 안 구조의 위치(fc, lcb).
 * - 글자: CLX 의 조각표(PlcPcd). 조각마다 압축(1바이트, cp1252 에 가까운 표) 또는 UTF-16LE. 본문 CP 0..ccpText 만
 *   읽는다(각주, 머리말 이야기는 뒤에 이어져 있어 뺀다).
 * - 문단 속성(PlcfBtePapx → PAPX FKP): 표 안 여부(sprmPFInTable), 행 끝(sprmPFTtp), 표 깊이(sprmPItap),
 *   행 정의(sprmTDefTable: 칸 경계, 세로 병합), 정렬, 들여쓰기, 문단 앞뒤 간격, 줄 간격.
 * - 글자 속성(PlcfBteChpx → CHPX FKP): 굵게, 기울임, 밑줄, 취소선, 크기, 색, 위/아래 첨자, 숨김(뺀다), 글꼴.
 * - 스타일 표(STSH): 문단 스타일과 글자 스타일의 sprm 을 바탕 스타일 사슬을 따라 쌓고, 그 위에 직접 서식을 얹는다
 *   (docx 의 docDefaults → 스타일 → 직접 서식과 같은 순서). 기본 글꼴은 STSHI 의 rgftcStandardChpStsh.
 * - 구역 속성(PlcfSed → SEPX): 용지 크기, 여백, 머리말 거리, 구역 나눔 종류.
 * - 요약 정보의 쪽 수: 쪽 나눔 어림의 목표(docx 의 docProps/app.xml <Pages> 와 같은 쓰임).
 *
 * 특수 글자: 문단 표지 0x0D, 칸/행 끝 0x07, 구역 끝 0x0C(구역 경계 위치일 때. 아니면 쪽 나눔), 줄 바꿈 0x0B('\n'),
 * 탭 0x09, 나누지 않는 하이픈 0x1E('-'), 선택 하이픈 0x1F(뺀다), 필드 0x13 시작 / 0x14 구분 / 0x15 끝(결과만
 * 남긴다). 그림(0x01, 0x08), 각주 참조(0x02), 메모 참조(0x05)와 그 밖의 제어 글자는 뺀다.
 * 문단 번호(PlfLst, PlfLfo)는 doclist.ts 가 세어 docx 처럼 이름표 조각으로 싣는다. 각주는 본문 참조 자리에 위첨자
 * 번호를 두고, 각주 글(각주 이야기)은 docx 처럼 참조가 있는 쪽 끝에 붙인다.
 * 그림, 글상자, 머리말/꼬리말, 미주는 아직 싣지 않는다(media: []). 중첩 표(깊이 2 이상)는 바깥 칸 안 문단으로 펼친다.
 */
import type { IRBlock, IRCell, IRItem, IRPara, IRRow, IRTable, IRText, ParaOut, RunOut, SectInfo } from '../docx/ir.js';
import { singleLinePx } from '../docx/fontmetrics.js';
import { canon, formatNumber, hasEastAsian, isSymbolFont, mapBulletGlyphs, round1, sanitizeFont, twipsToPx } from '../docx/units.js';
import { OfficeParseError } from '../errors.js';
import { RENDER_MODEL_VERSION, type Border, type FlowModel, type OfficeExtractResult } from '../model.js';
import { Cfb } from './cfb.js';
import { DocLists } from './doclist.js';
import { DEFAULT_SECT, layoutFlow } from './flow.js';
import { readPageCount } from './propset.js';

export const DOC_EXTRACTOR = 'doc-v1';

const ERR_CORRUPT = 'Word (doc) 파일을 읽을 수 없습니다. 파일이 손상되었을 수 있습니다. Word에서 다시 저장해 올려 주세요.';
const ERR_ENCRYPTED = '암호(열람 제한)가 걸린 Word (doc) 파일입니다. 암호를 해제해 저장한 뒤 다시 올려 주세요.';
const ERR_OLD = 'Word 95 이전 형식(doc)은 읽을 수 없습니다. Word에서 docx로 저장해 올려 주세요.';
const ERR_TOO_BIG = 'Word (doc) 문서가 너무 커서 미리보기를 만들지 못했습니다. 문서를 나눠 올려 주세요.';

const MAX_STREAM = 256 * 1024 * 1024;
/** 본문 글자 수 상한 (읽기 단계). 정본 글자 상한은 docx 와 같은 MAX_TEXT 를 출력 단계가 적용한다 */
const MAX_CP = 20_000_000;
/** 문단 수 상한 */
const MAX_PARAS = 300_000;
/** 기본 탭 간격: 문서 속성(DOP)의 dxaTab 이 없을 때 Word 기본 0.5인치 */
const TAB_PX = 48;
/** 글자 크기를 어디서도 정하지 않았을 때 (Word 기본 CHP 10pt) */
const DEFAULT_PT = 10;

/** 압축 조각 바이트 0x80..0x9F 의 글자 (MS-DOC 2.4.1) */
const CP1252_HIGH: Record<number, number> = {
  0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030,
  0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9f: 0x0178,
};

/** 글자색 번호 ico (sprmCIco) */
const ICO = [
  undefined, '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#ffff00', '#ffffff',
  '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0',
];

interface Piece {
  cp0: number;
  cp1: number;
  /** WordDocument 안 바이트 위치 */
  fc: number;
  compressed: boolean;
}

interface Run {
  fc0: number;
  fc1: number;
  grpprl: Buffer;
}

interface Sprm {
  op: number;
  arg: Buffer;
}

/** grpprl 의 sprm 들. 크기를 알 수 없는 sprm 을 만나면 거기서 멈춘다 */
function sprms(b: Buffer): Sprm[] {
  const out: Sprm[] = [];
  let p = 0;
  while (p + 2 <= b.length) {
    const op = b.readUInt16LE(p);
    p += 2;
    const spra = op >> 13;
    let argStart = p;
    let size: number;
    if (spra === 0 || spra === 1) size = 1;
    else if (spra === 2 || spra === 4 || spra === 5) size = 2;
    else if (spra === 3) size = 4;
    else if (spra === 7) size = 3;
    else if (op === 0xd608 || op === 0xd606) {
      // sprmTDefTable: 연산자 = cb(2바이트, '나머지 크기 + 1') + 나머지. arg 에는 cb 까지 담는다
      if (p + 2 > b.length) break;
      size = 2 + Math.max(0, b.readUInt16LE(p) - 1);
    } else {
      // 그 밖의 가변 크기: 첫 바이트가 크기. sprmPChgTabs 의 긴 형태(255)는 드물어 거기서 멈춘다
      if (p + 1 > b.length) break;
      const n = b[p]!;
      if (op === 0xc615 && n === 255) break;
      argStart = p + 1;
      size = n;
    }
    if (argStart + size > b.length) break;
    out.push({ op, arg: b.subarray(argStart, argStart + size) });
    p = argStart + size;
  }
  return out;
}

/** PlcfBte 를 읽어 FKP 쪽 번호 목록을 낸다 */
function bteList(table: Buffer, fc: number, lcb: number): number[] {
  if (lcb < 12 || fc + lcb > table.length) return [];
  const n = Math.floor((lcb - 4) / 8);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(table.readUInt32LE(fc + (n + 1) * 4 + i * 4) & 0x3fffff);
  return out;
}

function papxRuns(wd: Buffer, pns: number[]): (Run & { istd: number })[] {
  const out: (Run & { istd: number })[] = [];
  for (const pn of pns) {
    const base = pn * 512;
    if (base + 512 > wd.length) continue;
    const fkp = wd.subarray(base, base + 512);
    const crun = fkp[511]!;
    for (let i = 0; i < crun; i += 1) {
      const fc0 = fkp.readUInt32LE(i * 4);
      const fc1 = fkp.readUInt32LE((i + 1) * 4);
      const bOff = fkp[(crun + 1) * 4 + i * 13]! * 2;
      let grpprl: Buffer = Buffer.alloc(0);
      let istd = 0;
      if (bOff > 0 && bOff < 511) {
        let cb = fkp[bOff]!;
        let start = bOff + 1;
        let len: number;
        if (cb === 0) {
          cb = fkp[bOff + 1]!;
          start = bOff + 2;
          len = cb * 2;
        } else len = cb * 2 - 1;
        if (start + len <= 511 && len >= 2) {
          istd = fkp.readUInt16LE(start);
          grpprl = fkp.subarray(start + 2, start + len);
        }
      }
      out.push({ fc0, fc1, grpprl, istd });
    }
  }
  return out.sort((a, b) => a.fc0 - b.fc0);
}

function chpxRuns(wd: Buffer, pns: number[]): Run[] {
  const out: Run[] = [];
  for (const pn of pns) {
    const base = pn * 512;
    if (base + 512 > wd.length) continue;
    const fkp = wd.subarray(base, base + 512);
    const crun = fkp[511]!;
    for (let i = 0; i < crun; i += 1) {
      const fc0 = fkp.readUInt32LE(i * 4);
      const fc1 = fkp.readUInt32LE((i + 1) * 4);
      const off = fkp[(crun + 1) * 4 + i]! * 2;
      let grpprl: Buffer = Buffer.alloc(0);
      if (off > 0 && off < 511) {
        const cb = fkp[off]!;
        if (off + 1 + cb <= 511) grpprl = fkp.subarray(off + 1, off + 1 + cb);
      }
      out.push({ fc0, fc1, grpprl });
    }
  }
  return out.sort((a, b) => a.fc0 - b.fc0);
}

/** 정렬된 구간 목록에서 fc 를 담은 구간 (이진 검색) */
function findRun<T extends { fc0: number; fc1: number }>(runs: T[], fc: number): T | undefined {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid]!;
    if (fc < r.fc0) hi = mid - 1;
    else if (fc >= r.fc1) lo = mid + 1;
    else return r;
  }
  return undefined;
}

/** 글꼴 표(SttbfFfn): ftc → 이름 (docx 와 같은 sanitizeFont 를 거친다. 못 쓰는 이름은 undefined) */
function readFonts(table: Buffer, fc: number, lcb: number): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  if (lcb < 4 || fc + lcb > table.length) return out;
  try {
    const n = table.readUInt16LE(fc);
    let p = fc + 4;
    const end = fc + lcb;
    for (let i = 0; i < n && p < end; i += 1) {
      const cb = table[p]! + 1;
      const nameStart = p + 40;
      let q = nameStart;
      while (q + 1 < p + cb && (table[q] !== 0 || table[q + 1] !== 0)) q += 2;
      out.push(nameStart < p + cb ? sanitizeFont(table.toString('utf16le', nameStart, q)) : undefined);
      p += cb;
    }
  } catch {
    // 글꼴 이름은 보조 정보
  }
  return out;
}

/** 글자 모양 상태: 기본값 → 문단 스타일 → 글자 스타일 → 직접 서식 순서로 sprm 을 덮어쓴다 */
interface CharState {
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
  sup: boolean;
  sub: boolean;
  hidden: boolean;
  sz?: number;
  color?: string;
  /** ASCII, 동아시아, 그 밖(hAnsi 에 해당) 글꼴 */
  fontA?: string;
  fontE?: string;
  fontO?: string;
}

/**
 * 글자 모양 해석 결과. 글꼴은 조각 글자를 보고 고른다(docx 처럼 동아시아 글자가 있으면 동아시아 글꼴부터).
 * key 는 글꼴 셋까지 담아 같은 모양끼리 조각을 묶는 데 쓴다.
 */
interface CharProps {
  /** 글꼴을 뺀 모양 */
  s: RunOut;
  fontA?: string;
  fontE?: string;
  fontO?: string;
  key: string;
  hidden: boolean;
}

/** 줄 간격 규칙 (sprmPDyaLine). auto 의 val 은 240분의 1 줄, 나머지는 twips */
interface LineRule {
  rule: 'auto' | 'atLeast' | 'exact';
  val: number;
}

/** 들여쓰기 한 쪽: twips 와 글자 단위(1/100 글자) 값은 따로 물려받는다 (docx styles.ts IndSide 와 같다) */
interface IndSide {
  twips?: number;
  chars?: number;
}

/** 문단 앞/뒤 간격: twips 와 줄 단위(1/100 줄) */
interface SpSide {
  twips?: number;
  lines?: number;
}

interface IndSet {
  left?: IndSide;
  right?: IndSide;
  /** 첫 줄: + 들여쓰기, - 내어쓰기 */
  first?: IndSide;
}

/** 문단 모양 바탕 (문단 스타일 사슬이 정한 값) */
interface ParaBase {
  /** 정렬, 줄 간격 (들여쓰기와 간격은 문단 표지 글자 크기를 알아야 px 로 바꿀 수 있어 ind, sp 에 둔다) */
  props: ParaOut;
  /** 화면 값: 단위별로 덮는다 */
  ind?: IndSet;
  /** 쪽 나눔 어림용 옛 규칙 값: 한 겹(grpprl)이 그 쪽을 하나라도 정하면 그 겹 값으로 통째로 바꾼다 (docx indLeftL) */
  indL?: IndSet;
  sp?: { before?: SpSide; after?: SpSide; beforeAuto?: boolean; afterAuto?: boolean };
  line?: LineRule;
  /** 번호: 1-기준 LFO 번호(sprmPIlfo)와 0-기준 단계(sprmPIlvl) */
  ilfo?: number;
  ilvl?: number;
  /** 같은 스타일 문단 사이 간격 없앰 (sprmPFContextualSpacing) */
  contextual?: boolean;
}

/** 문단 모양에서 다음 단계의 바탕으로 넘길 값 */
function baseOf(pp: ParaBase): ParaBase {
  const out: ParaBase = { props: pp.props };
  if (pp.ind) out.ind = pp.ind;
  if (pp.indL) out.indL = pp.indL;
  if (pp.sp) out.sp = pp.sp;
  if (pp.line) out.line = pp.line;
  if (pp.ilfo !== undefined) out.ilfo = pp.ilfo;
  if (pp.ilvl !== undefined) out.ilvl = pp.ilvl;
  if (pp.contextual) out.contextual = true;
  return out;
}

/** 번호 문단인가: ilfo 1..0x7FFE (0 = 번호 없음, 0xF801 = 스타일 번호를 끈 문단) */
function listOf(pp: ParaBase): boolean {
  return pp.ilfo !== undefined && pp.ilfo > 0 && pp.ilfo < 0x7fff;
}

/** 문맥 간격: 같은 스타일 문단이 이어지면 앞 문단의 뒤 간격, 뒤 문단의 앞 간격을 없앤다 (docx post 와 같다) */
function contextSpacing(blocks: IRBlock[]): void {
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
}

/** 테두리 한 변: Border = 선, null = 선 없음으로 정함, undefined = 정하지 않음 */
type Brc = Border | null | undefined;

/** 칸 범위(itcFirst..itcLim) 에 주는 값 */
interface CellRange<T> {
  first: number;
  lim: number;
  v: T;
}

/** 행(TAP) 속성: 행 끝 문단의 sprm 에서 읽는다 */
interface RowTap {
  /** 칸 경계(twips) */
  centers: number[];
  /** 칸마다 세로 병합, 세로 정렬, 네 변(위, 왼쪽, 아래, 오른쪽) 테두리 (TC80) */
  vm: ('restart' | 'continue' | undefined)[];
  /** 옛 가로 병합: 앞 칸에 합친다 (TC80 fMerged) */
  hm: boolean[];
  va: (IRCell['va'] | 'top')[];
  tcBrc: Brc[][];
  /** 표 테두리 [위, 왼쪽, 아래, 오른쪽, 안쪽 가로, 안쪽 세로] */
  tblBrc: Brc[];
  /** 칸 범위 테두리 (sprmTSetBrc: 변 비트 위 1, 왼쪽 2, 아래 4, 오른쪽 8) */
  setBrc: CellRange<{ sides: number; brc: Brc }>[];
  vAlign: CellRange<IRCell['va'] | 'top'>[];
  /** 칸 안쪽 여백 twips: 기본(sprmTDxaGapHalf, sprmTCellPaddingDefault)과 칸 범위(sprmTCellPadding) */
  padDefault: { top?: number; left?: number; bottom?: number; right?: number };
  padCells: CellRange<{ sides: number; w: number }>[];
  /** 칸 음영 */
  shd: (string | undefined)[];
  /** 표 너비(sprmTTableWidth: 단위 2 = 50분의 1 퍼센트, 3 = twips), 정렬(sprmTJc), 들여쓰기(sprmTWidthIndent) */
  width?: { fts: number; w: number };
  jc?: number;
  ind?: number;
}

interface ParaProps extends ParaBase {
  inTable: boolean;
  ttp: boolean;
  itap: number;
  innerTtp: boolean;
  tap?: RowTap;
  rowH?: { h: number; exact: boolean };
  header: boolean;
}

const BASE_CHAR: CharState = { b: false, i: false, u: false, strike: false, sup: false, sub: false, hidden: false };

/** 켜기/끄기 sprm 값(ToggleOperand): 0 끔, 1 켬, 0x80 스타일과 같게, 0x81 스타일과 반대로 */
function toggle(v: number, styleVal: boolean): boolean {
  if (v === 0) return false;
  if (v === 1) return true;
  if (v === 0x81) return !styleVal;
  return styleVal;
}

/**
 * base 위에 grpprl 의 글자 sprm 을 얹는다. styleBase 는 0x80, 0x81 이 가리키는 '스타일 값'
 * (직접 서식이면 문단, 글자 스타일까지 쌓은 값, 스타일 정의면 바탕 스타일 값)
 */
function applyChar(base: CharState, grpprl: Buffer, fonts: (string | undefined)[], styleBase: CharState = base): CharState {
  const s: CharState = { ...base };
  for (const { op, arg } of sprms(grpprl)) {
    const v8 = arg[0] ?? 0;
    switch (op) {
      case 0x0835: // sprmCFBold
        s.b = toggle(v8, styleBase.b);
        break;
      case 0x0836: // sprmCFItalic
        s.i = toggle(v8, styleBase.i);
        break;
      case 0x0837: // sprmCFStrike
        s.strike = toggle(v8, styleBase.strike);
        break;
      case 0x2a53: // sprmCFDStrike (이중 취소선도 취소선으로)
        if (toggle(v8, styleBase.strike)) s.strike = true;
        break;
      case 0x083c: // sprmCFVanish (숨은 글자)
        s.hidden = toggle(v8, styleBase.hidden);
        break;
      case 0x2a3e: // sprmCKul
        s.u = v8 !== 0;
        break;
      case 0x4a43: // sprmCHps (반 포인트)
        if (arg.length >= 2) {
          const pt = arg.readUInt16LE(0) / 2;
          if (pt > 0 && pt <= 400) s.sz = pt;
        }
        break;
      case 0x2a42: // sprmCIco (0 = 자동)
        s.color = ICO[v8];
        break;
      case 0x6870: // sprmCCv (COLORREF, 넷째 바이트가 0 이 아니면 자동)
        if (arg.length >= 4) {
          s.color = arg[3] === 0 ? `#${[arg[0]!, arg[1]!, arg[2]!].map((x) => x.toString(16).padStart(2, '0')).join('')}` : undefined;
        }
        break;
      case 0x2a48: // sprmCIss (1 위첨자, 2 아래첨자)
        s.sup = v8 === 1;
        s.sub = v8 === 2;
        break;
      case 0x4a4f: // sprmCRgFtc0 (ASCII 글꼴)
        if (arg.length >= 2) s.fontA = fonts[arg.readUInt16LE(0)];
        break;
      case 0x4a50: // sprmCRgFtc1 (동아시아 글꼴)
        if (arg.length >= 2) s.fontE = fonts[arg.readUInt16LE(0)];
        break;
      case 0x4a51: // sprmCRgFtc2 (그 밖의 글꼴)
        if (arg.length >= 2) s.fontO = fonts[arg.readUInt16LE(0)];
        break;
      default:
        break;
    }
  }
  return s;
}

/** 글자 모양 상태 → 해석 결과 (글꼴을 뺀 모양은 docx runStyle 과 같은 키 순서) */
function charOut(c: CharState): CharProps {
  const s: RunOut = {};
  if (c.sz !== undefined) s.sz = c.sz;
  if (c.b) s.b = true;
  if (c.i) s.i = true;
  if (c.u) s.u = true;
  if (c.strike) s.strike = true;
  if (c.color && c.color !== '#000000') s.color = c.color;
  if (c.sup) s.sup = true;
  else if (c.sub) s.sub = true;
  const out: CharProps = { s, key: '', hidden: c.hidden };
  if (c.fontA) out.fontA = c.fontA;
  if (c.fontE) out.fontE = c.fontE;
  if (c.fontO) out.fontO = c.fontO;
  out.key = JSON.stringify([s, out.fontA, out.fontE, out.fontO]);
  return out;
}

/** 조각 글자를 보고 글꼴을 골라 모델 글자 모양을 낸다 (docx runStyle 과 같은 규칙, 같은 키 순서) */
function runStyleOf(c: CharProps, text: string): RunOut {
  const font = hasEastAsian(text) ? (c.fontE ?? c.fontA) : (c.fontA ?? c.fontO ?? c.fontE);
  if (!font) return c.s;
  const { sup, sub, ...rest } = c.s;
  const s: RunOut = { ...rest, font };
  if (sup) s.sup = true;
  else if (sub) s.sub = true;
  return s;
}

const JC: Record<number, ParaOut['align']> = { 0: 'left', 1: 'center', 2: 'right', 3: 'justify', 4: 'justify', 5: 'justify' };

/** COLORREF(빨강, 초록, 파랑, fAuto) → #rrggbb. fAuto 가 0 이 아니면 자동(undefined) */
function cref(b: Buffer, o: number): string | undefined {
  if (o + 4 > b.length || b[o + 3] !== 0) return undefined;
  return `#${[b[o]!, b[o + 1]!, b[o + 2]!].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** 선 종류(brcType) → 화면 테두리. 굵기는 docx borderModel 과 같은 규칙(1/8pt 를 6 으로 나눠 1..3px, 이중선 3px) */
function brcBorder(type: number, dpt: number, color: string): Border {
  const style: Border['style'] =
    type === 3 || (type >= 0x0a && type <= 0x13)
      ? 'double'
      : type === 6
        ? 'dotted'
        : type === 7 || type === 8 || type === 9 || type === 0x16 || type === 0x17
          ? 'dashed'
          : 'solid';
  let w = Math.round(Math.max(1, Math.min(3, dpt / 6)));
  if (style === 'double') w = 3;
  return { w: w as Border['w'], style, color };
}

/**
 * Brc80(4바이트: 굵기 1/8pt, 종류, 색 번호 ico, 간격과 표지). 0xFFFFFFFF 는 테두리 없음(MS-DOC Brc80MayBeNil).
 * zeroUnset: 칸 정의(TC80)의 0 은 '정하지 않음'(표 테두리를 따른다). Word 2000 이후 파일은 칸 테두리를 표 테두리로
 * 정하고 TC80 에는 0 을, 칸에서 뺀 테두리에는 0xFFFFFFFF 를 적는다(시험 파일로 확인).
 */
function brc80(b: Buffer, o: number, zeroUnset: boolean): Brc {
  if (o + 4 > b.length) return undefined;
  const u = b.readUInt32LE(o);
  if (u === 0xffffffff) return null;
  if (zeroUnset && u === 0) return undefined;
  const type = b[o + 1]!;
  if (type === 0 || type === 0xff) return null;
  return brcBorder(type, b[o]!, ICO[b[o + 2]!] ?? '#000000');
}

/** Brc(8바이트: COLORREF, 굵기 1/8pt, 종류, 간격과 표지) */
function brc(b: Buffer, o: number): Brc {
  if (o + 8 > b.length) return undefined;
  const type = b[o + 5]!;
  if (type === 0 || type === 0xff) return null;
  return brcBorder(type, b[o + 4]!, cref(b, o) ?? '#000000');
}

/** 음영 Shd(10바이트: 앞색, 바탕색, 무늬). 무늬 1(solid)은 앞색, 그 밖은 바탕색. 자동이면 음영 없음 */
function shd(b: Buffer, o: number): string | undefined {
  if (o + 10 > b.length) return undefined;
  const ipat = b.readUInt16LE(o + 8);
  if (ipat === 0xffff) return undefined;
  const c = ipat === 1 ? cref(b, o) : cref(b, o + 4);
  return c && c !== '#ffffff' ? c : undefined;
}

/** 음영 Shd80(2바이트: 앞색 ico 5비트, 바탕색 ico 5비트, 무늬 6비트) */
function shd80(b: Buffer, o: number): string | undefined {
  if (o + 2 > b.length) return undefined;
  const v = b.readUInt16LE(o);
  const ipat = v >> 10;
  const c = ICO[ipat === 1 ? v & 0x1f : (v >> 5) & 0x1f];
  return c && c !== '#ffffff' ? c : undefined;
}

const VA: Record<number, IRCell['va'] | 'top'> = { 0: 'top', 1: 'middle', 2: 'bottom' };
const PAD_SIDES = [
  [1, 'top'],
  [2, 'left'],
  [4, 'bottom'],
  [8, 'right'],
] as const;

/** base(문단 스타일 사슬이 정한 문단 모양) 위에 grpprl 의 문단, 표 sprm 을 얹는다 */
function paraProps(grpprl: Buffer, base: ParaBase = { props: {} }): ParaProps {
  const props: ParaOut = { ...base.props };
  const out: ParaProps = { props, inTable: false, ttp: false, itap: 0, innerTtp: false, header: false };
  if (base.line) out.line = base.line;
  if (base.ilfo !== undefined) out.ilfo = base.ilfo;
  if (base.ilvl !== undefined) out.ilvl = base.ilvl;
  if (base.contextual) out.contextual = true;
  // 이 겹이 정한 들여쓰기, 간격 (끝에서 바탕 값에 덮는다)
  const layer: IndSet = {};
  const setInd = (side: keyof IndSet, unit: keyof IndSide, v: number): void => {
    (layer[side] ??= {})[unit] = v;
  };
  const sp = { ...base.sp };
  const setSp = (side: 'before' | 'after', unit: keyof SpSide, v: number): void => {
    sp[side] = { ...sp[side], [unit]: v };
  };
  // 행(TAP) 속성
  let centers: number[] | undefined;
  const vm: RowTap['vm'] = [];
  const hm: boolean[] = [];
  const va: RowTap['va'] = [];
  const tcBrc: Brc[][] = [];
  let tbl80: Brc[] | undefined;
  let tbl: Brc[] | undefined;
  const setBrc: RowTap['setBrc'] = [];
  const vAlign: RowTap['vAlign'] = [];
  let gapHalf: number | undefined;
  const padExplicit: RowTap['padDefault'] = {};
  const padCells: RowTap['padCells'] = [];
  let shdList80: (string | undefined)[] | undefined;
  let shdList: (string | undefined)[] | undefined;
  let tblWidth: RowTap['width'];
  let tblJc: number | undefined;
  let tblInd: number | undefined;
  for (const { op, arg } of sprms(grpprl)) {
    const v8 = arg[0] ?? 0;
    const i16 = arg.length >= 2 ? arg.readInt16LE(0) : 0;
    const u16 = arg.length >= 2 ? arg.readUInt16LE(0) : 0;
    switch (op) {
      case 0x2403: // sprmPJc80
      case 0x2461: // sprmPJc
        props.align = JC[v8] ?? props.align;
        break;
      case 0x460b: // sprmPIlfo
        out.ilfo = u16;
        break;
      case 0x260a: // sprmPIlvl
        out.ilvl = Math.min(8, v8);
        break;
      case 0x246d: // sprmPFContextualSpacing
        out.contextual = v8 !== 0;
        break;
      case 0x2416: // sprmPFInTable
        out.inTable = v8 !== 0;
        break;
      case 0x2417: // sprmPFTtp
        out.ttp = v8 !== 0;
        break;
      case 0x6649: // sprmPItap
        if (arg.length >= 4) out.itap = arg.readInt32LE(0);
        break;
      case 0x244c: // sprmPFInnerTtp
        out.innerTtp = v8 !== 0;
        break;
      case 0x840f: // sprmPDxaLeft80
      case 0x845e: // sprmPDxaLeft
        setInd('left', 'twips', i16);
        break;
      case 0x840e: // sprmPDxaRight80
      case 0x845d: // sprmPDxaRight
        setInd('right', 'twips', i16);
        break;
      case 0x8411: // sprmPDxaLeft180
      case 0x8460: // sprmPDxaLeft1
        setInd('first', 'twips', i16);
        break;
      case 0x4456: // sprmPDxcLeft (1/100 글자)
        setInd('left', 'chars', i16);
        break;
      case 0x4455: // sprmPDxcRight
        setInd('right', 'chars', i16);
        break;
      case 0x4457: // sprmPDxcLeft1
        setInd('first', 'chars', i16);
        break;
      case 0xa413: // sprmPDyaBefore
        setSp('before', 'twips', u16);
        break;
      case 0xa414: // sprmPDyaAfter
        setSp('after', 'twips', u16);
        break;
      case 0x4458: // sprmPDylBefore (1/100 줄)
        setSp('before', 'lines', i16);
        break;
      case 0x4459: // sprmPDylAfter
        setSp('after', 'lines', i16);
        break;
      case 0x245b: // sprmPFDyaBeforeAuto
        sp.beforeAuto = v8 !== 0;
        break;
      case 0x245c: // sprmPFDyaAfterAuto
        sp.afterAuto = v8 !== 0;
        break;
      case 0x6412: {
        // sprmPDyaLine (LSPD: dyaLine, fMultLinespace). 배수면 auto, 아니면 양수 = 최소, 음수 = 고정
        if (arg.length < 4) break;
        const dya = arg.readInt16LE(0);
        const mult = arg.readInt16LE(2);
        delete props.lineHeight;
        delete props.linePx;
        if (mult === 1) {
          out.line = { rule: 'auto', val: dya };
          const v = Math.round((dya / 240) * 100) / 100;
          if (v > 0) props.lineHeight = Math.min(v, 20);
        } else if (dya !== 0) {
          out.line = { rule: dya < 0 ? 'exact' : 'atLeast', val: Math.abs(dya) };
          const v = twipsToPx(Math.abs(dya));
          if (v > 0) props.linePx = Math.min(v, 2000);
        } else delete out.line;
        break;
      }
      case 0xd608: {
        // sprmTDefTable: cb(2) itcMac(1) rgdxaCenter[itcMac+1](2) rgTc80[itcMac](20)
        // TC80 = tcgrf(2: 가로 병합 0x01/0x02, 세로 병합 0x20/0x40, 세로 정렬 비트 7-8) + 너비(2) + 테두리 4개(Brc80)
        if (arg.length < 3) break;
        const itcMac = arg[2]!;
        const cs: number[] = [];
        let p = 3;
        for (let i = 0; i <= itcMac && p + 2 <= arg.length; i += 1, p += 2) cs.push(arg.readInt16LE(p));
        for (let i = 0; i < itcMac; i += 1) {
          const q = p + i * 20;
          if (q + 2 > arg.length) {
            vm.push(undefined);
            hm.push(false);
            va.push(undefined);
            tcBrc.push([]);
            continue;
          }
          const f = arg.readUInt16LE(q);
          vm.push(f & 0x20 ? (f & 0x40 ? 'restart' : 'continue') : undefined);
          hm.push((f & 0x02) !== 0 && (f & 0x01) === 0);
          va.push(VA[(f >> 7) & 3]);
          tcBrc.push([0, 1, 2, 3].map((k) => brc80(arg, q + 4 + k * 4, true)));
        }
        if (cs.length >= 2) centers = cs;
        break;
      }
      case 0xd605: // sprmTTableBorders80: 위, 왼쪽, 아래, 오른쪽, 안쪽 가로, 안쪽 세로 (Brc80)
        tbl80 = [0, 1, 2, 3, 4, 5].map((k) => brc80(arg, k * 4, false));
        break;
      case 0xd613: // sprmTTableBorders (Brc)
        tbl = [0, 1, 2, 3, 4, 5].map((k) => brc(arg, k * 8));
        break;
      case 0xd620: // sprmTSetBrc80: itcFirst, itcLim, 변 비트, Brc80
        if (arg.length >= 7) setBrc.push({ first: arg[0]!, lim: arg[1]!, v: { sides: arg[2]!, brc: brc80(arg, 3, false) } });
        break;
      case 0xd62f: // sprmTSetBrc: itcFirst, itcLim, 변 비트, Brc
        if (arg.length >= 11) setBrc.push({ first: arg[0]!, lim: arg[1]!, v: { sides: arg[2]!, brc: brc(arg, 3) } });
        break;
      case 0xd62c: // sprmTVertAlign: itcFirst, itcLim, 정렬
        if (arg.length >= 3) vAlign.push({ first: arg[0]!, lim: arg[1]!, v: VA[arg[2]!] });
        break;
      case 0x9602: // sprmTDxaGapHalf: 칸 왼쪽, 오른쪽 여백(옛 방식)
        gapHalf = Math.max(0, i16);
        break;
      case 0xd634: // sprmTCellPaddingDefault: CSSA(itcFirst, itcLim, 변 비트, 단위, 값)
        if (arg.length >= 6 && arg[3] === 3) {
          for (const [bit, side] of PAD_SIDES) if (arg[2]! & bit) padExplicit[side] = arg.readUInt16LE(4);
        }
        break;
      case 0xd632: // sprmTCellPadding
        if (arg.length >= 6 && arg[3] === 3) padCells.push({ first: arg[0]!, lim: arg[1]!, v: { sides: arg[2]!, w: arg.readUInt16LE(4) } });
        break;
      case 0xd609: // sprmTDefTableShd80: 칸마다 Shd80
        shdList80 = [];
        for (let o = 0; o + 2 <= arg.length; o += 2) shdList80.push(shd80(arg, o));
        break;
      case 0xd612: // sprmTDefTableShd: 칸 0..21
      case 0xd616: // sprmTDefTableShd2nd: 칸 22..43
      case 0xd60c: {
        // sprmTDefTableShd3rd: 칸 44..62
        const at = op === 0xd612 ? 0 : op === 0xd616 ? 22 : 44;
        shdList ??= [];
        for (let o = 0, i = at; o + 10 <= arg.length; o += 10, i += 1) shdList[i] = shd(arg, o);
        break;
      }
      case 0xf614: // sprmTTableWidth: 단위(1), 값(2)
        if (arg.length >= 3) tblWidth = { fts: arg[0]!, w: arg.readInt16LE(1) };
        break;
      case 0x5400: // sprmTJc90
      case 0x548a: // sprmTJc
        tblJc = u16;
        break;
      case 0xf661: // sprmTWidthIndent: 단위(1), 값(2). twips 만 쓴다
        if (arg.length >= 3 && arg[0] === 3) tblInd = arg.readInt16LE(1);
        break;
      case 0x9407: // sprmTDyaRowHeight (+ 최소, - 고정)
        if (i16 !== 0) out.rowH = { h: twipsToPx(Math.abs(i16)), exact: i16 < 0 };
        break;
      case 0x3404: // sprmTTableHeader
        out.header = v8 !== 0;
        break;
      default:
        break;
    }
  }
  // 들여쓰기: 화면 값은 단위별로, 어림용 값은 이 겹이 정한 쪽을 통째로
  const ind: IndSet = { ...base.ind };
  const indL: IndSet = { ...base.indL };
  for (const k of ['left', 'right', 'first'] as const) {
    const l = layer[k];
    if (!l) continue;
    ind[k] = { ...ind[k], ...l };
    indL[k] = { ...l };
  }
  out.ind = ind;
  out.indL = indL;
  out.sp = sp;
  if (centers) {
    const padDefault: RowTap['padDefault'] = {};
    if (gapHalf !== undefined) {
      padDefault.left = gapHalf;
      padDefault.right = gapHalf;
    }
    out.tap = {
      centers,
      vm,
      hm,
      va,
      tcBrc,
      tblBrc: tbl ?? tbl80 ?? [],
      setBrc,
      vAlign,
      padDefault: { ...padDefault, ...padExplicit },
      padCells,
      shd: shdList ?? shdList80 ?? [],
    };
    if (tblWidth) out.tap.width = tblWidth;
    if (tblJc !== undefined) out.tap.jc = tblJc;
    if (tblInd !== undefined) out.tap.ind = tblInd;
  }
  return out;
}

// ─────────────────────────────── 스타일 표 (STSH) ───────────────────────────────

interface StyleDef {
  /** 1 문단 스타일, 2 글자 스타일 (3 표, 4 번호 스타일은 쓰지 않는다) */
  stk: number;
  /** 바탕 스타일 번호 (0x0FFF = 없음) */
  base: number;
  papx: Buffer | null;
  chpx: Buffer | null;
}

interface StyleSheet {
  styles: (StyleDef | undefined)[];
  /** 기본 글꼴 번호: ASCII, 동아시아, 그 밖 (rgftcStandardChpStsh) */
  ftc: number[];
}

/**
 * STSH: LPStshi(cbStshi 2 + STSHI) 뒤에 LPStd(cbStd 2 + STD) 가 cstd 개. STD = StdfBase(sti, stk/istdBase,
 * cupx/istdNext, ...) + 이름(Xstz) + UPX 들(각각 cbUpx 2 + 내용, STD 시작 기준 짝수 위치로 맞춘다).
 * 문단 스타일의 UPX 는 [UpxPapx(istd 2 + grpprl), UpxChpx], 글자 스타일은 [UpxChpx].
 * 스타일은 보조 정보라 읽다 막히면 읽은 데까지 쓴다.
 */
function readStyleSheet(table: Buffer, fc: number, lcb: number): StyleSheet {
  const styles: (StyleDef | undefined)[] = [];
  const ftc: number[] = [];
  if (lcb < 4 || fc + lcb > table.length) return { styles, ftc };
  try {
    const end = fc + lcb;
    const cbStshi = table.readUInt16LE(fc);
    const si = fc + 2;
    if (si + Math.max(cbStshi, 4) > end) return { styles, ftc };
    const cstd = table.readUInt16LE(si);
    const cbBase = table.readUInt16LE(si + 2);
    if (cbStshi >= 18) for (let k = 0; k < 3; k += 1) ftc.push(table.readUInt16LE(si + 12 + k * 2));
    let p = si + cbStshi;
    for (let i = 0; i < cstd && i < 4096 && p + 2 <= end; i += 1) {
      const cbStd = table.readUInt16LE(p);
      p += 2;
      const sp = p;
      const se = Math.min(end, p + cbStd);
      p += cbStd;
      if (cbStd === 0 || cbBase < 10 || se - sp < cbBase + 2) {
        styles.push(undefined);
        continue;
      }
      const w1 = table.readUInt16LE(sp + 2);
      const stk = w1 & 0x0f;
      const base = w1 >> 4;
      const cupx = table.readUInt16LE(sp + 4) & 0x0f;
      let q = sp + cbBase;
      const cch = table.readUInt16LE(q);
      q += 2 + cch * 2 + 2; // 이름 + 끝 글자 0
      let papx: Buffer | null = null;
      let chpx: Buffer | null = null;
      for (let u = 0; u < cupx; u += 1) {
        if ((q - sp) & 1) q += 1;
        if (q + 2 > se) break;
        const cbUpx = table.readUInt16LE(q);
        q += 2;
        const body = table.subarray(q, Math.min(se, q + cbUpx));
        q += cbUpx;
        if (stk === 1) {
          if (u === 0) papx = body.length >= 2 ? body.subarray(2) : null;
          else if (u === 1) chpx = body;
        } else if (stk === 2 && u === 0) chpx = body;
      }
      styles.push({ stk, base, papx, chpx });
    }
  } catch {
    // 읽은 데까지 쓴다
  }
  return { styles, ftc };
}

function sectInfo(grpprl: Buffer | null): SectInfo {
  let w = 12240;
  let h = 15840;
  let left = 1800;
  let right = 1800;
  let top = 1440;
  let bottom = 1440;
  let hdr = 720;
  let ftr = 720;
  let bkc = 2;
  let seen = false;
  if (grpprl) {
    for (const { op, arg } of sprms(grpprl)) {
      if (arg.length < 1) continue;
      const u16 = arg.length >= 2 ? arg.readUInt16LE(0) : 0;
      const i16 = arg.length >= 2 ? arg.readInt16LE(0) : 0;
      switch (op) {
        case 0xb01f: w = u16; seen = true; break; // sprmSXaPage
        case 0xb020: h = u16; seen = true; break; // sprmSYaPage
        case 0xb021: left = u16; break; // sprmSDxaLeft
        case 0xb022: right = u16; break; // sprmSDxaRight
        case 0x9023: top = Math.abs(i16); break; // sprmSDyaTop
        case 0x9024: bottom = Math.abs(i16); break; // sprmSDyaBottom
        case 0xb017: hdr = u16; break; // sprmSDyaHdrTop
        case 0xb018: ftr = u16; break; // sprmSDyaHdrBottom
        case 0x3009: bkc = arg[0]!; break; // sprmSBkc
        default: break;
      }
    }
  }
  if (!seen && !grpprl) return { ...DEFAULT_SECT };
  const W = Math.min(10_000, Math.max(200, twipsToPx(w)));
  const H = Math.min(10_000, Math.max(200, twipsToPx(h)));
  return {
    w: W,
    h: H,
    margin: [
      Math.min(H / 2, twipsToPx(top)),
      Math.min(W / 2, twipsToPx(right)),
      Math.min(H / 2, twipsToPx(bottom)),
      Math.min(W / 2, twipsToPx(left)),
    ],
    headerDist: twipsToPx(hdr),
    footerDist: twipsToPx(ftr),
    type: bkc === 0 ? 'continuous' : 'nextPage',
    titlePg: false,
    headers: {},
    footers: {},
  };
}

/** 들여쓰기 한 쪽 px: 글자 단위 값이 0 이 아니면 그것(문단 표지 글자 크기 기준), 아니면 twips (docx indentPx) */
function sidePx(s: IndSide | undefined, charPx: number): number {
  if (!s) return 0;
  if (s.chars) return round1((s.chars / 100) * charPx);
  return twipsToPx(s.twips ?? 0);
}

/** 문단 간격 px: 줄 단위 값이 있으면 1줄 16px, 아니면 twips (docx paraOut 과 같다) */
function spacePx(sp: SpSide | undefined): number {
  if (!sp) return 0;
  const v = sp.lines ? round1((sp.lines / 100) * 16) : twipsToPx(sp.twips ?? 0);
  return Math.max(0, v);
}

/**
 * 문단 모양 마무리: 들여쓰기와 간격을 px 로. props 의 들여쓰기는 쪽 나눔 어림용 옛 규칙 값, render 는 화면 값이다
 * (docx build.ts paraOut, para 와 같은 나눔). markPt = 문단 표지 글자 크기(글자 단위 들여쓰기의 기준)
 */
function finishPara(pp: ParaProps, markPt: number | undefined): { props: ParaOut; render: { marginLeft: number; marginRight: number; indent: number } } {
  const charPx = (markPt ?? DEFAULT_PT) * (96 / 72);
  const props: ParaOut = { ...pp.props };
  const ml = sidePx(pp.indL?.left, charPx);
  const mr = sidePx(pp.indL?.right, charPx);
  const ind = sidePx(pp.indL?.first, charPx);
  if (ml) props.marginLeft = ml;
  if (mr) props.marginRight = mr;
  if (ind) props.indent = ind;
  const sb = pp.sp?.beforeAuto ? 14 : spacePx(pp.sp?.before);
  if (sb) props.spaceBefore = sb;
  const sa = pp.sp?.afterAuto ? 14 : spacePx(pp.sp?.after);
  if (sa) props.spaceAfter = sa;
  return {
    props,
    render: { marginLeft: sidePx(pp.ind?.left, charPx), marginRight: sidePx(pp.ind?.right, charPx), indent: sidePx(pp.ind?.first, charPx) },
  };
}

/**
 * 화면에 그리는 줄 높이 px (docx build.ts lineBox 와 같은 규칙): 글자 조각마다 글꼴, 크기의 '한 줄' 높이 중 최댓값
 * (글자가 없으면 문단 표지 글꼴, 크기)에 줄 간격 규칙을 적용한다. 문서 격자 맞춤은 하지 않는다(docx 실물도 격자 없음).
 */
function lineBox(pp: ParaProps, items: IRItem[], mark: CharProps): number | undefined {
  const rule = pp.line?.rule ?? 'auto';
  if (rule === 'exact' && pp.props.linePx !== undefined) return pp.props.linePx;
  let single = 0;
  for (const it of items) {
    if (it.k !== 't') continue;
    single = Math.max(single, singleLinePx(it.s.font, it.s.sz ?? DEFAULT_PT, hasEastAsian(it.t)));
  }
  if (single === 0) {
    const sz = mark.s.sz ?? DEFAULT_PT;
    single = Math.max(singleLinePx(mark.fontE, sz, true), singleLinePx(mark.fontA ?? mark.fontE, sz, false));
  }
  let h: number;
  if (rule === 'atLeast') h = Math.max(pp.line ? twipsToPx(pp.line.val) : 0, single);
  else h = (pp.line && pp.line.val > 0 ? pp.line.val / 240 : 1) * single;
  return h > 0 ? round1(Math.min(h, 2000)) : undefined;
}

// ─────────────────────────────── 표 만들기 ───────────────────────────────

interface PendingCell {
  blocks: IRBlock[];
}

interface PendingRow {
  cells: PendingCell[];
  tap?: RowTap;
  rowH?: ParaProps['rowH'];
  header: boolean;
}

/** Word 기본 칸 왼쪽, 오른쪽 여백 0.075인치 (docx 와 같은 기본값) */
const DEFAULT_CELL_PAD = 108;

/**
 * 칸 네 변, 세로 정렬, 안쪽 여백, 음영. 테두리는 표 테두리(위치에 따라 바깥/안쪽) → 칸 정의(TC80) → 칸 범위
 * sprmTSetBrc 순서로 덮는다 (docx cellBorders 의 표 → 칸 직접 순서와 같다)
 */
function cellFormat(cell: IRCell, tap: RowTap, i: number, firstRow: boolean, lastRow: boolean, firstCell: boolean, lastCell: boolean): void {
  const T = tap.tblBrc;
  const side: Brc[] = [firstRow ? T[0] : T[4], firstCell ? T[1] : T[5], lastRow ? T[2] : T[4], lastCell ? T[3] : T[5]];
  const tc = tap.tcBrc[i] ?? [];
  for (let k = 0; k < 4; k += 1) if (tc[k] !== undefined) side[k] = tc[k];
  for (const r of tap.setBrc) {
    if (i < r.first || i >= r.lim || r.v.brc === undefined) continue;
    for (let k = 0; k < 4; k += 1) if (r.v.sides & (1 << k)) side[k] = r.v.brc;
  }
  const [top, left, bottom, right] = side;
  if (top) cell.bt = top;
  if (bottom) cell.bb = bottom;
  if (left) cell.bl = left;
  if (right) cell.br = right;
  let va = tap.va[i];
  for (const r of tap.vAlign) if (i >= r.first && i < r.lim) va = r.v;
  if (va === 'middle' || va === 'bottom') cell.va = va;
  const pad = { top: 0, right: DEFAULT_CELL_PAD, bottom: 0, left: DEFAULT_CELL_PAD, ...tap.padDefault };
  for (const r of tap.padCells) {
    if (i < r.first || i >= r.lim) continue;
    if (r.v.sides & 1) pad.top = r.v.w;
    if (r.v.sides & 2) pad.left = r.v.w;
    if (r.v.sides & 4) pad.bottom = r.v.w;
    if (r.v.sides & 8) pad.right = r.v.w;
  }
  cell.pad = [twipsToPx(pad.top), twipsToPx(pad.right), twipsToPx(pad.bottom), twipsToPx(pad.left)];
  const bg = tap.shd[i];
  if (bg) cell.bg = bg;
}

/** avail: 구역의 글자 영역 너비 px (퍼센트 너비의 바탕) */
function buildTable(rows: PendingRow[], sect: number, avail: number): IRTable {
  // 모든 행의 칸 경계를 모아 하나의 격자를 만든다 (docx tblGrid 와 같은 쓰임)
  const edges = new Set<number>();
  for (const r of rows) for (const c of r.tap?.centers ?? []) edges.add(c);
  const grid = [...edges].sort((a, b) => a - b);
  const useGrid = grid.length >= 2 && rows.every((r) => r.tap && r.tap.centers.length === r.cells.length + 1);
  const outRows: IRRow[] = rows.map((r, ri) => {
    const cells: IRCell[] = [];
    const tap = r.tap;
    r.cells.forEach((c, i) => {
      contextSpacing(c.blocks);
      const prev = cells[cells.length - 1];
      if (tap?.hm[i] && prev) {
        // 옛 가로 병합: 앞 칸에 합친다
        if (useGrid) {
          const end = Math.max(prev.col + prev.span, grid.indexOf(tap.centers[i + 1]!));
          prev.span = Math.max(1, end - prev.col);
          if (prev.w !== undefined) prev.w = twipsToPx(Math.max(0, tap.centers[i + 1]! - grid[prev.col]!));
        } else prev.span += 1;
        prev.blocks.push(...c.blocks);
        return;
      }
      let cell: IRCell;
      if (useGrid) {
        const left = tap!.centers[i]!;
        const right = tap!.centers[i + 1]!;
        const col = Math.max(0, grid.indexOf(left));
        const end = Math.max(col + 1, grid.indexOf(right));
        cell = { blocks: c.blocks, col, span: Math.max(1, end - col), w: twipsToPx(Math.max(0, right - left)) };
        const vm = tap!.vm[i];
        if (vm) cell.vm = vm;
      } else cell = { blocks: c.blocks, col: i, span: 1 };
      if (tap) cellFormat(cell, tap, i, ri === 0, ri === rows.length - 1, i === 0, i === r.cells.length - 1);
      else cell.pad = [0, twipsToPx(DEFAULT_CELL_PAD), 0, twipsToPx(DEFAULT_CELL_PAD)];
      cells.push(cell);
    });
    const row: IRRow = { cells };
    if (r.rowH) {
      row.h = r.rowH.h;
      row.hRule = r.rowH.exact ? 'exact' : 'atLeast';
    }
    if (r.header) row.header = true;
    return row;
  });
  const t: IRTable = { k: 'tbl', rows: outRows, sect };
  if (useGrid) t.colWidths = grid.slice(1).map((x, i) => twipsToPx(Math.max(0, x - grid[i]!)));
  // 표 너비, 정렬, 들여쓰기는 첫 행 값 (docx widthPx 와 같은 규칙: twips 또는 퍼센트만, 자동은 비운다)
  const first = rows[0]?.tap;
  if (first?.width && first.width.w > 0) {
    const { fts, w } = first.width;
    const width = fts === 3 ? twipsToPx(w) : fts === 2 ? round1((avail * (w / 50)) / 100) : undefined;
    if (width) t.width = width;
  }
  if (first?.jc === 1) t.align = 'center';
  else if (first?.jc === 2) t.align = 'right';
  if (first?.ind) {
    const ind = twipsToPx(first.ind);
    if (ind) t.indent = ind;
  }
  return t;
}

// ─────────────────────────────── 본체 ───────────────────────────────

export function processDoc(buf: Buffer, fileName: string): OfficeExtractResult {
  try {
    return extract(buf, fileName);
  } catch (e) {
    if (e instanceof OfficeParseError) throw e;
    const err = new OfficeParseError(ERR_CORRUPT);
    err.cause = e;
    throw err;
  }
}

function extract(buf: Buffer, _fileName: string): OfficeExtractResult {
  const cfb = Cfb.open(buf);
  if (!cfb) throw new OfficeParseError(ERR_CORRUPT);
  if (cfb.has('EncryptionInfo') || cfb.has('EncryptedPackage')) throw new OfficeParseError(ERR_ENCRYPTED);
  const wd = cfb.read('WordDocument', MAX_STREAM, ERR_TOO_BIG);
  if (!wd || wd.length < 0x200) throw new OfficeParseError(ERR_CORRUPT);
  if (wd.readUInt16LE(0) !== 0xa5ec) throw new OfficeParseError(ERR_CORRUPT);
  const nFib = wd.readUInt16LE(2);
  if (nFib < 0x00c1) throw new OfficeParseError(ERR_OLD);
  const flags = wd.readUInt16LE(0x0a);
  if (flags & 0x0100 || flags & 0x8000) throw new OfficeParseError(ERR_ENCRYPTED);
  const table = cfb.read(flags & 0x0200 ? '1Table' : '0Table', MAX_STREAM, ERR_TOO_BIG);
  if (!table) throw new OfficeParseError(ERR_CORRUPT);
  const cbRgFcLcb = wd.readUInt16LE(0x98);
  if (cbRgFcLcb < 0x22) throw new OfficeParseError(ERR_CORRUPT);
  const fcLcb = (k: number): { fc: number; lcb: number } => ({
    fc: wd.readUInt32LE(0x9a + k * 8),
    lcb: wd.readUInt32LE(0x9a + k * 8 + 4),
  });
  const ccpText = wd.readInt32LE(0x4c);
  if (ccpText < 0 || ccpText > MAX_CP) throw new OfficeParseError(ccpText > MAX_CP ? ERR_TOO_BIG : ERR_CORRUPT);

  // ── 조각표
  const clx = fcLcb(33);
  if (clx.fc + clx.lcb > table.length || clx.lcb < 5) throw new OfficeParseError(ERR_CORRUPT);
  let p = clx.fc;
  const clxEnd = clx.fc + clx.lcb;
  while (p < clxEnd && table[p] === 0x01) {
    const cb = table.readInt16LE(p + 1);
    p += 3 + Math.max(0, cb);
  }
  if (p >= clxEnd || table[p] !== 0x02) throw new OfficeParseError(ERR_CORRUPT);
  const lcbPcd = table.readUInt32LE(p + 1);
  const plc = p + 5;
  if (plc + lcbPcd > table.length) throw new OfficeParseError(ERR_CORRUPT);
  const nPcd = Math.floor((lcbPcd - 4) / 12);
  const pieces: Piece[] = [];
  for (let i = 0; i < nPcd; i += 1) {
    const cp0 = table.readInt32LE(plc + i * 4);
    const cp1 = table.readInt32LE(plc + (i + 1) * 4);
    const pcd = plc + (nPcd + 1) * 4 + i * 8;
    const fcRaw = table.readUInt32LE(pcd + 2);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = compressed ? (fcRaw & 0x3fffffff) / 2 : fcRaw;
    if (cp1 > cp0) pieces.push({ cp0, cp1, fc, compressed });
  }

  // ── 글자 (본문 CP 0..ccpText, 이어서 각주 이야기 ccpText..ccpText+ccpFtn) 와 CP → FC
  const ccpFtn = Math.max(0, wd.readInt32LE(0x50));
  const ccpAll = ccpText + (ccpText + ccpFtn <= MAX_CP ? ccpFtn : 0);
  const chars: number[] = new Array(ccpAll);
  const fcOf = new Float64Array(ccpAll);
  for (const pc of pieces) {
    const a = Math.max(0, pc.cp0);
    const b = Math.min(ccpAll, pc.cp1);
    for (let cp = a; cp < b; cp += 1) {
      const k = cp - pc.cp0;
      if (pc.compressed) {
        const at = pc.fc + k;
        const byte = at < wd.length ? wd[at]! : 0x20;
        chars[cp] = CP1252_HIGH[byte] ?? byte;
        fcOf[cp] = at;
      } else {
        const at = pc.fc + k * 2;
        chars[cp] = at + 1 < wd.length ? wd.readUInt16LE(at) : 0x20;
        fcOf[cp] = at;
      }
    }
  }
  for (let cp = 0; cp < ccpAll; cp += 1) if (chars[cp] === undefined) chars[cp] = 0x20;

  // ── 문서 속성(DOP): 기본 탭 간격 dxaTab(0x0A), 각주 시작 번호 nFtn(0x02 의 위 14비트)
  const dop = fcLcb(31);
  const dopOk = dop.lcb >= 12 && dop.fc + 12 <= table.length;
  const dxaTab = dopOk ? table.readUInt16LE(dop.fc + 0x0a) : 0;
  const tab = dxaTab > 0 && dxaTab < 0x7fff ? twipsToPx(dxaTab) : TAB_PX;
  const footStart = (dopOk ? table.readUInt16LE(dop.fc + 0x02) >> 2 : 0) || 1;

  // ── 속성 표
  const fonts = readFonts(table, fcLcb(15).fc, fcLcb(15).lcb);
  const chpx = chpxRuns(wd, bteList(table, fcLcb(12).fc, fcLcb(12).lcb));
  const papx = papxRuns(wd, bteList(table, fcLcb(13).fc, fcLcb(13).lcb));
  const sheet = readStyleSheet(table, fcLcb(1).fc, fcLcb(1).lcb);
  const lists = cbRgFcLcb > 74 ? DocLists.read(table, fcLcb(73), fcLcb(74)) : DocLists.read(table, { fc: 0, lcb: 0 }, { fc: 0, lcb: 0 });
  // 기본 글자 모양: Word 기본 CHP(10pt) + 스타일 표의 기본 글꼴
  const defaultChar: CharState = {
    ...BASE_CHAR,
    sz: DEFAULT_PT,
    fontA: fonts[sheet.ftc[0] ?? -1],
    fontE: fonts[sheet.ftc[1] ?? -1],
    fontO: fonts[sheet.ftc[2] ?? -1],
  };
  // 스타일 해석 (바탕 스타일 사슬. 고리와 지나친 깊이는 거기서 끊는다)
  const styleCharMemo = new Map<number, CharState>();
  const styleChar = (istd: number, depth = 0): CharState => {
    const hit = styleCharMemo.get(istd);
    if (hit) return hit;
    const st = sheet.styles[istd];
    const base = st && st.base !== 0x0fff && st.base !== istd && depth < 16 ? styleChar(st.base, depth + 1) : defaultChar;
    const out = st?.chpx ? applyChar(base, st.chpx, fonts) : base;
    styleCharMemo.set(istd, out);
    return out;
  };
  const styleParaMemo = new Map<number, ParaBase>();
  const stylePara = (istd: number, depth = 0): ParaBase => {
    const hit = styleParaMemo.get(istd);
    if (hit) return hit;
    const st = sheet.styles[istd];
    const base = st && st.base !== 0x0fff && st.base !== istd && depth < 16 ? stylePara(st.base, depth + 1) : { props: {} };
    const out = st?.stk === 1 && st.papx ? baseOf(paraProps(st.papx, base)) : base;
    styleParaMemo.set(istd, out);
    return out;
  };
  const empty = Buffer.alloc(0);
  const stateCache = new Map<number, Map<Buffer, CharState>>();
  /** 글자 모양 상태: 문단 스타일 → (sprmCIstd 가 있으면) 글자 스타일 → 직접 서식 */
  const charStateAt = (cp: number, istd: number): CharState => {
    const g = findRun(chpx, fcOf[cp]!)?.grpprl ?? empty;
    let byGrpprl = stateCache.get(istd);
    if (!byGrpprl) {
      byGrpprl = new Map();
      stateCache.set(istd, byGrpprl);
    }
    let c = byGrpprl.get(g);
    if (!c) {
      let base = styleChar(istd);
      const cs = sprms(g).find((x) => x.op === 0x4a30 && x.arg.length >= 2);
      if (cs) {
        const st = sheet.styles[cs.arg.readUInt16LE(0)];
        if (st?.stk === 2 && st.chpx) base = applyChar(base, st.chpx, fonts);
      }
      c = applyChar(base, g, fonts);
      byGrpprl.set(g, c);
    }
    return c;
  };
  const outCache = new WeakMap<CharState, CharProps>();
  const charAt = (cp: number, istd: number): CharProps => {
    const st = charStateAt(cp, istd);
    let c = outCache.get(st);
    if (!c) {
      c = charOut(st);
      outCache.set(st, c);
    }
    return c;
  };
  const papCache = new Map<Buffer, { pp: ParaProps; istd: number }>();
  /** 문단 모양: 문단 스타일 사슬 → (번호 문단이면) 번호 단계의 문단 sprm → 직접 서식. 문단 스타일 번호도 낸다 */
  const paraAt = (cpMark: number): { pp: ParaProps; istd: number } => {
    const run = findRun(papx, fcOf[cpMark]!);
    const g = run?.grpprl ?? empty;
    const istd = run?.istd ?? 0;
    let hit = papCache.get(g);
    if (!hit || hit.istd !== istd) {
      const sBase = stylePara(istd);
      let pp = paraProps(g, sBase);
      const lvl = listOf(pp) ? lists.level(pp.ilfo!, pp.ilvl ?? 0) : undefined;
      if (lvl && lvl.papx.length > 0) pp = paraProps(g, baseOf(paraProps(lvl.papx, sBase)));
      hit = { pp, istd };
      papCache.set(g, hit);
    }
    return hit;
  };

  // ── 구역
  const sed = fcLcb(6);
  const sectEnds: number[] = [];
  const sections: SectInfo[] = [];
  if (sed.lcb >= 16 && sed.fc + sed.lcb <= table.length) {
    const n = Math.floor((sed.lcb - 4) / 16);
    for (let i = 0; i < n; i += 1) {
      const cpEnd = table.readInt32LE(sed.fc + (i + 1) * 4);
      const fcSepx = table.readInt32LE(sed.fc + (n + 1) * 4 + i * 12 + 2);
      let grpprl: Buffer | null = null;
      if (fcSepx >= 0 && fcSepx + 2 <= wd.length) {
        const cb = wd.readUInt16LE(fcSepx);
        if (fcSepx + 2 + cb <= wd.length) grpprl = wd.subarray(fcSepx + 2, fcSepx + 2 + cb);
      }
      sections.push(sectInfo(grpprl ?? Buffer.alloc(0)));
      sectEnds.push(cpEnd);
    }
  }
  if (sections.length === 0) {
    sections.push({ ...DEFAULT_SECT });
    sectEnds.push(ccpText);
  }
  const sectionEndSet = new Set(sectEnds);
  const sectOf = (cp: number): number => {
    for (let i = 0; i < sectEnds.length; i += 1) if (cp < sectEnds[i]!) return i;
    return sectEnds.length - 1;
  };

  // ── 각주: 본문 참조 위치(PlcffndRef: CP 들 + FRD(nAuto)) 와 각주 글 범위(PlcffndTxt: 각주 이야기 안 CP 들)
  const noteAt = new Map<number, { key: string; num: number | null }>();
  const noteRanges: { key: string; num: number | null; a: number; b: number }[] = [];
  if (ccpAll > ccpText) {
    const ref = fcLcb(2);
    const txt = fcLcb(3);
    if (ref.lcb >= 6 && ref.fc + ref.lcb <= table.length && txt.lcb >= 8 && txt.fc + txt.lcb <= table.length) {
      const n = Math.floor((ref.lcb - 4) / 6);
      const nTxt = Math.floor(txt.lcb / 4) - 1;
      let auto = 0;
      for (let i = 0; i < n && i < nTxt; i += 1) {
        const cp = table.readInt32LE(ref.fc + i * 4);
        const nAuto = table.readInt16LE(ref.fc + (n + 1) * 4 + i * 2);
        const key = `f:${i}`;
        const num = nAuto > 0 ? footStart + auto++ : null;
        noteAt.set(cp, { key, num });
        const a = ccpText + table.readInt32LE(txt.fc + i * 4);
        const b = ccpText + table.readInt32LE(txt.fc + (i + 1) * 4);
        if (a >= ccpText && b <= ccpAll && b > a) noteRanges.push({ key, num, a, b });
      }
    }
  }

  // ── 문단으로 자르며 IR 을 만든다 (본문, 각주 글 하나씩)
  let paraCount = 0;
  /** [a, b) 범위를 블록으로. body 면 구역 경계를 알고, note 면 0x02 를 그 각주 번호로 그린다 */
  const parseRange = (a: number, b: number, story: { kind: 'body' } | { kind: 'note'; num: number | null }): IRBlock[] => {
    const blocks: IRBlock[] = [];
    let tableRows: PendingRow[] | null = null;
    let tableSect = 0;
    let row: PendingRow = { cells: [], header: false };
    let cell: PendingCell = { blocks: [] };
    const fieldStack: ('instr' | 'result')[] = [];
    const flushTable = (): void => {
      if (tableRows && tableRows.length > 0) {
        const sc = sections[Math.min(tableSect, sections.length - 1)]!;
        blocks.push(buildTable(tableRows, tableSect, Math.max(0, sc.w - sc.margin[1] - sc.margin[3])));
      }
      tableRows = null;
      row = { cells: [], header: false };
      cell = { blocks: [] };
    };
    const body = story.kind === 'body';
    let start = a;
    for (let cp = a; cp < b; cp += 1) {
      const ch = chars[cp]!;
      const isSectMark = body && ch === 0x0c && sectionEndSet.has(cp + 1);
      if (ch !== 0x0d && ch !== 0x07 && !isSectMark && cp !== b - 1) continue;
      const end = cp; // 표지 자리 (표지 글자는 글자에 넣지 않는다)
      const lastNoMark = cp === b - 1 && ch !== 0x0d && ch !== 0x07 && !isSectMark;
      if (++paraCount > MAX_PARAS) break;
      const { pp, istd } = paraAt(cp);
      const sect = body ? sectOf(start) : 0;

      // 문단 안 글자 → 조각
      const items: IRItem[] = [];
      let raw = '';
      let cur: CharProps | null = null;
      const flushRun = (): void => {
        if (cur && raw) {
          const t = canon(raw);
          if (t) {
            const s = runStyleOf(cur, t);
            items.push({ k: 't', t, s, key: JSON.stringify(s) });
          }
        }
        raw = '';
      };
      /** 각주 번호(위첨자) 조각 */
      const pushNum = (num: number, cprops: CharProps): void => {
        flushRun();
        cur = null;
        const t = formatNumber(num, 'decimal');
        const s: RunOut = { ...runStyleOf(cprops, t), sup: true };
        delete s.sub;
        items.push({ k: 't', t, s, key: JSON.stringify(s) });
      };
      const stop = lastNoMark ? end + 1 : end;
      for (let i = start; i < stop; i += 1) {
        const c = chars[i]!;
        if (c === 0x13) {
          fieldStack.push('instr');
          continue;
        }
        if (c === 0x14) {
          if (fieldStack.length > 0) fieldStack[fieldStack.length - 1] = 'result';
          continue;
        }
        if (c === 0x15) {
          fieldStack.pop();
          continue;
        }
        if (fieldStack.includes('instr')) continue;
        const cprops = charAt(i, istd);
        if (cprops.hidden) continue;
        if (c === 0x02) {
          // 각주 참조(본문) 또는 각주 글 머리의 번호 표지(각주 글)
          if (body) {
            const note = noteAt.get(i);
            if (note) {
              flushRun();
              cur = null;
              items.push({ k: 'note', key: note.key });
              if (note.num !== null) pushNum(note.num, cprops);
            }
          } else if (story.num !== null) pushNum(story.num, cprops);
          continue;
        }
        let text: string;
        if (c === 0x09) text = '\t';
        else if (c === 0x0b) text = '\n';
        else if (c === 0x0c) {
          // 구역 경계가 아닌 0x0C 는 쪽 나눔
          flushRun();
          cur = null;
          if (body) items.push({ k: 'pb' });
          continue;
        } else if (c === 0x1e) text = '-';
        else if (c < 0x20 || c === 0x1f) continue;
        else text = String.fromCharCode(c);
        if (!cur || cur.key !== cprops.key) {
          flushRun();
          cur = cprops;
        }
        raw += text;
      }
      flushRun();

      // 번호 이름표 (docx addLabel 과 같은 규칙: 문단 표지 모양 위에 단계 글자 모양, 숨김이면 싣지 않는다)
      const markState = charStateAt(end, istd);
      if (listOf(pp)) {
        const label = lists.next(pp.ilfo!, pp.ilvl ?? 0);
        if (label) {
          const LR = label.level.chpx.length > 0 ? applyChar(markState, label.level.chpx, fonts) : markState;
          if (!LR.hidden) {
            const symbol = label.level.fmt === 'bullet' && isSymbolFont(LR.fontA);
            const mapped = mapBulletGlyphs(label.text, symbol);
            const t = canon(mapped.text);
            if (t !== '') {
              const s: RunOut = { ...runStyleOf(charOut(LR), t.replace(/[\t ]/g, '')) };
              if (mapped.changed && isSymbolFont(s.font)) delete s.font;
              const it: IRText = { k: 't', t, s, key: `${JSON.stringify(s)}|lbl`, lbl: true };
              items.unshift(it);
            }
          }
        }
      }

      const fin = finishPara(pp, markState.sz);
      const para: IRPara = { k: 'p', props: fin.props, items, sect };
      // 문단 표지 글자의 크기와 글꼴 (빈 문단의 줄 높이, docx 의 markR 과 같은 쓰임)
      const mark = charAt(end, istd);
      if (mark.s.sz !== undefined) para.props.sz = mark.s.sz;
      const markFont = mark.fontE ?? mark.fontA;
      if (markFont) para.props.font = markFont;
      // 화면 값: 들여쓰기는 그대로, 줄 높이는 Word 식 '한 줄'에서 (emit.ts 가 모델에 싣는다)
      para.render = { ...fin.render };
      const line = lineBox(pp, items, mark);
      if (line !== undefined) para.render.linePx = line;
      para.styleId = `s${istd}`;
      if (pp.contextual) para.contextual = true;
      const inTable = pp.inTable && pp.itap <= 1;
      if (inTable || (pp.inTable && pp.itap > 1)) {
        if (!tableRows) {
          tableRows = [];
          tableSect = sect;
        }
        if (pp.itap > 1) {
          // 중첩 표: 바깥 칸 안 문단으로 펼친다 (안쪽 행 끝 문단은 버린다)
          if (!pp.innerTtp && items.length > 0) cell.blocks.push(para);
        } else if (pp.ttp) {
          // 행 끝
          if (cell.blocks.length > 0) row.cells.push(cell);
          if (pp.tap) row.tap = pp.tap;
          row.rowH = pp.rowH;
          row.header = pp.header;
          tableRows.push(row);
          row = { cells: [], header: false };
          cell = { blocks: [] };
        } else {
          cell.blocks.push(para);
          if (ch === 0x07) {
            row.cells.push(cell);
            cell = { blocks: [] };
          }
        }
      } else {
        flushTable();
        if (isSectMark) para.sectEnd = true;
        blocks.push(para);
      }
      start = cp + 1;
    }
    flushTable();
    contextSpacing(blocks);
    return blocks;
  };

  const blocks = parseRange(0, ccpText, { kind: 'body' });
  const notes = new Map<string, IRBlock[]>();
  for (const r of noteRanges) notes.set(r.key, parseRange(r.a, r.b, { kind: 'note', num: r.num }));

  const appPages = readPageCount(cfb.read('\u0005SummaryInformation', 1024 * 1024));
  const laid = layoutFlow(blocks, sections, { marks: false, appPages, tab, notes });
  const model: FlowModel = {
    v: RENDER_MODEL_VERSION,
    kind: 'flow',
    media: [],
    truncated: laid.truncated,
    defaultTab: tab,
    pages: laid.pages,
  };
  return {
    fileKind: 'docx',
    extractor: DOC_EXTRACTOR,
    pages: laid.texts.map((text, i) => ({ pageNo: i + 1, text, label: laid.labels[i] ?? null })),
    render: Buffer.from(JSON.stringify(model), 'utf8'),
    renderMime: 'application/json',
    truncated: laid.truncated,
  };
}
