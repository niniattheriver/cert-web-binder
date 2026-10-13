/**
 * 한글 문서(hwpx: OWPML, KS X 6101) → 정본 쪽 글자 + 흐름(flow) 렌더 모델
 *
 * 실물 확인 (실물 hwpx 55개에서 요소/속성 이름, 개수, 수치 관계만 세어 봄. 글자 내용은 보지 않음)
 * - ZIP: mimetype(application/hwp+zip), Contents/content.hpf(opf 목차, spine = 구역 순서),
 *   Contents/header.xml(서식표 hh:head), Contents/section0.xml..(본문 hs:sec), BinData/(그림).
 * - 접두사: hs(구역), hp(문단, 표, 그림), hh(서식표), hc(공통 값), opf(목차). 요소는 접두사를 떼고
 *   로컬 이름으로 찾는다(다른 도구가 접두사를 달리 써도 읽히게).
 * - 단위: HWPUNIT = 1/7200 인치 → px(96dpi) = 값 / 75. 글자 크기(charPr height)는 1/100 pt.
 * - 문단 여백, 줄 간격: hh:paraPr 안 hp:switch 의 hp:case(required-namespace 가 …/HwpUnitChar) 값이
 *   실제 HWPUNIT 이다(조판 캐시 hp:lineseg 의 줄 위치, 너비와 일치). hp:default 값과 스위치 없는
 *   옛 파일(xml 1.2, 1.3)의 직접 값은 2배로 적혀 있어 반으로 읽는다(줄 간격 PERCENT 는 그대로).
 * - 취소선: hh:strikeout shape="3D" 는 취소선이 아니다(파일 11개는 글자 절반 이상이 이 값).
 *   NONE, 3D 가 아닌 모양만 취소선으로 본다.
 * - 용지: landscape="WIDELY" 가 보통의 세로 용지였다(미리보기 그림 53개 모두 세로). NARROWLY 면 가로로 돌린다.
 *
 * 정본 글자 규칙 (page_text: 검색, 앵커 오프셋의 기준)
 * - 쪽: 첫 구역 시작, 이후 구역 시작마다, pageBreak="1" 문단 앞마다 새 쪽(빈 쪽에서는 다시 나누지 않는다).
 *   hwpx 는 마지막 조판의 쪽 나눔을 저장하지 않으므로 긴 쪽이 생길 수 있다.
 * - 블록(문단, 표, 글상자, 그림)을 순서대로 놓고, 글자가 있는 블록만 '\n' 으로 잇는다.
 *   표: 행 '\n', 칸 '\t', 칸 안 블록 '\n'. 글상자: 안 블록 '\n'. 빈 칸, 빈 행은 글자에 넣지 않는다
 *   (sheet-text.ts 와 같은 원칙).
 * - 글자 조각(run)은 normalizeText 를 거친 값이고, 쪽 글자는 조각과 위 구분자로만 이루어진다.
 * - 문단 안 표, 그림, 글상자(FlowBox)는 그 자리에서 문단을 끊고 블록으로 넣는다. 표, 그림 캡션도 본문이다.
 * - 머리말/꼬리말은 표시 전용(FlowPage.header/footer, o 없음)으로만 싣고 정본 글자에는 넣지 않는다.
 * - 제외: 각주, 미주, 숨은 설명, 메모, 필드, 쪽 번호(hp:ctrl 아래), 개체 설명(shapeComment), 수식, OLE,
 *   차트, 글맵시. 문단 번호/글머리표(머리 번호)는 아직 만들지 않는다(lbl 조각 없음).
 * - 그림은 png/jpeg/gif/bmp/webp 만 media 로 싣는다. wmf, emf, svg, tiff 는 흐름 모델에 자리 표시 형식이
 *   없어 뺀다.
 * - FlowPage.margin 은 [위, 오른쪽, 아래, 왼쪽] 이고, 위/아래에는 머리말/꼬리말 높이를 더한다(본문 시작 자리).
 * - 덧말(hp:dutmal)은 본말(mainText)만 본문 글자로 넣는다(덧말 subText 는 뺀다).
 * - 칸 영역(hp:cellzone)은 배경색만 자기 배경이 없는 칸에 옮긴다. 실물 영역 34개의 테두리는 대부분
 *   기본값(실선 0.12 mm)이었고 실제 선은 칸 자체 테두리에 있었다.
 * - 모양이 같은 이웃 조각은 하나로 합친다. 조각 경계에서 NFC 로 합쳐지는 글자(나뉜 한글 자모, 결합 문자)가
 *   있으면 앞 조각에 붙여 다시 정규화한다(쪽 글자가 normalizeText 의 고정점이 되게).
 *
 * 자원 상한 (작은 업로드가 서버를 오래 붙잡거나 메모리를 다 쓰지 않게)
 * - XML 부분은 해석 전에 압축 푼 크기(부분 64MB, 합계는 detect.ts 상한)와 '<' 개수(부분 200만,
 *   구역 합계 300만)를 잰다. 넘으면 첫 구역은 오류, 뒤 구역부터는 거기서 멈추고 안내한다.
 * - 모델 노드(블록, 글자 조각, 표 행, 칸) 20만 개, 표/글상자 중첩 24겹, 서식표 목록마다 65,536개.
 * - 머리말/꼬리말: 정의 하나에 문단 50, 글자 2,000, 노드 400. 쪽마다 되풀이해 단 JSON 은 합계 200만 자까지.
 * - 속성 문자열은 여기서 선형 시간으로 직접 훑는다(xml.ts attr() 의 정규식은 '=' 없는 긴 토큰에서
 *   되짚기가 제곱으로 늘어 작은 파일 하나로 수십 초가 걸린다).
 * - 상한에 걸리면 색인과 표시를 같은 자리에서 멈추고 truncated 에 한국어로 적는다.
 *
 * 두 단계: ① XML → 모델 블록(오프셋 없음, 문단, 쪽, 노드 상한 적용) ② 모델을 훑으며 쪽 글자와 오프셋을
 * 만들고 글자 상한에서 자른다. 쪽 글자는 모델에서만 만들어지므로 색인과 표시가 언제나 같은 범위다.
 */
import { readZipDirectory, readZipEntry, type ZipDirEntry } from '../files/unzip.js';
import { normalizeText } from '../pdf/normalize.js';
import { stripControls } from './controls.js';
import { MAX_ZIP_UNCOMPRESSED_BYTES } from './detect.js';
import { OfficeParseError } from './errors.js';
import {
  RENDER_MODEL_VERSION,
  type Border,
  type FlowBlock,
  type FlowBox,
  type FlowDisplayRun,
  type FlowImage,
  type FlowModel,
  type FlowPage,
  type FlowPara,
  type FlowRun,
  type FlowTable,
  type FlowTableCell,
  type FlowTableRow,
  type MediaRef,
  type OfficeExtractResult,
} from './model.js';
import { localName, parseXml, unescapeXml, type XElement } from './xml.js';

export const HWPX_EXTRACTOR = 'hwpx-v1';

const MAX_PARAGRAPHS = 50_000;
const MAX_TEXT = 3_000_000;
const MAX_PAGES = 2_000;
/** 모델 노드(블록, 글자 조각, 표 행, 칸) 상한: 빈 칸이나 모양이 번갈아 바뀌는 조각으로 렌더 JSON 이 부풀지 않게 */
const MAX_NODES = 200_000;
/** XML 한 부분의 '<' 개수 상한: 해석 전에 세어 트리 크기를 막는다 (실물 구역 최대 약 4만 6천) */
const MAX_PART_TAGS = 2_000_000;
/** 색인, 표시 공통 상한 (테스트도 이 값을 쓴다) */
export const HWPX_LIMITS = {
  paragraphs: MAX_PARAGRAPHS,
  text: MAX_TEXT,
  pages: MAX_PAGES,
  nodes: MAX_NODES,
  partTags: MAX_PART_TAGS,
} as const;

