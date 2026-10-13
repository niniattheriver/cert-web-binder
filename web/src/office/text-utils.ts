/**
 * 검사실 자료 렌더 모델(office/model.ts)을 그릴 때 쓰는 표시 전용 도우미
 *
 * 흐름(docx, hwpx), 시트, 슬라이드 뷰어가 함께 쓸 수 있게 DOM 과 React 에 기대지 않는 순수 함수만 둔다.
 * - 모델 값은 서버가 만들었지만 원본 문서에서 온 글자이므로 CSS 로 옮기기 전에 형식을 다시 본다
 *   (글꼴 이름의 따옴표와 제어 문자, 색 형식, 수치 범위). 화면은 React style 객체로만 쓰므로
 *   값 하나가 다른 CSS 선언으로 번지지는 않지만, 걸러 두면 서버 렌더나 인쇄 경로에서도 안전하다.
 * - 사설영역(PUA) 기호 글자 치환은 길이를 바꾸지 않는다(UTF-16 한 단위 → 한 단위). 화면 글자 위치와
 *   정본 page_text 오프셋의 1:1 대응을 지키기 위해서다. 저장 글자는 건드리지 않는다(표시 계층 전용,
 *   pdf/normalize.ts 머리 주석과 같은 원칙).
 */
import type { Border, ImageCrop } from './model';

/** 문서 글꼴 뒤에 붙이는 앱 공통 글꼴 스택 (앱 글꼴 규칙) */
export const FONT_FALLBACK = 'Arial, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

/** 1pt = 96/72 px (모델 길이 단위는 96dpi px) */
export const PX_PER_PT = 96 / 72;
/** 1px = 9525 EMU (914400 EMU = 1인치 = 96px) */
export const EMU_PER_PX = 9525;

export function ptToPx(pt: number): number {
  return pt * PX_PER_PT;
}

export function pxToPt(px: number): number {
  return px / PX_PER_PT;
}

export function emuToPx(emu: number): number {
  return emu / EMU_PER_PX;
}

/** 유한한 수이고 [min, max] 안이면 그 값, 아니면 undefined (모델의 선택 수치 읽기용) */
export function num(v: unknown, min = -1e6, max = 1e6): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

/** 소수 자리 정리 (CSS 값을 짧고 안정적으로) */
export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** '#rgb' 또는 '#rrggbb' 만 받아 소문자 '#rrggbb' 로. 그 밖의 값(이름, url(), 식)은 버린다 */
export function cssColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const [r, g, b] = [s[1]!, s[2]!, s[3]!];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return undefined;
}

/** CSS 글자열 안에서 뜻을 갖는 글자, 제어 문자, 줄 나눔 글자 */
const FONT_DROP_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029"'`\\;{}<>]/g;

/**
 * 문서 글꼴 이름 → CSS 따옴표 안에 그대로 넣어도 되는 이름. 비면 undefined.
 * 쉼표로 여러 이름이 붙어 오면(예: 'Arial,Bold') 첫 이름만 쓴다.
 */
export function sanitizeFont(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const first = name.split(',')[0] ?? '';
  const s = first.replace(FONT_DROP_RE, '').replace(/\s+/g, ' ').trim().slice(0, 64).trim();
  return s.length > 0 ? s : undefined;
}

/** 글꼴 스택: 문서 글꼴(걸러서 따옴표) → 앱 공통 스택 */
export function cssFontStack(font?: string | null): string {
  const f = sanitizeFont(font);
  return f ? `"${f}", ${FONT_FALLBACK}` : FONT_FALLBACK;
}

/** 기호 글꼴(글자 대신 그림 기호가 들어 있는 글꼴) */
const SYMBOL_FONT_RE = /^(symbol|wingdings( [23])?|webdings|marlett|zapf ?dingbats|ms outlook|bookshelf symbol 7|mt extra)$/i;

export function isSymbolFont(font?: string | null): boolean {
  return typeof font === 'string' && SYMBOL_FONT_RE.test(font.trim());
}

// ─────────────────── 사설영역(PUA) 기호 → 표준 글자 (길이 보존) ───────────────────
// 워드는 Symbol, Wingdings 글꼴 기호를 U+F020..U+F0FF(글꼴 코드 + 0xF000)로 저장한다. 같은 코드라도
// 글꼴마다 그림이 달라(F0A7: Symbol ♣, Wingdings ▪) 글꼴 이름으로 표를 고르고, 글꼴을 모르면 글머리
// 기호로 흔한 쪽(BULLET_PUA)만 바꾼다. 값은 모두 BMP 한 글자라 길이가 그대로다.

const symbolGreek = (): Record<number, string> => {
  const upper = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ';
  const lower = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';
  const out: Record<number, string> = {};
  for (let i = 0; i < 26; i += 1) {
    out[0xf041 + i] = upper[i]!;
    out[0xf061 + i] = lower[i]!;
  }
  return out;
};

/** Symbol 글꼴 (Adobe Symbol 배열) */
const SYMBOL_PUA: Record<number, string> = {
  ...symbolGreek(),
  0xf02d: '\u2212', // −
  0xf09f: '\u2022', // •
  0xf0a3: '\u2264', // ≤
  0xf0a7: '\u2663', // ♣
  0xf0a8: '\u2666', // ♦
  0xf0a9: '\u2665', // ♥
  0xf0aa: '\u2660', // ♠
  0xf0ae: '\u2192', // →
  0xf0b0: '\u00b0', // °
  0xf0b1: '\u00b1', // ±
  0xf0b3: '\u2265', // ≥
  0xf0b4: '\u00d7', // ×
  0xf0b7: '\u2022', // •
  0xf0b9: '\u2260', // ≠
  0xf0d7: '\u22c5', // ⋅
  0xf0d8: '\u00ac', // ¬
  0xf0de: '\u21d2', // ⇒
  0xf0e0: '\u25ca', // ◊
};

