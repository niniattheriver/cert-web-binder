import { describe, expect, it } from 'vitest';
import { zipEntries } from '../../jobs/zip.js';
import { OfficeParseError } from '../errors.js';
import type { FlowBox, FlowDisplayRun, FlowImage, FlowModel, FlowPara, FlowTable, OfficeExtractResult } from '../model.js';
import { DOCX_EXTRACTOR, processDocx } from './index.js';
import { MAX_CHROME_JSON, MAX_HEADER_CHARS, MAX_HEADER_UNITS } from './limits.js';
import {
  BR_PAGE,
  checkInvariants,
  makeDocx,
  NS,
  p,
  parseModel,
  PNG_1X1,
  pt,
  r,
  runsOf,
  sectPr,
  tbl,
  tc,
  tr,
  type Fixture,
} from './testkit.js';

interface Out {
  res: OfficeExtractResult;
  model: FlowModel;
  texts: string[];
}

/** 추출하고 불변식을 확인한다 */
function run(f: Fixture): Out {
  const res = processDocx(makeDocx(f), '문서.docx');
  expect(checkInvariants(res)).toEqual([]);
  return { res, model: parseModel(res), texts: res.pages.map((x) => x.text) };
}

const para = (o: Out, page: number, i: number): FlowPara => o.model.pages[page]!.blocks[i] as FlowPara;

const APP = (n: number): string =>
  `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>${n}</Pages></Properties>`;

describe('processDocx 기본', () => {
  it('결과 형식: 추출기 라벨, JSON 렌더, 쪽 번호 1..N, 기본 탭 간격', () => {
    const o = run({
      body: pt('검사실 지침서') + sectPr(),
      settings: '<w:defaultTabStop w:val="720"/>',
      files: { 'docProps/app.xml': APP(1) },
    });
    expect(o.res.fileKind).toBe('docx');
    expect(o.res.extractor).toBe(DOCX_EXTRACTOR);
    expect(o.res.renderMime).toBe('application/json');
    expect(o.res.pages).toEqual([{ pageNo: 1, text: '검사실 지침서', label: null }]);
    expect(o.model.kind).toBe('flow');
    expect(o.model.defaultTab).toBe(48);
    expect(o.model.pages[0]!.w).toBeCloseTo(793.7, 1);
    expect(o.model.pages[0]!.margin).toEqual([96, 96, 96, 96]);
    expect(o.res.truncated).toBeNull();
  });

  it('빈 문단은 글자에 넣지 않고 모델에는 runs [] 와 문단 표지 글자 크기로 남긴다', () => {
    const o = run({ body: pt('가') + p('', '<w:rPr><w:sz w:val="28"/></w:rPr>') + pt('나') });
    expect(o.texts).toEqual(['가\n나']);
    expect(para(o, 0, 1)).toMatchObject({ type: 'p', runs: [], sz: 14 });
  });

  it('w:tab, w:br, w:cr, w:sym, w:noBreakHyphen 은 글자로, w:softHyphen 은 버린다', () => {
    const inner =
      '<w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t><w:cr/><w:t>D</w:t><w:noBreakHyphen/><w:softHyphen/>' +
      '<w:sym w:font="Wingdings" w:char="F0FC"/></w:r>';
    const o = run({ body: p(inner) });
    expect(o.texts[0]).toBe(`A\tB\nC\nD-${String.fromCharCode(0xf0fc)}`);
  });

  it('깨진 파일은 OfficeParseError (한국어 안내), 본문이 빈 문서는 빈 쪽 하나', () => {
    const date = new Date(1980, 0, 1);
    expect(() => processDocx(Buffer.from('not a zip'), 'a.docx')).toThrow(OfficeParseError);
    const noDocument = zipEntries([{ name: 'word/styles.xml', data: Buffer.from('<x/>'), date }]);
    expect(() => processDocx(noDocument, 'a.docx')).toThrow(OfficeParseError);
    const broken = zipEntries([{ name: 'word/document.xml', data: Buffer.from('<w:document><w:body>'), date }]);
    expect(() => processDocx(broken, 'a.docx')).toThrow(/Word \(docx\)/);
    expect(processDocx(makeDocx({ body: '' }), 'a.docx').pages).toEqual([{ pageNo: 1, text: '', label: '구간 1' }]);
  });

  it('lrpb 가 없으면 구간 N, 다만 Word 가 센 쪽 수(app.xml)가 표지 쪽 수와 같으면 Word 쪽(null)', () => {
    const body = pt('첫') + p(BR_PAGE) + pt('둘');
    expect(run({ body }).res.pages.map((x) => x.label)).toEqual(['구간 1', '구간 2']);
    expect(run({ body, files: { 'docProps/app.xml': APP(2) } }).res.pages.map((x) => x.label)).toEqual([null, null]);
    expect(run({ body, files: { 'docProps/app.xml': APP(5) } }).res.pages.map((x) => x.label)).toEqual(['구간 1', '구간 2']);
  });
});