/** 머리말/꼬리말(표시 전용, 쪽마다 되풀이되므로 작게): 정의 하나가 넘으면 싣지 않는다 */
const DISPLAY_MAX_PARAS = 50;
const DISPLAY_MAX_CHARS = 2_000;
const DISPLAY_MAX_NODES = 400;
/** 쪽마다 되풀이해 단 머리말/꼬리말의 JSON 글자 수 합계 상한: 넘는 쪽부터는 달지 않는다 */
const DISPLAY_TOTAL_CHARS = 2_000_000;
/** XML 한 부분(구역, 서식표, 목차) 압축 해제 상한 */
const MAX_PART_BYTES = 64 * 1024 * 1024;
/** 문서 전체에서 푸는 바이트 합계 상한: 크기를 거짓으로 적은 ZIP 도 이 안에서만 푼다 */
const MAX_TOTAL_BYTES = MAX_ZIP_UNCOMPRESSED_BYTES;
/** 구역 XML '<' 개수 합계 상한 */
const MAX_SECTION_TAGS = 3_000_000;
/** 서식표 목록(글꼴, 테두리/배경, 글자 모양, 문단 모양)마다 읽는 항목 수 상한 */
const MAX_STYLE_ITEMS = 65_536;
/** 표 하나에서 읽는 배경색 칸 영역(cellzone) 수 상한 */
const MAX_ZONES = 100;
/** 열 너비 뺄셈에 쓰는 여러 칸짜리 칸 수 상한 (앞 행부터) */
const MAX_SPAN_GEO = 2_000;
/** 표, 글상자, 묶음 개체 중첩 깊이 상한 (재귀 스택 방어) */
const MAX_DEPTH = 24;
/** HWPUNIT(1/7200 인치) → px(96dpi) */
const HWPUNIT_PER_PX = 75;
/** 쪽 크기 상한 px (비정상 값 방어) */
const MAX_PAGE_PX = 10_000;
/** secPr 이 없을 때: A4 세로와 한글 기본 여백 (HWPUNIT) */
const DEFAULT_PAGE = {
  width: 59528,
  height: 84188,
  left: 8504,
  right: 8504,
  top: 5668,
  bottom: 4252,
  header: 4252,
  footer: 4252,
  gutter: 0,
} as const;

const TRUNC_PARAS = `문단이 많아 앞 ${MAX_PARAGRAPHS.toLocaleString('ko-KR')}개 문단만 색인하고 보여줍니다.`;
const TRUNC_TEXT = `글자가 많아 앞부분 ${MAX_TEXT.toLocaleString('ko-KR')}자만 색인하고 보여줍니다.`;
const TRUNC_PAGES = `쪽이 많아 앞 ${MAX_PAGES.toLocaleString('ko-KR')}쪽만 색인하고 보여줍니다.`;
const TRUNC_NODES = `표 칸, 글자 조각 같은 구성 요소가 많아 앞 ${MAX_NODES.toLocaleString('ko-KR')}개까지만 색인하고 보여줍니다.`;
const TRUNC_DEPTH = `표, 글상자가 ${MAX_DEPTH}겹보다 깊게 겹친 부분은 빼고 색인하고 보여줍니다.`;
const truncSize = (n: number): string => `본문이 너무 커서 앞 ${n}개 구역만 색인하고 보여줍니다.`;
const furnitureNote = (n: number): string =>
  `머리말/꼬리말은 분량이 커서 ${n.toLocaleString('ko-KR')}쪽까지만 보여줍니다.`;

const ERR_ZIP = '한글(hwpx) 파일의 압축 구조를 읽지 못했습니다(손상 가능성). 한글에서 다시 저장해 올려 주세요.';
const errTooBig = (label: string): string => `한글(${label}) 문서가 너무 커서 미리보기를 만들지 못했습니다. 문서를 나눠 올려 주세요.`;
const ERR_ENCRYPTED = '암호(열람 제한)가 걸린 한글(hwpx) 파일입니다. 암호를 해제해 저장한 뒤 다시 올려 주세요.';
const ERR_NO_SECTION =
  '한글(hwpx) 본문(Contents/section0.xml)을 찾지 못했습니다. 한글에서 다시 저장해 올려 주세요.';
const errSection = (label: string, n: number): string =>
  `한글(${label}) 본문의 ${n}번째 구역을 읽지 못했습니다(손상되었거나 너무 큽니다). 한글에서 다시 저장해 올려 주세요.`;

const SECTION_RE = /(^|\/)section(\d+)\.xml$/i;

/** 문단의 run 안에서 블록으로 꺼내는 개체. 그 밖의 run 자식(secPr, ctrl, 수식, OLE 등)은 건너뛴다 */
const OBJECTS = new Set(['tbl', 'pic', 'container', 'rect', 'ellipse', 'arc', 'polygon', 'curve', 'connectLine', 'line']);

// 파일 안 문자열을 키로 찾는 표는 전부 Map 이다(일반 객체는 'constructor' 같은 키에 프로토타입 값이 나온다)
const IMAGE_MIME = new Map<string, MediaRef['mime']>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['jpe', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['webp', 'image/webp'],
]);
const ALIGN = new Map<string, NonNullable<FlowPara['align']>>([
  ['JUSTIFY', 'justify'],
  ['DISTRIBUTE', 'justify'],
  ['DISTRIBUTE_SPACE', 'justify'],
  ['CENTER', 'center'],
  ['RIGHT', 'right'],
]);
const VALIGN = new Map<string, NonNullable<FlowTableCell['va']>>([
  ['TOP', 'top'],
  ['CENTER', 'middle'],
  ['BOTTOM', 'bottom'],
]);
const OBJECT_HALIGN = new Map<string, 'center' | 'right'>([
  ['CENTER', 'center'],
  ['RIGHT', 'right'],
]);
/** hp:t 안 빈 요소 → 글자 (그 밖의 표지는 글자 없음) */
const INLINE_CHAR = new Map<string, string>([
  ['tab', '\t'],
  ['lineBreak', '\n'],
  ['nbSpace', ' '],
  ['fwSpace', ' '],
  ['hyphen', '-'],
]);
const BORDER_STYLE = new Map<string, Border['style']>([
  ['SOLID', 'solid'],
  ['DASH', 'dashed'],
  ['LONG_DASH', 'dashed'],
  ['DASH_DOT', 'dashed'],
  ['DASH_DOT_DOT', 'dashed'],
  ['DOT', 'dotted'],
  ['CIRCLE', 'dotted'],
  ['DOUBLE_SLIM', 'double'],
  ['SLIM_THICK', 'double'],
  ['THICK_SLIM', 'double'],
  ['SLIM_THICK_SLIM', 'double'],
  ['DOUBLE_WAVE', 'double'],
]);

// ─────────────────────────────── XML 도우미 (로컬 이름) ───────────────────────────────

/** 로컬 이름이 같은 직계 자식 요소들 (앞에서 limit 개까지) */
function kids(el: XElement | undefined, local: string, limit = Infinity): XElement[] {
  const out: XElement[] = [];
  if (!el) return out;
  for (const c of el.children) {
    if (out.length >= limit) break;
    if (c.type === 'el' && localName(c.name) === local) out.push(c);
  }
  return out;
}

/** 로컬 이름이 같은 첫 직계 자식 요소 */
function kid(el: XElement | undefined, local: string): XElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) if (c.type === 'el' && localName(c.name) === local) return c;
  return undefined;
}

function isXmlSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** 원문 속성 문자열 → 이름별 값(엔티티 해제). 앞으로 한 번만 훑는다: 따옴표가 닫히지 않으면 거기서 멈춘다 */
function scanAttrs(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const n = raw.length;
  let i = 0;
  while (i < n) {
    while (i < n && isXmlSpace(raw.charCodeAt(i))) i += 1;
    const start = i;
    while (i < n && !isXmlSpace(raw.charCodeAt(i)) && raw.charCodeAt(i) !== 0x3d /* = */) i += 1;
    if (i === start) {
      i += 1; // 이름 없는 '='
      continue;
    }
    let j = i;
    while (j < n && isXmlSpace(raw.charCodeAt(j))) j += 1;
    if (raw.charCodeAt(j) !== 0x3d) {
      i = j; // 값 없는 이름
      continue;
    }
    j += 1;
    while (j < n && isXmlSpace(raw.charCodeAt(j))) j += 1;
    const q = raw[j];
    if (q !== '"' && q !== "'") {
      i = j; // 따옴표 없는 값
      continue;
    }
    const end = raw.indexOf(q, j + 1);
    if (end < 0) break;
    map.set(raw.slice(start, i), unescapeXml(raw.slice(j + 1, end)));
    i = end + 1;
  }
  return map;
}

/**
 * 속성 값. xml.ts attr() 와 같은 캐시(_attrs)를 채우되 선형 시간으로 훑는다
 * (그쪽 정규식은 '=' 없는 긴 토큰에서 되짚기가 제곱으로 늘어난다).
 */
function attr(el: XElement, name: string): string | undefined {
  el._attrs ??= scanAttrs(el.rawAttrs);
  return el._attrs.get(name);
}

function at(el: XElement | undefined, name: string): string | undefined {
  return el ? attr(el, name) : undefined;
}

