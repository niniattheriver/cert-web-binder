/**
 * docx 추출기 공용 도우미: 단위 변환, 정규화, 색, 글꼴 이름, 번호 서식
 *
 * 단위: twips(1/1440 인치) / 15 = px(96dpi), EMU / 9525 = px, 반 포인트(half-point) / 2 = pt,
 * 테두리 굵기는 1/8 포인트.
 */
import { normalizeText } from '../../pdf/normalize.js';
import { stripControls } from '../controls.js';
import type { XElement } from '../xml.js';
import { attr } from '../xml.js';

export const TWIPS_PER_PX = 15;
export const EMU_PER_PX = 9525;

/**
 * 고정 표(객체 글자 그대로)에서 속성 값으로 찾기. 표 자신의 키만 본다: 'constructor', 'toString',
 * '__proto__' 같은 값이 Object.prototype 의 함수나 객체를 돌려주지 않게 한다.
 */
export function own<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// ─────────────────────────────── 정규화 ───────────────────────────────

/**
 * 앞 글자와 합성되거나 정규화 때 순서가 바뀔 수 있는 글자: 결합 표지(\p{M}), 한글 중성, 종성 자모, U+16D67.
 * 이 묶음 밖의 글자는 앞 글자와 합쳐지지도, 앞으로 옮겨지지도 않는다(V8 의 정규화로 모든 코드 포인트를 확인:
 * ccc 가 0 이 아닌 글자와 뒤에서 합성되는 글자는 이 묶음 안에 있다. U+16D67 만 \p{M} 밖이었다)
 */
const COMBINING = '\\p{M}\\u1160-\\u11FF\\uD7B0-\\uD7FF\\u{16D67}';
/** 글자 앞머리의 결합 글자 묶음 */
export const COMBINING_HEAD = new RegExp(`^[${COMBINING}]+`, 'u');

const ZERO_WIDTH = /[​-‍﻿]/g;
const CGJ = '͏';
const MARK = /\p{M}/u;
const MARK_RUNS = /\p{M}+/gu;

/** 결합 표지가 30 코드 단위 넘게 이어진 곳이 있는가 (한 번 훑기: 반복 정규식은 묶음마다 되짚어 느리다) */
function hasLongMarkRun(s: string): boolean {
  if (!MARK.test(s)) return false;
  MARK_RUNS.lastIndex = 0;
  for (let m = MARK_RUNS.exec(s); m; m = MARK_RUNS.exec(s)) if (m[0].length > 30) return true;
  return false;
}

/**
 * 결합 표지가 30개를 넘게 이어지면 30개마다 CGJ(U+034F)를 넣는다 (UAX #15 Stream-Safe Text Format).
 * V8(ICU)의 NFC 는 결합 표지 묶음 안의 순서 정렬이 묶음 길이의 제곱에 비례한다: 결합 표지 16만 개짜리 글자
 * 하나가 18초 걸렸다(넣은 뒤 4ms). 실제 글에는 이런 묶음이 없으므로 보통 글자는 바뀌지 않는다.
 */
export function streamSafe(s: string): string {
  if (!hasLongMarkRun(s)) return s;
  let out = '';
  let run = 0;
  for (const ch of s) {
    if (ch === CGJ) run = 0;
    else if (MARK.test(ch)) {
      if (run === 30) {
        out += CGJ;
        run = 0;
      }
      run += 1;
    } else run = 0;
    out += ch;
  }
  return out;
}

/**
 * 정본 글자 정규화: 제로폭 글자를 먼저 지우고, 결합 표지 묶음을 제한한 뒤 normalizeText.
 * normalizeText 는 NFC 다음에 제로폭 글자를 지우므로 그 자리에서 새로 합성될 글자가 남을 수 있다
 * ('e' + ZWJ + U+0301). 먼저 지우면 결과는 다시 정규화해도 바뀌지 않는다.
 * 제어 문자(NUL 등, 탭과 줄바꿈 제외)도 먼저 지운다(../controls.ts).
 */
export function canon(s: string): string {
  return normalizeText(streamSafe(stripControls(s.replace(ZERO_WIDTH, ''))));
}

/** 소수 첫째 자리까지 */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function twipsToPx(v: number): number {
  return round1(v / TWIPS_PER_PX);
}

export function emuToPx(v: number): number {
  return round1(v / EMU_PER_PX);
}

/** 숫자 속성 (정수, 소수). 비었거나 숫자가 아니면 undefined */
export function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const UNIT_TWIPS: Record<string, number> = { in: 1440, cm: 1440 / 2.54, mm: 144 / 2.54, pt: 20, pc: 240, pi: 240 };

/**
 * 길이 속성 → twips. 보통은 정수 twips 이고, strict 형식은 '1.5in', '12pt' 같은 단위 붙은 값을 쓴다.
 */
