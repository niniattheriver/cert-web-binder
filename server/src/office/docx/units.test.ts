import { describe, expect, it } from 'vitest';
import { normalizeText } from '../../pdf/normalize.js';
import { settleRuns, type PreRun } from './emit.js';
import { parsePageField, formatPageNumber } from './fields.js';
import {
  canon,
  formatNumber,
  hexColor,
  mapBulletGlyphs,
  mix,
  own,
  sanitizeFont,
  sliceSafe,
  streamSafe,
  tintShade,
  twipsAttr,
} from './units.js';

describe('정규화', () => {
  it('canon: 제로폭 글자를 먼저 지워서 결과를 다시 정규화해도 바뀌지 않는다', () => {
    const s = canon('e‍́ a﻿b');
    expect(s).toBe('é ab');
    expect(normalizeText(s)).toBe(s);
    // normalizeText 한 번만으로는 'e' + U+0301 이 남아 다시 정규화하면 바뀐다
    expect(normalizeText(normalizeText('e‍́'))).not.toBe(normalizeText('e‍́'));
  });

  it('streamSafe: 결합 표지 30개마다 CGJ(U+034F), 30개 이하는 그대로, 두 번 해도 같다', () => {
    const marks = (n: number): string => '́'.repeat(n);
    expect(streamSafe(`a${marks(30)}`)).toBe(`a${marks(30)}`);
    expect(streamSafe(`a${marks(61)}`)).toBe(`a${marks(30)}͏${marks(30)}͏${marks(1)}`);
    const once = streamSafe(`a${'̣́'.repeat(50)}`);
    expect(streamSafe(once)).toBe(once);
    expect(streamSafe('가나다 abc')).toBe('가나다 abc');
  });

  it('settleRuns: 결합 글자 앞머리만 앞 조각에 붙이고 나머지는 제 모양을 지킨다 (쪽 번호 자리표시는 제외)', () => {
    const runs: PreRun[] = [{ t: 'e' }, { t: '́x', b: true }, { t: '̣' }, { t: '́y' }];
    expect(settleRuns(runs)).toEqual([{ t: 'é' }, { t: 'x̣́', b: true }, { t: 'y' }]);
    expect(settleRuns([{ t: '́a' }])).toEqual([{ t: '́a' }]);
    const pf: PreRun[] = [{ t: '#', pf: { kind: 'PAGE' } }, { t: '́' }];
    expect(settleRuns(pf)).toEqual(pf);
    const nfd = '한'.normalize('NFD');
    expect(settleRuns([{ t: nfd.slice(0, 1), b: true }, { t: nfd.slice(1) }])).toEqual([{ t: '한', b: true }]);
  });

  it('own: 고정 표 자신의 키만 찾는다 (Object.prototype 키는 없음)', () => {
    const table: Readonly<Record<string, number>> = { a: 1 };
    expect(own(table, 'a')).toBe(1);
    expect(own(table, 'constructor')).toBeUndefined();
    expect(own(table, 'toString')).toBeUndefined();
    expect(own(table, '__proto__')).toBeUndefined();
    expect(own(table, undefined)).toBeUndefined();
  });
});

describe('번호 서식', () => {
  it('십진, 로마자, 영문자 (Word 식 AA, BB)', () => {
    expect([1, 9, 10].map((n) => formatNumber(n, 'decimal'))).toEqual(['1', '9', '10']);
    expect(formatNumber(7, 'decimalZero')).toBe('07');
    expect([4, 9, 14, 1999].map((n) => formatNumber(n, 'upperRoman'))).toEqual(['IV', 'IX', 'XIV', 'MCMXCIX']);
    expect(formatNumber(3, 'lowerRoman')).toBe('iii');
    expect([1, 26, 27, 28].map((n) => formatNumber(n, 'upperLetter'))).toEqual(['A', 'Z', 'AA', 'BB']);
    expect(formatNumber(2, 'lowerLetter')).toBe('b');
  });

  it('한국어 서식: 가나다, 초성, 일이삼, 하나 둘', () => {
    expect([1, 2, 14, 15].map((n) => formatNumber(n, 'ganada'))).toEqual(['가', '나', '하', '가']);
    expect([1, 3].map((n) => formatNumber(n, 'chosung'))).toEqual(['ㄱ', 'ㄷ']);
    expect([1, 10, 11, 20, 123].map((n) => formatNumber(n, 'koreanDigital'))).toEqual(['일', '십', '십일', '이십', '백이십삼']);
    expect([1, 2, 10, 21].map((n) => formatNumber(n, 'koreanCounting'))).toEqual(['하나', '둘', '열', '스물하나']);
    expect(formatNumber(12, 'koreanDigital2')).toBe('十二');
    expect(formatNumber(105, 'ideographDigital')).toBe('一〇五');
  });

  it('동그라미 숫자는 20까지, 그 뒤는 괄호. 전각 숫자. 모르는 서식은 십진', () => {
    expect(formatNumber(1, 'decimalEnclosedCircle')).toBe('①');
    expect(formatNumber(20, 'decimalEnclosedCircle')).toBe('⑳');
    expect(formatNumber(21, 'decimalEnclosedCircle')).toBe('(21)');
    expect(formatNumber(3, 'decimalEnclosedParen')).toBe('⑶');
    expect(formatNumber(12, 'decimalFullWidth')).toBe('１２');
    expect(formatNumber(5, 'none')).toBe('');
    expect(formatNumber(5, 'cardinalText')).toBe('5');
  });
});

