import { describe, expect, it, vi } from 'vitest';
import { zipEntries, type ZipEntry } from '../jobs/zip.js';
import { normalizeText } from '../pdf/normalize.js';
import { OfficeParseError } from './errors.js';
import { HWPX_EXTRACTOR, HWPX_LIMITS, processHwpx } from './hwpx.js';
import {
  RENDER_MODEL_VERSION,
  type Border,
  type FlowBlock,
  type FlowBox,
  type FlowDisplayRun,
  type FlowImage,
  type FlowModel,
  type FlowPara,
  type FlowTable,
  type FlowTableCell,
  type OfficeExtractResult,
  type TextPiece,
} from './model.js';

// ─────────────────────────────── 고정 자료 만들기 (실물 hwpx 구조를 따름) ───────────────────────────────

const DATE = new Date(1980, 0, 1);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
  'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ' +
  'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" ' +
  'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" ' +
  'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" ' +
  'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Bin {
  id: string;
  path: string;
  mediaType: string;
  data: Buffer;
}

function buildHwpx(o: {
  header: string;
  sections: string[];
  sectionNames?: string[];
  bins?: Bin[];
  /** false 면 Contents/content.hpf 를 넣지 않는다 */
  hpf?: boolean;
  manifestXml?: string;
  /** spine 에 넣을 항목 id (기본: section0.. 구역 순서대로) */
  spineIds?: string[];
}): Buffer {
  const secNames = o.sectionNames ?? o.sections.map((_, i) => `Contents/section${i}.xml`);
  const items = [
    '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>',
    ...(o.bins ?? []).map((b) => `<opf:item id="${b.id}" href="${b.path}" media-type="${b.mediaType}" isEmbeded="1"/>`),
    ...secNames.map((n, i) => `<opf:item id="section${i}" href="${n}" media-type="application/xml"/>`),
    '<opf:item id="settings" href="settings.xml" media-type="application/xml"/>',
  ];
  const spine = [
    '<opf:itemref idref="header" linear="yes"/>',
    ...(o.spineIds ?? secNames.map((_, i) => `section${i}`)).map((id) => `<opf:itemref idref="${id}" linear="yes"/>`),
  ];
  const hpf =
    `${DECL}<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title/>` +
    `<opf:language>ko</opf:language></opf:metadata><opf:manifest>${items.join('')}</opf:manifest>` +
    `<opf:spine>${spine.join('')}</opf:spine></opf:package>`;
  const entries: ZipEntry[] = [
    { name: 'mimetype', data: Buffer.from('application/hwp+zip') },
    {
      name: 'version.xml',
      data: Buffer.from(
        `${DECL}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" ` +
          'major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Hancom Office Hangul" ' +
          'appVersion="12, 0, 0, 0 WIN32LEWindows_10"/>',
      ),
    },
    { name: 'Contents/header.xml', data: Buffer.from(o.header) },
    ...o.sections.map((s, i) => ({ name: secNames[i]!, data: Buffer.from(s) })),
    ...(o.hpf === false ? [] : [{ name: 'Contents/content.hpf', data: Buffer.from(hpf) }]),
    ...(o.bins ?? []).map((b) => ({ name: b.path, data: b.data })),
    {
      name: 'settings.xml',
      data: Buffer.from(`${DECL}<ha:HWPApplicationSetting ${NS}><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`),
    },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        `${DECL}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" ` +
          'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" ' +
          'media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>',
      ),
    },
    {
      name: 'META-INF/manifest.xml',
      data: Buffer.from(o.manifestXml ?? `${DECL}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`),
    },
    { name: 'Preview/PrvText.txt', data: Buffer.from('미리보기 글자') },
  ];
  return zipEntries(entries.map((e) => ({ ...e, date: DATE })));
}

// 서식표 조각

interface CharOpt {
  height?: number;
  color?: string;
  font?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: string;
  strike?: string;
  sup?: boolean;
  relSz?: number;
  shade?: string;
}

function charPr(id: number, c: CharOpt = {}): string {
  const f = c.font ?? 0;
  const langs = (v: number | string): string =>
    ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'].map((l) => `${l}="${v}"`).join(' ');
  return (
    `<hh:charPr id="${id}" height="${c.height ?? 1000}" textColor="${c.color ?? '#000000'}" shadeColor="${c.shade ?? 'none'}" ` +
    'useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1">' +
    `<hh:fontRef hangul="${f}" latin="0" hanja="${f}" japanese="${f}" other="${f}" symbol="${f}" user="${f}"/>` +
    `<hh:ratio ${langs(100)}/><hh:spacing ${langs(0)}/>` +
    `<hh:relSz hangul="${c.relSz ?? 100}" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>` +
    `<hh:offset ${langs(0)}/>` +
    (c.bold ? '<hh:bold/>' : '') +
    (c.italic ? '<hh:italic/>' : '') +
    `<hh:underline type="${c.underline ?? 'NONE'}" shape="SOLID" color="#000000"/>` +
    `<hh:strikeout shape="${c.strike ?? 'NONE'}" color="#000000"/>` +
    '<hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>' +
    (c.sup ? '<hh:supscript/>' : '') +
    '</hh:charPr>'
  );
}

interface Margin {
  intent?: number;
  left?: number;
  right?: number;
  prev?: number;
  next?: number;
}

function margin(m: Margin, leftUnit = 'HWPUNIT'): string {
  return (
    `<hh:margin><hc:intent value="${m.intent ?? 0}" unit="HWPUNIT"/><hc:left value="${m.left ?? 0}" unit="${leftUnit}"/>` +
    `<hc:right value="${m.right ?? 0}" unit="HWPUNIT"/><hc:prev value="${m.prev ?? 0}" unit="HWPUNIT"/>` +
    `<hc:next value="${m.next ?? 0}" unit="HWPUNIT"/></hh:margin>`
  );
}

const lineSpacing = (type: string, value: number): string =>
  `<hh:lineSpacing type="${type}" value="${value}" unit="HWPUNIT"/>`;

/** 옛 값(hp:default)은 2배로 적힌다 */
const doubled = (m: Margin): Margin => ({
  intent: (m.intent ?? 0) * 2,
  left: (m.left ?? 0) * 2,
  right: (m.right ?? 0) * 2,
  prev: (m.prev ?? 0) * 2,
  next: (m.next ?? 0) * 2,
});

const unitSwitch = (caseBody: string, defaultBody: string): string =>
  '<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">' +
  `${caseBody}</hp:case><hp:default>${defaultBody}</hp:default></hp:switch>`;

const headingSwitch =
  '<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/paragraph">' +
  '<hh:heading type="NONE" idRef="0" level="0"/></hp:case><hp:default><hh:heading type="NONE" idRef="0" level="0"/>' +
  '</hp:default></hp:switch>';

function paraPr(id: number, align: string, body: string): string {
  return (
    `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">` +
    `<hh:align horizontal="${align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>` +
    '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" ' +
    'keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
    body +
    '<hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>' +
    '</hh:paraPr>'
  );
}

