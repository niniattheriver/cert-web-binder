/**
 * pptx → 정본 쪽 글자 + 렌더 모델(SlidesModel)
 *
 * 한 번의 해석으로 두 산출물을 같이 만든다(model.ts 정합 원칙).
 * - 쪽 = 슬라이드 한 장. 순서는 발표 순서(presentation.xml sldIdLst → r:id → 관계 대상), 라벨 '슬라이드 N'.
 *   숨긴 슬라이드(show="0")도 넣고 hidden 으로 표시한다. 발표자 노트는 넣지 않는다.
 * - 정본 글자: 글자를 가진 항목(글상자, 표)을 도형 트리 순서로 '\n' 으로 잇는다.
 *   글상자 안은 빈 문단을 뺀 문단을 '\n' 으로, 표는 행을 '\n', 글자 있는 칸을 '\t', 칸 안 문단을 '\n' 으로 잇는다.
 *   글머리 기호와 자동 번호는 표시 전용이라 정본에 넣지 않는다.
 * - 모든 run 의 t 는 normalizeText 를 거친 값이고, o 는 그 쪽 글자 안 시작 위치다(글자를 먼저 정규화한 뒤 오프셋 계산).
 *   결합 문자(한글 중성, 종성 자모나 결합 부호)로 시작하는 run 은 앞 run 에 붙여 다시 정규화한다(docx 와 같은 규칙):
 *   쪽 글자 전체를 정규화해도 바뀌지 않게. 글자 노드의 엔티티는 한 번에 풀고, XML 이 허용하지 않는 글자 참조
 *   (서로게이트 반쪽 등)는 U+FFFD 로 바꾼다(DB 에 저장한 뒤에도 조각과 쪽 글자가 같게).
 * - 수식(a14:m 안의 m:oMath)은 m:t 를 이은 기울임 run 하나로 넣는다(docx 와 같은 규칙).
 * - 개체 틀(placeholder)은 위치, 크기, 글자 서식, 글머리를 레이아웃 → 마스터에서 물려받는다.
 * - 배경과 마스터/레이아웃 장식(그림, 글자 없는 도형)은 그림으로만 그린다. 글자 있는 장식은 넣지 않는다
 *   (모든 슬라이드에 같은 글자가 색인되지 않게). 장식은 마스터, 레이아웃마다 한 번 만들어 슬라이드끼리 같이 쓰고,
 *   슬라이드 자신의 도형 상한, 구성 요소 예산과 따로 센다(장식 때문에 슬라이드 글자를 잃지 않게).
 * - 그림은 png/jpeg/gif/bmp/webp 만(내용의 매직 바이트로 확인). 그 밖의 형식(emf, wmf, svg, tiff)은 자리 표시.
 * - 상한(PPTX_LIMITS): 슬라이드 수, 슬라이드 하나의 자기 도형 수, 글자 수, 모델 구성 요소 수(도형, 문단, run,
 *   표 열, 행, 칸: 글자 없는 것도 센다), 푼 XML 바이트 합, XML 부분 하나의 태그 수(넘는 슬라이드는 읽지 못한 쪽).
 *   어느 것에 걸려도 색인과 모델을 같은 자리에서 자르고 truncated 에 알린다. 연속 빈 문단은 앞 몇 개만 싣는다
 *   (글자가 없어 정본과 무관, 화면의 빈 줄만 준다).
 *   sldIdLst 가 같은 슬라이드를 거듭 가리키면 한 번만 해석하고 두 번째부터는 자리 표시로 둔다.
 * - 근사: 그룹 회전/뒤집기, 표 스타일, 그라데이션(첫 색), 세로 쓰기는 반영하지 않는다. 한 마스터, 레이아웃의
 *   색 대응표 변형이 많으면 장식 색은 처음 만든 것을 쓴다.
 */
import path from 'node:path';
import zlib from 'node:zlib';
import { readZipDirectory, readZipEntry, type ZipDirEntry } from '../files/unzip.js';
import { normalizeText } from '../pdf/normalize.js';
import { stripControls } from './controls.js';
import { cropFromSrcRect } from './crop.js';
import { sniffImage } from './image-sniff.js'; // 매직 바이트로 허용 형식 판정 (확장자는 믿지 않는다)
import { OfficeParseError } from './errors.js';
import {
  RENDER_MODEL_VERSION,
  type MediaRef,
  type OfficeExtractResult,
  type RunStyle,
  type SlidePage,
  type SlidePara,
  type SlidePicShape,
  type SlideRun,
  type SlideShape,
  type SlidesModel,
  type SlideTableCell,
  type SlideTableShape,
  type SlideTextShape,
} from './model.js';
import { attr, localName, makeEl, parseXml, type XElement } from './xml.js';

export const PPTX_EXTRACTOR = 'pptx-v1';

/** 추출 상한 (색인과 표시는 언제나 같은 범위다). 테스트는 processPptx 셋째 인자로 줄여 쓴다 */
export interface PptxLimits {
  /** 슬라이드 수 */
  slides: number;
  /** 슬라이드 하나의 자기 도형 수 (마스터, 레이아웃 장식은 세지 않는다) */
  shapesPerSlide: number;
  /** 글자 수 (모든 슬라이드 합, 구분자 포함) */
  text: number;
  /** 모델 구성 요소 수 (모든 슬라이드 합): 슬라이드 도형, 문단, run, 표 열, 행, 칸. 글자 없는 것도 센다 */
  nodes: number;
  /** 연속 빈 문단 중 싣는 수 (그 뒤 빈 문단은 접는다) */
  emptyParasInRow: number;
  /** 슬라이드 하나에 그리는 마스터, 레이아웃 장식 도형 수 */
  decorPerSlide: number;
  /** 모든 슬라이드에 그리는 장식 도형 수 합 */
  decorTotal: number;
  /** 푼 XML 부분 바이트 합 (이를 넘길 슬라이드부터 넣지 않는다) */
  xmlTotalBytes: number;
  /**
   * XML 부분 하나의 태그('<') 수. 넘는 부분은 해석하지 않는다(슬라이드라면 읽지 못한 쪽으로 둔다).
   * 해석 트리는 요소 하나에 백 바이트 넘게 쓰므로 바이트 상한만으로는 메모리가 묶이지 않는다
   */
  tagsPerPart: number;
}

/**
 * 실제 파일 414개에서 잰 최대값(구성 요소 27,872개, XML 합 12.8MB, 장식 6개, 부분 하나의 태그 82,172개)에
 * 견주어 넉넉히 잡았다
 */
export const PPTX_LIMITS: Readonly<PptxLimits> = {
  slides: 500,
  shapesPerSlide: 2000,
  text: 3_000_000,
  nodes: 250_000,
  emptyParasInRow: 50,
  decorPerSlide: 200,
  decorTotal: 25_000,
  xmlTotalBytes: 256 * 1024 * 1024,
  tagsPerPart: 2_000_000,
};
/** 장식을 한 번 만들 때 훑는 요소 수 상한 (마스터, 레이아웃 도형 트리) */
const MAX_DECOR_VISIT = 10_000;
/** 같은 마스터, 레이아웃의 장식을 색 대응표별로 따로 만드는 수 상한 (넘으면 처음 만든 것을 쓴다) */
const MAX_DECOR_VARIANTS = 4;
/** XML 부분 하나를 풀 때의 상한 */
const PART_MAX_BYTES = 64 * 1024 * 1024;
/** 자동 번호 시작값 범위 (ST_TextBulletStartAtNum: 1..32767) */
const MAX_START_AT = 32767;
/** 알파벳 자동 번호가 같은 글자를 이보다 많이 되풀이하면 숫자로 쓴다 (글머리 길이 상한) */
const MAX_ALPHA_REPEAT = 4;
const DEFAULT_SLIDE_W = 12_192_000;
const DEFAULT_SLIDE_H = 6_858_000;
const DEFAULT_FONT_PT = 18;
/** bodyPr 안쪽 여백 기본값 [l, t, r, b] EMU */
const DEFAULT_INSET: [number, number, number, number] = [91440, 45720, 91440, 45720];
const UNSUPPORTED_PIC_LABEL = '그림(미리보기 미지원 형식)';

// ─────────────────────────────── XML, 숫자 도우미 ───────────────────────────────

/** 속성 값 (요소가 없으면 undefined) */
function at(el: XElement | undefined, name: string): string | undefined {
  return el ? attr(el, name) : undefined;
}

/** 접두사가 무엇이든 로컬 이름이 같은 속성 (r:id, r:embed 등 관계 속성용). 'r:' 를 먼저 본다 */
function nsAttr(el: XElement | undefined, local: string): string | undefined {
  if (!el) return undefined;
  const direct = attr(el, `r:${local}`);
  if (direct !== undefined) return direct;
  for (const [k, v] of el._attrs ?? []) {
    if (k.includes(':') && !k.startsWith('xmlns:') && !k.startsWith('xml:') && localName(k) === local) return v;
  }
  return undefined;
}

/** 직계 자식 중 로컬 이름이 같은 요소들 (접두사 무시) */
function kids(el: XElement | undefined, local: string): XElement[] {
  const out: XElement[] = [];
  if (!el) return out;
  for (const c of el.children) if (c.type === 'el' && localName(c.name) === local) out.push(c);
  return out;
}

/** 로컬 이름이 같은 첫 직계 자식 */
function kid(el: XElement | undefined, local: string): XElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) if (c.type === 'el' && localName(c.name) === local) return c;
  return undefined;
}

/** 경로를 따라 내려간 첫 요소 */
function kidPath(el: XElement | undefined, ...locals: string[]): XElement | undefined {
  let cur = el;
  for (const l of locals) cur = kid(cur, l);
  return cur;
}

function int(v: string | undefined, dflt = 0): number {
  if (v === undefined) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'on';
}

/** 1000분의 1 퍼센트 값(75000) 또는 '75%' → 0.75 */
function pct(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = v.endsWith('%') ? Number.parseFloat(v) / 100 : Number(v) / 100_000;
  return Number.isFinite(n) ? n : undefined;
}

/** '<' 가 max 개를 넘는가 (해석 전에 싸게 센다) */
function tooManyTags(s: string, max: number): boolean {
  let n = 0;
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
    n += 1;
    if (n > max) return true;
  }
  return false;
}

function decodeXml(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const s = b.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ─────────────────────────────── 패키지(ZIP + 관계) ───────────────────────────────

interface Rel {
  type: string;
  /** ZIP 안 경로 (외부 대상이면 원문) */
  target: string;
  external: boolean;
}

/** 'ppt/slides/slide1.xml' → 'ppt/slides/_rels/slide1.xml.rels' */
function relsPathOf(part: string): string {
  const dir = path.posix.dirname(part);
  return `${dir === '.' ? '' : `${dir}/`}_rels/${path.posix.basename(part)}.rels`;
}

/** 관계 대상을 그 부분의 폴더 기준으로 푼다 ('../media/a.png', '/ppt/x.xml' 모두) */
function resolveTarget(part: string, target: string): string {
  const t = target.replace(/\\/g, '/');
  if (t.startsWith('/')) return path.posix.normalize(t.slice(1));
  const dir = path.posix.dirname(part);
  return path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, t));
}