describe('색, 글꼴, 길이', () => {
  it('16진 색은 소문자 #rrggbb, auto 는 없음', () => {
    expect(hexColor('FF00AA')).toBe('#ff00aa');
    expect(hexColor('auto')).toBeUndefined();
    expect(hexColor('12345')).toBeUndefined();
  });

  it('테마 색 밝게(tint), 어둡게(shade)', () => {
    expect(tintShade('#000000', '80', undefined)).toBe('#7f7f7f');
    expect(tintShade('#ffffff', undefined, '80')).toBe('#808080');
    expect(tintShade('#4472c4', undefined, undefined)).toBe('#4472c4');
  });

  it('무늬 음영 섞기', () => {
    expect(mix('#000000', '#ffffff', 10)).toBe('#e6e6e6');
  });

  it('글꼴 이름은 글자, 숫자, 빈칸, - _ . 만 남긴다', () => {
    expect(sanitizeFont('맑은 고딕')).toBe('맑은 고딕');
    expect(sanitizeFont('Times New Roman;}x<y>')).toBe('Times New Romanxy');
    expect(sanitizeFont('  ')).toBeUndefined();
    expect(sanitizeFont('a'.repeat(80))?.length).toBe(64);
  });

  it('단위 붙은 길이 → twips', () => {
    expect(twipsAttr('720')).toBe(720);
    expect(twipsAttr('1in')).toBe(1440);
    expect(twipsAttr('12pt')).toBe(240);
    expect(twipsAttr('x')).toBeUndefined();
  });

  it('대리 쌍을 가르지 않는다', () => {
    const s = `a${String.fromCodePoint(0x1f600)}b`;
    expect(sliceSafe(s, 2)).toBe('a');
    expect(sliceSafe(s, 3)).toBe(s.slice(0, 3));
  });
});

describe('글머리 기호 사설 영역 글자', () => {
  it('정해진 PUA 글자만 유니코드로 바꾸고 나머지는 그대로', () => {
    expect(mapBulletGlyphs(String.fromCharCode(0xf0b7), false)).toEqual({ text: '•', changed: true });
    expect(mapBulletGlyphs(String.fromCharCode(0xf075), false)).toEqual({ text: String.fromCharCode(0xf075), changed: false });
  });

  it('기호 글꼴의 ASCII 글자는 U+F0xx 로 보고 바꾼다', () => {
    expect(mapBulletGlyphs('l', true).text).toBe('●');
    expect(mapBulletGlyphs('n', true).text).toBe('■');
    expect(mapBulletGlyphs('l', false).text).toBe('l');
  });
});

describe('쪽 번호 필드', () => {
  it('PAGE, NUMPAGES, SECTIONPAGES 와 서식 스위치', () => {
    expect(parsePageField(' PAGE   \\* MERGEFORMAT ')).toEqual({ kind: 'PAGE' });
    expect(parsePageField('NUMPAGES \\* roman')).toEqual({ kind: 'NUMPAGES', fmt: 'roman' });
    expect(parsePageField('PAGEREF _Toc1 \\h')).toBeUndefined();
    expect(formatPageNumber(4, { kind: 'PAGE', fmt: 'ROMAN' }, undefined)).toBe('IV');
    expect(formatPageNumber(4, { kind: 'PAGE' }, 'lowerLetter')).toBe('d');
    expect(formatPageNumber(4, { kind: 'NUMPAGES' }, 'lowerLetter')).toBe('4');
    expect(formatPageNumber(4, { kind: 'PAGE' }, 'numberInDash')).toBe('- 4 -');
  });
});