/** 접두사와 무관한 속성 값 (예: hp:required-namespace) */
function atLocal(el: XElement, local: string): string | undefined {
  const v = attr(el, local);
  if (v !== undefined) return v;
  for (const [k, val] of el._attrs ?? []) if (localName(k) === local) return val;
  return undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function px(hwpunit: number): number {
  return Math.round((hwpunit / HWPUNIT_PER_PX) * 10) / 10;
}

function hexColor(v: string | undefined): string | undefined {
  return v !== undefined && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
}

/** 바탕색: 흰색은 종이와 같으므로 뺀다 */
function paperColor(v: string | undefined): string | undefined {
  const c = hexColor(v);
  return c === '#ffffff' ? undefined : c;
}

/** 글꼴 이름: 표시에만 쓰므로 제어 문자와 CSS 구분 기호를 걷어 낸다 */
function cleanFont(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f;{}<>"'\\]/g, '').trim().slice(0, 64);
  return s || undefined;
}

/** 테두리 한 변: type(NONE 이면 없음), width("0.12 mm"), color */
function readBorder(el: XElement | undefined): Border | undefined {
  const type = at(el, 'type') ?? 'NONE';
  if (type === 'NONE') return undefined;
  const style = BORDER_STYLE.get(type) ?? 'solid';
  const mm = Number.parseFloat(at(el, 'width') ?? '');
  const w = ((Number.isFinite(mm) ? mm : 0.12) * 96) / 25.4;
  return {
    w: style === 'double' ? 3 : w < 1.5 ? 1 : w < 2.5 ? 2 : 3,
    style,
    color: hexColor(at(el, 'color')) ?? '#000000',
  };
}

/** 안쪽 여백 요소(left, right, top, bottom) → [위, 오른쪽, 아래, 왼쪽] px */
function padding(el: XElement | undefined): [number, number, number, number] | undefined {
  if (!el) return undefined;
  const g = (k: string): number => Math.max(0, px(num(attr(el, k)) ?? 0));
  return [g('top'), g('right'), g('bottom'), g('left')];
}

/** 개체 크기: hp:sz(절대값일 때) → hp:curSz → hp:orgSz (px) */
function objectSize(el: XElement): { w: number; h: number } | undefined {
  const sz = kid(el, 'sz');
  const absolute =
    (at(sz, 'widthRelTo') ?? 'ABSOLUTE') === 'ABSOLUTE' && (at(sz, 'heightRelTo') ?? 'ABSOLUTE') === 'ABSOLUTE';
  for (const s of [absolute ? sz : undefined, kid(el, 'curSz'), kid(el, 'orgSz')]) {
    const w = num(at(s, 'width'));
    const h = num(at(s, 'height'));
    if (w !== undefined && h !== undefined && w > 0 && h > 0) {
      return { w: Math.max(1, px(w)), h: Math.max(1, px(h)) };
    }
  }
  return undefined;
}

/** XML 바이트 → 글자 (UTF-16 BOM 이 있으면 그대로, 아니면 UTF-8, 앞 BOM 제거) */
function decodeXml(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const s = b.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** '<' 개수 = 시작/끝 태그, 주석, 처리지시 수: 트리 노드 수를 해석 전에 가늠한다. limit 를 넘으면 바로 멈춘다 */
function countTags(s: string, limit: number): number {
  let n = 0;
  for (let i = s.indexOf('<'); i >= 0 && n <= limit; i = s.indexOf('<', i + 1)) n += 1;
  return n;
}

/** 요소 안 글자(직계 글자, CDATA) */
function plainText(el: XElement | undefined): string {
  let s = '';
  for (const x of el?.children ?? []) {
    if (x.type === 'text') s += unescapeXml(x.raw);
    else if (x.type === 'raw' && x.raw.startsWith('<![CDATA[')) s += x.raw.slice(9, -3);
  }
  return s;
}

/** 대리 쌍(surrogate pair)을 가르지 않게 앞 n 글자 */
function sliceSafe(s: string, n: number): string {
  if (n >= s.length) return s;
  let k = Math.max(0, n);
  if (k > 0) {
    const c = s.charCodeAt(k - 1);
    if (c >= 0xd800 && c <= 0xdbff) k -= 1;
  }
  return s.slice(0, k);
}

// ─────────────────────────────── 목차 (content.hpf) ───────────────────────────────

interface Item {
  href: string;
  mediaType: string;
}

interface Package {
  items: Map<string, Item>;
  spine: string[];
}

function readPackage(root: XElement | null): Package {
  const pkg: Package = { items: new Map(), spine: [] };
  if (!root) return pkg;
  for (const it of kids(kid(root, 'manifest'), 'item')) {
    const id = attr(it, 'id');
    const href = attr(it, 'href');
    if (id !== undefined && href) pkg.items.set(id, { href, mediaType: attr(it, 'media-type') ?? '' });
  }
  for (const ir of kids(kid(root, 'spine'), 'itemref')) {
    const idref = attr(ir, 'idref');
    if (idref !== undefined) pkg.spine.push(idref);
  }
  return pkg;
}

/** 목차 href → ZIP 안 실제 경로 (루트 기준이 보통, 목차 폴더 기준도 허용) */
function resolveHref(href: string, names: Set<string>, baseDir: string): string | undefined {
  const clean = href.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
  let decoded: string | undefined;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = undefined;
  }
  for (const cand of [clean, baseDir + clean, decoded]) {
    if (cand && names.has(cand)) return cand;
  }
  return undefined;
}

/**
 * 구역 순서: spine 이 가리키는 sectionN.xml (실물 55개 모두 번호 순과 같았다). 없으면 번호 순.
 * 구역마다 쪽이 하나 이상 열리므로 쪽 상한 + 1 개까지만 모은다(마지막 하나가 쪽 상한 안내를 낸다).
 */
function sectionOrder(pkg: Package, names: Set<string>, hpfDir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  for (const id of pkg.spine) {
    if (out.length > MAX_PAGES) break;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const it = pkg.items.get(id);
    const p = it ? resolveHref(it.href, names, hpfDir) : undefined;
    if (p && SECTION_RE.test(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  if (out.length > 0) return out;
  return [...names]
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .map((n) => ({ n, k: Number(SECTION_RE.exec(n)?.[2] ?? 0) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, MAX_PAGES + 1)
    .map((x) => x.n);
}

/** 경로 확장자로 그림 형식 (hwp 바이너리의 BinData 경로에도 쓴다). 래스터가 아니면 undefined */
export function imageMimeOf(path: string): MediaRef['mime'] | undefined {
  return imageMime(path, '');
}

function imageMime(path: string, mediaType: string): MediaRef['mime'] | undefined {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  if (ext) return IMAGE_MIME.get(ext);
  const mt = mediaType.toLowerCase().trim().replace(/^image\/jpg$/, 'image/jpeg');
  return [...IMAGE_MIME.values()].find((m) => m === mt);
}

// ─────────────────────────────── 서식표 (header.xml) ───────────────────────────────

type RunStyle = Omit<FlowRun, 't' | 'o'>;

interface ParaStyle {
  fields: Omit<FlowPara, 'type' | 'runs' | 'lineHeight' | 'linePx' | 'sz' | 'font'>;
  /** 줄 간격: PERCENT 는 %, 나머지는 실제 HWPUNIT */
  ls?: { type: string; value: number };
}

interface BorderFill {
  bg?: string;
  bt?: Border;
  br?: Border;
  bb?: Border;
  bl?: Border;
}

interface Styles {
  chars: Map<string, RunStyle>;
  paras: Map<string, ParaStyle>;
  fills: Map<string, BorderFill>;
}

interface Spacing {
  /** 로컬 이름(intent, left, right, prev, next) → 실제 HWPUNIT */
  margin: Map<string, number>;
  ls?: { type: string; value: number };
}

/**
 * 문단 여백, 줄 간격 고르기 (실물 확인 결과는 머리 주석 참고)
 * 1) hp:case(…/HwpUnitChar): 실제 HWPUNIT. 글자(CHAR) 단위 값은 건너뛰고 옛 값으로 대신한다.
 * 2) hp:default, 스위치 없는 직접 자식: 2배로 적힌 옛 값 → 반으로 (PERCENT 는 그대로).
 */
function readSpacing(pp: XElement): Spacing {
  const sp: Spacing = { margin: new Map() };
  const take = (margin: XElement | undefined, ls: XElement | undefined, scale: number): void => {
    if (margin) {
      for (const c of margin.children) {
        if (c.type !== 'el') continue;
        const k = localName(c.name);
        if (sp.margin.has(k) || (attr(c, 'unit') ?? 'HWPUNIT') !== 'HWPUNIT') continue;
        const v = num(attr(c, 'value'));
        if (v !== undefined) sp.margin.set(k, v * scale);
      }
    }
    if (ls && !sp.ls) {
      const type = attr(ls, 'type') ?? 'PERCENT';
      const v = num(attr(ls, 'value'));
      if (v !== undefined && (type === 'PERCENT' || (attr(ls, 'unit') ?? 'HWPUNIT') === 'HWPUNIT')) {
        sp.ls = { type, value: type === 'PERCENT' ? v : v * scale };
      }
    }
  };
  const switches = kids(pp, 'switch');
  for (const sw of switches) {
    for (const cs of kids(sw, 'case')) {
      if ((atLocal(cs, 'required-namespace') ?? '').endsWith('/HwpUnitChar')) {
        take(kid(cs, 'margin'), kid(cs, 'lineSpacing'), 1);
      }
    }
  }
  for (const sw of switches) {
    const df = kid(sw, 'default');
    if (df) take(kid(df, 'margin'), kid(df, 'lineSpacing'), 0.5);
  }
  take(kid(pp, 'margin'), kid(pp, 'lineSpacing'), 0.5);
  return sp;
}

function readStyles(head: XElement | null): Styles {
  const styles: Styles = { chars: new Map(), paras: new Map(), fills: new Map() };
  const refList = head ? kid(head, 'refList') : undefined;
  if (!refList) return styles;

  // 글꼴: 언어(HANGUL, LATIN, ..) → id → 이름
  const faces = new Map<string, Map<string, string>>();
  for (const ff of kids(kid(refList, 'fontfaces'), 'fontface', 64)) {
    const m = new Map<string, string>();
    for (const f of kids(ff, 'font', MAX_STYLE_ITEMS)) {
      const id = attr(f, 'id');
      const face = cleanFont(attr(f, 'face'));
      if (id !== undefined && face) m.set(id, face);
    }
    faces.set(attr(ff, 'lang') ?? '', m);
  }

  // 테두리/배경: 변마다 테두리 + 채우기 색 (칸, 문단이 참조한다)
  const sides: ['bt' | 'br' | 'bb' | 'bl', string][] = [
    ['bt', 'topBorder'],
    ['br', 'rightBorder'],
    ['bb', 'bottomBorder'],
    ['bl', 'leftBorder'],
  ];
  for (const bf of kids(kid(refList, 'borderFills'), 'borderFill', MAX_STYLE_ITEMS)) {
    const id = attr(bf, 'id');
    if (id === undefined) continue;
    const fill: BorderFill = {};
    const bg = paperColor(at(kid(kid(bf, 'fillBrush'), 'winBrush'), 'faceColor'));
    if (bg) fill.bg = bg;
    for (const [key, local] of sides) {
      const b = readBorder(kid(bf, local));
      if (b) fill[key] = b;
    }
    styles.fills.set(id, fill);
  }

  // 글자 모양
  for (const cp of kids(kid(refList, 'charProperties'), 'charPr', MAX_STYLE_ITEMS)) {
    const id = attr(cp, 'id');
    if (id === undefined) continue;
    const s: RunStyle = {};
    const height = num(attr(cp, 'height'));
    const rel = num(at(kid(cp, 'relSz'), 'hangul'));
    if (height !== undefined && height > 0) {
      const eff = rel !== undefined && rel > 0 ? (height * rel) / 100 : height;
      s.sz = Math.round(eff) / 100;
    }
    if (kid(cp, 'bold')) s.b = true;
    if (kid(cp, 'italic')) s.i = true;
    if ((at(kid(cp, 'underline'), 'type') ?? 'NONE') !== 'NONE') s.u = true;
    const strike = at(kid(cp, 'strikeout'), 'shape') ?? 'NONE';
    if (strike !== 'NONE' && strike !== '3D') s.strike = true;
    const color = hexColor(attr(cp, 'textColor'));
    if (color && color !== '#000000') s.color = color;
    const fr = kid(cp, 'fontRef');
    const font =
      faces.get('HANGUL')?.get(at(fr, 'hangul') ?? '') ?? faces.get('LATIN')?.get(at(fr, 'latin') ?? '');
    if (font) s.font = font;
    if (kid(cp, 'supscript')) s.sup = true;
    else if (kid(cp, 'subscript')) s.sub = true;
    const shade = paperColor(attr(cp, 'shadeColor'));
    if (shade) s.bg = shade;
    styles.chars.set(id, s);
  }

  // 문단 모양
  for (const pp of kids(kid(refList, 'paraProperties'), 'paraPr', MAX_STYLE_ITEMS)) {
    const id = attr(pp, 'id');
    if (id === undefined) continue;
    const fields: ParaStyle['fields'] = {};
    const align = ALIGN.get(at(kid(pp, 'align'), 'horizontal') ?? '');
    if (align) fields.align = align;
    const sp = readSpacing(pp);
    const put = (key: 'indent' | 'marginLeft' | 'marginRight' | 'spaceBefore' | 'spaceAfter', local: string): void => {
      const v = sp.margin.get(local);
      if (v === undefined) return;
      const p = px(v);
      if (p !== 0) fields[key] = p;
    };
    put('indent', 'intent');
    put('marginLeft', 'left');
    // 한글의 내어쓰기(intent < 0): 첫 줄은 왼쪽 여백에서, 둘째 줄부터 |intent| 만큼 안쪽에서 시작한다.
    // CSS 로는 왼쪽 여백 = left + |intent|, 첫 줄 들여쓰기 = intent (실물 9,615개 중 9,589개가 그대로 두면
    // 첫 줄이 쪽 여백 밖으로 나갔다)
    if (fields.indent !== undefined && fields.indent < 0) {
      fields.marginLeft = (fields.marginLeft ?? 0) + Math.abs(fields.indent);
    }
    put('marginRight', 'right');
    put('spaceBefore', 'prev');
    put('spaceAfter', 'next');
    // 문단 테두리/배경 (실물에서는 드물다)
    const pbf = styles.fills.get(at(kid(pp, 'border'), 'borderFillIDRef') ?? '');
    if (pbf) {
      if (pbf.bg) fields.bg = pbf.bg;
      for (const [key] of sides) {
        const b = pbf[key];
        if (b) fields[key] = b;
      }
    }
    const ps: ParaStyle = { fields };
    if (sp.ls) ps.ls = sp.ls;
    styles.paras.set(id, ps);
  }
  return styles;
}

// ─────────────────────────────── 1단계: XML → 모델 블록 ───────────────────────────────

type DisplayBlock = FlowBlock<FlowDisplayRun>;

interface Ctx {
  styles: Styles;
  /** 그림 id(hp:img binaryItemIDRef) → 원본 안 경로와 형식. 연결 그림, 래스터가 아닌 그림은 undefined */
  binary: (id: string) => MediaRef | undefined;
  media: MediaRef[];
  mediaIndex: Map<string, number>;
  paras: number;
  chars: number;
  /** 모델 노드(블록, 글자 조각, 표 행, 칸) 수 */
  nodes: number;
  maxParas: number;
  maxChars: number;
  maxNodes: number;
  /** 상한에 걸려 멈춘 사유 (안내 문구) */
  stop: string | null;
  /** 중첩 깊이 상한으로 뺀 개체가 있는가 (멈추지는 않고 안내만 더한다) */
  deep: boolean;
}

/** 모델 노드 하나를 센다. 상한을 넘으면 멈춤 사유를 남기고 false */
function charge(ctx: Ctx): boolean {
  ctx.nodes += 1;
  if (ctx.nodes <= ctx.maxNodes) return true;
  ctx.stop ??= TRUNC_NODES;
  return false;
}

/** 조각 모양 비교에 쓰는 필드 (FlowRun 에서 t, o 를 뺀 전부) */
const LOOK_KEYS = ['sz', 'b', 'i', 'u', 'strike', 'color', 'font', 'sup', 'sub', 'bg', 'lbl'] as const;

function sameLook(a: FlowRun, b: FlowRun): boolean {
  for (const k of LOOK_KEYS) if (a[k] !== b[k]) return false;
  return true;
}

/** 앞 글자와 NFC 로 합쳐질 수 있는 글자로 시작하는가 (결합 문자, 한글 중성/종성 자모) */
const JOINS_PREV = /^[\p{M}\u1160-\u11ff\ud7b0-\ud7ff]/u;

/**
 * 조각을 이은 글자가 normalizeText 의 고정점이 아니면 고친다(NFC 는 이어 붙이기에 닫혀 있지 않다).
 * 앞과 합쳐질 수 있는 글자로 시작하는 조각은 앞 조각에 붙여(모양은 앞 조각) 다시 정규화하고,
 * 그래도 안 되면 전부 첫 조각 하나로 합친다.
 */
function fixJoins(runs: FlowRun[]): FlowRun[] {
  if (runs.length < 2) return runs;
  const joined = runs.map((r) => r.t).join('');
  if (normalizeText(joined) === joined) return runs;
  const out: FlowRun[] = [];
  let parts: string[] = [];
  const close = (): void => {
    const head = out[out.length - 1];
    if (head && parts.length > 1) head.t = normalizeText(parts.join(''));
  };
  for (const r of runs) {
    if (out.length > 0 && JOINS_PREV.test(r.t)) {
      parts.push(r.t);
    } else {
      close();
      out.push(r);
      parts = [r.t];
    }
  }
  close();
  const again = out.map((r) => r.t).join('');
  if (normalizeText(again) === again) return out;
  const first = out[0]!;
  first.t = normalizeText(again);
  return [first];
}

/** 문단 조각 모음: 모양이 같은 이웃 조각은 하나로 합치고, 내줄 때 조각 경계의 NFC 를 고친다 */
interface RunSink {
  /** 정규화된 글자 하나를 넣는다 */
  push(t: string, look: RunStyle | undefined, mark: string | undefined): void;
  /** 모은 조각을 마무리해 내주고 비운다 */
  take(): FlowRun[];
}

function runSink(ctx: Ctx): RunSink {
  let runs: FlowRun[] = [];
  /** 마지막 조각에 합칠 글자들 (그 조각 글자 포함): 마무리 때 한 번에 잇는다 */
  let tail: string[] = [];
  const closeTail = (): void => {
    const last = runs[runs.length - 1];
    if (last && tail.length > 1) {
      const before = tail.reduce((s, x) => s + x.length, 0);
      last.t = normalizeText(tail.join(''));
      ctx.chars += last.t.length - before;
    }
    tail = [];
  };
  return {
    push(t, look, mark) {
      if (t.length === 0) return;
      const piece: FlowRun = { t, o: 0, ...look }; // o 는 2단계에서 단다
      if (mark) piece.bg = mark;
      const last = runs[runs.length - 1];
      if (last && sameLook(last, piece)) {
        tail.push(t);
      } else {
        if (!charge(ctx)) return;
        closeTail();
        runs.push(piece);
        tail = [t];
      }
      ctx.chars += t.length;
      if (ctx.chars > ctx.maxChars) ctx.stop ??= TRUNC_TEXT; // 정확한 자리는 2단계에서 자른다
    },
    take() {
      closeTail();
      const all = runs;
      runs = [];
      if (all.length < 2) return all;
      const before = all.reduce((s, r) => s + r.t.length, 0); // fixJoins 가 조각 글자를 바꾸기 전에 잰다
      const out = fixJoins(all);
      if (out !== all) {
        ctx.chars += out.reduce((s, r) => s + r.t.length, 0) - before;
        ctx.nodes -= all.length - out.length;
      }
      return out;
    },
  };
}

/** 줄 간격: PERCENT → 배수, 고정/최소 → px, 여백만 지정 → 문단에서 가장 큰 글자 기준 배수(어림) */
function lineSpec(ls: ParaStyle['ls'], runs: FlowRun[]): { lineHeight?: number; linePx?: number } {
  if (!ls) return {};
  const multiple = (v: number): { lineHeight?: number } =>
    Number.isFinite(v) && v > 0 ? { lineHeight: Math.round(Math.min(5, Math.max(0.5, v)) * 100) / 100 } : {};
  switch (ls.type) {
    case 'PERCENT':
      return multiple(ls.value / 100);
    case 'FIXED':
    case 'AT_LEAST': {
      const v = px(ls.value);
      return v > 0 ? { linePx: Math.min(v, 1000) } : {};
    }
    case 'BETWEEN_LINES': {
      const pt = runs.reduce((m, r) => Math.max(m, r.sz ?? 0), 0) || 10;
      return multiple(1 + ls.value / 100 / pt); // 1 pt = 100 HWPUNIT
    }
    default:
      return {};
  }
}

/** 문단 블록. 빈 문단이면 문단 끝 글자 모양(sz, font)을 실어 줄 높이를 맞춘다 */
function makePara(style: ParaStyle | undefined, runs: FlowRun[], mark?: RunStyle): FlowPara {
  const base = runs.length === 0 && mark ? { ...(mark.sz !== undefined ? { sz: mark.sz } : {}), ...(mark.font ? { font: mark.font } : {}) } : {};
  return { type: 'p', ...style?.fields, ...lineSpec(style?.ls, runs), ...base, runs };
}

function convertSubList(sub: XElement | undefined, ctx: Ctx, depth: number): FlowBlock[] {
  const out: FlowBlock[] = [];
  for (const p of kids(sub, 'p')) {
    if (ctx.stop) break;
    for (const b of convertPara(p, ctx, depth)) out.push(b);
  }
  return out;
}

/** 캡션: 위쪽(TOP)이면 개체 앞, 나머지는 개체 뒤 (변환도 문서 순서대로) */
function captioned(owner: XElement, ctx: Ctx, depth: number, body: () => FlowBlock[]): FlowBlock[] {
  const cap = kid(owner, 'caption');
  if (!cap) return body();
  const capBlocks = (): FlowBlock[] => convertSubList(kid(cap, 'subList'), ctx, depth);
  if (attr(cap, 'side') === 'TOP') {
    const c = capBlocks();
    return [...c, ...body()];
  }
  const b = body();
  return [...b, ...capBlocks()];
}

/** 열 너비: 한 칸짜리 칸에서, 모자라면 여러 칸을 덮는 칸에서 뺄셈으로. 다 못 구하면 undefined */
function columnWidths(geo: { col: number; span: number; w: number }[], colCnt: number): number[] | undefined {
  if (colCnt <= 0) return undefined;
  const widths: (number | undefined)[] = Array.from({ length: colCnt }, () => undefined);
  for (const g of geo) if (g.span === 1 && g.col >= 0 && g.col < colCnt) widths[g.col] ??= g.w;
  // 여러 칸짜리 칸은 앞에서부터 일부만 본다(칸마다 열 수만큼 훑으므로 넓게 병합된 칸이 많으면 느려진다)
  const multi = geo.filter((g) => g.span >= 2 && g.col >= 0).slice(0, MAX_SPAN_GEO);
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const g of multi) {
      const cols: number[] = [];
      for (let k = g.col; k < Math.min(g.col + g.span, colCnt); k += 1) cols.push(k);
      const unknown = cols.filter((k) => widths[k] === undefined);
      if (unknown.length !== 1) continue;
      const known = cols.reduce((s, k) => s + (widths[k] ?? 0), 0);
      widths[unknown[0]!] = Math.max(0, g.w - known);
      changed = true;
    }
    if (!changed) break;
  }
  const out: number[] = [];
  for (const w of widths) {
    if (w === undefined) return undefined;
    out.push(px(w));
  }
  return out;
}

interface Zone {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  bg: string;
}

/** 칸 영역(hp:cellzone) 가운데 배경색이 있는 것 (머리 주석: 테두리는 쓰지 않는다) */
function cellZones(tbl: XElement, ctx: Ctx): Zone[] {
  const out: Zone[] = [];
  for (const z of kids(kid(tbl, 'cellzoneList'), 'cellzone')) {
    if (out.length >= MAX_ZONES) break;
    const bg = ctx.styles.fills.get(attr(z, 'borderFillIDRef') ?? '')?.bg;
    const r1 = num(attr(z, 'startRowAddr'));
    const c1 = num(attr(z, 'startColAddr'));
    const r2 = num(attr(z, 'endRowAddr'));
    const c2 = num(attr(z, 'endColAddr'));
    if (bg && r1 !== undefined && c1 !== undefined && r2 !== undefined && c2 !== undefined) {
      out.push({ r1, c1, r2, c2, bg });
    }
  }
  return out;
}

/** 칸 자리(행, 열)를 덮는 영역의 배경색. 영역이 겹치면 뒤의 것 */
function zoneBg(zones: Zone[], row: number, col: number): string | undefined {
  let bg: string | undefined;
  for (const z of zones) if (row >= z.r1 && row <= z.r2 && col >= z.c1 && col <= z.c2) bg = z.bg;
  return bg;
}

function convertTable(tbl: XElement, ctx: Ctx, depth: number, paraAlign: FlowPara['align']): FlowBlock[] {
  return captioned(tbl, ctx, depth, () => {
    const repeatHeader = attr(tbl, 'repeatHeader') === '1';
    const colCnt = Math.min(1000, Math.max(0, Math.floor(num(attr(tbl, 'colCnt')) ?? 0)));
    /** 표 안쪽 여백: 자기 여백이 없는 칸은 모두 이 배열을 같이 쓴다 */
    const tablePad = padding(kid(tbl, 'inMargin'));
    const zones = cellZones(tbl, ctx);
    const geo: { col: number; span: number; w: number }[] = [];
    const rows: FlowTableRow[] = [];
    let rowNo = 0;
    for (const tr of kids(tbl, 'tr')) {
      if (ctx.stop || !charge(ctx)) break;
      // 병합으로 가려진 칸은 hwpx 에 없다(HTML 표와 같은 꼴). 열 순서만 맞춘다
      const tcs = kids(tr, 'tc')
        .map((tc, i) => {
          const addr = kid(tc, 'cellAddr');
          return { tc, col: num(at(addr, 'colAddr')) ?? i, row: num(at(addr, 'rowAddr')) ?? rowNo };
        })
        .sort((a, b) => a.col - b.col);
      rowNo += 1;
      const cells: FlowTableCell[] = [];
      let rowH = 0;
      let allHeader = tcs.length > 0;
      for (const { tc, col, row } of tcs) {
        if (ctx.stop || !charge(ctx)) break;
        const sub = kid(tc, 'subList');
        const cell: FlowTableCell = { blocks: convertSubList(sub, ctx, depth) };
        const span = kid(tc, 'cellSpan');
        const colSpan = Math.min(1000, Math.max(1, Math.floor(num(at(span, 'colSpan')) ?? 1)));
        const rowSpan = Math.min(10_000, Math.max(1, Math.floor(num(at(span, 'rowSpan')) ?? 1)));
        if (colSpan > 1) cell.colSpan = colSpan;
        if (rowSpan > 1) cell.rowSpan = rowSpan;
        const size = kid(tc, 'cellSz');
        const w = num(at(size, 'width'));
        const h = num(at(size, 'height'));
        if (w !== undefined && w > 0) {
          cell.w = px(w);
          geo.push({ col, span: colSpan, w });
        }
        if (rowSpan === 1 && h !== undefined && h > rowH) rowH = h;
        const fill = ctx.styles.fills.get(attr(tc, 'borderFillIDRef') ?? '');
        if (fill) {
          if (fill.bg) cell.bg = fill.bg;
          cell.border = Boolean(fill.bt ?? fill.br ?? fill.bb ?? fill.bl);
          if (fill.bt) cell.bt = fill.bt;
          if (fill.br) cell.br = fill.br;
          if (fill.bb) cell.bb = fill.bb;
          if (fill.bl) cell.bl = fill.bl;
        }
        if (!cell.bg) {
          const bg = zoneBg(zones, row, col);
          if (bg) cell.bg = bg;
        }
        const va = VALIGN.get(at(sub, 'vertAlign') ?? '');
        if (va) cell.va = va;
        const pad = attr(tc, 'hasMargin') === '1' ? padding(kid(tc, 'cellMargin')) : tablePad;
        if (pad) cell.pad = pad;
        if (attr(tc, 'header') !== '1') allHeader = false;
        cells.push(cell);
      }
      const row: FlowTableRow = { cells };
      if (rowH > 0) {
        row.h = px(rowH);
        row.hRule = 'atLeast'; // 한글 칸 높이는 내용이 넘치면 늘어난다
      }
      if (repeatHeader && allHeader) row.header = true;
      rows.push(row);
    }
    if (rows.length === 0) return [];
    charge(ctx);
    const table: FlowTable = { type: 'table', rows };
    const cw = columnWidths(geo, colCnt);
    if (cw) table.colWidths = cw;
    const size = objectSize(tbl);
    if (size) table.width = size.w;
    // 글자처럼 취급(treatAsChar)하는 표는 문단 정렬을, 떠 있는 표는 가로 정렬을 따른다
    const pos = kid(tbl, 'pos');
    const align = at(pos, 'treatAsChar') === '1' ? paraAlign : OBJECT_HALIGN.get(at(pos, 'horzAlign') ?? '');
    if (align === 'center' || align === 'right') table.align = align;
    return [table];
  });
}

/** hwpx 그림 찾기: 목차(content.hpf) 항목 → 경로, 없으면 BinData 파일 이름(확장자 뺀 것) */
function zipBinary(items: Map<string, Item>, names: Set<string>, hpfDir: string, binByStem: Map<string, string>) {
  return (id: string): MediaRef | undefined => {
    const item = items.get(id);
    const path = (item ? resolveHref(item.href, names, hpfDir) : undefined) ?? binByStem.get(id);
    if (!path) return undefined; // 연결(외부) 그림이거나 목차가 깨진 경우
    const mime = imageMime(path, item?.mediaType ?? '');
    return mime ? { path, mime } : undefined;
  };
}

function convertPic(pic: XElement, ctx: Ctx, paraAlign: FlowPara['align']): FlowBlock[] {
  const ref = at(kid(pic, 'img'), 'binaryItemIDRef');
  const found = ref !== undefined ? ctx.binary(ref) : undefined;
  const size = objectSize(pic);
  if (!found || !size || !charge(ctx)) return [];
  let idx = ctx.mediaIndex.get(found.path);
  if (idx === undefined) {
    idx = ctx.media.length;
    ctx.media.push(found);
    ctx.mediaIndex.set(found.path, idx);
  }
  const img: FlowImage = { type: 'img', media: idx, w: size.w, h: size.h };
  // 글자처럼 취급(treatAsChar)하는 그림은 문단 정렬을, 떠 있는 그림은 가로 정렬을 따른다 (표와 같은 규칙)
  const pos = kid(pic, 'pos');
  const align = at(pos, 'treatAsChar') === '1' ? paraAlign : OBJECT_HALIGN.get(at(pos, 'horzAlign') ?? '');
  if (align === 'center' || align === 'right') img.align = align;
  return [img];
}

/** 그리기 개체의 글상자(drawText) → FlowBox. 글상자가 없는 도형은 그리지 않는다 */
function convertShape(el: XElement, ctx: Ctx, depth: number): FlowBlock[] {
  const sub = kid(kid(el, 'drawText'), 'subList');
  if (!sub) return [];
  const blocks = convertSubList(sub, ctx, depth);
  if (blocks.length === 0) return [];
  charge(ctx);
  const box: FlowBox = { type: 'box', blocks };
  const size = objectSize(el);
  if (size) box.w = size.w;
  const line = kid(el, 'lineShape');
  if (line) box.border = (attr(line, 'style') ?? 'NONE') !== 'NONE' && (num(attr(line, 'width')) ?? 0) > 0;
  return [box];
}

function convertObject(el: XElement, ctx: Ctx, depth: number, paraAlign: FlowPara['align']): FlowBlock[] {
  if (ctx.stop) return [];
  if (depth > MAX_DEPTH) {
    ctx.deep = true; // 색인과 표시에서 함께 빠진다: 안내 문구에 적는다
    return [];
  }
  const name = localName(el.name);
  if (name === 'tbl') return convertTable(el, ctx, depth, paraAlign);
  if (name === 'pic') return captioned(el, ctx, depth, () => convertPic(el, ctx, paraAlign));
  if (name === 'container') {
    // 묶음 개체: 안의 그림, 글상자를 차례로
    const out: FlowBlock[] = [];
    for (const c of el.children) {
      if (c.type !== 'el' || !OBJECTS.has(localName(c.name))) continue;
      for (const b of convertObject(c, ctx, depth + 1, paraAlign)) out.push(b);
    }
    return out;
  }
  return convertShape(el, ctx, depth);
}

function convertPara(p: XElement, ctx: Ctx, depth: number): FlowBlock[] {
  const blocks: FlowBlock[] = [];
  if (ctx.stop) return blocks;
  ctx.paras += 1;
  if (ctx.paras > ctx.maxParas) {
    ctx.stop = TRUNC_PARAS;
    return blocks;
  }
  const style = ctx.styles.paras.get(attr(p, 'paraPrIDRef') ?? '');
  const runEls = kids(p, 'run');
  const sink = runSink(ctx);
  /** 형광펜 색 (hp:markpenBegin ~ hp:markpenEnd, run 을 넘어 이어질 수 있다) */
  let mark: string | undefined;
  const flush = (): void => {
    const runs = sink.take();
    if (runs.length === 0) return;
    charge(ctx);
    blocks.push(makePara(style, runs));
  };
  for (const run of runEls) {
    if (ctx.stop) break;
    const cs = ctx.styles.chars.get(attr(run, 'charPrIDRef') ?? '');
    let text = '';
    const pushText = (): void => {
      sink.push(normalizeText(stripControls(text)), cs, mark);
      text = '';
    };
    for (const c of run.children) {
      if (ctx.stop) break;
      if (c.type !== 'el') continue;
      const name = localName(c.name);
      if (name === 't') {
        // 섞인 내용: 글자, 탭/줄바꿈/빈칸 요소, 형광펜 표지
        for (const x of c.children) {
          if (x.type === 'text') {
            text += unescapeXml(x.raw);
          } else if (x.type === 'raw') {
            if (x.raw.startsWith('<![CDATA[')) text += x.raw.slice(9, -3);
          } else {
            const ln = localName(x.name);
            if (ln === 'markpenBegin' || ln === 'markpenEnd') {
              pushText();
              mark = ln === 'markpenBegin' ? paperColor(attr(x, 'color')) : undefined;
            } else {
              text += INLINE_CHAR.get(ln) ?? '';
            }
          }
        }
      } else if (name === 'compose') {
        text += attr(c, 'composeText') ?? ''; // 글자 겹치기
      } else if (name === 'dutmal') {
        text += plainText(kid(c, 'mainText')); // 덧말: 본말은 본문 글자, 덧말(subText)은 뺀다
      } else if (OBJECTS.has(name)) {
        pushText();
        const objs = convertObject(c, ctx, depth + 1, style?.fields.align);
        if (objs.length > 0) {
          flush();
          for (const b of objs) blocks.push(b);
        }
      }
      // secPr, ctrl(머리말, 꼬리말, 각주, 미주, 필드, 쪽 번호), equation, ole, chart, textart 등은 건너뛴다
    }
    pushText();
  }
  flush();
  if (blocks.length === 0) {
    // 빈 문단 = 빈 줄
    charge(ctx);
    blocks.push(makePara(style, [], ctx.styles.chars.get(at(runEls[0], 'charPrIDRef') ?? '')));
  }
  return blocks;
}

// ─────────────────────────────── 머리말/꼬리말 (표시 전용) ───────────────────────────────

interface Furniture {
  header?: DisplayBlock[];
  footer?: DisplayBlock[];
  /** 정의별 JSON 글자 수: 쪽마다 되풀이해 단 분량을 셀 때 쓴다 */
  size: Map<DisplayBlock[], number>;
}

/** 정본 글자에 들어가지 않는 블록: 조각에서 o 를 뺀다 */
function toDisplay(blocks: FlowBlock[]): DisplayBlock[] {
  const out: DisplayBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'p') {
      out.push({ ...b, runs: b.runs.map(({ o: _o, ...rest }) => rest) });
    } else if (b.type === 'table') {
      out.push({
        ...b,
        rows: b.rows.map((row) => ({ ...row, cells: row.cells.map((c) => ({ ...c, blocks: toDisplay(c.blocks) })) })),
      });
    } else if (b.type === 'box') {
      out.push({ ...b, blocks: toDisplay(b.blocks) });
    } else {
      out.push(b);
    }
  }
  return out;
}

function hasContent(blocks: FlowBlock[]): boolean {
  return blocks.some((b) => {
    if (b.type === 'img') return true;
    if (b.type === 'p') return b.runs.length > 0;
    if (b.type === 'box') return hasContent(b.blocks);
    return b.rows.some((row) => row.cells.some((c) => hasContent(c.blocks)));
  });
}

/** 머리말/꼬리말 글상자 → 표시 블록. 상한을 넘거나(깊이 상한 포함) 보일 것이 없으면 undefined */
function displayBlocks(sub: XElement | undefined, ctx: Ctx): DisplayBlock[] | undefined {
  if (!sub) return undefined;
  const sc: Ctx = {
    ...ctx,
    paras: 0,
    chars: 0,
    nodes: 0,
    stop: null,
    deep: false,
    maxParas: DISPLAY_MAX_PARAS,
    maxChars: DISPLAY_MAX_CHARS,
    maxNodes: DISPLAY_MAX_NODES,
  };
  const blocks = convertSubList(sub, sc, 1);
  if (sc.stop || sc.deep || !hasContent(blocks)) return undefined;
  return toDisplay(blocks);
}

/** 문단의 hp:ctrl 에서 머리말/꼬리말을 읽어 현재 값을 바꾼다. 바뀌었으면 true */
function scanFurniture(p: XElement, ctx: Ctx, furn: Furniture): boolean {
  let changed = false;
  for (const run of kids(p, 'run')) {
    for (const ctrl of kids(run, 'ctrl')) {
      for (const c of ctrl.children) {
        if (c.type !== 'el') continue;
        const name = localName(c.name);
        if (name !== 'header' && name !== 'footer') continue;
        // 쪽 홀짝을 모르므로 양쪽(BOTH)/홀수 쪽 것을 쓰고, 짝수 쪽 것은 다른 것이 없을 때만
        if (attr(c, 'applyPageType') === 'EVEN' && furn[name]) continue;
        const shown = displayBlocks(kid(c, 'subList'), ctx);
        if (shown) furn.size.set(shown, JSON.stringify(shown).length);
        furn[name] = shown;
        changed = true;
      }
    }
  }
  return changed;
}

// ─────────────────────────────── 구역 → 쪽 ───────────────────────────────

interface Geometry {
  w: number;
  h: number;
  margin: [number, number, number, number];
  /** 종이 위끝에서 머리말까지, 아래끝에서 꼬리말까지 px */
  headerDist: number;
  footerDist: number;
}

/** 구역 용지(hp:secPr > hp:pagePr): 크기, 방향, 여백 → px */
function pageGeometry(sec: XElement): Geometry {
  let pagePr: XElement | undefined;
  for (const p of kids(sec, 'p')) {
    const sp = kids(p, 'run')
      .map((r) => kid(r, 'secPr'))
      .find((x) => x !== undefined);
    if (sp) {
      pagePr = kid(sp, 'pagePr');
      break;
    }
  }
  const D = DEFAULT_PAGE;
  const val = (el: XElement | undefined, k: string, d: number): number => {
    const v = num(at(el, k));
    return v !== undefined && v >= 0 ? v : d;
  };
  let w = val(pagePr, 'width', D.width);
  let h = val(pagePr, 'height', D.height);
  if (w <= 0 || h <= 0) {
    w = D.width;
    h = D.height;
  }
  if (at(pagePr, 'landscape') === 'NARROWLY' && w < h) [w, h] = [h, w];
  const m = kid(pagePr, 'margin');
  const topEdge = val(m, 'top', D.top);
  const bottomEdge = val(m, 'bottom', D.bottom);
  let top = topEdge + val(m, 'header', D.header);
  const bottom = bottomEdge + val(m, 'footer', D.footer);
  let left = val(m, 'left', D.left);
  const right = val(m, 'right', D.right);
  const gutter = val(m, 'gutter', D.gutter);
  if (at(pagePr, 'gutterType') === 'TOP_BOTTOM') top += gutter;
  else left += gutter;
  const W = Math.min(MAX_PAGE_PX, Math.max(1, px(w)));
  const H = Math.min(MAX_PAGE_PX, Math.max(1, px(h)));
  const clampM = (v: number, dim: number): number => Math.min(px(v), Math.round((dim / 2) * 10) / 10);
  return {
    w: W,
    h: H,
    margin: [clampM(top, H), clampM(right, W), clampM(bottom, H), clampM(left, W)],
    headerDist: clampM(topEdge, H),
    footerDist: clampM(bottomEdge, H),
  };
}

function convertSection(sec: XElement, ctx: Ctx, pages: FlowPage[], furn: Furniture): void {
  const geo = pageGeometry(sec);
  /** 현재 머리말/꼬리말을 쪽에 단다 (머리말은 다음 구역에도 이어진다) */
  const dress = (page: FlowPage): void => {
    delete page.header;
    delete page.headerDist;
    delete page.footer;
    delete page.footerDist;
    if (furn.header) {
      page.header = furn.header;
      page.headerDist = geo.headerDist;
    }
    if (furn.footer) {
      page.footer = furn.footer;
      page.footerDist = geo.footerDist;
    }
  };
  const open = (): FlowPage | null => {
    if (pages.length >= MAX_PAGES) {
      ctx.stop = TRUNC_PAGES;
      return null;
    }
    const [mt, mr, mb, ml] = geo.margin;
    const page: FlowPage = { pageNo: pages.length + 1, w: geo.w, h: geo.h, margin: [mt, mr, mb, ml], blocks: [] };
    dress(page);
    pages.push(page);
    return page;
  };
  let page = open();
  for (const p of kids(sec, 'p')) {
    if (!page || ctx.stop) break;
    if (attr(p, 'pageBreak') === '1' && page.blocks.length > 0) {
      page = open();
      if (!page) break;
    }
    if (scanFurniture(p, ctx, furn)) dress(page);
    for (const b of convertPara(p, ctx, 0)) page.blocks.push(b);
  }
}

// ─────────────────────────────── 2단계: 쪽 글자 + 오프셋 ───────────────────────────────

interface LayoutState {
  /** 앞 쪽들 글자 수 합 */
  total: number;
  stopped: boolean;
  /** 글자 상한에서 잘랐는가 */
  cut: boolean;
}

/** 블록 목록: 글자가 있는 블록만 '\n' 으로 잇는다. start = 이 목록 글자가 쪽 글자에서 시작할 자리 */
function layoutBlocks(blocks: FlowBlock[], start: number, st: LayoutState): { blocks: FlowBlock[]; text: string } {
  const out: FlowBlock[] = [];
  let text = '';
  for (const b of blocks) {
    if (st.stopped) break;
    const sep = text.length > 0 ? 1 : 0;
    const r = layoutBlock(b, start + text.length + sep, st);
    if (r.block) out.push(r.block);
    if (r.text.length > 0) text += (sep ? '\n' : '') + r.text;
  }
  return { blocks: out, text };
}

function layoutBlock(b: FlowBlock, start: number, st: LayoutState): { block: FlowBlock | null; text: string } {
  if (b.type === 'img') return { block: b, text: '' };
  if (b.type === 'box') {
    const r = layoutBlocks(b.blocks, start, st);
    return { block: r.blocks.length > 0 ? { ...b, blocks: r.blocks } : null, text: r.text };
  }
  if (b.type === 'p') {
    const runs: FlowRun[] = [];
    let text = '';
    for (const r of b.runs) {
      const o = start + text.length;
      let t = r.t;
      const room = MAX_TEXT - st.total - o;
      if (t.length > room) {
        t = sliceSafe(t, room);
        st.stopped = true;
        st.cut = true;
      }
      if (t.length > 0) {
        runs.push({ ...r, t, o });
        text += t;
      }
      if (st.stopped) break;
    }
    if (st.stopped && runs.length === 0 && b.runs.length > 0) return { block: null, text: '' };
    return { block: { ...b, runs }, text };
  }
  // 표: 칸 '\t', 행 '\n' (글자 있는 칸, 행만)
  const rows: FlowTableRow[] = [];
  let text = '';
  for (const row of b.rows) {
    if (st.stopped) break;
    const rsep = text.length > 0 ? 1 : 0;
    const rowStart = start + text.length + rsep;
    let rowText = '';
    const cells: FlowTableCell[] = [];
    for (const cell of row.cells) {
      if (st.stopped) break;
      const csep = rowText.length > 0 ? 1 : 0;
      const r = layoutBlocks(cell.blocks, rowStart + rowText.length + csep, st);
      cells.push({ ...cell, blocks: r.blocks });
      if (r.text.length > 0) rowText += (csep ? '\t' : '') + r.text;
    }
    rows.push({ ...row, cells });
    if (rowText.length > 0) text += (rsep ? '\n' : '') + rowText;
  }
  return { block: { ...b, rows }, text };
}

// ─────────────────────────────── 진입점 ───────────────────────────────

/**
 * OWPML 트리 원천: hwpx 는 ZIP 안 XML 을, hwp(바이너리)는 레코드를 같은 꼴로 옮긴 트리를 준다(legacy/hwp.ts).
 * 변환 규칙(서식, 표, 쪽, 정본 글자)은 renderOwpml 하나라 두 형식의 결과가 같다.
 */
export interface OwpmlSource {
  /** 서식표(hh:head). 없거나 깨졌으면 null (기본 모양으로 본문을 읽는다) */
  head: XElement | null;
  sectionCount: number;
  /** i 번째 구역(hs:sec). maxTags 를 넘으면 'big', 없거나 깨졌으면 'broken' */
  section(i: number, maxTags: number): { root: XElement; tags: number } | 'big' | 'broken';
  binary(id: string): MediaRef | undefined;
  /** 안내 문구의 형식 이름 ('hwpx', 'hwp') */
  label: string;
}

export function renderOwpml(src: OwpmlSource): Pick<OfficeExtractResult, 'pages' | 'render' | 'renderMime' | 'truncated'> {
  const ctx: Ctx = {
    styles: readStyles(src.head),
    binary: (id) => src.binary(id),
    media: [],
    mediaIndex: new Map(),
    paras: 0,
    chars: 0,
    nodes: 0,
    maxParas: MAX_PARAGRAPHS,
    maxChars: MAX_TEXT,
    maxNodes: MAX_NODES,
    stop: null,
    deep: false,
  };

  // 1단계
  const rawPages: FlowPage[] = [];
  const furn: Furniture = { size: new Map() };
  let sectionTags = 0;
  for (let i = 0; i < src.sectionCount && !ctx.stop; i += 1) {
    const part = src.section(i, Math.min(MAX_PART_TAGS, MAX_SECTION_TAGS - sectionTags));
    if (part === 'big' && i > 0) {
      ctx.stop = truncSize(i); // 앞 구역들은 그대로 싣는다
      break;
    }
    if (typeof part === 'string') throw new OfficeParseError(errSection(src.label, i + 1));
    sectionTags += part.tags;
    convertSection(part.root, ctx, rawPages, furn);
  }

  // 2단계
  const st: LayoutState = { total: 0, stopped: false, cut: false };
  const pages: FlowPage[] = [];
  const texts: string[] = [];
  for (const pg of rawPages) {
    if (st.stopped) break;
    const r = layoutBlocks(pg.blocks, 0, st);
    pages.push({ ...pg, pageNo: pages.length + 1, blocks: r.blocks });
    texts.push(r.text);
    st.total += r.text.length;
  }

  // 머리말/꼬리말은 쪽마다 같은 블록이 JSON 에 되풀이된다: 합계 분량 상한을 넘는 쪽부터는 달지 않는다
  let furnUsed = 0;
  let furnCutAt = 0;
  for (const pg of pages) {
    const cost = (pg.header ? (furn.size.get(pg.header) ?? 0) : 0) + (pg.footer ? (furn.size.get(pg.footer) ?? 0) : 0);
    if (cost === 0) continue;
    if (furnCutAt === 0 && furnUsed + cost <= DISPLAY_TOTAL_CHARS) {
      furnUsed += cost;
      continue;
    }
    if (furnCutAt === 0) furnCutAt = pg.pageNo;
    delete pg.header;
    delete pg.headerDist;
    delete pg.footer;
    delete pg.footerDist;
  }

  // 글자 상한 자리는 1단계 멈춤 자리보다 언제나 앞이므로 그 사유가 우선한다. 깊이, 머리말 안내는 덧붙인다
  const notes = [
    st.cut ? TRUNC_TEXT : ctx.stop,
    ctx.deep ? TRUNC_DEPTH : null,
    furnCutAt > 0 ? furnitureNote(furnCutAt - 1) : null,
  ].filter((s): s is string => s !== null);
  const truncated = notes.length > 0 ? notes.join(' ') : null;
  // 한글의 % 줄 간격은 글자 크기 기준이라 화면 배율은 1 (Word 배수용 기본 1.15 를 쓰지 않는다)
  const model: FlowModel = { v: RENDER_MODEL_VERSION, kind: 'flow', media: ctx.media, truncated, lineScale: 1, pages };
  let json: string;
  try {
    json = JSON.stringify(model);
  } catch (e) {
    // 노드 상한이 있어 닿지 않아야 하지만, 문자열 길이 한계(RangeError)는 사용자 안내로 바꾼다
    if (e instanceof RangeError) throw new OfficeParseError(errTooBig(src.label));
    throw e;
  }
  return {
    pages: texts.map((text, i) => ({ pageNo: i + 1, text, label: null })),
    render: Buffer.from(json, 'utf8'),
    renderMime: 'application/json',
    truncated,
  };
}

export function processHwpx(buf: Buffer, _fileName: string): OfficeExtractResult {
  const dir = readZipDirectory(buf);
  if (!dir || dir.length === 0) throw new OfficeParseError(ERR_ZIP);
  const entries = new Map<string, ZipDirEntry>();
  for (const e of dir) if (!entries.has(e.name)) entries.set(e.name, e);
  const names = new Set(entries.keys());
  /** 지금까지 푼 바이트 합 (크기를 거짓으로 적은 ZIP 도 합계 상한 안에서만 푼다) */
  let inflated = 0;
  const room = (): number => Math.min(MAX_PART_BYTES, MAX_TOTAL_BYTES - inflated);
  const readBytes = (name: string): Buffer | null => {
    const e = entries.get(name);
    if (!e || room() <= 0) return null;
    const b = readZipEntry(buf, e, room());
    if (b) inflated += b.length;
    return b;
  };
  /** XML 부분 하나. 크기('<' 개수 포함) 상한을 넘으면 'big', 없거나 깨졌으면 'broken' */
  const readXml = (name: string | undefined, maxTags: number): { root: XElement; tags: number } | 'big' | 'broken' => {
    const e = name ? entries.get(name) : undefined;
    if (!e) return 'broken';
    if (room() <= 0 || e.uncompressedSize > room()) return 'big';
    const b = readBytes(e.name);
    if (!b) return 'broken';
    const src = decodeXml(b);
    const tags = countTags(src, maxTags);
    if (tags > maxTags) return 'big'; // 트리를 만들기 전에 멈춘다
    try {
      return { root: parseXml(src).root, tags };
    } catch {
      return 'broken';
    }
  };
  const optionalXml = (name: string | undefined): XElement | null => {
    const part = readXml(name, MAX_PART_TAGS);
    return typeof part === 'string' ? null : part.root; // 목차, 서식표는 없어도 본문은 읽는다
  };

  // 암호 걸린 hwpx 는 META-INF/manifest.xml 에 암호화 정보(encryption-data)가 있다
  const manifest = readBytes('META-INF/manifest.xml');
  if (manifest && manifest.toString('utf8').includes('encryption-data')) throw new OfficeParseError(ERR_ENCRYPTED);

  const hpfPath = names.has('Contents/content.hpf')
    ? 'Contents/content.hpf'
    : [...names].find((n) => /\.hpf$/i.test(n));
  const hpfDir = hpfPath ? hpfPath.slice(0, hpfPath.lastIndexOf('/') + 1) : 'Contents/';
  const pkg = readPackage(optionalXml(hpfPath));
  const headerItem = pkg.items.get('header');
  const headerPath = names.has('Contents/header.xml')
    ? 'Contents/header.xml'
    : headerItem
      ? resolveHref(headerItem.href, names, hpfDir)
      : undefined;
  const head = optionalXml(headerPath);
  const sections = sectionOrder(pkg, names, hpfDir);
  if (sections.length === 0) throw new OfficeParseError(ERR_NO_SECTION);

  const binByStem = new Map<string, string>();
  for (const n of names) {
    const m = /^BinData\/([^/]+)\.[^./]+$/i.exec(n);
    if (m?.[1] !== undefined && !binByStem.has(m[1])) binByStem.set(m[1], n);
  }
  const out = renderOwpml({
    head,
    sectionCount: sections.length,
    section: (i, maxTags) => readXml(sections[i], maxTags),
    binary: zipBinary(pkg.items, names, hpfDir, binByStem),
    label: 'hwpx',
  });
  return { fileKind: 'hwpx', extractor: HWPX_EXTRACTOR, ...out };
}