function borderFill(id: number, border: string, face?: string): string {
  return (
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
    ['left', 'right', 'top', 'bottom'].map((s) => `<hh:${s}Border type="${border}" width="0.12 mm" color="#000000"/>`).join('') +
    '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
    (face ? `<hc:fillBrush><hc:winBrush faceColor="${face}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : '') +
    '</hh:borderFill>'
  );
}

function header(chars: string[], paras: string[], fills: string[]): string {
  return (
    `${DECL}<hh:head ${NS} version="1.5" secCnt="2">` +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>' +
    '<hh:fontfaces itemCnt="2"><hh:fontface lang="HANGUL" fontCnt="2">' +
    '<hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" ' +
    'proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>' +
    '<hh:font id="1" face="맑은 고딕" type="TTF" isEmbedded="0"/></hh:fontface>' +
    '<hh:fontface lang="LATIN" fontCnt="1"><hh:font id="0" face="Times New Roman" type="TTF" isEmbedded="0"/></hh:fontface>' +
    '</hh:fontfaces>' +
    `<hh:borderFills itemCnt="${fills.length}">${fills.join('')}</hh:borderFills>` +
    `<hh:charProperties itemCnt="${chars.length}">${chars.join('')}</hh:charProperties>` +
    '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
    `<hh:paraProperties itemCnt="${paras.length}">${paras.join('')}</hh:paraProperties>` +
    '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" ' +
    'charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles></hh:refList>' +
    '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
    '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
    '<hh:trackchageConfig flags="56"/></hh:head>'
  );
}

const M1: Margin = { intent: -1500, left: 3000, right: 1500, prev: 750, next: 1500 };
const BASE_PARA = paraPr(
  0,
  'JUSTIFY',
  unitSwitch(margin({}) + lineSpacing('PERCENT', 160), margin({}) + lineSpacing('PERCENT', 160)),
);

const MAIN_HEADER = header(
  [
    charPr(0, { strike: '3D' }), // 바탕: 3D 는 취소선이 아니다
    charPr(1, { height: 1600, bold: true, color: '#C00000', font: 1 }),
    charPr(2, { italic: true, underline: 'BOTTOM', strike: 'SOLID' }),
    charPr(3, { sup: true, relSz: 90 }),
    charPr(4, { shade: '#FFFF00' }), // 글자 음영
  ],
  [
    BASE_PARA,
    paraPr(1, 'CENTER', unitSwitch(margin(M1) + lineSpacing('PERCENT', 130), margin(doubled(M1)) + lineSpacing('PERCENT', 130))),
    // 스위치 없는 옛 파일(xml 1.2, 1.3): 직접 값이 2배로 적혀 있다
    paraPr(2, 'RIGHT', margin({ intent: -2800, left: 7500 }) + lineSpacing('FIXED', 3600)),
    // 새 값이 글자(CHAR) 단위면 옛 값(반으로)을 쓴다
    paraPr(3, 'LEFT', unitSwitch(margin({ left: 200 }, 'CHAR') + lineSpacing('PERCENT', 160), margin({ left: 1500 }) + lineSpacing('PERCENT', 160))),
    // 스위치가 둘: 머리 번호용(paragraph 네임스페이스) + 단위용
    paraPr(4, 'DISTRIBUTE', headingSwitch + unitSwitch(margin({ prev: 1200 }) + lineSpacing('PERCENT', 150), margin({ prev: 2400 }) + lineSpacing('PERCENT', 150))),
  ],
  [borderFill(1, 'NONE'), borderFill(2, 'SOLID', '#D9E2F3'), borderFill(3, 'SOLID')],
);
const SIMPLE_HEADER = header([charPr(0)], [BASE_PARA], [borderFill(1, 'NONE'), borderFill(3, 'SOLID')]);

// 본문 조각

function para(inner: string, o: { pp?: number; pageBreak?: boolean } = {}): string {
  return (
    `<hp:p id="2147483648" paraPrIDRef="${o.pp ?? 0}" styleIDRef="0" pageBreak="${o.pageBreak ? 1 : 0}" columnBreak="0" merged="0">` +
    inner +
    '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" ' +
    'spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray></hp:p>'
  );
}
const run = (cp: number, inner: string): string => `<hp:run charPrIDRef="${cp}">${inner}</hp:run>`;
const t = (s: string): string => `<hp:t>${s}</hp:t>`;
const sec = (body: string): string => `${DECL}<hs:sec ${NS}>${body}</hs:sec>`;
const subList = (body: string): string =>
  '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" ' +
  `linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${body}</hp:subList>`;
const POS =
  '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" ' +
  'horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/>';
const absSz = (w: number, h: number): string =>
  `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`;
const MATRICES =
  '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" ' +
  'e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>';

function secPr(o: { landscape?: string; width?: number; height?: number; margin?: Record<string, number> } = {}): string {
  const m = { header: 4252, footer: 4252, gutter: 0, left: 8504, right: 8504, top: 5668, bottom: 4252, ...o.margin };
  return (
    '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" ' +
    'outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
    '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" ' +
    'hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
    '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
    `<hp:pagePr landscape="${o.landscape ?? 'WIDELY'}" width="${o.width ?? 59528}" height="${o.height ?? 84188}" gutterType="LEFT_ONLY">` +
    `<hp:margin header="${m.header}" footer="${m.footer}" gutter="${m.gutter}" left="${m.left}" right="${m.right}" ` +
    `top="${m.top}" bottom="${m.bottom}"/></hp:pagePr>` +
    '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
    '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" ' +
    'belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" ' +
    'beneathText="0"/></hp:footNotePr>' +
    '<hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">' +
    '<hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr>' +
    '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>'
  );
}

function cell(o: {
  col: number;
  row: number;
  colSpan?: number;
  rowSpan?: number;
  width: number;
  bf: number;
  body: string;
  header?: boolean;
}): string {
  return (
    `<hp:tc name="" header="${o.header ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${o.bf}">${subList(o.body)}` +
    `<hp:cellAddr colAddr="${o.col}" rowAddr="${o.row}"/><hp:cellSpan colSpan="${o.colSpan ?? 1}" rowSpan="${o.rowSpan ?? 1}"/>` +
    `<hp:cellSz width="${o.width}" height="1000"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`
  );
}

function table(o: { rows: string[]; cols: number; caption?: string }): string {
  return (
    '<hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ' +
    `dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${o.rows.length}" colCnt="${o.cols}" cellSpacing="0" ` +
    `borderFillIDRef="3" noAdjust="0">${absSz(45000, 3000)}${POS}${o.caption ?? ''}` +
    '<hp:inMargin left="510" right="510" top="141" bottom="141"/>' +
    o.rows.map((r) => `<hp:tr>${r}</hp:tr>`).join('') +
    '</hp:tbl>'
  );
}

function pic(ref: string, o: { sz?: [number, number]; cur: [number, number] }): string {
  const [cw, ch] = o.cur;
  return (
    '<hp:pic id="2" zOrder="1" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ' +
    'dropcapstyle="None" href="" groupLevel="0" instid="2" reverse="0">' +
    `<hp:offset x="0" y="0"/><hp:orgSz width="${cw}" height="${ch}"/><hp:curSz width="${cw}" height="${ch}"/>` +
    '<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="1"/>' +
    MATRICES +
    `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${cw}" y="0"/><hc:pt2 x="${cw}" y="${ch}"/><hc:pt3 x="0" y="${ch}"/></hp:imgRect>` +
    '<hp:imgClip left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>' +
    '<hp:imgDim dimwidth="0" dimheight="0"/>' +
    `<hc:img binaryItemIDRef="${ref}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>` +
    (o.sz ? absSz(o.sz[0], o.sz[1]) + POS : '') +
    '<hp:shapeComment>그림입니다. 원본 그림의 이름: 개체설명비밀.png</hp:shapeComment></hp:pic>'
  );
}

function textBox(body: string): string {
  return (
    '<hp:rect id="5" zOrder="2" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ' +
    'dropcapstyle="None" href="" groupLevel="0" instid="5" ratio="0">' +
    '<hp:offset x="0" y="0"/><hp:orgSz width="20000" height="5000"/><hp:curSz width="20000" height="5000"/>' +
    '<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="10000" centerY="2500" rotateimage="1"/>' +
    MATRICES +
    '<hp:lineShape color="#000000" width="33" style="SOLID" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" ' +
    'headfill="1" tailfill="1" headSz="MEDIUM_MEDIUM" tailSz="MEDIUM_MEDIUM" outlineStyle="NORMAL" alpha="0"/>' +
    '<hc:fillBrush><hc:winBrush faceColor="#FFFFFF" hatchColor="#000000" alpha="0"/></hc:fillBrush>' +
    '<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>' +
    `<hp:drawText lastWidth="20000" name="" editable="0">${subList(body)}` +
    '<hp:textMargin left="283" right="283" top="283" bottom="283"/></hp:drawText>' +
    '<hc:pt0 x="0" y="0"/><hc:pt1 x="20000" y="0"/><hc:pt2 x="20000" y="5000"/><hc:pt3 x="0" y="5000"/>' +
    absSz(20000, 5000) +
    POS +
    '<hp:shapeComment>사각형입니다.</hp:shapeComment></hp:rect>'
  );
}

// 정본 글자에 들어가면 안 되는 내용
const HEADER_CTRL = `<hp:ctrl><hp:header id="1" applyPageType="BOTH">${subList(para(run(0, t('머리말비밀'))))}</hp:header></hp:ctrl>`;
const FOOTER_CTRL = `<hp:ctrl><hp:footer id="2" applyPageType="BOTH">${subList(para(run(0, t('꼬리말비밀'))))}</hp:footer></hp:ctrl>`;
const FOOTNOTE_CTRL =
  `<hp:ctrl><hp:footNote number="1" suffixChar="41" instId="1">${subList(para(run(0, t('각주비밀'))))}</hp:footNote></hp:ctrl>`;
const ENDNOTE_IN_RUN = `<hp:endNote number="1" instId="2">${subList(para(run(0, t('미주비밀'))))}</hp:endNote>`;
const MEMO_BEGIN =
  '<hp:ctrl><hp:fieldBegin id="9" type="MEMO" name="" editable="1" dirty="0" zorder="-1" fieldid="0">' +
  `<hp:parameters cnt="0" name=""/>${subList(para(run(0, t('메모비밀'))))}</hp:fieldBegin></hp:ctrl>`;
const MEMO_END = '<hp:ctrl><hp:fieldEnd beginIDRef="9" fieldid="0"/></hp:ctrl>';
const EQUATION =
  '<hp:equation id="7" zOrder="3" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ' +
  'dropcapstyle="None" version="Equation Version 60" baseLine="85" textColor="#000000" baseUnit="1000" lineMode="CHAR" ' +
  `font="HYhwpEQ">${absSz(3000, 1500)}${POS}<hp:shapeComment>수식입니다.</hp:shapeComment>` +
  '<hp:script>수식비밀 over y</hp:script></hp:equation>';
const SECRETS = ['머리말비밀', '꼬리말비밀', '각주비밀', '미주비밀', '메모비밀', '수식비밀', '개체설명비밀', '사각형입니다', '그림입니다'];

const NFD_HANGUL = '한글'.normalize('NFD');

const MAIN_TABLE = table({
  cols: 3,
  caption:
    '<hp:caption side="TOP" fullSz="0" width="8504" gap="850" lastWidth="45000">' +
    `${subList(para(run(0, t('표 1. 장비 목록'))))}</hp:caption>`,
  rows: [
    cell({ col: 0, row: 0, colSpan: 2, width: 30000, bf: 2, body: para(run(1, t('항목'))), header: true }) +
      cell({ col: 2, row: 0, width: 15000, bf: 3, body: para(run(0, t('값'))), header: true }),
    cell({ col: 0, row: 1, rowSpan: 2, width: 15000, bf: 1, body: para(run(0, t('세로 병합'))) }) +
      cell({ col: 1, row: 1, width: 15000, bf: 3, body: para(run(0, t('가'))) + para(run(0, t('나'))) }) +
      cell({ col: 2, row: 1, width: 15000, bf: 3, body: para(run(0, '')) }),
    // 열 순서를 뒤섞어 적어도 colAddr 순으로 놓는다
    cell({ col: 2, row: 2, width: 15000, bf: 3, body: para(run(0, t('라'))) }) +
      cell({ col: 1, row: 2, width: 15000, bf: 3, body: para(run(0, t('다'))) }),
  ],
});

const SECTION0 = sec(
  para(run(0, secPr() + HEADER_CTRL + FOOTER_CTRL) + run(1, t('검사실 지침서'))) +
    para(run(0, t('일반 ')) + run(2, t('기울임&amp;밑줄')) + run(3, t('2')), { pp: 1 }) +
    para(
      run(
        0,
        t(
          '탭<hp:tab width="4000" leader="0" type="1"/>다음<hp:lineBreak/>줄<hp:nbSpace/>끝' +
            `<hp:markpenBegin color="#FFFF00"/>형광<hp:markpenEnd/>${NFD_HANGUL}​`,
        ),
      ),
    ) +
    para(run(0, '')) +
    para(run(0, FOOTNOTE_CTRL + t('각주 뒤') + MEMO_BEGIN + t(' 메모 붙은 글') + MEMO_END) + run(0, ENDNOTE_IN_RUN)) +
    para(run(0, t('둘째 쪽')), { pageBreak: true }) +
    para(run(0, MAIN_TABLE) + run(0, '<hp:t/>')) +
    para(run(0, t('그림 앞') + pic('image1', { sz: [15000, 7500], cur: [7500, 3750] }) + t('그림 뒤'))) +
    para(run(0, pic('image2', { sz: [3000, 3000], cur: [3000, 3000] }) + pic('image1', { cur: [3000, 1500] }))) +
    para(run(0, textBox(para(run(0, t('글상자 안')))) + EQUATION)),
);

const SECTION1 = sec(
  para(
    run(
      0,
      secPr({
        landscape: 'NARROWLY',
        margin: { header: 0, footer: 0, left: 5669, right: 5669, top: 2834, bottom: 2834 },
      }),
    ) + run(0, t('가로 구역 옛 문단')),
    { pp: 2, pageBreak: true },
  ) +
    para(run(0, t('글자 단위 여백')), { pp: 3 }) +
    para(run(0, t('스위치 ')) + run(4, t('둘')), { pp: 4 }),
);

const MAIN_BINS: Bin[] = [
  { id: 'image1', path: 'BinData/image1.png', mediaType: 'image/png', data: PNG_1PX },
  { id: 'image2', path: 'BinData/image2.wmf', mediaType: 'image/wmf', data: Buffer.from([0xd7, 0xcd, 0xc6, 0x9a]) },
];

// ─────────────────────────────── 불변식 검사 ───────────────────────────────

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp']);
const B1: Border = { w: 1, style: 'solid', color: '#000000' };

function collect(blocks: FlowBlock[], pieces: TextPiece[], imgs: FlowImage[], paras: FlowPara[]): void {
  for (const b of blocks) {
    if (b.type === 'p') {
      paras.push(b);
      for (const r of b.runs) pieces.push(r);
    } else if (b.type === 'img') {
      imgs.push(b);
    } else if (b.type === 'box') {
      collect(b.blocks, pieces, imgs, paras);
    } else {
      for (const row of b.rows) for (const c of row.cells) collect(c.blocks, pieces, imgs, paras);
    }
  }
}

/** 표시 전용 블록(머리말/꼬리말)의 조각: o 가 없어야 한다 */
function displayRuns(blocks: FlowBlock<FlowDisplayRun>[], out: FlowDisplayRun[]): void {
  for (const b of blocks) {
    if (b.type === 'p') out.push(...b.runs);
    else if (b.type === 'box') displayRuns(b.blocks, out);
    else if (b.type === 'table') for (const row of b.rows) for (const c of row.cells) displayRuns(c.blocks, out);
  }
}

/** 모든 결과에 공통: 쪽 번호, 조각 오프셋, 구분자 외 글자 없음, 정규화, media 참조, 상한, 표시 전용 조각 */
function checkInvariants(r: OfficeExtractResult): FlowModel {
  expect(r.fileKind).toBe('hwpx');
  expect(r.extractor).toBe(HWPX_EXTRACTOR);
  expect(r.renderMime).toBe('application/json');
  const m = JSON.parse(r.render.toString('utf8')) as FlowModel;
  expect(m.v).toBe(RENDER_MODEL_VERSION);
  expect(m.kind).toBe('flow');
  expect(m.truncated).toBe(r.truncated);
  expect(m.pages.length).toBe(r.pages.length);
  const problems: string[] = [];
  let total = 0;
  r.pages.forEach((pg, i) => {
    if (pg.pageNo !== i + 1) problems.push(`pageNo ${i}`);
    if (pg.label !== null) problems.push(`label ${i}`);
    const mp = m.pages[i]!;
    if (mp.pageNo !== i + 1) problems.push(`model pageNo ${i}`);
    total += pg.text.length;
    const pieces: TextPiece[] = [];
    const imgs: FlowImage[] = [];
    collect(mp.blocks, pieces, imgs, []);
    const covered = new Uint8Array(pg.text.length);
    let prevEnd = 0;
    for (const pc of pieces) {
      if (pc.t.length === 0) problems.push(`빈 조각 ${i + 1}쪽 ${pc.o}`);
      if (pg.text.slice(pc.o, pc.o + pc.t.length) !== pc.t) problems.push(`오프셋 ${i + 1}쪽 ${pc.o}`);
      if (pc.o < prevEnd) problems.push(`순서 ${i + 1}쪽 ${pc.o}`);
      prevEnd = pc.o + pc.t.length;
      covered.fill(1, pc.o, prevEnd);
    }
    for (let k = 0; k < pg.text.length; k += 1) {
      const ch = pg.text[k];
      if (!covered[k] && ch !== '\n' && ch !== '\t') {
        problems.push(`조각 밖 글자 ${i + 1}쪽 ${k}`);
        break;
      }
    }
    if (normalizeText(pg.text) !== pg.text) problems.push(`정규화 ${i + 1}쪽`);
    for (const img of imgs) {
      if (!(img.media >= 0 && img.media < m.media.length)) problems.push(`media 색인 ${i + 1}쪽`);
      if (!(img.w > 0 && img.h > 0)) problems.push(`그림 크기 ${i + 1}쪽`);
    }
    const shown: FlowDisplayRun[] = [];
    displayRuns([...(mp.header ?? []), ...(mp.footer ?? [])], shown);
    for (const d of shown) if ('o' in d) problems.push(`표시 전용 조각에 o ${i + 1}쪽`);
  });
  for (const md of m.media) if (!ALLOWED_MIME.has(md.mime)) problems.push(`mime ${md.mime}`);
  if (total > HWPX_LIMITS.text) problems.push('글자 상한 초과');
  expect(problems).toEqual([]);
  return m;
}

function parasOf(blocks: FlowBlock[]): FlowPara[] {
  const out: FlowPara[] = [];
  collect(blocks, [], [], out);
  return out;
}

/** 블록에서 runs/blocks 를 뺀 나머지(서식만) */
function propsOf(b: FlowBlock | FlowTableCell | undefined): Record<string, unknown> {
  const { runs: _r, blocks: _b, rows: _w, ...rest } = (b ?? {}) as Record<string, unknown>;
  return rest;
}

function runMain(): { r: OfficeExtractResult; m: FlowModel } {
  const r = processHwpx(buildHwpx({ header: MAIN_HEADER, sections: [SECTION0, SECTION1], bins: MAIN_BINS }), '지침서.hwpx');
  return { r, m: checkInvariants(r) };
}

// ─────────────────────────────── 테스트 ───────────────────────────────

describe('processHwpx: 쪽과 정본 글자', () => {
  it('구역 시작과 pageBreak 로 쪽을 나누고, 구역 첫 문단의 pageBreak 는 빈 쪽을 만들지 않는다', () => {
    const { r } = runMain();
    expect(r.truncated).toBeNull();
    expect(r.pages.map((p) => p.pageNo)).toEqual([1, 2, 3]);
    expect(r.pages[0]!.text).toBe('검사실 지침서\n일반 기울임&밑줄2\n탭\t다음\n줄 끝형광한글\n각주 뒤 메모 붙은 글');
    expect(r.pages[1]!.text).toBe(
      '둘째 쪽\n표 1. 장비 목록\n항목\t값\n세로 병합\t가\n나\n다\t라\n그림 앞\n그림 뒤\n글상자 안',
    );
    expect(r.pages[2]!.text).toBe('가로 구역 옛 문단\n글자 단위 여백\n스위치 둘');
  });

  it('각주, 미주, 메모, 수식, 개체 설명은 어디에도 없고, 머리말/꼬리말은 표시 전용 블록에만 있다', () => {
    const { r, m } = runMain();
    const all = r.pages.map((p) => p.text).join('\n');
    const body = JSON.stringify(m.pages.map((p) => p.blocks));
    const json = JSON.stringify(m);
    for (const s of SECRETS) {
      expect(all).not.toContain(s);
      expect(body).not.toContain(s);
      if (s !== '머리말비밀' && s !== '꼬리말비밀') expect(json).not.toContain(s);
    }
    expect(JSON.stringify(m.pages[0]!.header)).toContain('머리말비밀');
    expect(JSON.stringify(m.pages[0]!.footer)).toContain('꼬리말비밀');
  });

  it('NFD 한글은 NFC 로, 제로폭 문자는 지운 뒤 오프셋을 달고, 형광펜 구간은 조각을 나눠 바탕색을 단다', () => {
    const { r, m } = runMain();
    const p3 = m.pages[0]!.blocks[2] as FlowPara;
    expect(p3.runs.map((x) => [x.t, x.bg ?? null])).toEqual([
      ['탭\t다음\n줄 끝', null],
      ['형광', '#ffff00'],
      ['한글', null],
    ]);
    const last = p3.runs[2]!;
    expect(r.pages[0]!.text.indexOf('한글')).toBe(last.o);
  });
});

describe('processHwpx: 쪽 크기, 여백, 머리말/꼬리말', () => {
  it('A4 세로(WIDELY)는 그대로, NARROWLY 는 가로로 돌리고 위/아래 여백에 머리말/꼬리말을 더한다 (px, 96dpi)', () => {
    const { m } = runMain();
    const [p1, p2, p3] = m.pages;
    expect([p1!.w, p1!.h]).toEqual([793.7, 1122.5]);
    // [위, 오른쪽, 아래, 왼쪽]: 위 = 5668 + 4252, 아래 = 4252 + 4252
    expect(p1!.margin).toEqual([132.3, 113.4, 113.4, 113.4]);
    expect(p2!.margin).toEqual(p1!.margin);
    expect([p3!.w, p3!.h]).toEqual([1122.5, 793.7]);
    expect(p3!.margin).toEqual([37.8, 75.6, 37.8, 75.6]);
  });

  it('머리말/꼬리말은 o 없는 표시 블록으로 모든 쪽에 달리고 다음 구역에도 이어진다', () => {
    const { m } = runMain();
    const [p1, p2, p3] = m.pages;
    expect(p1!.header).toEqual([
      { type: 'p', align: 'justify', lineHeight: 1.6, runs: [{ t: '머리말비밀', sz: 10, font: '함초롬바탕' }] },
    ]);
    expect([p1!.headerDist, p1!.footerDist]).toEqual([75.6, 56.7]); // 종이 끝에서 5668, 4252
    expect(p2!.header).toEqual(p1!.header);
    expect(p3!.footer).toEqual(p1!.footer);
    expect([p3!.headerDist, p3!.footerDist]).toEqual([37.8, 37.8]);
  });
});

describe('processHwpx: 서식', () => {
  it('글자 모양: 크기(pt), 굵게, 기울임, 밑줄, 취소선(3D 제외), 색, 한글 글꼴, 위첨자(상대 크기), 음영', () => {
    const { m } = runMain();
    const title = m.pages[0]!.blocks[0] as FlowPara;
    expect(title.runs).toEqual([{ t: '검사실 지침서', o: 0, sz: 16, b: true, color: '#c00000', font: '맑은 고딕' }]);
    const mixed = m.pages[0]!.blocks[1] as FlowPara;
    expect(mixed.runs).toEqual([
      { t: '일반 ', o: 8, sz: 10, font: '함초롬바탕' },
      { t: '기울임&밑줄', o: 11, sz: 10, i: true, u: true, strike: true, font: '함초롬바탕' },
      { t: '2', o: 17, sz: 9, font: '함초롬바탕', sup: true },
    ]);
    const shaded = (m.pages[2]!.blocks[2] as FlowPara).runs[1]!;
    expect(shaded).toEqual({ t: '둘', o: 24, sz: 10, font: '함초롬바탕', bg: '#ffff00' }); // 10 + 1 + 8 + 1 + 4
  });

  it('문단 모양: 새 값(HwpUnitChar)은 그대로, 옛 값(default, 직접 자식)은 반으로, 고정 줄 간격은 linePx', () => {
    const { m } = runMain();
    expect(propsOf(m.pages[0]!.blocks[0])).toEqual({ type: 'p', align: 'justify', lineHeight: 1.6 });
    // intent -1500, left 3000, right 1500, prev 750, next 1500 HWPUNIT → px
    // 내어쓰기: 첫 줄은 left(40px)에서, 둘째 줄부터 left + |intent|(60px)에서 → marginLeft 60, indent -20
    expect(propsOf(m.pages[0]!.blocks[1])).toEqual({
      type: 'p',
      align: 'center',
      indent: -20,
      marginLeft: 60,
      marginRight: 20,
      spaceBefore: 10,
      spaceAfter: 20,
      lineHeight: 1.3,
    });
    const [legacy, charUnit, twoSwitches] = m.pages[2]!.blocks;
    // 직접 값 intent -2800, left 7500 → 반: -1400, 3750. FIXED 3600 → 1800 HWPUNIT = 24px
    // 내어쓰기라 marginLeft = 50 + 18.7
    expect(propsOf(legacy)).toEqual({ type: 'p', align: 'right', indent: -18.7, marginLeft: 68.7, linePx: 24 });
    // CHAR 단위 left 는 default 1500 의 반(750) → 10px, LEFT 정렬은 생략
    expect(propsOf(charUnit)).toEqual({ type: 'p', marginLeft: 10, lineHeight: 1.6 });
    expect(propsOf(twoSwitches)).toEqual({ type: 'p', align: 'justify', spaceBefore: 16, lineHeight: 1.5 });
  });

  it('빈 문단은 글자 없이 블록으로 남고, 문단 끝 글자 모양(sz, font)을 싣는다', () => {
    const { m } = runMain();
    const empty = m.pages[0]!.blocks[3] as FlowPara;
    expect(empty).toEqual({ type: 'p', align: 'justify', lineHeight: 1.6, sz: 10, font: '함초롬바탕', runs: [] });
  });
});

describe('processHwpx: 표, 그림, 글상자', () => {
  it('표: 병합 칸, 칸 너비, 배경색, 변별 테두리, 세로 정렬, 안쪽 여백, 행 높이, 머리글 행, 열 너비, 캡션은 표 앞', () => {
    const { m } = runMain();
    const blocks = m.pages[1]!.blocks;
    expect(blocks.map((b) => b.type)).toEqual(['p', 'p', 'table', 'p', 'img', 'p', 'img', 'box']);
    expect((blocks[1] as FlowPara).runs[0]!.t).toBe('표 1. 장비 목록');
    const tb = blocks[2] as FlowTable;
    expect(propsOf(tb)).toEqual({ type: 'table', colWidths: [200, 200, 200], width: 600 });
    expect(tb.rows.map((row) => row.cells.length)).toEqual([2, 3, 2]);
    expect(tb.rows.map((row) => [row.h, row.hRule, row.header ?? false])).toEqual([
      [13.3, 'atLeast', true],
      [13.3, 'atLeast', false],
      [13.3, 'atLeast', false],
    ]);
    const pad = [1.9, 6.8, 1.9, 6.8]; // 표 안쪽 여백 inMargin(510, 141) [위, 오른쪽, 아래, 왼쪽]
    const [c00, c02] = tb.rows[0]!.cells;
    expect(propsOf(c00)).toEqual({
      colSpan: 2,
      w: 400,
      bg: '#d9e2f3',
      border: true,
      bt: B1,
      br: B1,
      bb: B1,
      bl: B1,
      va: 'top',
      pad,
    });
    expect(propsOf(c02)).toEqual({ w: 200, border: true, bt: B1, br: B1, bb: B1, bl: B1, va: 'top', pad });
    expect(propsOf(tb.rows[1]!.cells[0])).toEqual({ rowSpan: 2, w: 200, border: false, va: 'top', pad });
    expect(tb.rows[1]!.cells[1]!.blocks).toHaveLength(2);
    expect(parasOf(tb.rows[2]!.cells[0]!.blocks)[0]!.runs[0]!.t).toBe('다');
  });

  it('그림: 허용 형식만 media 로, 같은 그림은 같은 색인, 크기는 sz 우선 없으면 curSz (px)', () => {
    const { m } = runMain();
    expect(m.media).toEqual([{ path: 'BinData/image1.png', mime: 'image/png' }]);
    const imgs = m.pages[1]!.blocks.filter((b): b is FlowImage => b.type === 'img');
    expect(imgs).toEqual([
      { type: 'img', media: 0, w: 200, h: 100 },
      { type: 'img', media: 0, w: 40, h: 20 },
    ]);
  });

  it('글상자는 FlowBox(너비, 테두리)로, 글자는 정본에 들어간다', () => {
    const { m } = runMain();
    const box = m.pages[1]!.blocks[7] as FlowBox;
    expect(propsOf(box)).toEqual({ type: 'box', w: 266.7, border: true });
    expect(parasOf(box.blocks).map((p) => p.runs.map((x) => x.t).join(''))).toEqual(['글상자 안']);
  });

  it('묶음 개체 안의 그림과 글상자, 표 안의 표를 제자리에 넣는다', () => {
    const group =
      '<hp:container id="8" zOrder="4" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ' +
      'dropcapstyle="None" href="" groupLevel="0" instid="8"><hp:offset x="0" y="0"/><hp:orgSz width="1" height="1"/>' +
      pic('image3', { cur: [7500, 7500] }) +
      textBox(para(run(0, t('묶음 글상자')))) +
      '</hp:container>';
    const inner = table({
      cols: 2,
      rows: [
        cell({ col: 0, row: 0, width: 7500, bf: 3, body: para(run(0, t('안1'))) }) +
          cell({ col: 1, row: 0, width: 7500, bf: 3, body: para(run(0, t('안2'))) }),
      ],
    });
    const outer = table({
      cols: 2,
      rows: [
        cell({ col: 0, row: 0, width: 15000, bf: 3, body: para(run(0, t('바깥'))) + para(run(0, inner)) }) +
          cell({ col: 1, row: 0, width: 15000, bf: 3, body: para(run(0, t('옆'))) }),
      ],
    });
    const r = processHwpx(
      buildHwpx({
        header: SIMPLE_HEADER,
        sections: [sec(para(run(0, secPr() + t('앞'))) + para(run(0, group)) + para(run(0, outer)) + para(run(0, t('끝'))))],
        bins: [{ id: 'image3', path: 'BinData/image3.gif', mediaType: 'image/gif', data: Buffer.from('GIF89a') }],
      }),
      'x.hwpx',
    );
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('앞\n묶음 글상자\n바깥\n안1\t안2\t옆\n끝');
    expect(m.pages[0]!.blocks.map((b) => b.type)).toEqual(['p', 'img', 'box', 'table', 'p']);
    expect(m.media).toEqual([{ path: 'BinData/image3.gif', mime: 'image/gif' }]);
  });

  it("파일 안 이름이 'constructor' 같은 객체 속성 이름이어도 값이 새어 나오지 않는다", () => {
    const r = processHwpx(
      buildHwpx({
        header: SIMPLE_HEADER,
        sections: [sec(para(run(0, secPr() + t('가<hp:constructor/>나<hp:toString/>다') + pic('image9', { cur: [750, 750] }))))],
        bins: [{ id: 'image9', path: 'BinData/image9.constructor', mediaType: 'image/png', data: PNG_1PX }],
      }),
      'x.hwpx',
    );
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('가나다');
    expect(m.media).toEqual([]);
  });
});

describe('processHwpx: 구역 순서와 목차', () => {
  const one = (s: string): string => sec(para(run(0, secPr() + t(s))));

  it('spine 순서를 따른다', () => {
    const r = processHwpx(
      buildHwpx({
        header: SIMPLE_HEADER,
        sections: [one('먼저'), one('나중')],
        sectionNames: ['Contents/section1.xml', 'Contents/section0.xml'],
      }),
      'x.hwpx',
    );
    checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(['먼저', '나중']);
  });

  it('목차(content.hpf)가 없으면 구역 번호 순(2 < 10), 그림은 BinData/<id>.* 로 찾는다', () => {
    const r = processHwpx(
      buildHwpx({
        header: SIMPLE_HEADER,
        sections: [one('열'), sec(para(run(0, secPr() + t('둘') + pic('image7', { cur: [750, 750] }))))],
        sectionNames: ['Contents/section10.xml', 'Contents/section2.xml'],
        bins: [{ id: 'image7', path: 'BinData/image7.jpg', mediaType: 'image/jpg', data: Buffer.from([0xff, 0xd8, 0xff]) }],
        hpf: false,
      }),
      'x.hwpx',
    );
    const m = checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(['둘', '열']);
    expect(m.media).toEqual([{ path: 'BinData/image7.jpg', mime: 'image/jpeg' }]);
    expect(m.pages[0]!.blocks.find((b) => b.type === 'img')).toEqual({ type: 'img', media: 0, w: 10, h: 10 });
  });

  it('접두사가 달라도 로컬 이름으로 읽는다', () => {
    const s = sec(para(run(0, secPr() + t('접두사')))).replace(/hp:/g, 'p:').replace(/hs:/g, 's:');
    const r = processHwpx(buildHwpx({ header: SIMPLE_HEADER, sections: [s] }), 'x.hwpx');
    checkInvariants(r);
    expect(r.pages[0]!.text).toBe('접두사');
  });
});

describe('processHwpx: 읽을 수 없는 파일', () => {
  it('ZIP 이 아니면 OfficeParseError', () => {
    expect(() => processHwpx(Buffer.from('not a zip at all'), 'x.hwpx')).toThrow(OfficeParseError);
  });

  it('본문 구역이 없으면 OfficeParseError', () => {
    const buf = zipEntries([
      { name: 'mimetype', data: Buffer.from('application/hwp+zip'), date: DATE },
      { name: 'Contents/header.xml', data: Buffer.from(SIMPLE_HEADER), date: DATE },
    ]);
    expect(() => processHwpx(buf, 'x.hwpx')).toThrow(/본문/);
  });

  it('구역 XML 이 깨졌거나 DOCTYPE(엔티티)이 있으면 OfficeParseError', () => {
    const broken = buildHwpx({ header: SIMPLE_HEADER, sections: [`${DECL}<hs:sec ${NS}><hp:p>`] });
    expect(() => processHwpx(broken, 'x.hwpx')).toThrow(OfficeParseError);
    const doctype = buildHwpx({
      header: SIMPLE_HEADER,
      sections: [`${DECL}<!DOCTYPE x [<!ENTITY e "y">]><hs:sec ${NS}><hp:p><hp:run><hp:t>&e;</hp:t></hp:run></hp:p></hs:sec>`],
    });
    expect(() => processHwpx(doctype, 'x.hwpx')).toThrow(/1번째 구역/);
  });

  it('암호 걸린 파일(manifest 에 encryption-data)은 암호 안내', () => {
    const enc = buildHwpx({
      header: SIMPLE_HEADER,
      sections: [sec(para(run(0, t('x'))))],
      manifestXml:
        `${DECL}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><odf:file-entry ` +
        'odf:full-path="Contents/section0.xml" odf:media-type="application/xml"><odf:encryption-data ' +
        'odf:checksum-type="SHA1" odf:checksum="x"/></odf:file-entry></odf:manifest>',
    });
    expect(() => processHwpx(enc, 'x.hwpx')).toThrow(/암호/);
  });

  it('서식표가 깨져도 본문은 읽는다(서식 없이)', () => {
    const r = processHwpx(buildHwpx({ header: '<hh:head><broken>', sections: [sec(para(run(0, t('본문만'))))] }), 'x.hwpx');
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('본문만');
    expect((m.pages[0]!.blocks[0] as FlowPara).runs[0]).toEqual({ t: '본문만', o: 0 });
  });
});

describe('processHwpx: 상한 (색인과 표시가 같은 범위로 잘린다)', () => {
  const tiny = (s: string, pageBreak = false): string =>
    `<hp:p paraPrIDRef="0" pageBreak="${pageBreak ? 1 : 0}"><hp:run charPrIDRef="0"><hp:t>${s}</hp:t></hp:run></hp:p>`;

  it(`문단 ${HWPX_LIMITS.paragraphs.toLocaleString('ko-KR')}개 상한`, () => {
    const body = Array.from({ length: HWPX_LIMITS.paragraphs + 1 }, () => tiny('p')).join('');
    const r = processHwpx(buildHwpx({ header: SIMPLE_HEADER, sections: [sec(body)] }), 'x.hwpx');
    const m = checkInvariants(r);
    expect(r.truncated).toMatch(/문단/);
    expect(parasOf(m.pages[0]!.blocks)).toHaveLength(HWPX_LIMITS.paragraphs);
    expect(r.pages[0]!.text.length).toBe(HWPX_LIMITS.paragraphs * 2 - 1);
  }, 60_000);

  it('글자 상한: 정확히 상한에서 자르고, 대리 쌍을 가르지 않는다', () => {
    const over = processHwpx(
      buildHwpx({ header: SIMPLE_HEADER, sections: [sec(tiny('a'.repeat(HWPX_LIMITS.text + 10)))] }),
      'x.hwpx',
    );
    checkInvariants(over);
    expect(over.truncated).toMatch(/글자/);
    expect(over.pages[0]!.text.length).toBe(HWPX_LIMITS.text);

    const emoji = processHwpx(
      buildHwpx({
        header: SIMPLE_HEADER,
        sections: [sec(tiny(`${'a'.repeat(HWPX_LIMITS.text - 1)}😀${'b'.repeat(10)}`))],
      }),
      'x.hwpx',
    );
    checkInvariants(emoji);
    expect(emoji.pages[0]!.text.length).toBe(HWPX_LIMITS.text - 1);
    expect(emoji.pages[0]!.text.endsWith('a')).toBe(true);
  }, 60_000);

  it('글자 상한은 쪽을 넘어 합산하고, 뒤 쪽은 버린다', () => {
    const big = 2_000_000;
    const r = processHwpx(
      buildHwpx({
        header: SIMPLE_HEADER,
        sections: [sec(tiny('a'.repeat(big)) + tiny('b'.repeat(big), true) + tiny('c', true))],
      }),
      'x.hwpx',
    );
    checkInvariants(r);
    expect(r.pages.map((p) => p.text.length)).toEqual([big, HWPX_LIMITS.text - big]);
    expect(r.truncated).toMatch(/글자/);
  }, 60_000);

  it(`쪽 ${HWPX_LIMITS.pages.toLocaleString('ko-KR')}개 상한`, () => {
    const body = Array.from({ length: HWPX_LIMITS.pages + 1 }, (_, i) => tiny(`쪽${i + 1}`, true)).join('');
    const r = processHwpx(buildHwpx({ header: SIMPLE_HEADER, sections: [sec(body)] }), 'x.hwpx');
    checkInvariants(r);
    expect(r.pages).toHaveLength(HWPX_LIMITS.pages);
    expect(r.truncated).toMatch(/쪽/);
    expect(r.pages[HWPX_LIMITS.pages - 1]!.text).toBe(`쪽${HWPX_LIMITS.pages}`);
  }, 60_000);

  it('머리말이 표시 상한을 넘으면 싣지 않는다(쪽마다 되풀이되므로)', () => {
    const bigHeader =
      '<hp:ctrl><hp:header id="1" applyPageType="BOTH">' +
      subList(Array.from({ length: 60 }, (_, i) => para(run(0, t(`머리${i}`)))).join('')) +
      '</hp:header></hp:ctrl>';
    const r = processHwpx(
      buildHwpx({ header: SIMPLE_HEADER, sections: [sec(para(run(0, secPr() + bigHeader) + run(0, t('본문'))))] }),
      'x.hwpx',
    );
    const m = checkInvariants(r);
    expect(m.pages[0]!.header).toBeUndefined();
    expect(r.pages[0]!.text).toBe('본문');
  });

  it('머리말 정의 하나가 노드 상한을 넘어도 싣지 않는다(모양이 번갈아 바뀌는 조각)', () => {
    const runs = Array.from({ length: 500 }, (_, i) => run(i % 2, t('머'))).join('');
    const hdr = `<hp:ctrl><hp:header id="1" applyPageType="BOTH">${subList(para(runs))}</hp:header></hp:ctrl>`;
    const r = processHwpx(
      buildHwpx({ header: MAIN_HEADER, sections: [sec(para(run(0, secPr() + hdr) + run(0, t('본문'))))] }),
      'x.hwpx',
    );
    const m = checkInvariants(r);
    expect(m.pages[0]!.header).toBeUndefined();
    expect(r.truncated).toBeNull();
  });
});

// ─────────────────────── 자원 상한: 작은 파일이 서버를 오래 붙잡거나 메모리를 다 쓰지 않는다 ───────────────────────

/** 모델 노드 수 (블록, 글자 조각, 표 행, 칸) */
function countNodes(blocks: FlowBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    n += 1;
    if (b.type === 'p') n += b.runs.length;
    else if (b.type === 'box') n += countNodes(b.blocks);
    else if (b.type === 'table') for (const row of b.rows) n += 1 + row.cells.reduce((s, c) => s + 1 + countNodes(c.blocks), 0);
  }
  return n;
}

