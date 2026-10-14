import { describe, expect, it } from 'vitest';
import {
  attr,
  childEl,
  childEls,
  childPath,
  deepClone,
  descendants,
  escapeXmlText,
  hasDescendant,
  localName,
  parseAttrs,
  parseXml,
  serializeNode,
  serializeXml,
  unescapeXml,
  XmlParseError,
} from './xml.js';

const DOCX_SAMPLE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body><w:p w:rsidR="00A1"><w:pPr><w:jc w:val="center"/></w:pPr>' +
  '<w:r><w:t xml:space="preserve">가 &amp; 나 </w:t></w:r><w:r><w:br w:type="page" /></w:r></w:p>' +
  '<!-- 주석 --><w:tbl><w:tr><w:tc><w:p><w:r><w:t>셀</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>';

describe('parseXml / serializeXml', () => {
  it('원문과 같은 문자열로 왕복한다 (선언, 주석, 자기닫힘 공백 포함)', () => {
    const doc = parseXml(DOCX_SAMPLE);
    expect(serializeXml(doc)).toBe(DOCX_SAMPLE);
    expect(doc.root.name).toBe('w:document');
    expect(doc.prolog.length).toBeGreaterThan(0);
  });

  it('따옴표 안의 > 와 작은따옴표 속성을 처리한다', () => {
    const src = `<a x="1>2" y='z"q'><b/></a>`;
    const doc = parseXml(src);
    expect(serializeXml(doc)).toBe(src);
    expect(attr(doc.root, 'x')).toBe('1>2');
    expect(attr(doc.root, 'y')).toBe('z"q');
  });

  it('CDATA, 처리지시를 원문 그대로 보관한다', () => {
    const src = '<a><![CDATA[<x>]]><?pi data?>t</a>';
    expect(serializeXml(parseXml(src))).toBe(src);
  });

  it('DOCTYPE 은 거부한다 (엔티티 해석 없음)', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>')).toThrow(XmlParseError);
  });

  it('끝 태그 불일치, 닫히지 않은 요소, 루트 둘을 거부한다', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(XmlParseError);
    expect(() => parseXml('<a><b>')).toThrow(XmlParseError);
    expect(() => parseXml('<a/><b/>')).toThrow(XmlParseError);
    expect(() => parseXml('텍스트만')).toThrow(XmlParseError);
  });
});

describe('탐색 도우미', () => {
  it('childEls/childEl/childPath/descendants/hasDescendant', () => {
    const doc = parseXml(DOCX_SAMPLE);
    const body = childEl(doc.root, 'w:body')!;
    expect(childEls(body).map((e) => e.name)).toEqual(['w:p', 'w:tbl', 'w:sectPr']);
    const p = childEl(body, 'w:p')!;
    expect(attr(childPath(p, 'w:pPr', 'w:jc')!, 'w:val')).toBe('center');
    expect(descendants(body, 'w:t')).toHaveLength(2);
    expect(hasDescendant(p, 'w:br')).toBe(true);
    expect(hasDescendant(childEl(body, 'w:tbl')!, 'w:br')).toBe(false);
    expect(localName('w:tbl')).toBe('tbl');
    expect(localName('plain')).toBe('plain');
  });

  it('deepClone 은 원본과 분리되고 같은 문자열로 직렬화된다', () => {
    const doc = parseXml(DOCX_SAMPLE);
    const body = childEl(doc.root, 'w:body')!;
    const clone = deepClone(body);
    expect(serializeNode(clone)).toBe(serializeNode(body));
    clone.children.pop();
    expect(serializeNode(clone)).not.toBe(serializeNode(body));
  });
});

describe('속성 스캐너 (선형 시간)', () => {
  it('따옴표 종류, = 주변 공백, 중복(뒤 값), 따옴표 없는 값 무시', () => {
    const m = parseAttrs(` a="1" b = '2'  c=3 d="x &amp; y" a="last"`);
    expect(m.get('a')).toBe('last');
    expect(m.get('b')).toBe('2');
    expect(m.has('c')).toBe(false);
    expect(m.get('d')).toBe('x & y');
  });

  it("'=' 없는 아주 긴 토큰에서도 빠르다 (예전 정규식은 제곱 시간)", () => {
    const long = ' ' + 'x'.repeat(200_000) + ' "' + 'y'.repeat(200_000) + '" w:val="ok"';
    const t0 = performance.now();
    const m = parseAttrs(long);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(m.get('w:val')).toBe('ok');
  });

  it('attr() 는 캐시한 스캔 결과를 쓴다', () => {
    const doc = parseXml(`<w:x w:val="1" w:other='2'/>`);
    expect(attr(doc.root, 'w:val')).toBe('1');
    expect(attr(doc.root, 'w:other')).toBe('2');
    expect(attr(doc.root, 'none')).toBeUndefined();
  });
});

describe('엔티티', () => {
  it('한 번만 푼다: 문자 참조로 만든 & 뒤의 엔티티는 다시 풀지 않는다', () => {
    expect(unescapeXml('&#38;lt;')).toBe('&lt;');
    expect(unescapeXml('&amp;amp;')).toBe('&amp;');
  });

  it('XML 이 허용하지 않는 글자(짝 없는 서로게이트, NUL)는 대체 문자로', () => {
    const rep = String.fromCharCode(0xfffd);
    expect(unescapeXml('a&#xD800;b')).toBe('a' + rep + 'b');
    expect(unescapeXml('&#0;')).toBe(rep);
    expect(unescapeXml('&#x1F600;')).toBe(String.fromCodePoint(0x1f600));
    expect(unescapeXml('&nbsp;')).toBe('&nbsp;'); // 모르는 엔티티는 그대로
  });

  it('문자 참조와 기본 엔티티만 되돌린다', () => {
    expect(unescapeXml('&lt;a&gt; &amp;amp; &#54620;&#xAE00; &quot;&apos;')).toBe('<a> &amp; 한글 "\'');
    expect(unescapeXml('&#1114112;')).toBe('�');
    expect(escapeXmlText('a<b&c>')).toBe('a&lt;b&amp;c&gt;');
  });
});
