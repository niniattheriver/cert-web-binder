/**
 * 테마(word/theme/theme1.xml): 테마 글꼴(major/minor, latin/동아시아)과 테마 색
 *
 * - 글꼴 속성 asciiTheme="minorHAnsi", eastAsiaTheme="minorEastAsia" 등을 실제 글꼴 이름으로 바꾼다.
 *   동아시아(ea) 글꼴 이름이 비어 있으면 문서 동아시아 언어의 문자 체계 글꼴(한국어 'Hang')을 쓴다.
 * - 색 속성 themeColor="accent1" 은 색 체계(clrScheme)에서, text1/background1 같은 이름은
 *   settings.xml 의 clrSchemeMapping 을 거쳐 찾는다.
 */
import { attr, localName, type XElement } from '../xml.js';
import { hexColor, own, sanitizeFont, tintShade } from './units.js';

export interface Theme {
  /** 'dk1', 'lt1', 'accent1', 'hlink' ... → '#rrggbb' */
  colors: Map<string, string>;
  fonts: {
    majorLatin?: string;
    majorEa?: string;
    minorLatin?: string;
    minorEa?: string;
  };
}

/** w:themeColor 이름 → 색 체계 항목 */
const THEME_COLOR_SLOT: Record<string, string> = {
  dark1: 'dk1',
  light1: 'lt1',
  dark2: 'dk2',
  light2: 'lt2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hyperlink: 'hlink',
  followedHyperlink: 'folHlink',
};

/** settings clrSchemeMapping 기본값 (text1 → dark1 ...) */
export const DEFAULT_CLR_MAPPING: Readonly<Record<string, string>> = {
  text1: 'dark1',
  background1: 'light1',
  text2: 'dark2',
  background2: 'light2',
};

function kid(el: XElement | undefined, local: string): XElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) if (c.type === 'el' && localName(c.name) === local) return c;
  return undefined;
}

/** 동아시아 언어 → 테마 글꼴 문자 체계 이름 */
function scriptFor(eastAsiaLang: string | undefined): string {
  const l = (eastAsiaLang ?? 'ko-KR').toLowerCase();
  if (l.startsWith('ja')) return 'Jpan';
  if (l === 'zh-tw' || l === 'zh-hk' || l === 'zh-mo') return 'Hant';
  if (l.startsWith('zh')) return 'Hans';
  return 'Hang';
}

export function readTheme(root: XElement | null, eastAsiaLang: string | undefined): Theme {
  const theme: Theme = { colors: new Map(), fonts: {} };
  const elements = kid(root ?? undefined, 'themeElements');
  if (!elements) return theme;
  const scheme = kid(elements, 'clrScheme');
  if (scheme) {
    for (const c of scheme.children) {
      if (c.type !== 'el') continue;
      const slot = localName(c.name);
      const srgb = kid(c, 'srgbClr');
      const sys = kid(c, 'sysClr');
      const v = hexColor(srgb ? attr(srgb, 'val') : sys ? (attr(sys, 'lastClr') ?? (attr(sys, 'val') === 'window' ? 'FFFFFF' : '000000')) : undefined);
      if (v) theme.colors.set(slot, v);
    }
  }
  const fontScheme = kid(elements, 'fontScheme');
  const script = scriptFor(eastAsiaLang);
  const read = (el: XElement | undefined): { latin?: string; ea?: string } => {
    if (!el) return {};
    const latinEl = kid(el, 'latin');
    const eaEl = kid(el, 'ea');
    const latin = latinEl ? sanitizeFont(attr(latinEl, 'typeface')) : undefined;
    let ea = eaEl ? sanitizeFont(attr(eaEl, 'typeface')) : undefined;
    if (!ea) {
      for (const f of el.children) {
        if (f.type === 'el' && localName(f.name) === 'font' && attr(f, 'script') === script) {
          ea = sanitizeFont(attr(f, 'typeface'));
          break;
        }
      }
    }
    const out: { latin?: string; ea?: string } = {};
    if (latin) out.latin = latin;
    if (ea) out.ea = ea;
    return out;
  };
  const major = read(kid(fontScheme, 'majorFont'));
  const minor = read(kid(fontScheme, 'minorFont'));
  if (major.latin) theme.fonts.majorLatin = major.latin;
  if (major.ea) theme.fonts.majorEa = major.ea;
  if (minor.latin) theme.fonts.minorLatin = minor.latin;
  if (minor.ea) theme.fonts.minorEa = minor.ea;
  return theme;
}

/** asciiTheme 등의 값(ST_Theme) → 글꼴 이름 */
export function themeFont(theme: Theme, value: string): string | undefined {
  const major = value.startsWith('major');
  const ea = value.endsWith('EastAsia');
  if (major) return ea ? (theme.fonts.majorEa ?? theme.fonts.majorLatin) : theme.fonts.majorLatin;
  return ea ? (theme.fonts.minorEa ?? theme.fonts.minorLatin) : theme.fonts.minorLatin;
}

/**
 * themeColor(+themeTint/themeShade) → '#rrggbb'. 테마에 없으면 fallback(w:val 의 캐시된 색).
 * mapping: settings clrSchemeMapping (text1 → dark1 등)
 */
export function themeColor(
  theme: Theme,
  mapping: Readonly<Record<string, string>>,
  name: string,
  tint: string | undefined,
  shade: string | undefined,
  fallback: string | undefined,
): string | undefined {
  const mapped = own(mapping, name) ?? own(DEFAULT_CLR_MAPPING, name) ?? name;
  const slot = own(THEME_COLOR_SLOT, mapped);
  const base = slot ? theme.colors.get(slot) : undefined;
  if (!base) return fallback;
  return tintShade(base, tint, shade);
}