describe('processHwpx: 자원 상한', () => {
  it("속성 자리에 '=' 없는 긴 토큰이 있어도 선형 시간에 읽고, 그 뒤의 속성도 찾는다", () => {
    const body =
      `<hp:p ${'x'.repeat(200_000)} paraPrIDRef="1" pageBreak="0">` +
      `<hp:run z=q"${'w'.repeat(200_000)}" charPrIDRef="1"><hp:t>가</hp:t></hp:run></hp:p>`;
    const buf = buildHwpx({ header: MAIN_HEADER, sections: [sec(body)] });
    const t0 = performance.now();
    const r = processHwpx(buf, 'x.hwpx');
    const ms = performance.now() - t0;
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('가');
    const p = m.pages[0]!.blocks[0] as FlowPara;
    expect(p.align).toBe('center');
    expect(p.runs[0]).toMatchObject({ t: '가', sz: 16, b: true });
    expect(ms).toBeLessThan(2_000); // 정규식 되짚기로는 수십 초가 걸리던 입력
  }, 60_000);

  it(`빈 칸만 많은 표도 노드 ${HWPX_LIMITS.nodes.toLocaleString('ko-KR')}개에서 멈추고 렌더 크기가 묶인다`, () => {
    const rows = Math.ceil((HWPX_LIMITS.nodes + 10_000) / 100);
    const tr = `<hp:tr>${'<hp:tc/>'.repeat(100)}</hp:tr>`;
    const tbl =
      `<hp:tbl colCnt="100"><hp:inMargin left="510" right="510" top="141" bottom="141"/>${tr.repeat(rows)}</hp:tbl>`;
    const r = processHwpx(
      buildHwpx({ header: SIMPLE_HEADER, sections: [sec(para(run(0, secPr() + t('앞') + tbl)))] }),
      'x.hwpx',
    );
    const m = checkInvariants(r);
    expect(r.truncated).toMatch(/구성 요소가 많아/);
    expect(r.pages[0]!.text).toBe('앞');
    const nodes = countNodes(m.pages[0]!.blocks);
    expect(nodes).toBeGreaterThan(HWPX_LIMITS.nodes * 0.9);
    expect(nodes).toBeLessThanOrEqual(HWPX_LIMITS.nodes + 2);
    expect(r.render.length).toBeLessThan(20 * 1024 * 1024);
  }, 60_000);

  it('모양이 같은 이웃 조각은 하나로 합친다', () => {
    const body = para(run(0, secPr()) + Array.from({ length: 1000 }, () => run(0, t('가'))).join(''));
    const r = processHwpx(buildHwpx({ header: SIMPLE_HEADER, sections: [sec(body)] }), 'x.hwpx');
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('가'.repeat(1000));
    expect((m.pages[0]!.blocks[0] as FlowPara).runs).toEqual([{ t: '가'.repeat(1000), o: 0, sz: 10, font: '함초롬바탕' }]);
  });

  it('모양이 번갈아 바뀌는 조각이 많으면 노드 상한에서 멈춘다(색인과 표시가 같은 자리)', () => {
    const body = para(
      run(0, secPr()) + Array.from({ length: HWPX_LIMITS.nodes + 10 }, (_, i) => run(i % 2, t('가'))).join(''),
    );
    const r = processHwpx(buildHwpx({ header: MAIN_HEADER, sections: [sec(body)] }), 'x.hwpx');
    const m = checkInvariants(r);
    expect(r.truncated).toMatch(/구성 요소가 많아/);
    const runs = (m.pages[0]!.blocks[0] as FlowPara).runs;
    expect(runs.length).toBeLessThanOrEqual(HWPX_LIMITS.nodes);
    expect(runs.length).toBeGreaterThan(HWPX_LIMITS.nodes * 0.9);
    expect(r.pages[0]!.text).toBe('가'.repeat(runs.length));
    expect(r.render.length).toBeLessThan(40 * 1024 * 1024);
  }, 60_000);

  it('쪽마다 되풀이되는 머리말은 합계 분량 상한까지만 앞쪽부터 달고 안내한다', () => {
    const hdrRuns = Array.from({ length: 300 }, (_, i) => run(i % 2, t('머'))).join('');
    const hdr = `<hp:ctrl><hp:header id="1" applyPageType="BOTH">${subList(para(hdrRuns))}</hp:header></hp:ctrl>`;
    const body =
      para(run(0, secPr() + hdr) + run(0, t('쪽1'))) +
      Array.from({ length: HWPX_LIMITS.pages - 1 }, (_, i) => para(run(0, t(`쪽${i + 2}`)), { pageBreak: true })).join('');
    const r = processHwpx(buildHwpx({ header: MAIN_HEADER, sections: [sec(body)] }), 'x.hwpx');
    const m = checkInvariants(r);
    expect(r.pages).toHaveLength(HWPX_LIMITS.pages);
    const shown = m.pages.filter((p) => p.header).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(HWPX_LIMITS.pages);
    expect(m.pages.slice(0, shown).every((p) => p.header && p.headerDist !== undefined)).toBe(true);
    expect(m.pages.slice(shown).some((p) => p.header || p.headerDist !== undefined)).toBe(false);
    expect(r.truncated).toBe(`머리말/꼬리말은 분량이 커서 ${shown.toLocaleString('ko-KR')}쪽까지만 보여줍니다.`);
    expect(r.render.length).toBeLessThan(8 * 1024 * 1024);
  }, 60_000);

  it('spine 이 길어도 구역은 쪽 상한 + 1 개까지만 모아 빠르게 읽는다', () => {
    const n = 5_000;
    const light = `${DECL}<hs:sec><hp:p><hp:run><hp:t>x</hp:t></hp:run></hp:p></hs:sec>`;
    const buf = buildHwpx({
      header: SIMPLE_HEADER,
      sections: Array.from({ length: n }, () => light),
      spineIds: Array.from({ length: 200_000 }, (_, i) => `section${i % n}`),
    });
    const t0 = performance.now();
    const r = processHwpx(buf, 'x.hwpx');
    const ms = performance.now() - t0;
    expect(r.pages).toHaveLength(HWPX_LIMITS.pages);
    expect(r.truncated).toMatch(/쪽이 많아/);
    expect(ms).toBeLessThan(3_000); // Array.includes 로 중복을 거르면 6초 넘게 걸리던 입력
  }, 60_000);

  it('spine 에 같은 구역이 여러 번 나오면 처음 자리에서 한 번만 읽는다', () => {
    const one = (s: string): string => sec(para(run(0, secPr() + t(s))));
    const r = processHwpx(
      buildHwpx({
        header: SIMPLE_HEADER,
        sections: [one('영'), one('일')],
        spineIds: ['section1', 'section0', 'section1', 'section0'],
      }),
      'x.hwpx',
    );
    checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(['일', '영']);
  });

  it(`구역 XML 의 '<' 가 ${HWPX_LIMITS.partTags.toLocaleString('ko-KR')}개를 넘으면 첫 구역은 오류, 뒤 구역은 거기서 멈추고 안내한다`, () => {
    const big = `${DECL}<hs:sec>${'<hp:x/>'.repeat(HWPX_LIMITS.partTags + 1)}</hs:sec>`;
    const later = processHwpx(
      buildHwpx({ header: SIMPLE_HEADER, sections: [sec(para(run(0, secPr() + t('앞 구역')))), big] }),
      'x.hwpx',
    );
    checkInvariants(later);
    expect(later.pages.map((p) => p.text)).toEqual(['앞 구역']);
    expect(later.truncated).toMatch(/앞 1개 구역만/);
    expect(() => processHwpx(buildHwpx({ header: SIMPLE_HEADER, sections: [big] }), 'x.hwpx')).toThrow(/1번째 구역/);
  }, 60_000);

  it('렌더 JSON 이 문자열 길이 한계를 넘으면(RangeError) 사용자 안내 오류로 바꾼다', () => {
    const buf = buildHwpx({ header: SIMPLE_HEADER, sections: [sec(para(run(0, secPr() + t('본문'))))] });
    const spy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new RangeError('Invalid string length');
    });
    let err: unknown;
    try {
      processHwpx(buf, 'x.hwpx');
    } catch (e) {
      err = e;
    } finally {
      spy.mockRestore();
    }
    expect(err).toBeInstanceOf(OfficeParseError);
    expect((err as Error).message).toMatch(/너무 커서/);
  });

  it('표가 24겹보다 깊게 겹치면 그 안은 색인과 표시에서 함께 빼고 안내한다', () => {
    let inner = t('깊은글자');
    for (let i = 0; i < 30; i += 1) {
      inner = table({ cols: 1, rows: [cell({ col: 0, row: 0, width: 7500, bf: 3, body: para(run(0, inner)) })] });
    }
    const r = processHwpx(
      buildHwpx({
        header: SIMPLE_HEADER,
        sections: [sec(para(run(0, secPr() + t('앞'))) + para(run(0, inner)) + para(run(0, t('뒤'))))],
      }),
      'x.hwpx',
    );
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('앞\n뒤');
    expect(JSON.stringify(m)).not.toContain('깊은글자');
    expect(r.truncated).toBe('표, 글상자가 24겹보다 깊게 겹친 부분은 빼고 색인하고 보여줍니다.');
  });
});