export function twipsAttr(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const plain = num(v);
  if (plain !== undefined) return plain;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(in|cm|mm|pt|pc|pi)\s*$/.exec(v);
  if (!m) return undefined;
  return Number(m[1]) * UNIT_TWIPS[m[2]!]!;
}

/** w:val 같은 켜고 끄는 속성: 값이 없으면 켬. '0', 'false', 'off' 는 끔 */
export function onOff(el: XElement | undefined, name = 'w:val'): boolean | undefined {
  if (!el) return undefined;
  const v = attr(el, name);
  if (v === undefined) return true;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
}

/** 'FF00AA' / '#ff00aa' → '#ff00aa'. 'auto' 나 형식이 틀리면 undefined */
export function hexColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toLowerCase()}` : undefined;
}

/** w:highlight 이름 → 색 (ST_HighlightColor) */
export const HIGHLIGHT: Readonly<Record<string, string>> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  yellow: '#ffff00',
  white: '#ffffff',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
};

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/**
 * 테마 색의 themeTint / themeShade(16진 바이트) 적용: HSL 밝기에 곱한다.
 * tint: L' = L * t + (1 - t), shade: L' = L * s  (t, s = 값 / 255)
 */
export function tintShade(hex: string, tint?: string, shade?: string): string {
  const t = tint !== undefined ? parseInt(tint, 16) : NaN;
  const s = shade !== undefined ? parseInt(shade, 16) : NaN;
  if (!Number.isFinite(t) && !Number.isFinite(s)) return hex;
  const [r, g, b] = rgb(hex);
  const [h, sat, l0] = rgbToHsl(r, g, b);
  let l = l0;
  if (Number.isFinite(s)) l = l * (s / 255);
  if (Number.isFinite(t)) l = l * (t / 255) + (1 - t / 255);
  const [R, G, B] = hslToRgb(h, sat, Math.max(0, Math.min(1, l)));
  return toHex(R, G, B);
}

/** 무늬 음영(pctN): 무늬 색을 바탕색 위에 N% 섞는다 */
export function mix(fg: string, bg: string, pct: number): string {
  const [r1, g1, b1] = rgb(fg);
  const [r2, g2, b2] = rgb(bg);
  const a = Math.max(0, Math.min(1, pct / 100));
  return toHex(r1 * a + r2 * (1 - a), g1 * a + g2 * (1 - a), b1 * a + b2 * (1 - a));
}

/** 상대 밝기 0..1 (어두운 바탕 위 '자동' 글자색을 흰색으로 바꿀 때 쓴다) */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** 글꼴 이름: 글자(한글 포함), 숫자, 빈칸, '-', '_', '.' 만 남기고 64자로 자른다 */
export function sanitizeFont(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v
    .replace(/[^\p{L}\p{N} \-_.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
  return s || undefined;
}

/** 대리 쌍(surrogate pair)을 가르지 않게 앞 n 글자 */
export function sliceSafe(s: string, n: number): string {
  if (n >= s.length) return s;
  let k = Math.max(0, n);
  if (k > 0) {
    const c = s.charCodeAt(k - 1);
    if (c >= 0xd800 && c <= 0xdbff) k -= 1;
  }
  return s.slice(0, k);
}

/** XML 바이트 → 글자 (UTF-16 BOM 이 있으면 그 인코딩, 아니면 UTF-8, 앞 BOM 제거) */
export function decodeXmlBytes(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const s = b.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 한글, 한자, 가나, 전각 글자가 들어 있는가 (동아시아 글꼴을 고를 때) */
const EAST_ASIAN_RE = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-퟿豈-﫿＀-￯]/;
export function hasEastAsian(s: string): boolean {
  return EAST_ASIAN_RE.test(s);
}

// ─────────────────────────────── 번호 서식 ───────────────────────────────

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  let v = n;
  for (const [k, s] of table) {
    while (v >= k) {
      out += s;
      v -= k;
    }
  }
  return out;
}

/** Word 식 글자 번호: A..Z, AA..ZZ(같은 글자 반복), AAA.. */
function letters(n: number): string {
  if (n <= 0 || n > 26 * 30) return String(n);
  const ch = String.fromCharCode(65 + ((n - 1) % 26));
  return ch.repeat(Math.floor((n - 1) / 26) + 1);
}

const GANADA = '가나다라마바사아자차카타파하';
const CHOSUNG = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const SINO_KO = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const HANJA = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 십, 백, 천, 만 자리로 읽는 수 (일이삼 / 一二三) */
function positional(n: number, digits: string[], units: [string, string, string, string]): string {
  if (n <= 0 || n >= 100_000_000) return String(n);
  const out: string[] = [];
  const man = Math.floor(n / 10000);
  const rest = n % 10000;
  const four = (v: number): string => {
    let s = '';
    const ds = [Math.floor(v / 1000), Math.floor(v / 100) % 10, Math.floor(v / 10) % 10, v % 10];
    const us = [units[2], units[1], units[0], ''];
    ds.forEach((d, i) => {
      if (d === 0) return;
      // 십, 백, 천 앞의 1 은 읽지 않는다(십일, 백이)
      s += (d === 1 && i < 3 ? '' : digits[d]!) + us[i]!;
    });
    return s;
  };
  if (man > 0) out.push(four(man) + units[3]);
  if (rest > 0) out.push(four(rest));
  return out.join('');
}

const NATIVE_ONES = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉'];
const NATIVE_TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];

function nativeKorean(n: number): string {
  if (n <= 0 || n >= 100) return positional(n, SINO_KO, ['십', '백', '천', '만']);
  return NATIVE_TENS[Math.floor(n / 10)]! + NATIVE_ONES[n % 10]!;
}

function enclosed(n: number, base: number, count: number, fallback: (n: number) => string): string {
  return n >= 1 && n <= count ? String.fromCharCode(base + n - 1) : fallback(n);
}

/** ST_NumberFormat → 글자. 모르는 형식은 decimal. 아주 큰 값(비정상 시작 값)은 십진으로 */
export function formatNumber(n: number, fmt: string): string {
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) > 100_000 && fmt !== 'none') return String(n);
  switch (fmt) {
    case 'decimal':
    case 'decimalHalfWidth':
      return String(n);
    case 'decimalZero':
      return n >= 0 && n < 10 ? `0${n}` : String(n);
    case 'upperRoman':
      return roman(n);
    case 'lowerRoman':
      return roman(n).toLowerCase();
    case 'upperLetter':
      return letters(n);
    case 'lowerLetter':
      return letters(n).toLowerCase();
    case 'ganada':
      return n >= 1 ? GANADA[(n - 1) % GANADA.length]! : String(n);
    case 'chosung':
      return n >= 1 ? CHOSUNG[(n - 1) % CHOSUNG.length]! : String(n);
    case 'koreanDigital':
      return positional(n, SINO_KO, ['십', '백', '천', '만']);
    case 'koreanCounting':
    case 'koreanLegal':
      return nativeKorean(n);
    case 'koreanDigital2':
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'japaneseCounting':
    case 'taiwaneseCounting':
      return positional(n, HANJA, ['十', '百', '千', '万']);
    case 'ideographDigital':
    case 'taiwaneseDigital':
    case 'japaneseDigitalTenThousand':
      return n >= 0
        ? String(n)
            .split('')
            .map((d) => HANJA[Number(d)] ?? d)
            .join('')
        : String(n);
    case 'decimalEnclosedCircle':
    case 'decimalEnclosedCircleChinese':
      return enclosed(n, 0x2460, 20, (v) => `(${v})`);
    case 'decimalEnclosedParen':
      return enclosed(n, 0x2474, 20, (v) => `(${v})`);
    case 'decimalEnclosedFullstop':
      return enclosed(n, 0x2488, 20, (v) => `${v}.`);
    case 'decimalFullWidth':
    case 'decimalFullWidth2':
      return String(n)
        .split('')
        .map((d) => (d >= '0' && d <= '9' ? String.fromCharCode(0xff10 + Number(d)) : d))
        .join('');
    case 'none':
      return '';
    default:
      return String(n);
  }
}

/** 글머리 기호 사설 영역(PUA) 글자 → 유니코드 (번호 이름표에만 쓴다) */
export const PUA_BULLETS: Readonly<Record<number, string>> = {
  0xf0b7: '•',
  0xf0a7: '▪',
  0xf0d8: '➢',
  0xf076: '❖',
  0xf0fc: '✓',
  0xf06c: '●',
  0xf06e: '■',
  0xf0a8: '□',
};

/** 기호 글꼴(Symbol, Wingdings, Webdings): 이 글꼴의 0x20..0xFF 글자는 Word 안에서 U+F0xx 로 다룬다 */
export function isSymbolFont(font: string | undefined): boolean {
  return font !== undefined && /^(symbol|wingdings( [23])?|webdings)$/i.test(font.trim());
}

/** 이름표 글자의 PUA 글머리 기호를 유니코드로. 바꾼 글자가 있으면 changed */
export function mapBulletGlyphs(s: string, symbolFont: boolean): { text: string; changed: boolean } {
  let changed = false;
  let out = '';
  for (const ch of s) {
    let code = ch.codePointAt(0)!;
    if (symbolFont && code >= 0x20 && code <= 0xff) code += 0xf000;
    const mapped = PUA_BULLETS[code];
    if (mapped !== undefined) {
      out += mapped;
      changed = true;
    } else {
      out += ch;
    }
  }
  return { text: out, changed };
}