/** Wingdings 글꼴 (글머리 기호, 확인란으로 흔한 것만) */
const WINGDINGS_PUA: Record<number, string> = {
  0xf06c: '\u25cf', // ●
  0xf06e: '\u25a0', // ■
  0xf06f: '\u25a1', // □
  0xf071: '\u2751', // ❑
  0xf075: '\u25c6', // ◆
  0xf076: '\u2756', // ❖
  0xf09f: '\u2022', // •
  0xf0a1: '\u25cb', // ○
  0xf0a7: '\u25aa', // ▪
  0xf0a8: '\u25fb', // ◻
  0xf0d8: '\u27a2', // ➢
  0xf0e8: '\u2794', // ➔
  0xf0f0: '\u21e8', // ⇨
  0xf0fb: '\u2717', // ✗
  0xf0fc: '\u2714', // ✔
  0xf0fd: '\u2612', // ☒
  0xf0fe: '\u2611', // ☑
};

/** 글꼴을 모를 때: 글머리 기호로 흔한 뜻 (U+F0B7 은 Symbol, 나머지는 Wingdings 쪽) */
const BULLET_PUA: Record<number, string> = {
  0xf09f: '\u2022',
  0xf0b7: '\u2022',
  0xf06c: '\u25cf',
  0xf06e: '\u25a0',
  0xf06f: '\u25a1',
  0xf071: '\u2751',
  0xf075: '\u25c6',
  0xf076: '\u2756',
  0xf0a7: '\u25aa',
  0xf0a8: '\u25fb',
  0xf0d8: '\u27a2',
  0xf0fc: '\u2714',
  0xf0fe: '\u2611',
};

const PUA_RE = /[\uf020-\uf0ff]/;
const PUA_RE_G = /[\uf020-\uf0ff]/g;

function puaTable(font?: string | null): Record<number, string> | null {
  const f = typeof font === 'string' ? font.trim().toLowerCase() : '';
  if (f === 'symbol') return SYMBOL_PUA;
  if (f === 'wingdings') return WINGDINGS_PUA;
  if (f !== '' && isSymbolFont(f)) return null; // Wingdings 2, 3, Webdings 등: 표를 모르면 그대로
  return BULLET_PUA;
}

/**
 * 표시용 글자: 사설영역 기호를 같은 길이의 표준 글자로 바꾼다. 바뀐 글자가 없으면 원래 문자열을
 * 그대로 돌려준다(=== 로 치환 여부를 알 수 있다). 반환값 길이는 언제나 입력과 같다.
 */
export function mapPuaText(text: string, font?: string | null): string {
  if (!PUA_RE.test(text)) return text;
  const table = puaTable(font);
  if (!table) return text;
  const out = text.replace(PUA_RE_G, (ch) => {
    const rep = table[ch.charCodeAt(0)];
    return rep !== undefined && rep.length === 1 ? rep : ch;
  });
  return out === text ? text : out;
}

/** 글머리 기호만 다루는 짧은 이름 (예전 이름과 맞춤) */
export const mapPuaBullets = mapPuaText;

const BORDER_STYLES = new Set<Border['style']>(['solid', 'dashed', 'dotted', 'double']);

/** 선 굵기 px (모델 값 1..3, 이상하면 1) */
export function borderWidth(b: Border | undefined): number {
  if (!b) return 0;
  const w = b.w === 2 || b.w === 3 ? b.w : 1;
  return b.style === 'double' ? Math.max(3, w) : w;
}

/** 모델 테두리 → CSS border 값. double 은 두 줄이 보이도록 3px 이상 */
export function borderCss(b: Border | undefined): string | undefined {
  if (!b) return undefined;
  const style = BORDER_STYLES.has(b.style) ? b.style : 'solid';
  return `${borderWidth(b)}px ${style} ${cssColor(b.color) ?? '#000000'}`;
}

/**
 * 모델의 그림 잘라 내기 값(ImageCrop) 검사: 네 값이 0 이상 0.99 이하이고 남는 부분이 가로, 세로 1% 이상일 때만.
 * 아니면 null 이고 화면은 원본 전체를 틀에 그린다(예전 모델과 같다)
 */
export function cropOf(v: unknown): ImageCrop | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const l = num(o.l, 0, 0.99);
  const t = num(o.t, 0, 0.99);
  const r = num(o.r, 0, 0.99);
  const b = num(o.b, 0, 0.99);
  if (l === undefined || t === undefined || r === undefined || b === undefined) return null;
  if (1 - l - r < 0.01 || 1 - t - b < 0.01) return null;
  if (l === 0 && t === 0 && r === 0 && b === 0) return null;
  return { l, t, r, b };
}

/**
 * 잘라 낸 그림의 안쪽 img 자리(틀 기준 %). 틀(overflow: hidden)은 잘라 낸 뒤 크기이고, 원본을 가로 1 / (1 - l - r),
 * 세로 1 / (1 - t - b) 배로 키워 왼쪽 위로 l, t 만큼 민다. % 라서 틀이 칸 폭에 맞춰 줄어도 비율이 그대로다
 */
export function cropPlacement(c: ImageCrop): { left: string; top: string; width: string; height: string } {
  const fw = 1 - c.l - c.r;
  const fh = 1 - c.t - c.b;
  const p = (v: number): string => `${round(v * 100, 4)}%`;
  return { left: p(-c.l / fw), top: p(-c.t / fh), width: p(1 / fw), height: p(1 / fh) };
}