class Pkg {
  private readonly byName = new Map<string, ZipDirEntry>();
  private readonly byLower = new Map<string, ZipDirEntry>();
  private readonly xmlCache = new Map<string, XElement | null>();
  private readonly relCache = new Map<string, Map<string, Rel>>();
  /** 지금까지 푼 바이트 합 (PptxLimits.xmlTotalBytes) */
  bytesRead = 0;

  constructor(
    readonly buf: Buffer,
    dir: ZipDirEntry[],
    private readonly maxTags: number,
  ) {
    for (const e of dir) {
      this.byName.set(e.name, e);
      const low = e.name.toLowerCase();
      if (!this.byLower.has(low)) this.byLower.set(low, e);
    }
  }

  /** 이름으로 엔트리 (정확히 → 대소문자 무시 → %인코딩 해제 순) */
  entry(name: string): ZipDirEntry | undefined {
    const hit = this.byName.get(name) ?? this.byLower.get(name.toLowerCase());
    if (hit || !name.includes('%')) return hit;
    try {
      const dec = decodeURIComponent(name);
      return this.byName.get(dec) ?? this.byLower.get(dec.toLowerCase());
    } catch {
      return undefined;
    }
  }

  read(name: string): Buffer | null {
    const e = this.entry(name);
    const b = e ? readZipEntry(this.buf, e, PART_MAX_BYTES) : null;
    if (b) this.bytesRead += b.length;
    return b;
  }

  /**
   * XML 부분의 루트 요소. 없거나 깨졌거나 태그가 너무 많으면 null (레이아웃, 마스터, 테마는 cache 로 한 번만 해석)
   */
  xml(name: string, cache = false): XElement | null {
    if (cache && this.xmlCache.has(name)) return this.xmlCache.get(name) ?? null;
    const b = this.read(name);
    let root: XElement | null = null;
    if (b) {
      const src = decodeXml(b);
      if (!tooManyTags(src, this.maxTags)) {
        try {
          root = parseXml(src).root;
        } catch {
          root = null;
        }
      }
    }
    if (cache) this.xmlCache.set(name, root);
    return root;
  }

  /** 부분 하나의 관계표 (Id → 대상) */
  rels(part: string): Map<string, Rel> {
    const hit = this.relCache.get(part);
    if (hit) return hit;
    const map = new Map<string, Rel>();
    const root = this.xml(relsPathOf(part));
    for (const r of kids(root ?? undefined, 'Relationship')) {
      const id = attr(r, 'Id');
      const target = attr(r, 'Target');
      if (!id || target === undefined) continue;
      const external = (attr(r, 'TargetMode') ?? '').toLowerCase() === 'external';
      map.set(id, { type: attr(r, 'Type') ?? '', target: external ? target : resolveTarget(part, target), external });
    }
    this.relCache.set(part, map);
    return map;
  }
}

/** 관계 형식(끝 이름)이 같은 첫 내부 관계 대상 */
function relTarget(rels: Map<string, Rel>, typeSuffix: string): string | undefined {
  for (const r of rels.values()) if (!r.external && r.type.endsWith(`/${typeSuffix}`)) return r.target;
  return undefined;
}

// ─────────────────────────────── 테마, 색 ───────────────────────────────

interface FontSet {
  latin?: string;
  ea?: string;
}

interface Theme {
  /** 'dk1' → 'rrggbb' */
  colors: Map<string, string>;
  major: FontSet;
  minor: FontSet;
}

interface ColorCtx {
  theme: Theme;
  /** 'tx1' → 'dk1' 같은 색 대응표 (마스터 clrMap, 슬라이드/레이아웃 덮어쓰기 반영) */
  clrMap: Map<string, string>;
}

const HEX_RE = /^[0-9a-fA-F]{6}$/;
const COLOR_TAGS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr']);
const CLR_MAP_KEYS = [
  'bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink',
];
const DEFAULT_CLR_MAP: [string, string][] = [
  ['bg1', 'lt1'],
  ['tx1', 'dk1'],
  ['bg2', 'lt2'],
  ['tx2', 'dk2'],
];
/** 자주 쓰는 미리 정의 색 (prstClr) */
const PRESET_COLORS: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00',
  gray: '808080', grey: '808080', darkGray: 'a9a9a9', lightGray: 'd3d3d3', orange: 'ffa500', purple: '800080',
  navy: '000080', cyan: '00ffff', magenta: 'ff00ff', brown: 'a52a2a', darkBlue: '00008b', darkRed: '8b0000',
};

const EMPTY_THEME: Theme = { colors: new Map(), major: {}, minor: {} };

function readFontSet(el: XElement | undefined): FontSet {
  const out: FontSet = {};
  const latin = at(kid(el, 'latin'), 'typeface');
  if (latin) out.latin = latin;
  const hang = kids(el, 'font').find((f) => attr(f, 'script') === 'Hang');
  const ea = at(kid(el, 'ea'), 'typeface') || at(hang, 'typeface');
  if (ea) out.ea = ea;
  return out;
}

function readTheme(root: XElement | null): Theme {
  if (!root) return EMPTY_THEME;
  const els = kid(root, 'themeElements');
  const colors = new Map<string, string>();
  for (const c of kid(els, 'clrScheme')?.children ?? []) {
    if (c.type !== 'el') continue;
    const inner = c.children.find((x): x is XElement => x.type === 'el' && COLOR_TAGS.has(localName(x.name)));
    if (!inner) continue;
    const tag = localName(inner.name);
    let hex: string | undefined;
    if (tag === 'srgbClr') hex = attr(inner, 'val');
    else if (tag === 'sysClr') hex = attr(inner, 'lastClr') ?? (attr(inner, 'val') === 'window' ? 'ffffff' : '000000');
    if (hex && HEX_RE.test(hex)) colors.set(localName(c.name), hex.toLowerCase());
  }
  const fs = kid(els, 'fontScheme');
  return { colors, major: readFontSet(kid(fs, 'majorFont')), minor: readFontSet(kid(fs, 'minorFont')) };
}

function readClrMap(el: XElement | undefined, base?: Map<string, string>): Map<string, string> {
  const m = new Map<string, string>(base ?? DEFAULT_CLR_MAP);
  if (el) {
    for (const k of CLR_MAP_KEYS) {
      const v = attr(el, k);
      if (v) m.set(k, v);
    }
  }
  return m;
}

type RGB = [number, number, number];