describe('processHwpx: 조각 경계 정규화, 덧말, 칸 영역', () => {
  it('조각 경계에서 NFC 로 합쳐지는 글자(나뉜 자모, 음절 + 종성, 결합 문자)는 앞 조각에 붙여 다시 정규화한다', () => {
    const L = String.fromCharCode(0x1112); // 초성 ㅎ (조합형 자모)
    const VT = String.fromCharCode(0x1161, 0x11ab); // 중성 ㅏ + 종성 ㄴ
    const T = String.fromCharCode(0x11ab); // 종성 ㄴ
    const ACUTE = String.fromCharCode(0x0301); // 결합 악센트
    const CAFE = `caf${String.fromCharCode(0xe9)} au lait`; // 미리 합친 e + 악센트
    const body =
      para(run(0, secPr() + t(L)) + run(1, t(VT))) + // 초성 | 중성 + 종성 (모양이 다른 조각)
      para(run(0, t('하')) + run(1, t(`${T}글`))) + // 음절 | 종성
      para(run(0, t(`${L}<hp:markpenBegin color="#FFFF00"/>${VT}<hp:markpenEnd/>뒤`))) + // 형광펜 경계
      para(run(0, t('cafe')) + run(1, t(`${ACUTE} au lait`))) + // 결합 악센트
      para(run(0, t('보통')) + run(1, t('경계'))); // 합쳐지지 않는 경계는 그대로
    const r = processHwpx(buildHwpx({ header: MAIN_HEADER, sections: [sec(body)] }), 'x.hwpx');
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe(`한\n한글\n한뒤\n${CAFE}\n보통경계`);
    expect(r.pages[0]!.text.includes('한')).toBe(true); // 미리 합친 음절로 검색된다
    const looks = m.pages[0]!.blocks.map((b) => (b as FlowPara).runs.map((x) => [x.t, x.b ?? false, x.bg ?? null]));
    expect(looks).toEqual([
      [['한', false, null]],
      [['한글', false, null]],
      [
        ['한', false, null],
        ['뒤', false, null],
      ],
      [[CAFE, false, null]],
      [
        ['보통', false, null],
        ['경계', true, null],
      ],
    ]);
  });

  it('덧말(dutmal)은 본말만 본문 글자로 넣는다', () => {
    const dut =
      '<hp:dutmal posType="TOP" szRatio="0" option="0" styleIDRef="0" align="CENTER">' +
      '<hp:mainText>본말</hp:mainText><hp:subText>덧말비밀</hp:subText></hp:dutmal>';
    const r = processHwpx(
      buildHwpx({ header: SIMPLE_HEADER, sections: [sec(para(run(0, secPr() + t('앞') + dut + t('뒤'))))] }),
      'x.hwpx',
    );
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('앞본말뒤');
    expect(JSON.stringify(m)).not.toContain('덧말비밀');
  });

  it('칸 영역(cellzone)의 배경색은 자기 배경이 없는 칸에만 옮기고, 테두리는 칸 자체 것을 쓴다', () => {
    const fills = [borderFill(1, 'NONE'), borderFill(2, 'SOLID', '#D9E2F3'), borderFill(3, 'SOLID'), borderFill(4, 'DASH', '#FFC000')];
    const H = header([charPr(0)], [BASE_PARA], fills);
    const c = (col: number, row: number, bf: number, s: string): string =>
      cell({ col, row, width: 7500, bf, body: para(run(0, t(s))) });
    const tbl =
      `<hp:tbl id="1" rowCnt="2" colCnt="2" repeatHeader="0" borderFillIDRef="3">${absSz(15000, 2000)}${POS}` +
      '<hp:inMargin left="510" right="510" top="141" bottom="141"/>' +
      '<hp:cellzoneList><hp:cellzone startRowAddr="0" startColAddr="0" endRowAddr="0" endColAddr="1" borderFillIDRef="4"/>' +
      '</hp:cellzoneList>' +
      `<hp:tr>${c(0, 0, 1, '가')}${c(1, 0, 2, '나')}</hp:tr><hp:tr>${c(0, 1, 1, '다')}${c(1, 1, 1, '라')}</hp:tr></hp:tbl>`;
    const r = processHwpx(buildHwpx({ header: H, sections: [sec(para(run(0, secPr() + tbl)))] }), 'x.hwpx');
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('가\t나\n다\t라');
    const tb = m.pages[0]!.blocks.find((b): b is FlowTable => b.type === 'table')!;
    const props = tb.rows.map((row) => row.cells.map((x) => [x.bg ?? null, x.border ?? null, x.bt ?? null]));
    expect(props).toEqual([
      [
        ['#ffc000', false, null],
        ['#d9e2f3', true, B1],
      ],
      [
        [null, false, null],
        [null, false, null],
      ],
    ]);
  });
});