describe('서식 상속', () => {
  const styles =
    '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="18"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:color w:val="333333"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Base"><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="Base"/><w:pPr><w:ind w:left="720"/></w:pPr>' +
    '<w:rPr><w:sz w:val="32"/><w:i/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Em"><w:rPr><w:u w:val="single"/><w:b w:val="0"/></w:rPr></w:style>';

  it('docDefaults 와 기본 문단 스타일(pStyle 없음)', () => {
    const o = run({ styles, body: pt('평문') });
    expect(para(o, 0, 0)).toMatchObject({ spaceAfter: 8, runs: [{ t: '평문', o: 0, sz: 9, color: '#333333' }] });
  });

  it('basedOn 사슬: 바탕 먼저, 파생이 덮어쓴다', () => {
    const o = run({ styles, body: p(r('파생'), '<w:pStyle w:val="Derived"/>') });
    const pa = para(o, 0, 0);
    expect(pa.align).toBe('center');
    expect(pa.marginLeft).toBe(48);
    expect(pa.runs[0]).toMatchObject({ t: '파생', sz: 16, b: true, i: true, color: '#333333' });
  });

  it('글자 스타일과 직접 서식 순서', () => {
    const o = run({
      styles,
      body:
        p(r('글자', '<w:rStyle w:val="Em"/>'), '<w:pStyle w:val="Derived"/>') +
        p(r('직접', '<w:sz w:val="40"/>'), '<w:pStyle w:val="Derived"/><w:jc w:val="right"/>'),
    });
    const r0 = para(o, 0, 0).runs[0]!;
    expect(r0.u).toBe(true);
    expect(r0.b).toBeUndefined();
    expect(para(o, 0, 1)).toMatchObject({ align: 'right', runs: [{ t: '직접', sz: 20 }] });
  });

  it('글자 단위 들여쓰기(leftChars, hangingChars)는 twips 값보다 우선한다', () => {
    const o = run({
      body: p(r('들여'), '<w:ind w:leftChars="200" w:left="9999" w:hangingChars="100" w:hanging="9999"/><w:rPr><w:sz w:val="20"/></w:rPr>'),
    });
    expect(para(o, 0, 0).marginLeft).toBeCloseTo(26.7, 1);
    expect(para(o, 0, 0).indent).toBeCloseTo(-13.3, 1);
  });

  it('줄 간격: auto 는 배수, exact 는 px, 자동 간격은 14px', () => {
    const o = run({
      body:
        pt('a', '<w:spacing w:line="360" w:lineRule="auto"/>') +
        pt('b', '<w:spacing w:line="300" w:lineRule="exact"/>') +
        pt('c', '<w:spacing w:beforeAutospacing="1" w:afterAutospacing="1"/>'),
    });
    expect(para(o, 0, 0).lineHeight).toBe(1.5);
    expect(para(o, 0, 1).linePx).toBe(20);
    expect(para(o, 0, 2)).toMatchObject({ spaceBefore: 14, spaceAfter: 14 });
  });

  it('문맥 간격: 같은 스타일 이웃 문단 사이 간격을 없앤다', () => {
    const st =
      '<w:style w:type="paragraph" w:styleId="L"><w:pPr><w:spacing w:before="200" w:after="200"/><w:contextualSpacing/></w:pPr></w:style>';
    const o = run({ styles: st, body: pt('1', '<w:pStyle w:val="L"/>') + pt('2', '<w:pStyle w:val="L"/>') });
    expect(para(o, 0, 0).spaceAfter).toBeUndefined();
    expect(para(o, 0, 1).spaceBefore).toBeUndefined();
    expect(para(o, 0, 0).spaceBefore).toBeCloseTo(13.3, 1);
  });

  it('테마 글꼴과 테마 색: 한글이 든 조각은 동아시아 글꼴', () => {
    const theme =
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements>' +
      '<a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
      '<a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>' +
      '<a:fontScheme name="x"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/></a:majorFont>' +
      '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:font script="Hang" typeface="맑은 고딕"/></a:minorFont>' +
      '</a:fontScheme></a:themeElements></a:theme>';
    const rf = '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/>';
    const o = run({
      theme,
      body: p(r('가나', rf) + r('abc', `${rf}<w:color w:val="FF0000" w:themeColor="accent1"/>`)),
    });
    const [ko, en] = para(o, 0, 0).runs;
    expect(ko!.font).toBe('맑은 고딕');
    expect(en!.font).toBe('Calibri');
    expect(en!.color).toBe('#4472c4');
  });

  it('형광펜, 음영, 위첨자, 취소선', () => {
    const o = run({
      body: p(
        r('형광', '<w:highlight w:val="yellow"/>') +
          r('음영', '<w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/>') +
          r('2', '<w:vertAlign w:val="superscript"/>') +
          r('삭', '<w:dstrike/>'),
      ),
    });
    const runs = para(o, 0, 0).runs;
    expect(runs.map((x) => [x.t, x.bg, x.sup, x.strike])).toEqual([
      ['형광', '#ffff00', undefined, undefined],
      ['음영', '#d9d9d9', undefined, undefined],
      ['2', undefined, true, undefined],
      ['삭', undefined, undefined, true],
    ]);
  });

  it('NFD 한글이 모양이 다른 조각으로 갈려도 쪽 글자는 NFC 로 안정하다', () => {
    const nfd = '한'.normalize('NFD');
    const o = run({ body: p(r(nfd.slice(0, 1), '<w:b/>') + r(nfd.slice(1))) });
    expect(o.texts[0]).toBe('한');
  });

  it('결합 글자 조각은 떠 있는 그림, 사용자 지정 각주 표지, 번호 이름표를 사이에 두어도 앞 조각에 붙는다', () => {
    const anchor =
      '<w:r><w:drawing><wp:anchor><wp:extent cx="952500" cy="952500"/><wp:wrapSquare/><a:graphic>' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill>' +
      '<a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
    const numbering =
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="ganada"/>' +
      '<w:lvlText w:val="%1"/><w:suff w:val="nothing"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const nfd = '한'.normalize('NFD');
    const o = run({
      numbering,
      rels: [{ id: 'rIdImg', type: 'image', target: 'media/image1.png' }],
      files: { 'word/media/image1.png': PNG_1X1 },
      footnotes: `<w:footnote w:id="1"><w:p>${r('주')}</w:p></w:footnote>`,
      body:
        p(r('e') + anchor + r('́x', '<w:b/>')) +
        p(r(nfd.slice(0, 1)) + anchor + r(nfd.slice(1))) +
        p(r('e') + '<w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/></w:r>' + r('́', '<w:i/>')) +
        p(r('ᆨ 뒤'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    });
    expect(o.texts[0]).toBe('éx\n한\né\n각 뒤\n주');
    // 앞머리만 옮기고 나머지 글자는 제 모양(굵게)을 지킨다. 떠 있는 그림은 문단 뒤 블록
    expect(para(o, 0, 0).runs.map((x) => [x.t, x.b])).toEqual([
      ['é', undefined],
      ['x', true],
    ]);
    expect(o.model.pages[0]!.blocks[1]!.type).toBe('img');
  });
});

describe('문단 번호', () => {
  const numbering =
    '<w:abstractNum w:abstractNumId="0">' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>' +
    '<w:pPr><w:ind w:left="400" w:hanging="400"/></w:pPr></w:lvl>' +
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="ganada"/><w:lvlText w:val="%1."/>' +
    '<w:suff w:val="space"/></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#xF0B7;"/>' +
    '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl>' +
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="l"/>' +
    '<w:rPr><w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings"/></w:rPr></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:start w:val="12"/><w:numFmt w:val="decimal"/><w:lvlText w:val="제%1조"/>' +
    '<w:suff w:val="nothing"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '<w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>' +
    '<w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>' +
    '<w:num w:numId="5"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>';
  const np = (text: string, numId: number, ilvl = 0): string =>
    pt(text, `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);

  it('십진 "1.", 하위 "1.1.", 상위가 오르면 하위는 처음부터', () => {
    const o = run({ numbering, body: np('개요', 1) + np('범위', 1, 1) + np('용어', 1, 1) + np('책임', 1) + np('세부', 1, 1) });
    expect(o.texts[0]!.split('\n')).toEqual(['1.\t개요', '1.1.\t범위', '1.2.\t용어', '2.\t책임', '2.1.\t세부']);
    const first = para(o, 0, 0);
    expect(first.runs[0]).toMatchObject({ t: '1.\t', o: 0, lbl: true });
    expect(first.marginLeft).toBeCloseTo(26.7, 1);
    expect(first.indent).toBeCloseTo(-26.7, 1);
  });

  it('가나다 서식과 빈칸 뒤붙임, "제%1조" (뒤붙임 없음)', () => {
    const o = run({ numbering, body: np('목적', 2) + np('범위', 2) + np('적용', 4) + np('정의', 4) });
    expect(o.texts[0]!.split('\n')).toEqual(['가. 목적', '나. 범위', '제12조적용', '제13조정의']);
  });

  it('글머리 기호: PUA 와 기호 글꼴 글자를 유니코드로, 기호 글꼴 이름은 뺀다', () => {
    const o = run({ numbering, body: np('항목', 3) + np('하위', 3, 1) });
    expect(o.texts[0]!.split('\n')).toEqual(['•\t항목', '●\t하위']);
    expect(para(o, 0, 0).runs[0]!.font).toBeUndefined();
  });

  it('startOverride: 그 num 이 그 단계에서 처음 쓰일 때 다시 시작, 같은 정의를 쓰는 num 은 이어 센다', () => {
    const o = run({ numbering, body: np('가', 1) + np('나', 1) + np('다시', 5) + np('이어', 5) + np('원래', 1) });
    expect(o.texts[0]!.split('\n').map((l) => l.split('\t')[0])).toEqual(['1.', '2.', '1.', '2.', '3.']);
  });

  it('스타일의 numPr 로도 번호를 단다 (numId 0 은 번호 없음)', () => {
    const styles =
      '<w:style w:type="paragraph" w:styleId="H"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>';
    const o = run({
      numbering,
      styles,
      body: pt('제목', '<w:pStyle w:val="H"/>') + pt('없음', '<w:pStyle w:val="H"/><w:numPr><w:numId w:val="0"/></w:numPr>'),
    });
    expect(o.texts[0]).toBe('1.\t제목\n없음');
  });
});

describe('문단 번호 세부', () => {
  const lvl = (ilvl: number, text: string, extra = ''): string =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`;
  const np = (text: string, numId: number, ilvl = 0): string =>
    pt(text, `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);

  it('lvlRestart 0 은 상위 단계가 올라도 다시 시작하지 않는다, isLgl 은 모든 단계를 십진으로', () => {
    const numbering =
      '<w:abstractNum w:abstractNumId="0">' +
      '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl>' +
      lvl(1, '%1-%2', '<w:lvlRestart w:val="0"/><w:isLgl/>') +
      '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const o = run({ numbering, body: np('a', 1) + np('b', 1, 1) + np('c', 1) + np('d', 1, 1) });
    expect(o.texts[0]!.split('\n').map((l) => l.split('\t')[0])).toEqual(['I.', '1-1', 'II.', '2-2']);
  });

  it('numStyleLink 는 번호 스타일을 거쳐 실제 정의(styleLink)로 건너간다', () => {
    const numbering =
      `<w:abstractNum w:abstractNumId="0"><w:styleLink w:val="ListStyle"/>${lvl(0, '(%1)')}</w:abstractNum>` +
      '<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="ListStyle"/></w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';
    const styles =
      '<w:style w:type="numbering" w:styleId="ListStyle"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>';
    const o = run({ numbering, styles, body: np('가', 2) + np('나', 2) });
    expect(o.texts[0]).toBe('(1)\t가\n(2)\t나');
  });
});

describe('Word 와 같은 화면 값 (PDF 짝 대조로 바로잡은 줄 높이, 들여쓰기, 글자 크기)', () => {
  const malgun =
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="맑은 고딕" w:eastAsia="맑은 고딕" w:hAnsi="맑은 고딕"/>' +
    '<w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>';

  it('들여쓰기: twips 값과 글자 단위 값은 따로 물려받는다 (leftChars="0" 만 있으면 번호 단계의 left 를 쓴다)', () => {
    const numbering =
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>' +
      '<w:lvlText w:val="%1)"/><w:pPr><w:ind w:left="800" w:hanging="400"/></w:pPr></w:lvl></w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const styles =
      malgun +
      '<w:style w:type="paragraph" w:styleId="LP"><w:pPr><w:ind w:leftChars="400" w:left="800"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="H"><w:pPr><w:ind w:left="600" w:hanging="400"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="D"><w:basedOn w:val="H"/><w:pPr><w:ind w:leftChars="0" w:hangingChars="0"/></w:pPr></w:style>';
    const o = run({
      numbering,
      styles,
      body:
        pt('항목', '<w:pStyle w:val="LP"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:leftChars="0"/>') +
        pt('내어', '<w:pStyle w:val="H"/><w:ind w:firstLineChars="0"/>') +
        pt('파생', '<w:pStyle w:val="D"/>'),
    });
    expect(para(o, 0, 0).marginLeft).toBeCloseTo(53.3, 1);
    expect(para(o, 0, 0).indent).toBeCloseTo(-26.7, 1);
    expect(para(o, 0, 1).marginLeft).toBeCloseTo(40, 1);
    expect(para(o, 0, 1).indent).toBeCloseTo(-26.7, 1);
    // 스타일 사슬(basedOn) 안에서도 같다
    expect(para(o, 0, 2).marginLeft).toBeCloseTo(40, 1);
    expect(para(o, 0, 2).indent).toBeCloseTo(-26.7, 1);
  });

  it('줄 높이 px: 글꼴의 Word 한 줄(맑은 고딕 1.73배, Arial 1.15배) x 배수, atLeast 는 한 줄 이상, exact 는 그 값', () => {
    const o = run({
      styles: malgun,
      body:
        pt('가', '<w:spacing w:line="276" w:lineRule="auto"/>') +
        pt('나', '<w:spacing w:line="100" w:lineRule="atLeast"/>') +
        pt('다', '<w:spacing w:line="300" w:lineRule="exact"/>') +
        p(r('A', '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="24"/>')) +
        p('', '<w:rPr><w:sz w:val="28"/></w:rPr>') +
        pt('바', '<w:rPr><w:rFonts w:eastAsia="바탕"/></w:rPr>').replace('<w:r>', '<w:r><w:rPr><w:rFonts w:eastAsia="바탕"/></w:rPr>'),
    });
    expect(para(o, 0, 0)).toMatchObject({ lineHeight: 1.15, linePx: 26.5 });
    expect(para(o, 0, 1).linePx).toBe(23.1);
    expect(para(o, 0, 2).linePx).toBe(20);
    expect(para(o, 0, 3).linePx).toBe(18.4);
    expect(para(o, 0, 4)).toMatchObject({ runs: [], sz: 14, linePx: 32.3 });
    expect(para(o, 0, 5).linePx).toBe(17.3);
  });

  it('문서 격자(type lines)가 있으면 한 줄을 격자 간격의 정수배로 올린다. type 이 없거나 snapToGrid 0 이면 그대로', () => {
    const grid = (type: string): string => sectPr(`<w:docGrid${type} w:linePitch="360"/>`);
    const body =
      pt('가') +
      pt('나', '<w:spacing w:line="360" w:lineRule="auto"/>') +
      pt('다', '<w:snapToGrid w:val="0"/>') +
      p(r('라', '<w:sz w:val="28"/>'));
    const on = run({ styles: malgun, body: body + grid(' w:type="lines"') });
    expect([0, 1, 2, 3].map((i) => para(on, 0, i).linePx)).toEqual([24, 36, 23.1, 48]);
    const off = run({ styles: malgun, body: body + grid('') });
    expect([0, 1, 2, 3].map((i) => para(off, 0, i).linePx)).toEqual([23.1, 34.6, 23.1, 32.3]);
  });

  it('크기를 정하지 않은 글자는 모델에 Word 기본 10pt 를 싣는다 (문단 표지 크기를 물려주지 않는다)', () => {
    const o = run({ body: p(r('가'), '<w:rPr><w:sz w:val="24"/></w:rPr>') + pt('나') });
    expect(para(o, 0, 0)).toMatchObject({ sz: 12, runs: [{ t: '가', sz: 10 }] });
    expect(para(o, 0, 1).runs[0]!.sz).toBe(10);
  });

  it('쪽 나눔만 있는 문단은 새 쪽 맨 위에 빈 줄로 그리지 않는다 (정본 글자는 그대로)', () => {
    const o = run({
      body: pt('첫') + p(BR_PAGE) + p('') + pt('둘') + p(r('셋') + BR_PAGE) + pt('넷') + sectPr(),
      files: { 'docProps/app.xml': APP(3) },
    });
    expect(o.texts).toEqual(['첫', '둘\n셋', '넷']);
    const second = o.model.pages[1]!.blocks as FlowPara[];
    expect(second.map((b) => b.runs.map((x) => x.t).join(''))).toEqual(['', '둘', '셋']);
    expect((o.model.pages[2]!.blocks as FlowPara[]).map((b) => b.runs.map((x) => x.t).join(''))).toEqual(['넷']);
  });
});

describe('모양 세부', () => {
  it('어두운 칸 음영 위의 자동 글자색은 흰색, 16진 tblLook(w:val)', () => {
    const styles =
      '<w:style w:type="table" w:styleId="T"><w:tblStylePr w:type="firstRow"><w:tcPr><w:shd w:val="clear" w:fill="1F3864"/></w:tcPr></w:tblStylePr></w:style>';
    const o = run({
      styles,
      body: tbl([tr([tc(pt('머리'))]), tr([tc(pt('본문'))])], [3000], '<w:tblStyle w:val="T"/><w:tblLook w:val="0020"/>'),
    });
    const t = o.model.pages[0]!.blocks[0] as FlowTable;
    expect(t.rows[0]!.cells[0]!.bg).toBe('#1f3864');
    expect((t.rows[0]!.cells[0]!.blocks[0] as FlowPara).runs[0]!.color).toBe('#ffffff');
    expect((t.rows[1]!.cells[0]!.blocks[0] as FlowPara).runs[0]!.color).toBeUndefined();
  });

  it('같은 테두리 문단이 이어지면 한 상자로 묶는다 (사이 선은 w:between)', () => {
    const bdr =
      '<w:pBdr><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/>' +
      '<w:right w:val="single" w:sz="4"/><w:between w:val="dashed" w:sz="4"/></w:pBdr>';
    const o = run({ body: pt('1', bdr) + pt('2', bdr) + pt('3', bdr) + pt('밖') });
    const [a, b, c, d] = [0, 1, 2, 3].map((i) => para(o, 0, i));
    expect(a!.bt).toBeDefined();
    expect(a!.bb).toEqual({ w: 1, style: 'dashed', color: '#000000' });
    expect(b!.bt).toBeUndefined();
    expect(c!.bt).toBeUndefined();
    expect(c!.bb).toEqual({ w: 1, style: 'solid', color: '#000000' });
    expect(d!.bt).toBeUndefined();
  });

  it('머리말 그림은 머리말 부분의 관계로 찾고, VML 그림(v:imagedata)도 싣는다', () => {
    const hdr =
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:p><w:r><w:pict><v:shape style="width:75pt;height:30pt"><v:imagedata r:id="rLogo"/></v:shape></w:pict></w:r></w:p></w:hdr>';
    const o = run({
      rels: [{ id: 'rH', type: 'header', target: 'header1.xml' }],
      files: {
        'word/header1.xml': hdr,
        'word/_rels/header1.xml.rels':
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>',
        'word/media/logo.png': PNG_1X1,
      },
      body: pt('본문') + sectPr('<w:headerReference w:type="default" r:id="rH"/>'),
    });
    expect(o.model.media).toEqual([{ path: 'word/media/logo.png', mime: 'image/png' }]);
    expect(o.model.pages[0]!.header).toEqual([{ type: 'img', media: 0, w: 100, h: 40 }]);
    expect(o.texts[0]).toBe('본문');
  });

  it('속성 값이 Object.prototype 키여도(형광펜, 정렬, 테마 색, 그림 확장자) 문서를 거부하지 않고 모르는 값으로 본다', () => {
    const blip = (rid: string): string =>
      `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><a:graphic><a:graphicData uri="x"><pic:pic>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const o = run({
      rels: [
        { id: 'r1', type: 'image', target: 'media/a.constructor' },
        { id: 'r2', type: 'image', target: 'media/b.__proto__' },
      ],
      files: { 'word/media/a.constructor': PNG_1X1, 'word/media/b.__proto__': PNG_1X1 },
      body:
        p(
          r('가', '<w:highlight w:val="toString"/>') +
            r('나', '<w:highlight w:val="__proto__"/><w:color w:val="FF0000" w:themeColor="__proto__"/>') +
            r('다', '<w:highlight w:val="constructor"/><w:shd w:val="clear" w:fill="D9D9D9"/>'),
          '<w:jc w:val="__proto__"/>',
        ) + p(blip('r1') + blip('r2')),
    });
    expect(o.texts[0]).toBe('가나다');
    expect(o.model.media).toEqual([]);
    const pa = para(o, 0, 0);
    expect(pa.align).toBeUndefined();
    expect(pa.runs.map((x) => [x.t, x.bg, x.color])).toEqual([
      ['가', undefined, undefined],
      ['나', undefined, '#ff0000'],
      ['다', '#d9d9d9', undefined],
    ]);
  });
});

describe('필드, 변경 추적, 숨은 글자, 펼치기', () => {
  const fld = (instr: string, result: string): string =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

  it('복합 필드는 결과 구간만, 명령은 숨긴다. 겹친 필드와 결과 없는 필드', () => {
    const nested =
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>IF </w:instrText></w:r>' +
      fld('MERGEFIELD x', r('안쪽')) +
      '<w:r><w:instrText> = 1 "y"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      r('결과') +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const xe = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> XE "색인" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const o = run({ body: p(r('총 ') + fld(' NUMPAGES ', r('9')) + r('쪽 ') + nested + xe + r(' 끝')) });
    expect(o.texts[0]).toBe('총 9쪽 결과 끝');
  });

  it('필드가 문단을 넘어 이어져도(목차) 결과만 보인다', () => {
    const o = run({
      body:
        p('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC \\o "1-3"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + r('1장\t3')) +
        p(r('2장\t5') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>') +
        pt('본문'),
    });
    expect(o.texts[0]).toBe('1장\t3\n2장\t5\n본문');
  });

  it('fldSimple 은 캐시된 결과를 보인다', () => {
    const o = run({ body: p(`<w:fldSimple w:instr=" DATE \\@ &quot;yyyy-MM-dd&quot; ">${r('2026-10-06')}</w:fldSimple>`) });
    expect(o.texts[0]).toBe('2026-10-06');
  });

  it('변경 추적: 넣은 글자는 보이고 지운 글자, 옮겨 온 원래 자리는 뺀다', () => {
    const o = run({
      body: p(
        `<w:ins w:id="1" w:author="a">${r('새')}</w:ins>` +
          '<w:del w:id="2" w:author="a"><w:r><w:delText>옛</w:delText></w:r></w:del>' +
          `<w:moveFrom w:id="3" w:author="a">${r('이전')}</w:moveFrom><w:moveTo w:id="4" w:author="a">${r('이후')}</w:moveTo>` +
          r(' 끝', '<w:rPrChange w:id="5" w:author="a"><w:rPr><w:b/></w:rPr></w:rPrChange>'),
      ),
    });
    expect(o.texts[0]).toBe('새이후 끝');
    expect(para(o, 0, 0).runs.every((x) => !x.b)).toBe(true);
  });

  it('숨은 글자(직접, 글자 스타일)는 통째로 뺀다', () => {
    const styles = '<w:style w:type="character" w:styleId="Hid"><w:rPr><w:vanish/></w:rPr></w:style>';
    const o = run({ styles, body: p(r('보임') + r('숨김', '<w:vanish/>') + r('스타일숨김', '<w:rStyle w:val="Hid"/>') + r('!')) });
    expect(o.texts[0]).toBe('보임!');
  });

  it('하이퍼링크, 글자/블록 sdt, customXml, smartTag 는 펼치고 링크 주소는 모델에 넣지 않는다', () => {
    const o = run({
      rels: [{ id: 'rIdLink', type: 'hyperlink', target: 'https://secret.example/path', external: true }],
      body:
        p(
          `<w:hyperlink r:id="rIdLink">${r('링크')}</w:hyperlink>` +
            `<w:sdt><w:sdtPr/><w:sdtContent>${r('콘텐츠')}</w:sdtContent></w:sdt>` +
            `<w:smartTag w:element="x">${r('태그')}</w:smartTag><w:customXml w:element="y">${r('사용자')}</w:customXml>`,
        ) + `<w:sdt><w:sdtContent>${pt('블록 sdt')}</w:sdtContent></w:sdt>`,
    });
    expect(o.texts[0]).toBe('링크콘텐츠태그사용자\n블록 sdt');
    expect(o.res.render.toString('utf8')).not.toContain('secret.example');
  });

  it('mc:AlternateContent 는 한 갈래만 (Choice 에 지원 내용이 없으면 Fallback)', () => {
    const ac = (choice: string, fallback: string): string =>
      `<mc:AlternateContent><mc:Choice Requires="w14">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;
    const o = run({ body: p(ac(r('선택'), r('대체'))) + p(ac('<w:r><w:drawing/></w:r>', r('대체만'))) });
    expect(o.texts[0]).toBe('선택\n대체만');
  });

  it('수식은 m:t 를 이은 기울임 글자, 루비는 바탕 글자만', () => {
    const o = run({
      body: p(
        '<m:oMath><m:r><m:t>x</m:t></m:r><m:r><m:t>=1</m:t></m:r></m:oMath>' +
          `<w:r><w:ruby><w:rubyPr/><w:rt>${r('한')}</w:rt><w:rubyBase>${r('漢')}</w:rubyBase></w:ruby></w:r>`,
      ),
    });
    expect(o.texts[0]).toBe('x=1漢');
    expect(para(o, 0, 0).runs[0]).toMatchObject({ t: 'x=1', i: true });
  });
});

describe('표', () => {
  it('행 \\n, 칸 \\t, 칸 안 블록 \\n. 빈 칸은 글자에 넣지 않는다. 너비, 병합, 음영, 테두리', () => {
    const borders =
      '<w:tblBorders><w:top w:val="single" w:sz="8" w:color="000000"/><w:left w:val="single" w:sz="4"/>' +
      '<w:bottom w:val="double" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="nil"/>' +
      '<w:insideV w:val="dotted" w:sz="4" w:color="FF0000"/></w:tblBorders>';
    const o = run({
      body: tbl(
        [
          tr([tc(pt('머리'), '<w:gridSpan w:val="2"/><w:shd w:val="clear" w:fill="FFFF00"/>'), tc(pt('셋'))]),
          tr([tc(pt('가') + pt('나'), '<w:tcW w:w="1500" w:type="dxa"/><w:vAlign w:val="center"/>'), tc(''), tc(pt('다'))]),
        ],
        [1500, 1500, 3000],
        `<w:tblW w:w="5000" w:type="pct"/><w:jc w:val="center"/>${borders}`,
      ),
    });
    expect(o.texts[0]).toBe('머리\t셋\n가\n나\t다');
    const t = o.model.pages[0]!.blocks[0] as FlowTable;
    expect(t.colWidths).toEqual([100, 100, 200]);
    expect(t.width).toBeCloseTo(601.7, 1);
    expect(t.align).toBe('center');
    const [head, three] = t.rows[0]!.cells;
    expect(head).toMatchObject({ colSpan: 2, bg: '#ffff00', border: false });
    expect(head!.bt).toEqual({ w: 1, style: 'solid', color: '#000000' });
    expect(head!.bb).toBeUndefined(); // insideH nil
    expect(head!.br).toEqual({ w: 1, style: 'dotted', color: '#ff0000' }); // insideV
    expect(three!.br).toEqual({ w: 1, style: 'solid', color: '#000000' });
    const c = t.rows[1]!.cells[0]!;
    expect(c).toMatchObject({ w: 100, va: 'middle', pad: [0, 7.2, 0, 7.2] });
    expect(c.bb).toEqual({ w: 3, style: 'double', color: '#000000' });
  });

  it('세로 병합: 시작 칸에 rowSpan, 이어지는 칸은 빼고 내용은 시작 칸에 붙인다', () => {
    const o = run({
      body: tbl(
        [
          tr([tc(pt('병합'), '<w:vMerge w:val="restart"/>'), tc(pt('a'))]),
          tr([tc(pt('숨은 내용'), '<w:vMerge/>'), tc(pt('b'))]),
          tr([tc(pt('c')), tc(pt('d'))]),
        ],
        [2000, 2000],
      ),
    });
    const t = o.model.pages[0]!.blocks[0] as FlowTable;
    expect(t.rows[0]!.cells[0]!.rowSpan).toBe(2);
    expect(t.rows[1]!.cells).toHaveLength(1);
    expect(o.texts[0]).toBe('병합\n숨은 내용\ta\nb\nc\td');
  });

  it('gridBefore/gridAfter 는 테두리 없는 빈 칸, 지운 행은 뺀다', () => {
    const o = run({
      body: tbl(
        [
          tr([tc(pt('x'))], '<w:gridBefore w:val="1"/><w:gridAfter w:val="1"/>'),
          tr([tc(pt('지움')), tc(pt('행')), tc(pt('!'))], '<w:del w:id="1" w:author="a"/>'),
        ],
        [1000, 1000, 1000],
      ),
    });
    const t = o.model.pages[0]!.blocks[0] as FlowTable;
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.cells.map((c) => [c.blocks.length, c.colSpan, c.border])).toEqual([
      [0, undefined, false],
      [1, undefined, false],
      [0, undefined, false],
    ]);
    expect(o.texts[0]).toBe('x');
  });

  it('표 스타일: 전체 테두리, 칸 여백, firstRow 조건부 서식(tblLook)', () => {
    const styles =
      '<w:style w:type="table" w:styleId="Grid"><w:tblPr><w:tblBorders><w:insideH w:val="single" w:sz="4"/></w:tblBorders>' +
      '<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
      '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:val="clear" w:fill="DDDDDD"/></w:tcPr></w:tblStylePr>' +
      '</w:style>';
    const rows = [tr([tc(pt('머리'))]), tr([tc(pt('본문'))])];
    const look = (v: string): string => `<w:tblStyle w:val="Grid"/><w:tblLook ${v}/>`;
    const on = run({ styles, body: tbl(rows, [3000], look('w:firstRow="1" w:noHBand="1"')) });
    const t = on.model.pages[0]!.blocks[0] as FlowTable;
    const head = t.rows[0]!.cells[0]!;
    expect(head.bg).toBe('#dddddd');
    expect(head.pad).toEqual([0, 0, 0, 0]);
    expect(head.bb).toEqual({ w: 1, style: 'solid', color: '#000000' });
    expect((head.blocks[0] as FlowPara).runs[0]!.b).toBe(true);
    expect((t.rows[1]!.cells[0]!.blocks[0] as FlowPara).runs[0]!.b).toBeUndefined();
    const off = run({ styles, body: tbl(rows, [3000], '<w:tblStyle w:val="Grid"/><w:tblLook w:val="0000"/>') });
    expect(((off.model.pages[0]!.blocks[0] as FlowTable).rows[0]!.cells[0]!).bg).toBeUndefined();
  });

  it('행 높이, 머리글 행 표시, 중첩 표', () => {
    const inner = tbl([tr([tc(pt('안'))])], [1000]);
    const o = run({
      body: tbl(
        [tr([tc(pt('머리'))], '<w:tblHeader/><w:trHeight w:val="600" w:hRule="exact"/>'), tr([tc(pt('밖') + inner)])],
        [3000],
      ),
    });
    const t = o.model.pages[0]!.blocks[0] as FlowTable;
    expect(t.rows[0]).toMatchObject({ header: true, h: 40, hRule: 'exact' });
    expect(t.rows[1]!.cells[0]!.blocks[1]!.type).toBe('table');
    expect(o.texts[0]).toBe('머리\n밖\n안');
  });
});

describe('그림, 글상자', () => {
  const inline = (rid: string, cx: number, cy: number): string =>
    `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="p"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill>` +
    '<pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';

  it('글자 안 그림 → media(png 등만), 크기는 EMU / 9525. 그림만 있는 문단은 그림 블록만', () => {
    const o = run({
      rels: [
        { id: 'rIdImg', type: 'image', target: 'media/image1.png' },
        { id: 'rIdEmf', type: 'image', target: 'media/image2.emf' },
      ],
      files: { 'word/media/image1.png': PNG_1X1, 'word/media/image2.emf': Buffer.from('emf') },
      body: p(inline('rIdImg', 952500, 476250)) + p(r('앞 ') + inline('rIdImg', 95250, 95250) + r(' 뒤')) + p(inline('rIdEmf', 9525, 9525)),
    });
    expect(o.model.media).toEqual([{ path: 'word/media/image1.png', mime: 'image/png' }]);
    const blocks = o.model.pages[0]!.blocks;
    expect(blocks[0]).toEqual({ type: 'img', media: 0, w: 100, h: 50 } satisfies FlowImage);
    expect(blocks.slice(1, 4).map((b) => b.type)).toEqual(['p', 'img', 'p']);
    expect(o.texts[0]).toBe('앞 \n 뒤');
    expect((blocks[3] as FlowPara).indent).toBeUndefined();
  });

  it('DrawingML 글상자와 VML 글상자는 기준 문단 뒤 글상자 블록, 글자는 정본에 들어간다', () => {
    const wps =
      '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="1905000" cy="952500"/>' +
      '<wp:wrapSquare/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp><wps:spPr><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr>' +
      `<wps:txbx><w:txbxContent>${pt('상자 글')}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>` +
      '</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>' +
      `<mc:Fallback><w:pict><v:shape style="width:150pt;height:75pt"><v:textbox><w:txbxContent>${pt('대체 상자')}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>` +
      '</mc:AlternateContent></w:r>';
    const vml =
      `<w:r><w:pict><v:shape style="position:absolute;width:100pt;height:50pt" stroked="f"><v:textbox><w:txbxContent>${pt('VML 글')}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`;
    const o = run({ body: p(r('기준') + wps) + p(vml + r('둘째')) });
    expect(o.texts[0]).toBe('기준\n상자 글\n둘째\nVML 글');
    const blocks = o.model.pages[0]!.blocks;
    const box = blocks[1] as FlowBox;
    expect(box).toMatchObject({ type: 'box', w: 200, border: true });
    expect((blocks[3] as FlowBox).border).toBe(false);
    expect(runsOf(o.model.pages[0]!.blocks).map((x) => x.t)).toEqual(['기준', '상자 글', '둘째', 'VML 글']);
  });
});

describe('머리말/꼬리말, 각주', () => {
  const hdrRels = [
    { id: 'rIdH', type: 'header', target: 'header1.xml' },
    { id: 'rIdF', type: 'footer', target: 'footer1.xml' },
  ];
  const page = (instr: string): string =>
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>${instr}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';

  it('머리말/꼬리말은 표시 전용(o 없음, 정본 글자 밖)이고 PAGE, NUMPAGES 는 쪽마다 계산한다', () => {
    const hf = (tag: string, inner: string): string =>
      `<?xml version="1.0"?><w:${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:${tag}>`;
    const o = run({
      rels: hdrRels,
      files: {
        'word/header1.xml': hf('hdr', pt('검사실 지침서')),
        'word/footer1.xml': hf('ftr', p(page(' PAGE ') + r(' / ') + `<w:fldSimple w:instr="NUMPAGES">${r('1')}</w:fldSimple>`)),
      },
      body:
        pt('첫 쪽') +
        p(BR_PAGE) +
        pt('둘째 쪽') +
        sectPr('<w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/><w:pgNumType w:start="5"/>'),
    });
    expect(o.texts).toEqual(['첫 쪽', '둘째 쪽']);
    const pg2 = o.model.pages[1]!;
    expect((pg2.header![0] as FlowPara<FlowDisplayRun>).runs.map((x) => x.t)).toEqual(['검사실 지침서']);
    expect((pg2.footer![0] as FlowPara<FlowDisplayRun>).runs.map((x) => x.t).join('')).toBe('6 / 2');
    expect((o.model.pages[0]!.footer![0] as FlowPara<FlowDisplayRun>).runs.map((x) => x.t).join('')).toBe('5 / 2');
    expect(pg2.headerDist).toBe(48);
  });

  it('머리말/꼬리말의 위치 탭(w:ptab 오른쪽)은 뒤 글자를 오른쪽 정렬 칸으로 나눈다 (표시 전용, 본문 위치 탭은 탭 글자)', () => {
    const ptab = '<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>';
    const o = run({
      rels: hdrRels.slice(1),
      files: {
        'word/footer1.xml': `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p(r('지침서 제목') + ptab + page(' PAGE ') + r(' / ') + page(' NUMPAGES '))}</w:ftr>`,
      },
      body: p(r('본문') + ptab + r('끝')) + sectPr('<w:footerReference w:type="default" r:id="rIdF"/>'),
    });
    expect(o.texts).toEqual(['본문\t끝']);
    const ftr = o.model.pages[0]!.footer!;
    expect(ftr).toHaveLength(1);
    const t = ftr[0] as FlowTable<FlowDisplayRun>;
    expect(t.type).toBe('table');
    const cells = t.rows[0]!.cells.map((c) => c.blocks[0] as FlowPara<FlowDisplayRun>);
    expect(cells.map((c) => c.runs.map((x) => x.t).join(''))).toEqual(['지침서 제목', '1 / 1']);
    expect(cells.map((c) => c.align)).toEqual([undefined, 'right']);
    expect(t.rows[0]!.cells.every((c) => c.border === false)).toBe(true);
  });

  it('첫 쪽 다른 머리말(titlePg)과 짝수 쪽 머리말(evenAndOddHeaders)', () => {
    const hf = (text: string): string =>
      `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${pt(text)}</w:hdr>`;
    const o = run({
      settings: '<w:evenAndOddHeaders/>',
      rels: [
        { id: 'rD', type: 'header', target: 'h1.xml' },
        { id: 'rF', type: 'header', target: 'h2.xml' },
        { id: 'rE', type: 'header', target: 'h3.xml' },
      ],
      files: { 'word/h1.xml': hf('기본'), 'word/h2.xml': hf('첫'), 'word/h3.xml': hf('짝') },
      body:
        pt('1') +
        p(BR_PAGE) +
        pt('2') +
        p(BR_PAGE) +
        pt('3') +
        sectPr(
          '<w:headerReference w:type="default" r:id="rD"/><w:headerReference w:type="first" r:id="rF"/>' +
            '<w:headerReference w:type="even" r:id="rE"/><w:titlePg/>',
        ),
    });
    expect(o.model.pages.map((pg) => (pg.header![0] as FlowPara<FlowDisplayRun>).runs[0]!.t)).toEqual(['첫', '짝', '기본']);
  });

  it('각주: 참조는 위첨자 번호, 각주 글은 참조가 있는 쪽 끝에. 미주는 마지막 쪽 끝에', () => {
    const fn = (id: number, text: string): string =>
      `<w:footnote w:id="${id}"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>${r(` ${text}`)}</w:p></w:footnote>`;
    const o = run({
      footnotes:
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' + fn(2, '첫 각주') + fn(3, '둘째 각주'),
      endnotes: `<w:endnote w:id="1"><w:p><w:r><w:endnoteRef/></w:r>${r(' 미주 글')}</w:p></w:endnote>`,
      body:
        p(r('본문') + '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r>') +
        p(BR_PAGE) +
        p(r('다음') + '<w:r><w:footnoteReference w:id="3"/></w:r>' + r(' 끝') + '<w:r><w:endnoteReference w:id="1"/></w:r>'),
    });
    expect(o.texts).toEqual(['본문1\n1 첫 각주', '다음2 끝i\n2 둘째 각주\ni 미주 글']);
    const ref = para(o, 0, 0).runs[1]!;
    expect(ref).toMatchObject({ t: '1', sup: true });
  });

  it('사용자 지정 표지(customMarkFollows) 각주는 번호를 쓰지도 세지도 않는다: 다음 자동 번호가 이어진다', () => {
    const sup = '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>';
    const ref = (id: number): string => `<w:r>${sup}<w:footnoteReference w:id="${id}"/></w:r>`;
    const custom = (id: number): string => `<w:r>${sup}<w:footnoteReference w:customMarkFollows="1" w:id="${id}"/><w:t>*</w:t></w:r>`;
    const fn = (id: number, text: string): string =>
      `<w:footnote w:id="${id}"><w:p><w:r>${sup}<w:footnoteRef/></w:r>${r(` ${text}`)}</w:p></w:footnote>`;
    const o = run({
      footnotes: fn(2, '첫 자동') + `<w:footnote w:id="3"><w:p>${r('* 표지')}</w:p></w:footnote>` + fn(4, '둘째 자동'),
      body: p(r('가') + ref(2) + r(' 나') + custom(3) + r(' 다') + ref(4)),
    });
    expect(o.texts).toEqual(['가1 나* 다2\n1 첫 자동\n* 표지\n2 둘째 자동']);
  });

  it('머리말/꼬리말은 부분마다 상한(글자, 문단)까지만 싣고, 쪽마다 되풀이되는 JSON 합도 묶는다', () => {
    // 굵게와 보통이 번갈아 조각이 합쳐지지 않는 큰 머리말 (글자 1만, 문단 50)
    const line = Array.from({ length: 200 }, (_, i) => r('머', i % 2 ? '<w:b/>' : '')).join('');
    const hdr = `<w:hdr ${NS}>${Array.from({ length: 50 }, () => p(line)).join('')}</w:hdr>`;
    const pages = 300;
    const body =
      Array.from({ length: pages }, (_, i) => p(r(`본문 ${i + 1}`) + (i < pages - 1 ? BR_PAGE : ''))).join('') +
      sectPr('<w:headerReference w:type="default" r:id="rH"/>');
    const res = processDocx(
      makeDocx({ body, rels: [{ id: 'rH', type: 'header', target: 'header1.xml' }], files: { 'word/header1.xml': hdr } }),
      'a.docx',
    );
    expect(checkInvariants(res)).toEqual([]);
    const model = parseModel(res);
    expect(model.pages).toHaveLength(pages);
    const first = model.pages[0]!.header!;
    const chars = first.reduce((s, b) => s + (b.type === 'p' ? b.runs.reduce((n, x) => n + x.t.length, 0) : 0), 0);
    expect(chars).toBe(MAX_HEADER_CHARS);
    expect(first.length).toBeLessThanOrEqual(MAX_HEADER_UNITS);
    // 상한을 넘은 뒤 쪽에는 머리말을 싣지 않는다 (정본 글자는 그대로)
    expect(model.pages[pages - 1]!.header).toBeUndefined();
    expect(res.pages[pages - 1]!.text).toBe(`본문 ${pages}`);
    expect(res.render.length).toBeLessThan(MAX_CHROME_JSON + 1024 * 1024);
  });
});

describe('상한, 비정상 구조', () => {
  it('문단 상한: 앞 50,000 문단만 색인하고 보여준다', () => {
    const body = Array.from({ length: 50_010 }, (_, i) => `<w:p><w:r><w:t>${i % 10}</w:t></w:r></w:p>`).join('');
    const o = run({ body });
    expect(o.texts.join('\n').split('\n')).toHaveLength(50_000);
    expect(o.res.truncated).toMatch(/50,000개 문단/);
  }, 60_000);

  it('쪽 상한: 앞 2,000 쪽만', () => {
    const body = Array.from({ length: 2_010 }, (_, i) => pt(`${i}`) + p(BR_PAGE)).join('');
    const o = run({ body });
    expect(o.texts).toHaveLength(2_000);
    expect(o.res.truncated).toMatch(/2,000쪽/);
  }, 60_000);

  it('비정상적으로 깊은 중첩과 아주 큰 번호 시작 값도 예외 없이 처리한다', () => {
    const deep = '<w:customXml>'.repeat(3000) + pt('깊음') + '</w:customXml>'.repeat(3000);
    const numbering =
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="999999999"/><w:numFmt w:val="upperLetter"/>' +
      '<w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const o = run({ numbering, body: deep + pt('번호', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') });
    expect(o.texts[0]).toBe('999999999.\t번호');
  });

  it('글자 상한에서 자르고 색인과 표시가 같은 범위다', () => {
    const big = 'ㄱ'.repeat(1_500_000);
    const o = run({ body: pt(big) + pt(big) + pt('넘침') });
    const total = o.texts.reduce((s, x) => s + x.length, 0);
    expect(total).toBe(3_000_000);
    expect(o.res.truncated).toMatch(/3,000,000자/);
    expect(o.model.truncated).toBe(o.res.truncated);
  }, 60_000);

  it('결합 글자 조각이 아주 많거나 결합 표지가 아주 길게 이어져도 선형 시간에 끝난다', () => {
    // 굵게/보통이 번갈아 조각마다 앞 조각에 붙는 결합 표지 4만 개, 그리고 순서 정렬이 필요한 결합 표지 8만 개
    // (고치기 전: 각각 약 11초, 약 18초)
    const n = 40_000;
    const many = Array.from({ length: n }, (_, i) => `<w:r>${i % 2 ? '' : '<w:rPr><w:b/></w:rPr>'}<w:t>́</w:t></w:r>`).join('');
    const t0 = performance.now();
    const o = run({ body: p(r('a') + many) + pt(`x${'̣́'.repeat(n)}`) });
    expect(performance.now() - t0).toBeLessThan(5000);
    // 쪽 정보가 없는 문서라 6000자를 넘는 쪽은 블록 경계에서 갈린다: 문단 하나가 한 구간
    const [first, second] = o.texts;
    expect(o.texts).toHaveLength(2);
    expect(first!.startsWith('á')).toBe(true);
    expect(second!.startsWith('x')).toBe(true);
    // 결합 표지 30개마다 CGJ (UAX #15 Stream-Safe Text Format). 원래 글자는 하나도 버리지 않는다
    for (const t of o.texts) expect(/(?:(?!͏)\p{M}){31}/u.test(t)).toBe(false);
    expect(first!.replace(/͏/g, '').length).toBe(n);
    expect(second!.replace(/͏/g, '').length).toBe(1 + 2 * n);
  }, 60_000);
});