function hexToRgb(hex: string | undefined): RGB | undefined {
  if (!hex || !HEX_RE.test(hex)) return undefined;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function rgbToHex(c: RGB): string {
  return `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function rgbToHsl([r0, g0, b0]: RGB): RGB {
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: RGB): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255];
}

/** 색 변형(lumMod, lumOff, satMod, tint, shade)을 문서 순서대로 근사 적용. alpha 등은 무시 */
function applyColorMods(rgb: RGB, el: XElement): RGB {
  let c = rgb;
  for (const m of el.children) {
    if (m.type !== 'el') continue;
    const v = pct(attr(m, 'val'));
    if (v === undefined) continue;
    const name = localName(m.name);
    if (name === 'lumMod' || name === 'lumOff' || name === 'satMod') {
      const [h, s, l] = rgbToHsl(c);
      if (name === 'lumMod') c = hslToRgb([h, s, clamp01(l * v)]);
      else if (name === 'lumOff') c = hslToRgb([h, s, clamp01(l + v)]);
      else c = hslToRgb([h, clamp01(s * v), l]);
    } else if (name === 'tint') {
      c = c.map((x) => x + (255 - x) * (1 - v)) as RGB;
    } else if (name === 'shade') {
      c = c.map((x) => x * v) as RGB;
    }
  }
  return c;
}

/** 색 요소 하나(srgbClr, schemeClr …) → '#rrggbb' */
function colorOfEl(el: XElement, cc: ColorCtx): string | undefined {
  let rgb: RGB | undefined;
  switch (localName(el.name)) {
    case 'srgbClr':
      rgb = hexToRgb(attr(el, 'val'));
      break;
    case 'sysClr':
      rgb = hexToRgb(attr(el, 'lastClr')) ?? (attr(el, 'val') === 'window' ? [255, 255, 255] : [0, 0, 0]);
      break;
    case 'schemeClr': {
      const val = attr(el, 'val') ?? '';
      rgb = hexToRgb(cc.theme.colors.get(cc.clrMap.get(val) ?? val));
      break;
    }
    case 'prstClr': {
      const val = attr(el, 'val') ?? '';
      rgb = Object.hasOwn(PRESET_COLORS, val) ? hexToRgb(PRESET_COLORS[val]) : undefined;
      break;
    }
    case 'scrgbClr': {
      const ch = (k: string): number => clamp01(pct(attr(el, k)) ?? 0) * 255;
      rgb = [ch('r'), ch('g'), ch('b')];
      break;
    }
    case 'hslClr': {
      const hue = int(attr(el, 'hue')) / 60000 / 360;
      rgb = hslToRgb([hue - Math.floor(hue), clamp01(pct(attr(el, 'sat')) ?? 0), clamp01(pct(attr(el, 'lum')) ?? 0)]);
      break;
    }
    default:
      rgb = undefined;
  }
  return rgb ? rgbToHex(applyColorMods(rgb, el)) : undefined;
}

/** 색을 담은 요소(solidFill, fontRef, fgClr …)의 첫 색 자식 → '#rrggbb' */
function colorIn(container: XElement | undefined, cc: ColorCtx): string | undefined {
  if (!container) return undefined;
  for (const c of container.children) {
    if (c.type === 'el' && COLOR_TAGS.has(localName(c.name))) return colorOfEl(c, cc);
  }
  return undefined;
}

/**
 * 채우기 선택 요소를 가진 부모(spPr, ln, bgPr, tcPr, rPr)에서 채우기 색을 정한다.
 * decided=false 면 이 수준에 채우기 지정이 없다(상속 계속). 그라데이션은 첫 색, 무늬는 전경색으로 근사.
 */
function fillOf(parent: XElement | undefined, cc: ColorCtx): { decided: boolean; color?: string } {
  if (!parent) return { decided: false };
  for (const c of parent.children) {
    if (c.type !== 'el') continue;
    switch (localName(c.name)) {
      case 'solidFill':
        return { decided: true, color: colorIn(c, cc) };
      case 'gradFill':
        return { decided: true, color: colorIn(kidPath(c, 'gsLst', 'gs'), cc) };
      case 'pattFill':
        return { decided: true, color: colorIn(kid(c, 'fgClr'), cc) };
      case 'noFill':
      case 'blipFill':
      case 'grpFill':
        return { decided: true };
      default:
        break;
    }
  }
  return { decided: false };
}

// ─────────────────────────────── 글자 서식 상속 ───────────────────────────────

/**
 * 문단 속성 출처 하나. lst = 수준별 lvlNpPr 을 가진 요소(lstStyle, txStyles 의 titleStyle 등),
 * fixed = 모든 수준에 공통인 pPr(도형 스타일 fontRef 를 합성한 것).
 */
type StyleSrc = { lst: XElement } | { fixed: XElement };

interface TextCtx {
  /** 우선순위 순 (문단 자신의 pPr 은 제외) */
  srcs: StyleSrc[];
  /** normAutofit 글자 축소 비율 (1 = 100%) */
  fontScale: number;
  cc: ColorCtx;
  /** 모델 구성 요소 예산 (모든 슬라이드 공통) */
  nodes: NodeBudget;
  /** 연속 빈 문단 중 싣는 수 */
  maxEmptyInRow: number;
}

/** 문단 속성 사슬: 문단 pPr → 출처들의 lvl(N+1)pPr */
function pChain(ctx: TextCtx, pPr: XElement | undefined, lvl: number): XElement[] {
  const name = `lvl${lvl + 1}pPr`;
  const out: XElement[] = [];
  if (pPr) out.push(pPr);
  for (const s of ctx.srcs) {
    const el = 'lst' in s ? kid(s.lst, name) : s.fixed;
    if (el) out.push(el);
  }
  return out;
}

function firstAttr(chain: XElement[], name: string): string | undefined {
  for (const el of chain) {
    const v = attr(el, name);
    if (v !== undefined) return v;
  }
  return undefined;
}

const CJK_RE = /[ᄀ-ᇿ　-鿿가-힯豈-﫿＀-￯]/;

/** '+mj-lt' 같은 테마 글꼴 참조를 실제 이름으로 */
function resolveTypeface(tf: string | undefined, theme: Theme): string | undefined {
  if (!tf) return undefined;
  if (!tf.startsWith('+')) return tf;
  const set = tf.startsWith('+mj') ? theme.major : theme.minor;
  if (tf.endsWith('-lt')) return set.latin || undefined;
  if (tf.endsWith('-ea')) return set.ea || undefined;
  return undefined;
}

/** 글꼴 이름: 화면이 CSS 값으로 쓰므로 따옴표, 세미콜론, 괄호 같은 글자는 빼고 64자로 자른다 */
function safeFont(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const s = name.replace(/[^\p{L}\p{N} _\-.&+]/gu, '').trim().slice(0, 64);
  return s || undefined;
}

function firstTypeface(chain: XElement[], local: string): string | undefined {
  for (const el of chain) {
    const tf = at(kid(el, local), 'typeface');
    if (tf) return tf;
  }
  return undefined;
}

/** run 서식: rPr → 문단 pPr/defRPr → 출처들의 defRPr 순으로 처음 지정된 값. 크기 기본 18pt */
function runStyle(rPr: XElement | undefined, pch: XElement[], ctx: TextCtx, text: string): RunStyle {
  const chain: XElement[] = [];
  if (rPr) chain.push(rPr);
  for (const p of pch) {
    const d = kid(p, 'defRPr');
    if (d) chain.push(d);
  }
  const st: RunStyle = {};
  const sz = int(firstAttr(chain, 'sz'), -1);
  st.sz = Math.round((sz > 0 ? sz / 100 : DEFAULT_FONT_PT) * ctx.fontScale * 10) / 10;
  if (truthy(firstAttr(chain, 'b'))) st.b = true;
  if (truthy(firstAttr(chain, 'i'))) st.i = true;
  const u = firstAttr(chain, 'u');
  if (u !== undefined && u !== 'none') st.u = true;
  const strike = firstAttr(chain, 'strike');
  if (strike !== undefined && strike !== 'noStrike') st.strike = true;
  for (const el of chain) {
    const f = fillOf(el, ctx.cc);
    if (f.decided) {
      if (f.color) st.color = f.color;
      break;
    }
  }
  const latin = resolveTypeface(firstTypeface(chain, 'latin'), ctx.cc.theme);
  const ea = resolveTypeface(firstTypeface(chain, 'ea'), ctx.cc.theme);
  const font = safeFont(CJK_RE.test(text) ? (ea ?? latin) : (latin ?? ea));
  if (font) st.font = font;
  return st;
}

// ─────────────────────────────── 글머리, 자동 번호 ───────────────────────────────

type BulletSpec = { kind: 'none' } | { kind: 'char'; ch: string } | { kind: 'auto'; scheme: string; startAt: number };

const SYMBOL_FONT_RE = /wingdings|symbol|webdings/i;
/** 기호 글꼴(Wingdings, Symbol) 글머리 글자 → 비슷한 유니코드 (표시 전용 근사) */
const SYMBOL_BULLETS: Record<string, string> = {
  l: '●', n: '■', o: '□', p: '□', q: '❑', u: '◆', v: '❖', w: '⬥',
  '§': '▪', 'Ø': '➢', 'ü': '✔', 'û': '✘', 'à': '➔',
  'è': '➔', 'ð': '⇨', '\u009f': '•', 'Ÿ': '•',
};
/** Symbol 글꼴의 글머리 점(U+00B7) */
SYMBOL_BULLETS[String.fromCharCode(0xb7)] = '•';

function bulletGlyph(ch: string, font: string | undefined): string {
  if (ch === '') return '';
  let c = ch;
  const code = c.codePointAt(0) ?? 0;
  const pua = code >= 0xf020 && code <= 0xf0ff; // 기호 글꼴의 사용자 영역 글자
  if (pua) c = String.fromCharCode(code - 0xf000);
  if (pua || (font !== undefined && SYMBOL_FONT_RE.test(font))) return SYMBOL_BULLETS[c] ?? '•';
  return Array.from(c)[0] ?? ''; // 글머리는 한 글자
}

/** 사슬에서 처음 정해진 글머리 (buNone 은 상속을 끊는다) */
function bulletOf(pch: XElement[]): BulletSpec {
  let font: string | undefined;
  for (const el of pch) {
    const bf = kid(el, 'buFont');
    if (bf || kid(el, 'buFontTx')) {
      font = at(bf, 'typeface');
      break;
    }
  }
  for (const el of pch) {
    for (const c of el.children) {
      if (c.type !== 'el') continue;
      const n = localName(c.name);
      if (n === 'buNone') return { kind: 'none' };
      if (n === 'buChar') return { kind: 'char', ch: bulletGlyph(attr(c, 'char') ?? '', font) };
      if (n === 'buBlip') return { kind: 'char', ch: '•' };
      if (n === 'buAutoNum') {
        const startAt = Math.min(MAX_START_AT, Math.max(1, int(attr(c, 'startAt'), 1)));
        return { kind: 'auto', scheme: attr(c, 'type') ?? 'arabicPeriod', startAt };
      }
    }
  }
  return { kind: 'none' };
}

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let s = '';
  let rest = n;
  for (const [v, sym] of table) {
    while (rest >= v) {
      s += sym;
      rest -= v;
    }
  }
  return s;
}

/**
 * A..Z, AA..ZZ, AAA.. (ECMA-376: 27 → aa, 53 → aaa). 같은 글자를 MAX_ALPHA_REPEAT 번보다 많이 되풀이해야
 * 하면 숫자로 쓴다 (표시 전용 글머리가 번호에 비례해 길어지지 않게)
 */
function alpha(n: number): string {
  const reps = Math.ceil(n / 26);
  if (n <= 0 || reps > MAX_ALPHA_REPEAT) return String(n);
  return String.fromCharCode(65 + ((n - 1) % 26)).repeat(reps);
}

/** buAutoNum type + 순번 → 표시 글자 ('arabicPeriod', 3 → '3.') */
function autoNumText(scheme: string, n: number): string {
  if (scheme.startsWith('circleNum')) return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : `${n}.`;
  let num: string;
  if (scheme.startsWith('alphaLc')) num = alpha(n).toLowerCase();
  else if (scheme.startsWith('alphaUc')) num = alpha(n);
  else if (scheme.startsWith('romanLc')) num = roman(n).toLowerCase();
  else if (scheme.startsWith('romanUc')) num = roman(n);
  else num = String(n);
  if (scheme.endsWith('ParenBoth')) return `(${num})`;
  if (scheme.endsWith('ParenR')) return `${num})`;
  if (scheme.endsWith('Plain')) return num;
  if (scheme.endsWith('Minus')) return `- ${num} -`;
  return `${num}.`;
}

// ─────────────────────────────── 문단, 글상자 ───────────────────────────────

const ALIGN = new Map<string, NonNullable<SlidePara['align']>>([
  ['l', 'l'], ['ctr', 'ctr'], ['r', 'r'], ['just', 'just'], ['dist', 'just'], ['justLow', 'just'], ['thaiDist', 'just'],
]);
const RUN_TAGS = new Set(['r', 'fld', 'br']);
/** 문단 안의 수식: a14:m(PowerPoint), 그 안이나 바로 놓인 m:oMath, m:oMathPara */
const MATH_TAGS = new Set(['m', 'oMath', 'oMathPara']);
/** 정규화 때 앞 글자와 합쳐질 수 있는 첫 글자: 결합 부호, 한글 중성/종성 자모 (docx/build.ts 와 같은 범위) */
const COMBINING_START = /^[\p{M}\u{1160}-\u{11FF}\u{D7B0}-\u{D7FF}]/u;

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g;
const NAMED_ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML 1.0 이 허용하는 글자만 그대로, 나머지(서로게이트 반쪽, 제어 문자 등) 참조는 U+FFFD */
function xmlChar(cp: number): string {
  const ok =
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff);
  return ok ? String.fromCodePoint(cp) : '\u{FFFD}';
}

/**
 * 글자 노드의 엔티티를 한 번에 푼다. 공용 unescapeXml(xml.ts)은 치환을 차례로 돌려 '&#38;lt;' 를 '<' 로
 * 두 번 풀고, '&#xD800;' 같은 서로게이트 반쪽을 남긴다(better-sqlite3 가 저장하며 U+FFFD 로 바꿔 오프셋 정합이
 * 깨진다). 그래서 정본 글자는 여기서 푼다.
 */
function decodeText(raw: string): string {
  if (raw.indexOf('&') < 0) return raw;
  return raw.replace(ENTITY_RE, (m: string, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return xmlChar(Number(dec));
    if (hex !== undefined) return xmlChar(Number.parseInt(hex, 16));
    return (name !== undefined ? NAMED_ENTITY[name] : undefined) ?? m;
  });
}

/** a:t(또는 m:t)의 글자 (엔티티, CDATA 해제) */
function textOf(el: XElement | undefined): string {
  if (!el) return '';
  let s = '';
  for (const c of el.children) {
    if (c.type === 'text') s += decodeText(c.raw);
    else if (c.type === 'raw' && c.raw.startsWith('<![CDATA[')) s += c.raw.slice(9, -3);
  }
  return s;
}

/** 문단 자식: mc:AlternateContent 는 run 이나 수식을 가진 쪽(Fallback 우선)으로 펼친다 */
function paraKids(p: XElement): XElement[] {
  const out: XElement[] = [];
  for (const c of p.children) {
    if (c.type !== 'el') continue;
    if (localName(c.name) === 'AlternateContent') {
      const pick = [kid(c, 'Fallback'), ...kids(c, 'Choice')].find(
        (a) =>
          a !== undefined &&
          a.children.some((x) => x.type === 'el' && (RUN_TAGS.has(localName(x.name)) || MATH_TAGS.has(localName(x.name)))),
      );
      // 펼침 인자(...)는 자식이 아주 많으면 호출 인자 한계를 넘으므로 하나씩 넣는다
      if (pick) for (const x of paraKids(pick)) out.push(x);
      continue;
    }
    out.push(c);
  }
  return out;
}

/** 수식 요소의 m:t 글자(문서 순서)와 첫 DrawingML 글자 서식(a:rPr). 깊게 중첩돼도 재귀하지 않는다 */
function readMath(el: XElement): { t: string; rPr: XElement | undefined } {
  let t = '';
  let rPr: XElement | undefined;
  const stack: XElement[] = [el];
  for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
    const ln = localName(e.name);
    if (ln === 't') {
      t += textOf(e);
      continue;
    }
    if (ln === 'rPr' && !e.name.startsWith('m:')) {
      rPr ??= e;
      continue;
    }
    for (let k = e.children.length - 1; k >= 0; k -= 1) {
      const c = e.children[k];
      if (c?.type === 'el') stack.push(c);
    }
  }
  return { t, rPr };
}

interface ParaOut {
  para: SlidePara;
  lvl: number;
  bullet: BulletSpec;
  hasText: boolean;
}

/** 서식을 매기기 전의 조각: 글자(run, 필드, 수식) 또는 줄바꿈 */
type Piece = { t: string; rPr: XElement | undefined; math: boolean } | { br: XElement };

/**
 * 문단 하나. keepEmpty 가 false 면 글자 없는 문단은 서식을 계산하지 않고 null (연속 빈 문단 접기).
 * 구성 요소 예산은 문단 1 + run 마다 1 을 쓰고, 모자라면 그 자리에서 끊는다(예산이 끊겨도 null 일 수 있다).
 */
function readPara(p: XElement, ctx: TextCtx, keepEmpty: boolean): ParaOut | null {
  const pieces: Piece[] = [];
  // 결합 문자로 시작하는 조각은 앞 조각에 붙여 다시 정규화한다(쪽 글자 전체를 정규화해도 바뀌지 않게, docx 와 같은 규칙).
  // 이어지는 결합 조각은 모아 두었다가 한 번에 정규화한다: 조각마다 앞 글자 전체를 다시 정규화하면 조각 수의 제곱
  // 시간이 든다. 이미 정규화한 조각을 이어 붙인 글자는 한 번에 하든 차례로 하든 NFC 결과가 같다.
  let pend: string[] = [];
  const settle = (): void => {
    if (pend.length === 0) return;
    const prev = pieces[pieces.length - 1] as { t: string };
    prev.t = normalizeText(prev.t + pend.join(''));
    pend = [];
  };
  for (const c of paraKids(p)) {
    const n = localName(c.name);
    if (n === 'br') {
      settle();
      pieces.push({ br: c });
      continue;
    }
    const isMath = MATH_TAGS.has(n);
    if (!isMath && n !== 'r' && n !== 'fld') continue;
    const src = isMath ? readMath(c) : { t: textOf(kid(c, 't')), rPr: kid(c, 'rPr') };
    const t = normalizeText(stripControls(src.t));
    if (t.length === 0) continue;
    const prev = pieces[pieces.length - 1];
    // 줄바꿈 뒤라면 붙이지 않는다: '\n' 은 무엇과도 합쳐지지 않는다
    if (prev !== undefined && 't' in prev && COMBINING_START.test(t)) {
      pend.push(t);
      continue;
    }
    settle();
    pieces.push({ t, rPr: src.rPr, math: isMath });
  }
  settle();
  const hasText = pieces.length > 0;
  if (!hasText && !keepEmpty) return null;
  if (!ctx.nodes.take()) return null;
  const pPr = kid(p, 'pPr');
  const lvl = Math.max(0, Math.min(8, int(at(pPr, 'lvl'))));
  const pch = pChain(ctx, pPr, lvl);
  const runs: SlideRun[] = [];
  for (const pc of pieces) {
    if (!ctx.nodes.take()) break;
    if ('br' in pc) {
      runs.push({ t: '\n', o: 0, sz: runStyle(kid(pc.br, 'rPr'), pch, ctx, '').sz });
      continue;
    }
    const st = runStyle(pc.rPr, pch, ctx, pc.t);
    if (pc.math) st.i = true;
    runs.push({ t: pc.t, o: 0, ...st });
  }
  if (hasText && runs.length === 0) return null; // 예산이 이 문단 첫 run 에서 끊겼다
  if (!hasText) {
    // 빈 문단: 줄 높이를 알리는 빈 run 하나(t '')만 둔다. 정본 글자에는 들어가지 않는다
    if (!ctx.nodes.take()) return null;
    runs.push({ t: '', o: 0, sz: runStyle(kid(p, 'endParaRPr'), pch, ctx, '').sz });
  }
  const para: SlidePara = { runs };
  const align = ALIGN.get(firstAttr(pch, 'algn') ?? '');
  if (align) para.align = align;
  if (lvl > 0) para.lvl = lvl;
  return { para, lvl, bullet: bulletOf(pch), hasText };
}

/**
 * txBody → 문단들. 자동 번호는 같은 수준의 연속 번호 문단끼리 센다(빈 문단은 번호 없음, 세지 않음).
 * 연속 빈 문단은 maxEmptyInRow 개까지만 싣고(글자가 없어 정본과 무관), 구성 요소 예산이 끊기면 거기서 멈춘다.
 */
function readTextBody(txBody: XElement | undefined, ctx: TextCtx): SlidePara[] {
  const out: SlidePara[] = [];
  const counters = new Map<number, { scheme: string; n: number }>();
  let emptyInRow = 0;
  for (const p of txBody?.children ?? []) {
    if (p.type !== 'el' || localName(p.name) !== 'p') continue;
    const r = readPara(p, ctx, emptyInRow < ctx.maxEmptyInRow);
    if (!r) {
      if (ctx.nodes.cut) break;
      continue; // 접은 빈 문단
    }
    if (!r.hasText) emptyInRow += 1;
    else {
      emptyInRow = 0;
      if (r.bullet.kind === 'auto') {
        const prev = counters.get(r.lvl);
        const n = prev && prev.scheme === r.bullet.scheme ? prev.n + 1 : r.bullet.startAt;
        counters.set(r.lvl, { scheme: r.bullet.scheme, n });
        r.para.bullet = autoNumText(r.bullet.scheme, n);
      } else {
        counters.delete(r.lvl);
        if (r.bullet.kind === 'char' && r.bullet.ch !== '') r.para.bullet = r.bullet.ch;
      }
      for (const k of [...counters.keys()]) if (k > r.lvl) counters.delete(k);
    }
    out.push(r.para);
    if (ctx.nodes.cut) break; // 이 문단 안에서 예산이 끊겼다
  }
  return out;
}

function parasHaveText(paras: SlidePara[]): boolean {
  return paras.some((p) => p.runs.some((r) => r.t.length > 0));
}

// ─────────────────────────────── 정본 글자 조립 ───────────────────────────────

/** 조립 단위: run 배열(그대로 이어 붙임) 또는 구분자로 잇는 하위 묶음 (글자 없는 묶음은 건너뛴다) */
type Seg = SlideRun[] | { sep: string; parts: Seg[] };

function segHasText(s: Seg): boolean {
  return Array.isArray(s) ? s.some((r) => r.t.length > 0) : s.parts.some(segHasText);
}

/** 쪽 글자를 모으며 run 의 o 를 매기는 곳. 글자 예산(PptxLimits.text)은 슬라이드를 넘어 이어진다 */
class TextSink {
  private chunks: string[] = [];
  len = 0;
  /** 예산 때문에 글자를 버렸는가 */
  cut = false;

  constructor(private budget: number) {}

  /** run 글자를 붙이고 실제로 붙인 글자를 돌려준다 (예산이 모자라면 앞부분만, 없으면 '') */
  take(t: string): string {
    if (t.length === 0) return t;
    if (this.budget <= 0) {
      this.cut = true;
      return '';
    }
    let s = t;
    if (s.length > this.budget) {
      let n = this.budget;
      const code = s.charCodeAt(n - 1);
      if (code >= 0xd800 && code <= 0xdbff) n -= 1; // 서로게이트 쌍을 가르지 않는다
      s = s.slice(0, n);
      this.budget = 0;
      this.cut = true;
    } else {
      this.budget -= s.length;
    }
    this.chunks.push(s);
    this.len += s.length;
    return s;
  }

  /** 구분자: 뒤에 글자가 한 자라도 들어갈 예산이 있을 때만 붙인다 */
  sep(s: string): void {
    if (this.budget > s.length) {
      this.chunks.push(s);
      this.len += s.length;
      this.budget -= s.length;
    } else {
      this.budget = 0;
    }
  }

  /** 한 쪽을 마치고 글자를 돌려준다 (예산은 다음 쪽으로 이어진다) */
  finishPage(): string {
    const text = this.chunks.join('');
    this.chunks = [];
    this.len = 0;
    return text;
  }

  get exhausted(): boolean {
    return this.budget <= 0;
  }
}

/**
 * 모델 구성 요소 예산 (모든 슬라이드에 걸쳐 이어진다). 글자 없는 요소(빈 문단, 빈 칸)도 하나씩 써서 렌더 JSON 과
 * 메모리를 묶는다. 모자라면 cut 을 세우고, 만드는 쪽은 그 자리에서 멈춘다(정본은 모델에서 뽑으므로 같은 자리에서 끝난다).
 */
class NodeBudget {
  /** 예산 때문에 요소를 버렸는가 */
  cut = false;

  constructor(private left: number) {}

  /** n 개를 쓸 수 있으면 쓰고 true, 아니면 cut 을 세우고 false */
  take(n = 1): boolean {
    if (this.left < n) {
      this.left = 0;
      this.cut = true;
      return false;
    }
    this.left -= n;
    return true;
  }

  /** 미리 썼지만 모델에 넣지 않은 몫을 돌려준다 */
  give(n = 1): void {
    this.left += n;
  }

  get exhausted(): boolean {
    return this.left <= 0;
  }
}

function emitSeg(s: Seg, sink: TextSink): void {
  if (Array.isArray(s)) {
    for (const r of s) {
      r.o = sink.len;
      r.t = sink.take(r.t);
    }
    return;
  }
  let wrote = false;
  for (const part of s.parts) {
    const has = segHasText(part);
    if (has && wrote) sink.sep(s.sep);
    emitSeg(part, sink);
    if (has) wrote = true;
  }
}

function shapeSeg(sh: SlideShape): Seg {
  if (sh.type === 'text') return { sep: '\n', parts: sh.paras.map((p) => p.runs) };
  if (sh.type === 'table') {
    return {
      sep: '\n',
      parts: sh.rows.map((row) => ({
        sep: '\t',
        parts: row.cells.map((c) => ({ sep: '\n', parts: c.paras.map((p) => p.runs) })),
      })),
    };
  }
  return [];
}

// ─────────────────────────────── 좌표 ───────────────────────────────

/** 그룹 안 자식 좌표 → 슬라이드 좌표: X = x * sx + tx */
interface Xf {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

const IDENTITY: Xf = { sx: 1, sy: 1, tx: 0, ty: 0 };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

/** a:xfrm(off, ext, rot) → 슬라이드 좌표 상자. off/ext 가 없으면 null */
function boxOf(xfrm: XElement | undefined, xf: Xf): Box | null {
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  if (!off || !ext) return null;
  const box: Box = {
    x: Math.round(int(attr(off, 'x')) * xf.sx + xf.tx),
    y: Math.round(int(attr(off, 'y')) * xf.sy + xf.ty),
    w: Math.round(int(attr(ext, 'cx')) * xf.sx),
    h: Math.round(int(attr(ext, 'cy')) * xf.sy),
  };
  const rot = int(at(xfrm, 'rot')) / 60000;
  if (rot) box.rot = Math.round(rot * 100) / 100;
  return box;
}

/** 그룹 a:xfrm(off, ext, chOff, chExt)을 부모 변환에 합성 (회전, 뒤집기는 근사로 무시) */
function groupXf(parent: Xf, xfrm: XElement | undefined): Xf {
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  if (!off || !ext) return parent;
  const chOff = kid(xfrm, 'chOff');
  const chExt = kid(xfrm, 'chExt');
  const ccx = int(at(chExt, 'cx'));
  const ccy = int(at(chExt, 'cy'));
  const kx = ccx > 0 ? int(attr(ext, 'cx')) / ccx : 1;
  const ky = ccy > 0 ? int(attr(ext, 'cy')) / ccy : 1;
  const ox = int(attr(off, 'x')) - int(at(chOff, 'x')) * kx;
  const oy = int(attr(off, 'y')) - int(at(chOff, 'y')) * ky;
  return { sx: parent.sx * kx, sy: parent.sy * ky, tx: parent.sx * ox + parent.tx, ty: parent.sy * oy + parent.ty };
}

/** 도형의 xfrm: sp/pic 은 spPr 아래, graphicFrame 은 바로 아래(p:xfrm), 그룹은 grpSpPr 아래 */
function xfrmOf(el: XElement | undefined): XElement | undefined {
  return kid(kid(el, 'spPr'), 'xfrm') ?? kid(el, 'xfrm') ?? kid(kid(el, 'grpSpPr'), 'xfrm');
}

// ─────────────────────────────── 개체 틀(placeholder) ───────────────────────────────

interface PhInfo {
  /** 기본값 'obj' */
  type: string;
  /** 기본값 0 */
  idx: number;
  hasIdx: boolean;
}

interface PhShape extends PhInfo {
  el: XElement;
}

/** 레이아웃, 마스터에서 물려받을 개체 틀 도형 */
interface PhChain {
  /** 서식 선택용 유형 (슬라이드에 유형이 없으면 레이아웃 것) */
  type: string;
  layoutEl?: XElement;
  masterEl?: XElement;
}

/** nvSpPr, nvPicPr, nvGraphicFramePr … */
function nvOf(el: XElement): XElement | undefined {
  for (const c of el.children) if (c.type === 'el' && localName(c.name).startsWith('nv')) return c;
  return undefined;
}

function phOf(el: XElement): PhInfo | undefined {
  const ph = kid(kid(nvOf(el), 'nvPr'), 'ph');
  if (!ph) return undefined;
  const idxRaw = attr(ph, 'idx');
  return { type: attr(ph, 'type') ?? 'obj', idx: int(idxRaw), hasIdx: idxRaw !== undefined };
}

function isHidden(el: XElement): boolean {
  return truthy(at(kid(nvOf(el), 'cNvPr'), 'hidden'));
}

const typeKey = (t: string): string => (t === 'ctrTitle' ? 'title' : t);

/** 마스터에서 찾을 유형: 제목, 날짜/바닥글/번호는 그대로, 나머지는 본문 */
function masterType(t: string): string {
  if (t === 'title' || t === 'ctrTitle') return 'title';
  if (t === 'dt' || t === 'ftr' || t === 'sldNum' || t === 'hdr') return t;
  return 'body';
}

/** 마스터 txStyles 중 어느 것: 제목 → titleStyle, 날짜/바닥글/번호와 일반 도형 → otherStyle, 그 밖의 개체 틀 → bodyStyle */
function txStyleKind(phType: string | undefined): 'title' | 'body' | 'other' {
  if (phType === undefined) return 'other';
  const mt = masterType(phType);
  return mt === 'title' ? 'title' : mt === 'body' ? 'body' : 'other';
}

const SHAPE_TAGS = new Set(['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp']);

/**
 * 도형 트리의 자식 요소. mc:AlternateContent 는 도형을 가진 첫 Choice(수식 글상자처럼 글자가 남는 쪽),
 * 없으면 Fallback 으로 펼친다.
 */
function treeKids(el: XElement | undefined): XElement[] {
  const out: XElement[] = [];
  if (!el) return out;
  for (const c of el.children) {
    if (c.type !== 'el') continue;
    if (localName(c.name) === 'AlternateContent') {
      const choice = kids(c, 'Choice').find((ch) =>
        ch.children.some((x) => x.type === 'el' && SHAPE_TAGS.has(localName(x.name))),
      );
      const pick = choice ?? kid(c, 'Fallback');
      if (pick) for (const x of treeKids(pick)) out.push(x);
      continue;
    }
    out.push(c);
  }
  return out;
}

function collectPhs(tree: XElement | undefined, out: PhShape[] = []): PhShape[] {
  for (const el of treeKids(tree)) {
    if (localName(el.name) === 'grpSp') {
      collectPhs(el, out);
      continue;
    }
    const ph = phOf(el);
    if (ph) out.push({ ...ph, el });
  }
  return out;
}

/** 레이아웃 개체 틀: 같은 idx(유형도 같으면 우선) → 같은 유형(title, ctrTitle 은 같은 것으로) */
function findLayoutPh(phs: PhShape[], ph: PhInfo): PhShape | undefined {
  if (ph.hasIdx) {
    const byIdx =
      phs.find((p) => p.idx === ph.idx && typeKey(p.type) === typeKey(ph.type)) ?? phs.find((p) => p.idx === ph.idx);
    if (byIdx) return byIdx;
  }
  return phs.find((p) => typeKey(p.type) === typeKey(ph.type));
}

// ─────────────────────────────── 슬라이드 문맥 ───────────────────────────────

interface MasterInfo {
  part: string;
  rels: Map<string, Rel>;
  tree?: XElement;
  bg?: XElement;
  phs: PhShape[];
  clrMap: Map<string, string>;
  theme: Theme;
  titleStyle?: XElement;
  bodyStyle?: XElement;
  otherStyle?: XElement;
}

interface LayoutInfo {
  part: string;
  rels: Map<string, Rel>;
  tree?: XElement;
  bg?: XElement;
  phs: PhShape[];
  /** false 면 마스터 장식을 그리지 않는다 */
  showMasterSp: boolean;
  clrMapOvr?: XElement;
  master?: MasterInfo;
}

interface MediaTable {
  list: MediaRef[];
  /** ZIP 경로 → media 색인 (-1 = 미지원 형식 또는 없음) */
  byPath: Map<string, number>;
}

interface SlideCtx {
  pkg: Pkg;
  slideW: number;
  slideH: number;
  layout?: LayoutInfo;
  master?: MasterInfo;
  cc: ColorCtx;
  /** presentation.xml defaultTextStyle */
  presDefault?: XElement;
  media: MediaTable;
  lim: PptxLimits;
  /** 모델 구성 요소 예산 (모든 슬라이드 공통) */
  nodes: NodeBudget;
  /** 장식 판정용: 요소별 '보이는 글자가 있는가' 기억 (같은 요소를 다시 훑지 않게) */
  textMemo: WeakMap<XElement, boolean>;
}

function resolvePh(sc: SlideCtx, ph: PhInfo): PhChain {
  const lp = sc.layout ? findLayoutPh(sc.layout.phs, ph) : undefined;
  const type = ph.type !== 'obj' ? ph.type : (lp?.type ?? ph.type);
  const mt = masterType(type);
  const mp = sc.master?.phs.find((p) => masterType(p.type) === mt);
  return { type, layoutEl: lp?.el, masterEl: mp?.el };
}

/** 도형 상자: 자기 xfrm → (개체 틀이면) 레이아웃 → 마스터의 xfrm (레이아웃, 마스터 좌표는 슬라이드 좌표) */
function shapeBox(el: XElement, xf: Xf, chain: PhChain | undefined): Box | null {
  const own = boxOf(xfrmOf(el), xf);
  if (own || !chain) return own;
  return boxOf(xfrmOf(chain.layoutEl), IDENTITY) ?? boxOf(xfrmOf(chain.masterEl), IDENTITY);
}

// ─────────────────────────────── 그림(media) ───────────────────────────────

const SIG_LOCAL = 0x04034b50;

/** ZIP 엔트리 앞부분 n 바이트만 (deflate 는 앞 1KB 만 부분 해제) */
function entryHead(buf: Buffer, e: ZipDirEntry, n: number): Buffer | null {
  const lh = e.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== SIG_LOCAL) return null;
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const end = Math.min(buf.length, start + e.compressedSize);
  if (start >= end) return null;
  if (e.method === 0) return buf.subarray(start, Math.min(end, start + n));
  if (e.method !== 8) return null;
  try {
    const out = zlib.inflateRawSync(buf.subarray(start, Math.min(end, start + 1024)), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
    return out.subarray(0, n);
  } catch {
    return null;
  }
}

/** 관계 Id → media 색인 (경로로 중복 제거). 외부 연결, 없는 파일, 미지원 형식은 -1 */
function mediaIndex(sc: SlideCtx, rels: Map<string, Rel>, rid: string | undefined): number {
  if (!rid) return -1;
  const rel = rels.get(rid);
  if (!rel || rel.external) return -1;
  const e = sc.pkg.entry(rel.target);
  const key = e?.name ?? rel.target;
  const known = sc.media.byPath.get(key);
  if (known !== undefined) return known;
  let idx = -1;
  const head = e ? entryHead(sc.pkg.buf, e, 32) : null;
  const mime = head ? sniffImage(head) : null;
  if (e && mime) {
    idx = sc.media.list.length;
    sc.media.list.push({ path: e.name, mime });
  }
  sc.media.byPath.set(key, idx);
  return idx;
}

// ─────────────────────────────── 도형 ───────────────────────────────

interface WalkCtx {
  sc: SlideCtx;
  /** r:embed 를 풀 관계표 (도형이 들어 있는 부분: 슬라이드, 레이아웃, 마스터) */
  rels: Map<string, Rel>;
  /** 장식 모드: 마스터, 레이아웃의 개체 틀이 아닌 그림과 글자 없는 도형만 그린다 */
  decor: boolean;
  out: SlideShape[];
  /** 이 갈래(슬라이드 자신, 또는 마스터나 레이아웃 장식 하나)에 싣는 도형 상한 */
  max: number;
  /** 장식만: 더 훑을 수 있는 요소 수 (색 대응표 변형마다 같은 트리를 다시 훑는 비용 상한) */
  visits: number;
  capped: boolean;
}

/** p:style 의 fontRef(색, 테마 글꼴)를 모든 수준 공통 pPr/defRPr 로 합성 */
function fontRefPPr(fr: XElement | undefined): XElement | undefined {
  if (!fr) return undefined;
  const children: XElement[] = [];
  const clr = fr.children.find((c): c is XElement => c.type === 'el' && COLOR_TAGS.has(localName(c.name)));
  if (clr) children.push(makeEl('a:solidFill', '', [clr]));
  const idx = attr(fr, 'idx');
  if (idx === 'major' || idx === 'minor') {
    const k = idx === 'major' ? 'mj' : 'mn';
    children.push(makeEl('a:latin', ` typeface="+${k}-lt"`), makeEl('a:ea', ` typeface="+${k}-ea"`));
  }
  return children.length > 0 ? makeEl('a:pPr', '', [makeEl('a:defRPr', '', children)]) : undefined;
}

/** 글자 서식 출처: 도형 lstStyle → fontRef → 레이아웃 개체 틀 → 마스터 개체 틀 → 마스터 txStyles → 기본 글자 스타일 */
function shapeTextCtx(sc: SlideCtx, sp: XElement, chain: PhChain | undefined, fontScale: number): TextCtx {
  const srcs: StyleSrc[] = [];
  const own = kidPath(sp, 'txBody', 'lstStyle');
  if (own) srcs.push({ lst: own });
  const fr = fontRefPPr(kidPath(sp, 'style', 'fontRef'));
  if (fr) srcs.push({ fixed: fr });
  for (const inh of [chain?.layoutEl, chain?.masterEl]) {
    const l = kidPath(inh, 'txBody', 'lstStyle');
    if (l) srcs.push({ lst: l });
  }
  const kind = txStyleKind(chain?.type);
  const txs = kind === 'title' ? sc.master?.titleStyle : kind === 'body' ? sc.master?.bodyStyle : sc.master?.otherStyle;
  if (txs) srcs.push({ lst: txs });
  if (sc.presDefault) srcs.push({ lst: sc.presDefault });
  return { srcs, fontScale, cc: sc.cc, nodes: sc.nodes, maxEmptyInRow: sc.lim.emptyParasInRow };
}

/**
 * 장식 도형 판정용: 보이는 글자(a:t)가 하나라도 있는가. 요소마다 한 번만 훑어 기억한다(장식은 색 대응표 변형마다
 * 다시 만들 수 있다). 깊게 중첩돼도 재귀하지 않는다
 */
function hasVisibleText(el: XElement | undefined, memo: WeakMap<XElement, boolean>): boolean {
  if (!el) return false;
  const known = memo.get(el);
  if (known !== undefined) return known;
  let found = false;
  const stack: XElement[] = [el];
  for (let e = stack.pop(); e !== undefined && !found; e = stack.pop()) {
    for (const c of e.children) {
      if (c.type !== 'el') continue;
      if (localName(c.name) !== 't') stack.push(c);
      else if (textOf(c).trim() !== '') {
        found = true;
        break;
      }
    }
  }
  memo.set(el, found);
  return found;
}

/** 채우기/선 색: 도형 spPr → (개체 틀이면) 레이아웃 → 마스터 spPr → 도형 스타일 참조(idx > 0) */
function shapePaint(
  spPrs: (XElement | undefined)[],
  style: XElement | undefined,
  cc: ColorCtx,
  which: 'fill' | 'line',
): string | undefined {
  for (const spPr of spPrs) {
    const f = fillOf(which === 'fill' ? spPr : kid(spPr, 'ln'), cc);
    if (f.decided) return f.color;
  }
  const ref = kid(style, which === 'fill' ? 'fillRef' : 'lnRef');
  return ref && int(attr(ref, 'idx')) > 0 ? colorIn(ref, cc) : undefined;
}

function textShape(wc: WalkCtx, sp: XElement, xf: Xf): SlideTextShape | null {
  const sc = wc.sc;
  const txBody = kid(sp, 'txBody');
  if (wc.decor && hasVisibleText(txBody, sc.textMemo)) return null;
  const ph = wc.decor ? undefined : phOf(sp);
  const chain = ph ? resolvePh(sc, ph) : undefined;
  const bodyPrs = [
    kid(txBody, 'bodyPr'),
    kidPath(chain?.layoutEl, 'txBody', 'bodyPr'),
    kidPath(chain?.masterEl, 'txBody', 'bodyPr'),
  ];
  const fontScale = pct(at(kid(bodyPrs[0], 'normAutofit'), 'fontScale')) ?? 1;
  const paras = wc.decor ? [] : readTextBody(txBody, shapeTextCtx(sc, sp, chain, fontScale > 0 ? fontScale : 1));
  let box = shapeBox(sp, xf, chain);
  if (!box) {
    // 위치를 알 수 없는 글상자: 글자를 잃지 않게 슬라이드 전체에 둔다
    if (!parasHaveText(paras)) return null;
    box = { x: 0, y: 0, w: sc.slideW, h: sc.slideH };
  }
  const shape: SlideTextShape = { type: 'text', ...box, paras };
  const spPrs = [kid(sp, 'spPr'), kid(chain?.layoutEl, 'spPr'), kid(chain?.masterEl, 'spPr')];
  const style = kid(sp, 'style');
  const fill = shapePaint(spPrs, style, sc.cc, 'fill');
  if (fill) shape.fill = fill;
  const line = shapePaint(spPrs, style, sc.cc, 'line');
  if (line) shape.line = line;
  if (wc.decor && !fill && !line) return null; // 보이지 않는 장식은 싣지 않는다
  if (paras.length > 0) {
    const body = (name: string): string | undefined => firstAttr(bodyPrs.filter((b): b is XElement => !!b), name);
    const anchor = body('anchor');
    shape.anchor = anchor === 'ctr' ? 'ctr' : anchor === 'b' ? 'b' : 't';
    shape.inset = [
      int(body('lIns'), DEFAULT_INSET[0]),
      int(body('tIns'), DEFAULT_INSET[1]),
      int(body('rIns'), DEFAULT_INSET[2]),
      int(body('bIns'), DEFAULT_INSET[3]),
    ];
  }
  return shape;
}

function picShape(wc: WalkCtx, pic: XElement, xf: Xf): SlideShape | null {
  const ph = wc.decor ? undefined : phOf(pic);
  const box = shapeBox(pic, xf, ph ? resolvePh(wc.sc, ph) : undefined);
  if (!box) return null;
  const idx = mediaIndex(wc.sc, wc.rels, nsAttr(kidPath(pic, 'blipFill', 'blip'), 'embed'));
  if (idx >= 0) {
    const shape: SlidePicShape = { type: 'pic', ...box, media: idx };
    // 잘라 낸 그림: 틀은 잘라 낸 뒤 크기다. 잘라 낸 값이 없으면 원본 전체가 틀에 눌려 들어간다(./crop.ts)
    const crop = cropFromSrcRect(kidPath(pic, 'blipFill', 'srcRect'));
    if (crop) shape.crop = crop;
    return shape;
  }
  // 마스터 장식의 미지원 그림은 모든 슬라이드에 자리 표시가 생기므로 뺀다
  return wc.decor ? null : { type: 'other', ...box, label: UNSUPPORTED_PIC_LABEL };
}

function tableCell(sc: SlideCtx, tc: XElement): SlideTableCell {
  if (truthy(attr(tc, 'hMerge')) || truthy(attr(tc, 'vMerge'))) return { paras: [], hidden: true };
  const txBody = kid(tc, 'txBody');
  const srcs: StyleSrc[] = [];
  const own = kid(txBody, 'lstStyle');
  if (own) srcs.push({ lst: own });
  if (sc.master?.otherStyle) srcs.push({ lst: sc.master.otherStyle });
  if (sc.presDefault) srcs.push({ lst: sc.presDefault });
  const ctx: TextCtx = { srcs, fontScale: 1, cc: sc.cc, nodes: sc.nodes, maxEmptyInRow: sc.lim.emptyParasInRow };
  const cell: SlideTableCell = { paras: readTextBody(txBody, ctx) };
  const gs = int(attr(tc, 'gridSpan'), 1);
  if (gs > 1) cell.gridSpan = gs;
  const rs = int(attr(tc, 'rowSpan'), 1);
  if (rs > 1) cell.rowSpan = rs;
  const fill = fillOf(kid(tc, 'tcPr'), sc.cc).color;
  if (fill) cell.fill = fill;
  return cell;
}

/** 표: 열, 행, 칸 하나하나가 구성 요소 예산을 쓴다 (빈 칸도. 예산이 끊기면 거기까지의 표) */
function tableShape(sc: SlideCtx, tbl: XElement, box: Box): SlideTableShape {
  const cols: number[] = [];
  for (const g of kids(kid(tbl, 'tblGrid'), 'gridCol')) {
    if (!sc.nodes.take()) break;
    cols.push(int(attr(g, 'w')));
  }
  const rows: SlideTableShape['rows'] = [];
  for (const tr of kids(tbl, 'tr')) {
    if (sc.nodes.cut || !sc.nodes.take()) break;
    const cells: SlideTableCell[] = [];
    rows.push({ h: int(attr(tr, 'h')), cells });
    for (const tc of kids(tr, 'tc')) {
      if (sc.nodes.cut || !sc.nodes.take()) break;
      cells.push(tableCell(sc, tc));
    }
  }
  return { type: 'table', ...box, cols, rows };
}

function frameShape(wc: WalkCtx, gf: XElement, xf: Xf): SlideShape | null {
  if (wc.decor) return null; // 마스터, 레이아웃의 표, 차트는 그리지 않는다
  const ph = phOf(gf);
  const box = shapeBox(gf, xf, ph ? resolvePh(wc.sc, ph) : undefined);
  if (!box) return null;
  const gd = kidPath(gf, 'graphic', 'graphicData');
  const tbl = kid(gd, 'tbl');
  if (tbl) return tableShape(wc.sc, tbl, box);
  const uri = at(gd, 'uri') ?? '';
  let label = '개체';
  if (kid(gd, 'chart') || /chart/i.test(uri)) label = '차트';
  else if (kid(gd, 'relIds') || /diagram/i.test(uri)) label = 'SmartArt';
  return { type: 'other', ...box, label };
}

/**
 * 도형 트리를 문서 순서로 훑어 wc.out 에 모은다 (그룹은 변환을 합성해 펼친다, 연결선은 건너뛴다).
 * 슬라이드 자신의 도형은 하나마다 구성 요소 예산을 쓴다. 장식은 예산 대신 wc.max, wc.visits 로 따로 센다.
 */
function walk(container: XElement | undefined, xf: Xf, wc: WalkCtx): void {
  const nodes = wc.sc.nodes;
  for (const el of treeKids(container)) {
    if (wc.capped || (!wc.decor && nodes.cut)) return;
    if (wc.decor) {
      wc.visits -= 1;
      if (wc.visits < 0) {
        wc.capped = true;
        return;
      }
    }
    const n = localName(el.name);
    if (n !== 'sp' && n !== 'pic' && n !== 'graphicFrame' && n !== 'grpSp') continue;
    if (isHidden(el)) continue;
    if (n === 'grpSp') {
      walk(el, groupXf(xf, kid(kid(el, 'grpSpPr'), 'xfrm')), wc);
      continue;
    }
    if (wc.decor && phOf(el)) continue;
    if (wc.out.length >= wc.max) {
      wc.capped = true;
      return;
    }
    if (!wc.decor && !nodes.take()) return;
    const shape = n === 'sp' ? textShape(wc, el, xf) : n === 'pic' ? picShape(wc, el, xf) : frameShape(wc, el, xf);
    if (shape) wc.out.push(shape);
    else if (!wc.decor) nodes.give();
  }
}

// ─────────────────────────────── 레이아웃, 마스터, 배경 ───────────────────────────────

function loadMaster(pkg: Pkg, part: string, cache: Map<string, MasterInfo | null>): MasterInfo | undefined {
  if (cache.has(part)) return cache.get(part) ?? undefined;
  const root = pkg.xml(part, true);
  let info: MasterInfo | null = null;
  if (root) {
    const rels = pkg.rels(part);
    const themePart = relTarget(rels, 'theme');
    const cSld = kid(root, 'cSld');
    const tree = kid(cSld, 'spTree');
    const txStyles = kid(root, 'txStyles');
    info = {
      part,
      rels,
      tree,
      bg: kid(cSld, 'bg'),
      phs: collectPhs(tree),
      clrMap: readClrMap(kid(root, 'clrMap')),
      theme: themePart ? readTheme(pkg.xml(themePart, true)) : EMPTY_THEME,
      titleStyle: kid(txStyles, 'titleStyle'),
      bodyStyle: kid(txStyles, 'bodyStyle'),
      otherStyle: kid(txStyles, 'otherStyle'),
    };
  }
  cache.set(part, info);
  return info ?? undefined;
}

function loadLayout(
  pkg: Pkg,
  part: string,
  cache: Map<string, LayoutInfo | null>,
  masters: Map<string, MasterInfo | null>,
): LayoutInfo | undefined {
  if (cache.has(part)) return cache.get(part) ?? undefined;
  const root = pkg.xml(part, true);
  let info: LayoutInfo | null = null;
  if (root) {
    const rels = pkg.rels(part);
    const masterPart = relTarget(rels, 'slideMaster');
    const cSld = kid(root, 'cSld');
    const tree = kid(cSld, 'spTree');
    const show = attr(root, 'showMasterSp');
    info = {
      part,
      rels,
      tree,
      bg: kid(cSld, 'bg'),
      phs: collectPhs(tree),
      showMasterSp: show !== '0' && show !== 'false',
      clrMapOvr: kidPath(root, 'clrMapOvr', 'overrideClrMapping'),
      master: masterPart ? loadMaster(pkg, masterPart, masters) : undefined,
    };
  }
  cache.set(part, info);
  return info ?? undefined;
}

/** p:bg 하나 → 배경 (단색 = color, 그림 = media). 이 수준에 배경이 없으면 null */
function readBg(bg: XElement | undefined, rels: Map<string, Rel>, sc: SlideCtx): { color?: string; media?: number } | null {
  if (!bg) return null;
  const bgPr = kid(bg, 'bgPr');
  if (bgPr) {
    const blip = kidPath(bgPr, 'blipFill', 'blip');
    if (blip) {
      const m = mediaIndex(sc, rels, nsAttr(blip, 'embed'));
      return m >= 0 ? { media: m } : {};
    }
    const color = fillOf(bgPr, sc.cc).color;
    return color ? { color } : {};
  }
  // bgRef: 테마 배경 스타일 참조. 딸린 색으로 근사
  const color = colorIn(kid(bg, 'bgRef'), sc.cc);
  return color ? { color } : {};
}

// ─────────────────────────────── 슬라이드 ───────────────────────────────

/** 마스터나 레이아웃 하나의 장식 도형 묶음 */
interface DecorSet {
  shapes: SlideShape[];
  /** 장식 상한(도형 수, 훑은 요소 수)에 걸렸는가 */
  capped: boolean;
}

interface DeckCtx {
  pkg: Pkg;
  slideW: number;
  slideH: number;
  presDefault?: XElement;
  media: MediaTable;
  layouts: Map<string, LayoutInfo | null>;
  masters: Map<string, MasterInfo | null>;
  lim: PptxLimits;
  nodes: NodeBudget;
  /** 장식 캐시: 부분(마스터, 레이아웃) 경로 → 색 대응표 열쇠 → 장식 */
  decor: Map<string, Map<string, DecorSet>>;
  /** 더 그릴 수 있는 장식 도형 수 (모든 슬라이드 합) */
  decorLeft: number;
  textMemo: WeakMap<XElement, boolean>;
}

interface BuiltSlide {
  shapes: SlideShape[];
  bg?: string;
  hidden: boolean;
  /** 슬라이드 자신의 도형 상한에 걸렸는가 */
  capped: boolean;
  /** 장식을 다 그리지 못했는가 */
  decorCapped: boolean;
}

function clrKey(m: Map<string, string>): string {
  let s = '';
  for (const [k, v] of m) s += `${k}=${v};`;
  return s;
}

/**
 * 마스터나 레이아웃 하나의 장식(글자 없는 도형, 그림). 부분과 색 대응표마다 한 번만 만들어 슬라이드끼리 같이 쓴다
 * (장식에는 글자 run 이 없어 오프셋을 매기며 고칠 것이 없다). 한 부분의 색 대응표 변형이 MAX_DECOR_VARIANTS 개에
 * 이르면 처음 만든 장식을 쓴다(색 근사: 슬라이드마다 같은 트리를 다시 훑지 않게).
 */
function decorOf(deck: DeckCtx, sc: SlideCtx, part: string, tree: XElement | undefined, rels: Map<string, Rel>): DecorSet {
  let byClr = deck.decor.get(part);
  if (!byClr) {
    byClr = new Map();
    deck.decor.set(part, byClr);
  }
  const key = clrKey(sc.cc.clrMap);
  const hit = byClr.get(key);
  if (hit) return hit;
  const first = byClr.values().next();
  if (byClr.size >= MAX_DECOR_VARIANTS && !first.done) return first.value;
  const wc: WalkCtx = {
    sc,
    rels,
    decor: true,
    out: [],
    max: sc.lim.decorPerSlide,
    visits: MAX_DECOR_VISIT,
    capped: false,
  };
  walk(tree, IDENTITY, wc);
  const set: DecorSet = { shapes: wc.out, capped: wc.capped };
  byClr.set(key, set);
  return set;
}

/** 슬라이드 하나 → 도형 목록 (배경 그림, 마스터 장식, 레이아웃 장식, 슬라이드 도형 순 = 그리는 순서) */
function buildSlide(deck: DeckCtx, part: string, root: XElement): BuiltSlide {
  const { pkg, slideW, slideH, lim } = deck;
  const rels = pkg.rels(part);
  const layoutPart = relTarget(rels, 'slideLayout');
  const layout = layoutPart ? loadLayout(pkg, layoutPart, deck.layouts, deck.masters) : undefined;
  const master = layout?.master;
  // 색 대응표: 마스터 clrMap ← 레이아웃 덮어쓰기 ← 슬라이드 덮어쓰기
  let clrMap = master?.clrMap ?? readClrMap(undefined);
  if (layout?.clrMapOvr) clrMap = readClrMap(layout.clrMapOvr, clrMap);
  const ovr = kidPath(root, 'clrMapOvr', 'overrideClrMapping');
  if (ovr) clrMap = readClrMap(ovr, clrMap);
  const sc: SlideCtx = {
    pkg,
    slideW,
    slideH,
    layout,
    master,
    cc: { theme: master?.theme ?? EMPTY_THEME, clrMap },
    presDefault: deck.presDefault,
    media: deck.media,
    lim,
    nodes: deck.nodes,
    textMemo: deck.textMemo,
  };
  const cSld = kid(root, 'cSld');
  const out: SlideShape[] = [];

  const bg =
    readBg(kid(cSld, 'bg'), rels, sc) ??
    (layout ? readBg(layout.bg, layout.rels, sc) : null) ??
    (master ? readBg(master.bg, master.rels, sc) : null) ??
    {};
  if (bg.media !== undefined) out.push({ type: 'pic', x: 0, y: 0, w: slideW, h: slideH, media: bg.media });

  // 마스터, 레이아웃 장식: 슬라이드 하나 상한과 모든 슬라이드 합 상한 안에서 앞에서부터 그린다
  let decorCapped = false;
  const showMaster = attr(root, 'showMasterSp');
  if (layout && showMaster !== '0' && showMaster !== 'false') {
    const sets: DecorSet[] = [];
    if (master && layout.showMasterSp) sets.push(decorOf(deck, sc, master.part, master.tree, master.rels));
    sets.push(decorOf(deck, sc, layout.part, layout.tree, layout.rels));
    let room = Math.min(lim.decorPerSlide, deck.decorLeft);
    for (const set of sets) {
      if (set.capped) decorCapped = true;
      for (const sh of set.shapes) {
        if (room <= 0) {
          decorCapped = true;
          break;
        }
        out.push(sh);
        room -= 1;
        deck.decorLeft -= 1;
      }
    }
  }

  // 슬라이드 자신의 도형: 장식과 따로 센다 (장식 때문에 슬라이드 글자를 잃지 않게)
  const own: WalkCtx = { sc, rels, decor: false, out: [], max: lim.shapesPerSlide, visits: 0, capped: false };
  walk(kid(cSld, 'spTree'), IDENTITY, own);
  for (const sh of own.out) out.push(sh);

  const show = attr(root, 'show');
  const built: BuiltSlide = { shapes: out, hidden: show === '0' || show === 'false', capped: own.capped, decorCapped };
  if (bg.color) built.bg = bg.color;
  return built;
}

/** 발표 순서의 슬라이드 부분 경로 (목록이 없는 비정형 파일은 slideN.xml 번호 순) */
function slideOrder(pkg: Pkg, pres: XElement, presRels: Map<string, Rel>, dir: ZipDirEntry[]): (string | undefined)[] {
  const listed = kids(kid(pres, 'sldIdLst'), 'sldId').map((s) => {
    const rel = presRels.get(nsAttr(s, 'id') ?? '');
    return rel && !rel.external ? rel.target : undefined;
  });
  if (listed.length > 0) return listed;
  const num = (n: string): number => int(/slide(\d+)\.xml$/i.exec(n)?.[1]);
  return dir
    .map((e) => e.name)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n) && pkg.entry(n) !== undefined)
    .sort((a, b) => num(a) - num(b));
}

/**
 * pptx 바이트 → 쪽(슬라이드)별 정본 글자 + SlidesModel JSON.
 * 파일 자체를 읽지 못하면 OfficeParseError(사용자용 한국어 문구). 슬라이드 하나가 깨진 경우는 그 쪽만
 * 자리 표시로 두고 truncated 에 알린다. limits 는 테스트가 상한을 줄여 쓸 때만 넘긴다(기본 PPTX_LIMITS).
 */
export function processPptx(buf: Buffer, _fileName: string, limits: Partial<PptxLimits> = {}): OfficeExtractResult {
  const lim: PptxLimits = { ...PPTX_LIMITS, ...limits };
  const dir = readZipDirectory(buf);
  if (!dir || dir.length === 0) {
    throw new OfficeParseError('PowerPoint 파일을 열지 못했습니다(압축 구조 손상). 원본 파일을 확인해 주세요.');
  }
  const pkg = new Pkg(buf, dir, lim.tagsPerPart);
  const presPart = relTarget(pkg.rels(''), 'officeDocument') ?? 'ppt/presentation.xml';
  const pres = pkg.xml(presPart) ?? (presPart !== 'ppt/presentation.xml' ? pkg.xml('ppt/presentation.xml') : null);
  if (!pres || localName(pres.name) !== 'presentation') {
    throw new OfficeParseError('PowerPoint 슬라이드 목록(presentation.xml)을 읽지 못했습니다. 파일이 손상되었을 수 있습니다.');
  }
  const presRels = pkg.rels(presPart);
  const sldSz = kid(pres, 'sldSz');
  const cx = int(at(sldSz, 'cx'), DEFAULT_SLIDE_W);
  const cy = int(at(sldSz, 'cy'), DEFAULT_SLIDE_H);
  const deck: DeckCtx = {
    pkg,
    slideW: cx > 0 ? cx : DEFAULT_SLIDE_W,
    slideH: cy > 0 ? cy : DEFAULT_SLIDE_H,
    presDefault: kid(pres, 'defaultTextStyle'),
    media: { list: [], byPath: new Map() },
    layouts: new Map(),
    masters: new Map(),
    lim,
    nodes: new NodeBudget(lim.nodes),
    decor: new Map(),
    decorLeft: lim.decorTotal,
    textMemo: new WeakMap(),
  };

  const order = slideOrder(pkg, pres, presRels, dir);
  if (order.length === 0) throw new OfficeParseError('슬라이드가 하나도 없는 PowerPoint 파일입니다.');

  const sink = new TextSink(lim.text);
  const pages: OfficeExtractResult['pages'] = [];
  const modelPages: SlidePage[] = [];
  const unreadable: number[] = [];
  const dups: number[] = [];
  /** 슬라이드 부분(ZIP 엔트리 이름) → 처음 나온 슬라이드 번호 */
  const firstNo = new Map<string, number>();
  let shapeCapped = false;
  let decorCapped = false;
  /** 예산 때문에 멈춘 이유와 마지막으로 넣은 슬라이드 번호 */
  let stop: { why: 'text' | 'nodes' | 'bytes'; at: number } | null = null;
  const placeholder = (label: string): BuiltSlide => ({
    shapes: [{ type: 'other', x: 0, y: 0, w: deck.slideW, h: deck.slideH, label }],
    hidden: false,
    capped: false,
    decorCapped: false,
  });
  const limit = Math.min(order.length, lim.slides);
  for (let i = 0; i < limit; i += 1) {
    const no = i + 1;
    // 앞 슬라이드에서 예산을 다 썼다: 여기부터는 색인도 표시도 하지 않는다
    if (i > 0 && sink.exhausted) {
      stop = { why: 'text', at: no - 1 };
      break;
    }
    if (i > 0 && deck.nodes.exhausted) {
      stop = { why: 'nodes', at: no - 1 };
      break;
    }
    const part = order[i];
    const entry = part ? pkg.entry(part) : undefined;
    const seenAt = entry ? firstNo.get(entry.name) : undefined;
    let built: BuiltSlide | null = null;
    if (seenAt !== undefined) {
      // 목록이 같은 슬라이드를 거듭 가리킨다: 다시 해석하지 않는다(모델과 시간이 목록 길이만큼 불어나지 않게)
      dups.push(no);
      built = placeholder(`앞의 슬라이드 ${seenAt}과(와) 같은 슬라이드`);
    } else {
      // 푼 XML 합 상한: 이 슬라이드를 풀면 넘는다면 그 앞에서 멈춘다(부분 상한을 넘는 것은 어차피 풀지 않는다)
      const next = Math.min(entry?.uncompressedSize ?? 0, PART_MAX_BYTES);
      if (i > 0 && pkg.bytesRead + next > lim.xmlTotalBytes) {
        stop = { why: 'bytes', at: no - 1 };
        break;
      }
      if (entry) firstNo.set(entry.name, no);
      const root = part ? pkg.xml(part) : null;
      if (part && root && localName(root.name) === 'sld') {
        try {
          built = buildSlide(deck, part, root);
        } catch {
          built = null;
        }
      }
      if (!built) {
        unreadable.push(no);
        built = placeholder('이 슬라이드를 읽지 못했습니다');
      }
    }
    if (built.capped) shapeCapped = true;
    if (built.decorCapped) decorCapped = true;
    emitSeg({ sep: '\n', parts: built.shapes.map(shapeSeg) }, sink);
    pages.push({ pageNo: no, text: sink.finishPage(), label: `슬라이드 ${no}` });
    const page: SlidePage = { pageNo: no, no, shapes: built.shapes };
    if (built.bg) page.bg = built.bg;
    if (built.hidden) page.hidden = true;
    modelPages.push(page);
    if (sink.cut) {
      stop = { why: 'text', at: no };
      break;
    }
    if (deck.nodes.cut) {
      stop = { why: 'nodes', at: no };
      break;
    }
  }

  const fmt = (n: number): string => n.toLocaleString('ko-KR');
  const list = (nos: number[]): string => nos.slice(0, 10).join(', ') + (nos.length > 10 ? ' 등' : '');
  const notes: string[] = [];
  if (order.length > lim.slides && stop === null) {
    notes.push(`슬라이드가 ${fmt(order.length)}장이라 앞 ${fmt(lim.slides)}장만 색인하고 보여줍니다.`);
  }
  if (stop?.why === 'text') {
    notes.push(`글자가 많아 앞부분 ${fmt(lim.text)}자(슬라이드 ${stop.at}까지)만 색인하고 보여줍니다.`);
  } else if (stop?.why === 'nodes') {
    notes.push(
      `도형, 문단, 표 칸 같은 구성 요소가 많아 앞 ${fmt(lim.nodes)}개(슬라이드 ${stop.at}까지)만 색인하고 보여줍니다.`,
    );
  } else if (stop?.why === 'bytes') {
    const mb = fmt(Math.round(lim.xmlTotalBytes / (1024 * 1024)));
    notes.push(`파일 내용(XML)이 ${mb}MB를 넘어 슬라이드 ${stop.at}까지만 색인하고 보여줍니다.`);
  }
  if (shapeCapped) {
    const cap = fmt(lim.shapesPerSlide);
    notes.push(`도형이 ${cap}개가 넘는 슬라이드는 앞 ${cap}개 도형만 색인하고 보여줍니다.`);
  }
  if (decorCapped) notes.push('마스터, 레이아웃의 장식 도형이 많아 일부만 그립니다(글자 색인과는 무관합니다).');
  if (dups.length > 0) {
    notes.push(`슬라이드 목록이 같은 슬라이드를 거듭 가리켜 슬라이드 ${list(dups)}은(는) 자리 표시로 둡니다.`);
  }
  if (unreadable.length > 0) notes.push(`슬라이드 ${list(unreadable)}을(를) 읽지 못해 빈 슬라이드로 표시합니다.`);
  const truncated = notes.length > 0 ? notes.join(' ') : null;

  const model: SlidesModel = {
    v: RENDER_MODEL_VERSION,
    kind: 'slides',
    media: deck.media.list,
    truncated,
    slideW: deck.slideW,
    slideH: deck.slideH,
    pages: modelPages,
  };
  let render: Buffer;
  try {
    render = Buffer.from(JSON.stringify(model), 'utf8');
  } catch (e) {
    // 상한 안에서는 생기지 않지만, 문자열 길이 한계(RangeError)에 닿으면 사용자용 오류로 바꾼다
    if (e instanceof RangeError) {
      throw new OfficeParseError('PowerPoint 미리보기 자료가 너무 커서 만들지 못했습니다. 파일을 나누어 올려 주세요.');
    }
    throw e;
  }
  return {
    fileKind: 'pptx',
    extractor: PPTX_EXTRACTOR,
    pages,
    render,
    renderMime: 'application/json',
    truncated,
  };
}
