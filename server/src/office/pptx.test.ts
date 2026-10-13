import { describe, expect, it, vi } from 'vitest';
import { zipEntries } from '../jobs/zip.js';
import { normalizeText } from '../pdf/normalize.js';
import { OfficeParseError } from './errors.js';
import type {
  OfficeExtractResult,
  SlidePage,
  SlidePara,
  SlideRun,
  SlidesModel,
  SlideTableShape,
  SlideTextShape,
} from './model.js';
import { PPTX_EXTRACTOR, PPTX_LIMITS, processPptx } from './pptx.js';

// ─────────────────────────────── 고정물(fixture) 도우미 ───────────────────────────────

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const FIXED_DATE = new Date(1980, 0, 1);

/** 1x1 PNG (실제로 열리는 바이트) */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
/** EMF 머리(레코드 1 + ' EMF' 서명): 허용 형식이 아니다 */
const EMF_BYTES = Buffer.concat([Buffer.from([1, 0, 0, 0, 108, 0, 0, 0]), Buffer.alloc(32), Buffer.from(' EMF', 'latin1')]);

function zip(files: Record<string, string | Buffer>): Buffer {
  return zipEntries(
    Object.entries(files).map(([name, data]) => ({
      name,
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      date: FIXED_DATE,
    })),
  );
}

/** [Id, 관계 형식 끝 이름, 대상] */
function rels(list: [string, string, string][]): string {
  const items = list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${RT}/${type}" Target="${target}"/>`);
  return `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

let nextId = 2;
const NV_TAG = { sp: 'nvSpPr', pic: 'nvPicPr', graphicFrame: 'nvGraphicFramePr', grpSp: 'nvGrpSpPr', cxnSp: 'nvCxnSpPr' };
const CNV_TAG = { sp: 'cNvSpPr', pic: 'cNvPicPr', graphicFrame: 'cNvGraphicFramePr', grpSp: 'cNvGrpSpPr', cxnSp: 'cNvCxnSpPr' };

function nv(tag: keyof typeof NV_TAG, opts: { ph?: string; hidden?: boolean } = {}): string {
  const id = nextId++;
  const hidden = opts.hidden ? ' hidden="1"' : '';
  return (
    `<p:${NV_TAG[tag]}><p:cNvPr id="${id}" name="S${id}"${hidden}/><p:${CNV_TAG[tag]}/>` +
    `<p:nvPr>${opts.ph ?? ''}</p:nvPr></p:${NV_TAG[tag]}>`
  );
}

const xfrm = (x: number, y: number, w: number, h: number): string =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;

interface SpOpts {
  ph?: string;
  xfrm?: string;
  spPr?: string;
  style?: string;
  bodyPr?: string;
  lst?: string;
  body?: string;
  hidden?: boolean;
}

function sp(o: SpOpts): string {
  const tx = o.body === undefined ? '' : `<p:txBody>${o.bodyPr ?? '<a:bodyPr/>'}<a:lstStyle>${o.lst ?? ''}</a:lstStyle>${o.body}</p:txBody>`;
  return `<p:sp>${nv('sp', o)}<p:spPr>${o.xfrm ?? ''}${o.spPr ?? ''}</p:spPr>${o.style ?? ''}${tx}</p:sp>`;
}

const para = (inner: string, pPr = ''): string => `<a:p>${pPr}${inner}</a:p>`;
const run = (t: string, rPr = '<a:rPr lang="ko-KR"/>'): string => `<a:r>${rPr}<a:t>${t}</a:t></a:r>`;

function pic(rid: string, x: number, y: number, w: number, h: number, ph = ''): string {
  return (
    `<p:pic>${nv('pic', { ph })}<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

function frame(x: number, y: number, w: number, h: number, graphicData: string): string {
  return (
    `<p:graphicFrame>${nv('graphicFrame')}<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>` +
    `<a:graphic>${graphicData}</a:graphic></p:graphicFrame>`
  );
}

const TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function sld(shapes: string, o: { attrs?: string; bg?: string } = {}): string {
  return (
    `${HEAD}<p:sld ${NS}${o.attrs ?? ''}><p:cSld>${o.bg ?? ''}<p:spTree>${TREE_HEAD}${shapes}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

const CONTENT_TYPES =
  `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
  '<Default Extension="emf" ContentType="image/x-emf"/>' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  '</Types>';

const ROOT_RELS = rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]);

/**
 * 프레젠테이션 묶음. slides[i] 는 ppt/slides/slide{i+1}.xml, order 는 발표 순서(slides 색인).
 * 관계 Id: rId1 = 마스터, rId{10+i} = slide{i+1}.
 */
function deckZip(o: {
  slides: { xml: string; rels?: [string, string, string][] }[];
  order?: number[];
  sldSz?: string;
  withMaster?: boolean;
  extra?: Record<string, string | Buffer>;
  sldIdLst?: string;
}): Buffer {
  const order = o.order ?? o.slides.map((_, i) => i);
  const ids = order.map((i, k) => `<p:sldId id="${256 + k}" r:id="rId${10 + i}"/>`).join('');
  const pres =
    `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `${o.sldIdLst ?? `<p:sldIdLst>${ids}</p:sldIdLst>`}${o.sldSz ?? '<p:sldSz cx="9144000" cy="6858000"/>'}` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '<p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>';
  const presRels: [string, string, string][] = [['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml']];
  o.slides.forEach((_, i) => presRels.push([`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`]));
  const files: Record<string, string | Buffer> = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'ppt/presentation.xml': pres,
    'ppt/_rels/presentation.xml.rels': rels(presRels),
  };
  o.slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = s.xml;
    const r = s.rels ?? (o.withMaster ? [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']] : []);
    if (r.length > 0) files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels(r as [string, string, string][]);
  });
  if (o.withMaster) Object.assign(files, MASTER_FILES);
  return zip({ ...files, ...(o.extra ?? {}) });
}

// ─────────────────────────────── 테마, 마스터, 레이아웃 ───────────────────────────────

const THEME =
  `${HEAD}<a:theme ${NS} name="T"><a:themeElements><a:clrScheme name="C">` +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="F"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/>' +
  '<a:font script="Hang" typeface="맑은 고딕"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/>' +
  '<a:cs typeface=""/><a:font script="Hang" typeface="맑은 고딕"/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="M"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>' +
  '</a:themeElements></a:theme>';

const MASTER =
  `${HEAD}<p:sldMaster ${NS}><p:cSld>` +
  '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
  `<p:spTree>${TREE_HEAD}` +
  sp({
    ph: '<p:ph type="title"/>',
    xfrm: xfrm(838200, 365125, 10515600, 1325563),
    bodyPr: '<a:bodyPr anchor="ctr"/>',
    body: para(run('마스터 제목 스타일')),
  }) +
  sp({
    ph: '<p:ph type="body" idx="1"/>',
    xfrm: xfrm(838200, 1825625, 10515600, 4351338),
    body: para(run('마스터 텍스트 스타일')),
  }) +
  // 장식: 글자 없는 색 막대(그린다), 글자 있는 도형(넣지 않는다), 로고 그림(그린다)
  sp({ xfrm: xfrm(0, 6500000, 9144000, 358000), spPr: '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>' }) +
  sp({ xfrm: xfrm(0, 0, 3000000, 300000), body: para(run('병원 이름')) }) +
  pic('rId3', 8500000, 6500000, 300000, 300000) +
  '</p:spTree></p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles>' +
  '<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
  '<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="•"/>' +
  '<a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/>' +
  '<a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600">' +
  '<a:buFont typeface="Courier New"/><a:buChar char="o"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';

const LAYOUT =
  `${HEAD}<p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${TREE_HEAD}` +
  sp({
    ph: '<p:ph type="title"/>',
    xfrm: xfrm(457200, 274638, 8229600, 1143000),
    lst: '<a:lvl1pPr algn="ctr"/>',
    body: para(''),
  }) +
  // 본문 개체 틀: 위치 없음(마스터에서), 글자 크기 20pt
  sp({ ph: '<p:ph idx="1"/>', lst: '<a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr>', body: para('') }) +
  sp({ xfrm: xfrm(100, 200, 300, 400), spPr: '<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>' }) +
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const MASTER_FILES: Record<string, string | Buffer> = {
  'ppt/slideMasters/slideMaster1.xml': MASTER,
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
    ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
    ['rId2', 'theme', '../theme/theme1.xml'],
    ['rId3', 'image', '../media/image1.png'],
  ]),
  'ppt/slideLayouts/slideLayout1.xml': LAYOUT,
  'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  'ppt/theme/theme1.xml': THEME,
  'ppt/media/image1.png': PNG_1PX,
};

// ─────────────────────────────── 주 고정물: 두 슬라이드 ───────────────────────────────

const cell = (t: string, attrs = '', tcPr = ''): string =>
  `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${para(t === '' ? '' : run(t))}</a:txBody>${tcPr || '<a:tcPr/>'}</a:tc>`;
const cellParas = (ts: string[]): string =>
  `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${ts.map((t) => para(run(t))).join('')}</a:txBody><a:tcPr/></a:tc>`;

const TABLE_DATA =
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/>' +
  '<a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>' +
  `<a:tr h="370840">${cell('항목', ' gridSpan="2"')}${cell('숨김', ' hMerge="1"')}` +
  `${cell('결과', '', '<a:tcPr><a:solidFill><a:srgbClr val="D9E2F3"/></a:solidFill></a:tcPr>')}</a:tr>` +
  `<a:tr h="370840">${cell('A', ' rowSpan="2"')}${cell('B')}${cell('')}</a:tr>` +
  `<a:tr h="400000">${cell('', ' vMerge="1"')}${cellParas(['C1', 'C2'])}${cell('D')}</a:tr>` +
  '</a:tbl></a:graphicData>';

const STYLE_REFS =
  '<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef>' +
  '<a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef>' +
  '<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>';

/** slide1.xml: 발표 순서 2번, 숨김, 표, 그림, 차트, SmartArt */
const SLIDE_FILE1 = sld(
  frame(500000, 600000, 6000000, 1500000, TABLE_DATA) +
    pic('rId2', 7000000, 600000, 1000000, 1000000) +
    pic('rId3', 7000000, 1700000, 1000000, 1000000) + // 같은 그림을 다른 관계 Id 로
    pic('rId7', 7000000, 2800000, 1000000, 1000000) + // 확장자는 png, 내용은 gif
    pic('rId4', 7000000, 3900000, 1000000, 1000000) + // emf: 미지원
    frame(
      500000,
      2500000,
      3000000,
      2000000,
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
        '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId5"/></a:graphicData>',
    ) +
    frame(
      3600000,
      2500000,
      3000000,
      2000000,
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
        '<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId8" r:lo="rId9" r:qs="rId10" r:cs="rId11"/>' +
        '</a:graphicData>',
    ) +
    `<p:cxnSp>${nv('cxnSp')}<p:spPr>${xfrm(0, 0, 100, 100)}</p:spPr></p:cxnSp>` +
    sp({ hidden: true, xfrm: xfrm(0, 0, 100, 100), body: para(run('숨긴 도형')) }) +
    sp({ xfrm: xfrm(500000, 4800000, 3000000, 800000), style: STYLE_REFS, body: para(run('스타일 도형')) }),
  { attrs: ' show="0"', bg: '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' },
);

const GROUP =
  `<p:grpSp>${nv('grpSp')}<p:grpSpPr><a:xfrm><a:off x="1000000" y="2000000"/><a:ext cx="2000000" cy="1000000"/>` +
  '<a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr>' +
  sp({ xfrm: xfrm(400000, 200000, 800000, 400000), body: para(run('그룹 안 글자')) }) +
  `<p:grpSp>${nv('grpSp')}<p:grpSpPr><a:xfrm><a:off x="2000000" y="0"/><a:ext cx="1000000" cy="1000000"/>` +
  '<a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="2000000"/></a:xfrm></p:grpSpPr>' +
  sp({ xfrm: xfrm(0, 0, 400000, 400000), body: para(run('깊은 글자')) }) +
  '</p:grpSp></p:grpSp>';

const AUTO_NUM = '<a:pPr><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>';

/** slide2.xml: 발표 순서 1번, 개체 틀 상속, 글머리, 그룹 */
const SLIDE_FILE2 = sld(
  sp({ ph: '<p:ph type="title"/>', body: para(run('검사실 지침')) }) +
    sp({
      ph: '<p:ph idx="1"/>',
      body:
        para(run('첫째 항목')) +
        para('<a:endParaRPr lang="ko-KR" sz="1000"/>') +
        para(run('둘째 수준', '<a:rPr lang="ko-KR" sz="1600"/>'), '<a:pPr lvl="1"/>') +
        para(run('번호 하나'), AUTO_NUM) +
        para(run('번호 둘'), AUTO_NUM) +
        para(`${run('줄1')}<a:br><a:rPr lang="ko-KR"/></a:br>${run('줄2')}`),
    }) +
    sp({
      xfrm: xfrm(6000000, 6000000, 2000000, 400000),
      spPr: '<a:noFill/>',
      body: para(
        run(
          '쪽 ',
          '<a:rPr lang="ko-KR"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill></a:rPr>',
        ) + '<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="ko-KR"/><a:t>1</a:t></a:fld>',
      ),
    }) +
    GROUP,
);

const NOTES = `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${TREE_HEAD}${sp({ xfrm: xfrm(0, 0, 10, 10), body: para(run('발표자 메모')) })}</p:spTree></p:cSld></p:notes>`;

function mainDeck(): Buffer {
  return deckZip({
    withMaster: true,
    order: [1, 0], // 파일 이름 순서와 반대
    slides: [
      {
        xml: SLIDE_FILE1,
        rels: [
          ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
          ['rId2', 'image', '../media/image1.png'],
          ['rId3', 'image', '../media/image1.png'],
          ['rId4', 'image', '../media/image2.emf'],
          ['rId5', 'chart', '../charts/chart1.xml'],
          ['rId6', 'notesSlide', '../notesSlides/notesSlide1.xml'],
          ['rId7', 'image', '../media/image3.png'],
        ],
      },
      { xml: SLIDE_FILE2 },
    ],
    extra: {
      'ppt/media/image2.emf': EMF_BYTES,
      'ppt/media/image3.png': GIF_BYTES,
      'ppt/notesSlides/notesSlide1.xml': NOTES,
    },
  });
}

// ─────────────────────────────── 불변식 ───────────────────────────────

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp']);
/** 짝 없는 서로게이트(DB 가 U+FFFD 로 바꿔 저장 뒤 오프셋 정합이 깨진다) */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function pageRuns(pg: SlidePage): SlideRun[] {
  const out: SlideRun[] = [];
  for (const sh of pg.shapes) {
    if (sh.type === 'text') for (const p of sh.paras) out.push(...p.runs);
    else if (sh.type === 'table') {
      for (const row of sh.rows) for (const c of row.cells) for (const p of c.paras) out.push(...p.runs);
    }
  }
  return out;
}

/** 모든 고정물에 거는 정합 불변식. 해석한 모델을 돌려준다 */
function checkInvariants(r: OfficeExtractResult): SlidesModel {
  const m = JSON.parse(r.render.toString('utf8')) as SlidesModel;
  expect(r.fileKind).toBe('pptx');
  expect(r.extractor).toBe(PPTX_EXTRACTOR);
  expect(r.renderMime).toBe('application/json');
  expect(m.kind).toBe('slides');
  // 4) 색인과 표시는 같은 범위, 같은 안내
  expect(m.truncated).toBe(r.truncated);
  // 1) 쪽 번호 1..N 연속, 모델과 1:1
  expect(r.pages.map((p) => p.pageNo)).toEqual(r.pages.map((_, i) => i + 1));
  expect(m.pages.map((p) => p.pageNo)).toEqual(r.pages.map((p) => p.pageNo));
  m.pages.forEach((pg, i) => {
    const text = r.pages[i]!.text;
    expect(r.pages[i]!.label).toBe(`슬라이드 ${pg.no}`);
    expect(normalizeText(text)).toBe(text);
    expect(LONE_SURROGATE.test(text)).toBe(false);
    // 2) 모든 조각이 제자리에
    const covered = new Uint8Array(text.length);
    let bad = 0;
    for (const rn of pageRuns(pg)) {
      if (text.slice(rn.o, rn.o + rn.t.length) !== rn.t) bad += 1;
      for (let k = rn.o; k < rn.o + rn.t.length; k += 1) covered[k] = 1;
    }
    expect(bad).toBe(0);
    // 3) 조각 밖 글자는 구분자('\n', '\t')뿐
    let stray = 0;
    for (let k = 0; k < text.length; k += 1) {
      if (!covered[k] && text[k] !== '\n' && text[k] !== '\t') stray += 1;
    }
    expect(stray).toBe(0);
    for (const sh of pg.shapes) if (sh.type === 'pic') expect(m.media[sh.media]).toBeDefined();
  });
  for (const md of m.media) expect(ALLOWED_MIME.has(md.mime)).toBe(true);
  return m;
}

function textShapes(pg: SlidePage): SlideTextShape[] {
  return pg.shapes.filter((s): s is SlideTextShape => s.type === 'text');
}

/** 모델 구성 요소 수 (예산이 세는 것: 도형, 문단, run, 표 열, 행, 칸) */
function modelNodes(m: SlidesModel): number {
  let n = 0;
  const paras = (ps: SlidePara[]): void => {
    n += ps.length;
    for (const p of ps) n += p.runs.length;
  };
  for (const pg of m.pages) {
    for (const sh of pg.shapes) {
      n += 1;
      if (sh.type === 'text') paras(sh.paras);
      else if (sh.type === 'table') {
        n += sh.cols.length + sh.rows.length;
        for (const rw of sh.rows) {
          n += rw.cells.length;
          for (const c of rw.cells) paras(c.paras);
        }
      }
    }
  }
  return n;
}

/** 글자에 s 가 들어 있는 글상자 */
function shapeWith(pg: SlidePage, s: string): SlideTextShape {
  const hit = textShapes(pg).find((sh) => sh.paras.some((p) => p.runs.map((r) => r.t).join('').includes(s)));
  if (!hit) throw new Error(`글상자 없음: ${s}`);
  return hit;
}

/** '#rrggbb' 두 색이 채널마다 tol 이내인가 */
function nearColor(hex: string | undefined, want: string, tol = 2): boolean {
  if (!hex) return false;
  const ch = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = ch(hex);
  const b = ch(want);
  return a.every((v, k) => Math.abs(v - b[k]!) <= tol);
}

let mainCache: { r: OfficeExtractResult; m: SlidesModel } | undefined;
function main(): { r: OfficeExtractResult; m: SlidesModel } {
  if (!mainCache) {
    const r = processPptx(mainDeck(), '검사실 지침.pptx');
    mainCache = { r, m: checkInvariants(r) };
  }
  return mainCache;
}

// ─────────────────────────────── 주 고정물 ───────────────────────────────

describe('processPptx: 주 고정물(마스터, 레이아웃, 두 슬라이드)', () => {
  it('발표 순서(sldIdLst)대로 쪽을 만들고 라벨은 슬라이드 N, 크기는 sldSz', () => {
    const { r, m } = main();
    expect(r.pages.map((p) => p.label)).toEqual(['슬라이드 1', '슬라이드 2']);
    expect(m.pages.map((p) => p.no)).toEqual([1, 2]);
    expect(r.pages[0]!.text.startsWith('검사실 지침')).toBe(true); // slide2.xml 이 첫 쪽
    expect(r.pages[1]!.text.startsWith('항목')).toBe(true);
    expect([m.slideW, m.slideH]).toEqual([9144000, 6858000]);
    expect(r.truncated).toBeNull();
  });

  it('정본 글자: 문단은 줄, 표 칸은 탭, 항목은 줄로 잇고 글머리, 노트, 숨김, 장식 글자는 넣지 않는다', () => {
    const { r } = main();
    expect(r.pages[0]!.text).toBe(
      '검사실 지침\n첫째 항목\n둘째 수준\n번호 하나\n번호 둘\n줄1\n줄2\n쪽 1\n그룹 안 글자\n깊은 글자',
    );
    expect(r.pages[1]!.text).toBe('항목\t결과\nA\tB\nC1\nC2\tD\n스타일 도형');
    const all = r.pages.map((p) => p.text).join('\n');
    for (const s of ['마스터', '병원 이름', '발표자 메모', '숨김', '숨긴 도형', '•', '1.']) {
      expect(all.includes(s)).toBe(false);
    }
  });

  it('제목 개체 틀은 레이아웃 위치를, 레이아웃에 위치가 없는 본문은 마스터 위치를 물려받는다', () => {
    const { m } = main();
    const s1 = m.pages[0]!;
    const title = shapeWith(s1, '검사실 지침');
    expect([title.x, title.y, title.w, title.h]).toEqual([457200, 274638, 8229600, 1143000]);
    expect(title.anchor).toBe('ctr'); // 마스터 bodyPr
    const body = shapeWith(s1, '첫째 항목');
    expect([body.x, body.y, body.w, body.h]).toEqual([838200, 1825625, 10515600, 4351338]);
    expect(body.inset).toEqual([91440, 45720, 91440, 45720]);
  });

  it('글자 서식 상속: 크기, 굵기, 정렬, 색, 글꼴, 글머리, 자동 번호, 줄바꿈', () => {
    const { m } = main();
    const s1 = m.pages[0]!;
    const tp = shapeWith(s1, '검사실 지침').paras[0]!;
    expect(tp.align).toBe('ctr'); // 레이아웃 lstStyle
    expect(tp.bullet).toBeUndefined();
    expect(tp.runs[0]).toMatchObject({ t: '검사실 지침', sz: 44, b: true, color: '#000000', font: '맑은 고딕' });

    const paras = shapeWith(s1, '첫째 항목').paras;
    expect(paras).toHaveLength(6);
    expect(paras[0]!.bullet).toBe('•'); // 마스터 bodyStyle
    expect(paras[0]!.runs[0]).toMatchObject({ sz: 20, color: '#000000', font: '맑은 고딕' }); // 레이아웃 20pt
    expect(paras[1]!.runs).toEqual([{ t: '', o: paras[1]!.runs[0]!.o, sz: 10 }]); // 빈 문단: 줄 높이만
    expect(paras[1]!.bullet).toBeUndefined();
    expect(paras[2]).toMatchObject({ lvl: 1, bullet: 'o' });
    expect(paras[2]!.runs[0]!.sz).toBe(16);
    expect(paras.slice(3, 5).map((p) => p.bullet)).toEqual(['1.', '2.']);
    expect(paras[5]!.runs.map((x) => x.t)).toEqual(['줄1', '\n', '줄2']);

    const box = shapeWith(s1, '쪽');
    expect(box.fill).toBeUndefined(); // noFill
    const [r1, r2] = box.paras[0]!.runs;
    expect(nearColor(r1!.color, '#2f5597')).toBe(true); // accent1 75% 어둡게
    expect(r1!.sz).toBe(18); // otherStyle
    expect(r2).toMatchObject({ t: '1', sz: 18 });
  });

  it('그룹(중첩 포함)의 off/ext/chOff/chExt 변환을 자식 좌표에 적용한다', () => {
    const { m } = main();
    const s1 = m.pages[0]!;
    const a = shapeWith(s1, '그룹 안 글자');
    expect([a.x, a.y, a.w, a.h]).toEqual([1200000, 2100000, 400000, 200000]);
    const b = shapeWith(s1, '깊은 글자');
    expect([b.x, b.y, b.w, b.h]).toEqual([2000000, 2000000, 100000, 100000]);
  });

  it('마스터, 레이아웃 장식은 글자 없는 도형과 그림만 먼저 그리고, 배경은 슬라이드 → 마스터 순으로 정한다', () => {
    const { m } = main();
    const [s1, s2] = m.pages;
    expect(s1!.shapes.slice(0, 3)).toEqual([
      { type: 'text', x: 0, y: 6500000, w: 9144000, h: 358000, paras: [], fill: '#4472c4' },
      { type: 'pic', x: 8500000, y: 6500000, w: 300000, h: 300000, media: 0 },
      { type: 'text', x: 100, y: 200, w: 300, h: 400, paras: [], fill: '#00ff00' },
    ]);
    expect(s1!.shapes).toHaveLength(8);
    expect(s1!.bg).toBe('#fff2cc');
    expect(s1!.hidden).toBeUndefined();
    expect(s2!.bg).toBe('#112233');
    expect(s2!.hidden).toBe(true);
  });

  it('표: 열 너비, 행 높이, 병합(가려진 칸은 hidden, 글자 없음), 칸 채우기', () => {
    const { m } = main();
    const t = m.pages[1]!.shapes.find((s): s is SlideTableShape => s.type === 'table')!;
    expect([t.x, t.y, t.w, t.h]).toEqual([500000, 600000, 6000000, 1500000]);
    expect(t.cols).toEqual([2000000, 2000000, 2000000]);
    expect(t.rows.map((rw) => rw.h)).toEqual([370840, 370840, 400000]);
    const c = t.rows.map((rw) => rw.cells);
    expect(c[0]![0]!.gridSpan).toBe(2);
    expect(c[0]![1]).toEqual({ paras: [], hidden: true });
    expect(c[0]![2]!.fill).toBe('#d9e2f3');
    expect(c[1]![0]!.rowSpan).toBe(2);
    expect(c[2]![0]!.hidden).toBe(true);
    expect(c[2]![1]!.paras.map((p) => p.runs[0]!.t)).toEqual(['C1', 'C2']);
  });

  it('그림: 경로로 중복 제거, 내용으로 형식 판정, 미지원 형식과 차트, SmartArt 는 자리 표시, 연결선은 뺀다', () => {
    const { m } = main();
    expect(m.media).toEqual([
      { path: 'ppt/media/image1.png', mime: 'image/png' },
      { path: 'ppt/media/image3.png', mime: 'image/gif' },
    ]);
    const shapes = m.pages[1]!.shapes;
    expect(shapes).toHaveLength(11); // 장식 3 + 표 1 + 그림 3 + 자리 표시 3 + 스타일 도형 1
    expect(shapes.filter((s) => s.type === 'pic').map((s) => (s.type === 'pic' ? s.media : -1))).toEqual([0, 0, 0, 1]);
    expect(shapes.filter((s) => s.type === 'other').map((s) => (s.type === 'other' ? s.label : ''))).toEqual([
      '그림(미리보기 미지원 형식)',
      '차트',
      'SmartArt',
    ]);
  });

  it('도형 스타일 참조(fillRef, lnRef, fontRef)로 채우기, 선, 글자색, 글꼴을 정한다', () => {
    const { m } = main();
    const s = shapeWith(m.pages[1]!, '스타일 도형');
    expect(s.fill).toBe('#ed7d31');
    expect(s.line).toBe('#223962'); // accent1 50% shade
    expect(s.paras[0]!.runs[0]).toMatchObject({ color: '#ffffff', font: '맑은 고딕', sz: 18 });
  });
});

// ─────────────────────────────── 작은 고정물 ───────────────────────────────

const box = (x = 0, y = 0, w = 1000, h = 1000): string => xfrm(x, y, w, h);

describe('processPptx: 순서, 경로, 정규화', () => {
  it('sldIdLst 가 없으면 slideN 번호 순(slide10 이 slide2 뒤)', () => {
    const slides = Array.from({ length: 10 }, (_, i) => ({ xml: sld(sp({ xfrm: box(), body: para(run(`s${i + 1}`)) })) }));
    const r = processPptx(deckZip({ slides, sldIdLst: '' }), 'a.pptx');
    checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(slides.map((_, i) => `s${i + 1}`));
  });

  it("절대 경로('/ppt/...') 관계 대상과 '../' 를 푼다", () => {
    const r = processPptx(
      deckZip({
        slides: [{ xml: sld(sp({ xfrm: box(), body: para(run('절대')) })) }],
        extra: {
          'ppt/_rels/presentation.xml.rels': rels([['rId10', 'slide', '/ppt/slides/../slides/slide1.xml']]),
        },
      }),
      'a.pptx',
    );
    checkInvariants(r);
    expect(r.pages[0]!.text).toBe('절대');
  });

  it('조각 글자를 정규화(NFD 한글 → NFC, XML 엔티티 해제)한 뒤 오프셋을 단다', () => {
    const nfd = '한글'.normalize('NFD');
    const r = processPptx(
      deckZip({ slides: [{ xml: sld(sp({ xfrm: box(), body: para(run(nfd) + run(' A &amp; B')) })) }] }),
      'a.pptx',
    );
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('한글 A & B');
    expect(textShapes(m.pages[0]!)[0]!.paras[0]!.runs.map((x) => [x.t, x.o])).toEqual([
      ['한글', 0],
      [' A & B', 2],
    ]);
  });

  it('mc:AlternateContent 는 도형을 가진 Choice 를 쓴다(수식 글상자의 글자 보존)', () => {
    const alt =
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
      `<mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14">${sp({ xfrm: box(), body: para(run('수식 글상자')) })}</mc:Choice>` +
      `<mc:Fallback>${pic('rId2', 0, 0, 10, 10)}</mc:Fallback></mc:AlternateContent>`;
    const r = processPptx(deckZip({ slides: [{ xml: sld(alt) }] }), 'a.pptx');
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('수식 글상자');
    expect(m.pages[0]!.shapes.map((s) => s.type)).toEqual(['text']);
  });
});

describe('processPptx: 서식', () => {
  it('글자 크기: run sz > 문단 defRPr > 도형 lstStyle > 기본 18pt, normAutofit fontScale 로 축소', () => {
    const lst = '<a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr>';
    const xml = sld(
      sp({
        xfrm: box(),
        lst,
        body:
          para(run('문단기본'), '<a:pPr><a:defRPr sz="2000"/></a:pPr>') +
          para(run('런크기', '<a:rPr lang="ko-KR" sz="1200"/>')) +
          para(run('목록스타일')),
      }) +
        sp({ xfrm: box(), body: para(run('기본값')) }) +
        sp({
          xfrm: box(),
          bodyPr: '<a:bodyPr><a:normAutofit fontScale="50000" lnSpcReduction="20000"/></a:bodyPr>',
          body: para(run('축소', '<a:rPr lang="ko-KR" sz="2000"/>')),
        }),
    );
    const r = processPptx(deckZip({ slides: [{ xml }] }), 'a.pptx');
    const pg = checkInvariants(r).pages[0]!;
    const sz = (s: string): number | undefined =>
      shapeWith(pg, s).paras.flatMap((p) => p.runs).find((x) => x.t === s)?.sz;
    expect([sz('문단기본'), sz('런크기'), sz('목록스타일'), sz('기본값'), sz('축소')]).toEqual([20, 12, 24, 18, 10]);
  });

  it('자동 번호 형식과 연속(빈 문단은 세지 않음), 기호 글꼴 글머리 근사', () => {
    const an = (type: string, extra = ''): string => `<a:pPr><a:buAutoNum type="${type}"${extra}/></a:pPr>`;
    const xml = sld(
      sp({
        xfrm: box(),
        body:
          para(run('가'), an('alphaLcParenR')) +
          para('<a:endParaRPr lang="ko-KR"/>') +
          para(run('나'), an('alphaLcParenR')) +
          para(run('다'), an('romanUcPeriod', ' startAt="4"')) +
          para(run('라'), an('circleNumDbPlain')) +
          para(run('마'), an('arabicParenBoth')) +
          para(run('바'), '<a:pPr><a:buFont typeface="Wingdings"/><a:buChar char="§"/></a:pPr>') +
          para(run('사'), '<a:pPr><a:buNone/></a:pPr>'),
      }),
    );
    const r = processPptx(deckZip({ slides: [{ xml }] }), 'a.pptx');
    const paras = textShapes(checkInvariants(r).pages[0]!)[0]!.paras;
    expect(paras.map((p) => p.bullet)).toEqual(['a)', undefined, 'b)', 'IV.', '①', '(1)', '▪', undefined]);
    expect(r.pages[0]!.text).toBe('가\n나\n다\n라\n마\n바\n사');
  });

  it('채우기, 선, 안쪽 여백, 세로 정렬, 회전', () => {
    const xml = sld(
      sp({
        xfrm: '<a:xfrm rot="5400000"><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm>',
        spPr:
          '<a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln>',
        bodyPr: '<a:bodyPr anchor="b" lIns="0" tIns="0" rIns="0" bIns="12700"/>',
        body: para(run('상자')),
      }),
    );
    const r = processPptx(deckZip({ slides: [{ xml }] }), 'a.pptx');
    const s = textShapes(checkInvariants(r).pages[0]!)[0]!;
    expect(s).toMatchObject({ x: 10, y: 20, w: 30, h: 40, rot: 90, fill: '#abcdef', line: '#123456', anchor: 'b' });
    expect(s.inset).toEqual([0, 0, 0, 12700]);
  });

  it('글꼴 이름에서 CSS 를 깨뜨릴 수 있는 글자를 빼고, 글머리는 한 글자만 쓴다', () => {
    const xml = sld(
      sp({
        xfrm: box(),
        body: para(
          run('A', '<a:rPr lang="en-US"><a:latin typeface="Evil&quot;;x:url(a)"/></a:rPr>'),
          '<a:pPr><a:buChar char="»»»"/></a:pPr>',
        ),
      }),
    );
    const r = processPptx(deckZip({ slides: [{ xml }] }), 'a.pptx');
    const p = textShapes(checkInvariants(r).pages[0]!)[0]!.paras[0]!;
    expect(p.runs[0]!.font).toBe('Evilxurla');
    expect(p.bullet).toBe('»');
  });

  it('배경 그림은 슬라이드 전체를 덮는 첫 그림으로 넣는다', () => {
    const bg = '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>';
    const r = processPptx(
      deckZip({
        slides: [{ xml: sld(sp({ xfrm: box(), body: para(run('위')) }), { bg }), rels: [['rId2', 'image', '../media/bg.png']] }],
        extra: { 'ppt/media/bg.png': PNG_1PX },
      }),
      'a.pptx',
    );
    const m = checkInvariants(r);
    expect(m.pages[0]!.shapes[0]).toEqual({ type: 'pic', x: 0, y: 0, w: 9144000, h: 6858000, media: 0 });
    expect(m.pages[0]!.bg).toBeUndefined();
  });
});

describe('processPptx: 오류와 상한', () => {
  it('ZIP 이 아니거나 presentation.xml 이 없거나 깨졌거나 슬라이드가 없으면 OfficeParseError', () => {
    expect(() => processPptx(Buffer.from('PK 가짜 파일'), 'a.pptx')).toThrow(OfficeParseError);
    expect(() => processPptx(zip({ 'docProps/app.xml': '<a/>' }), 'a.pptx')).toThrow(OfficeParseError);
    expect(() =>
      processPptx(zip({ '_rels/.rels': ROOT_RELS, 'ppt/presentation.xml': '<p:presentation><p:sldIdLst>' }), 'a.pptx'),
    ).toThrow(OfficeParseError);
    expect(() => processPptx(deckZip({ slides: [], sldIdLst: '<p:sldIdLst/>' }), 'a.pptx')).toThrow(
      /슬라이드가 하나도 없는/,
    );
  });

  it('깨진 슬라이드는 자리 표시 쪽으로 두고 truncated 로 알린다(번호는 유지)', () => {
    const r = processPptx(
      deckZip({
        slides: [{ xml: sld(sp({ xfrm: box(), body: para(run('정상')) })) }, { xml: `${HEAD}<p:sld ${NS}><p:cSld>` }],
      }),
      'a.pptx',
    );
    const m = checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(['정상', '']);
    expect(m.pages[1]!.shapes).toEqual([
      { type: 'other', x: 0, y: 0, w: 9144000, h: 6858000, label: '이 슬라이드를 읽지 못했습니다' },
    ]);
    expect(r.truncated).toContain('슬라이드 2');
  });

  it('슬라이드는 앞 500장까지', () => {
    const slides = Array.from({ length: 501 }, (_, i) => ({ xml: sld(sp({ xfrm: box(), body: para(run(`s${i + 1}`)) })) }));
    const r = processPptx(deckZip({ slides }), 'a.pptx');
    const m = checkInvariants(r);
    expect(r.pages).toHaveLength(500);
    expect(m.pages).toHaveLength(500);
    expect(r.pages[499]!.text).toBe('s500');
    expect(r.truncated).toContain('500장');
  });

  it('슬라이드 하나의 도형은 앞 2,000개까지(뒤 도형의 글자는 색인하지 않는다)', () => {
    const many = Array.from({ length: 2000 }, () => sp({ xfrm: box() })).join('');
    const r = processPptx(deckZip({ slides: [{ xml: sld(many + sp({ xfrm: box(), body: para(run('마지막')) })) }] }), 'a.pptx');
    const m = checkInvariants(r);
    expect(m.pages[0]!.shapes).toHaveLength(2000);
    expect(r.pages[0]!.text).toBe('');
    expect(r.truncated).toContain('2,000개');
  });

  it('글자 상한(3,000,000자)에 닿으면 색인과 모델을 같은 자리에서 자르고 뒤 슬라이드는 넣지 않는다', () => {
    const big = 'x'.repeat(2_999_990);
    const r = processPptx(
      deckZip({
        slides: [
          { xml: sld(sp({ xfrm: box(), body: para(run(big)) })) },
          { xml: sld(sp({ xfrm: box(), body: para(run('abcdefghijklmnop')) + para(run('zz')) })) },
          { xml: sld(sp({ xfrm: box(), body: para(run('셋째')) })) },
        ],
      }),
      'a.pptx',
    );
    const m = checkInvariants(r);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1]!.text).toBe('abcdefghij');
    expect(r.pages.reduce((s, p) => s + p.text.length, 0)).toBe(3_000_000);
    expect(textShapes(m.pages[1]!)[0]!.paras.map((p) => p.runs[0]!.t)).toEqual(['abcdefghij', '']);
    expect(r.truncated).toContain('3,000,000자');
    expect(r.truncated).toContain('슬라이드 2');
  });
});

// ─────────────────────────────── 자원 상한 ───────────────────────────────

const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table';
const LAYOUT_REL: [string, string, string][] = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];

/** 글자 없는 색 막대 n 개를 장식으로 가진 마스터와 빈 레이아웃 */
function decorFiles(n: number): Record<string, string> {
  const rects = Array.from({ length: n }, (_, i) =>
    sp({ xfrm: xfrm(i, 0, 10, 10), spPr: '<a:solidFill><a:srgbClr val="CCCCCC"/></a:solidFill>' }),
  ).join('');
  return {
    'ppt/slideMasters/slideMaster1.xml': `${HEAD}<p:sldMaster ${NS}><p:cSld><p:spTree>${TREE_HEAD}${rects}</p:spTree></p:cSld></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `${HEAD}<p:sldLayout ${NS}><p:cSld><p:spTree>${TREE_HEAD}</p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  };
}

describe('processPptx: 자원 상한(글자 없는 요소, 중복 슬라이드, 장식, XML 크기)', () => {
  it('연속 빈 문단은 앞 몇 개만 싣는다(글자 문단 뒤에는 다시 센다, 정본은 그대로)', () => {
    const k = PPTX_LIMITS.emptyParasInRow;
    const body = '<a:p/>'.repeat(k + 150) + para(run('가운데')) + '<a:p/>'.repeat(k + 5) + para(run('끝'));
    const r = processPptx(deckZip({ slides: [{ xml: sld(sp({ xfrm: box(), body })) }] }), 'a.pptx');
    const m = checkInvariants(r);
    const paras = textShapes(m.pages[0]!)[0]!.paras;
    expect(paras).toHaveLength(k + 1 + k + 1);
    expect(paras[k]!.runs[0]!.t).toBe('가운데');
    expect(r.pages[0]!.text).toBe('가운데\n끝');
    expect(r.truncated).toBeNull();
  });

  it('빈 문단 10만 개짜리 슬라이드를 sldIdLst 에서 40번 가리켜도 한 번만 해석하고 모델은 작다', () => {
    const slide = sld(sp({ xfrm: box(), body: '<a:p/>'.repeat(100_000) + para(run('끝')) }));
    const r = processPptx(deckZip({ slides: [{ xml: slide }], order: Array.from({ length: 40 }, () => 0) }), 'a.pptx');
    const m = checkInvariants(r);
    expect(r.pages).toHaveLength(40);
    expect(r.pages.map((p) => p.text)).toEqual(['끝', ...Array.from({ length: 39 }, () => '')]);
    expect(r.render.length).toBeLessThan(50_000);
    expect(m.pages[1]!.shapes).toEqual([
      { type: 'other', x: 0, y: 0, w: 9144000, h: 6858000, label: '앞의 슬라이드 1과(와) 같은 슬라이드' },
    ]);
    expect(r.truncated).toContain('같은 슬라이드를 거듭 가리켜 슬라이드 2, 3,');
  });

  it('다른 관계 Id, 대소문자만 다른 경로로 같은 슬라이드를 가리켜도 중복으로 본다', () => {
    const ids = ['rId10', 'rId11', 'rId12', 'rId13'].map((rid, k) => `<p:sldId id="${256 + k}" r:id="${rid}"/>`).join('');
    const buf = deckZip({
      slides: [{ xml: sld(sp({ xfrm: box(), body: para(run('하나')) })) }, { xml: sld(sp({ xfrm: box(), body: para(run('둘')) })) }],
      sldIdLst: `<p:sldIdLst>${ids}</p:sldIdLst>`,
      extra: {
        'ppt/_rels/presentation.xml.rels': rels([
          ['rId10', 'slide', 'slides/slide1.xml'],
          ['rId11', 'slide', 'slides/slide2.xml'],
          ['rId12', 'slide', 'slides/slide1.xml'],
          ['rId13', 'slide', '/ppt/slides/SLIDE1.xml'],
        ]),
      },
    });
    const r = processPptx(buf, 'a.pptx');
    checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(['하나', '둘', '', '']);
    expect(r.truncated).toContain('슬라이드 3, 4은(는) 자리 표시');
  });

  it('구성 요소 예산: 빈 표 칸도 세고, 끊긴 자리에서 색인과 모델이 함께 끝나며 뒤 슬라이드는 넣지 않는다', () => {
    const tbl = frame(
      0,
      0,
      1000,
      1000,
      `<a:graphicData uri="${TABLE_URI}"><a:tbl><a:tblGrid><a:gridCol w="10"/></a:tblGrid>` +
        `<a:tr h="1">${cell('앞')}${'<a:tc/>'.repeat(100)}${cell('뒤')}</a:tr></a:tbl></a:graphicData>`,
    );
    const r = processPptx(
      deckZip({ slides: [{ xml: sld(tbl) }, { xml: sld(sp({ xfrm: box(), body: para(run('둘째')) })) }] }),
      'a.pptx',
      { nodes: 40 },
    );
    const m = checkInvariants(r);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]!.text).toBe('앞');
    expect(modelNodes(m)).toBeLessThanOrEqual(40);
    const cells = (m.pages[0]!.shapes[0] as SlideTableShape).rows[0]!.cells;
    expect(cells.length).toBeGreaterThan(1);
    expect(cells.length).toBeLessThan(102);
    expect(r.truncated).toContain('구성 요소가 많아 앞 40개(슬라이드 1까지)');
  });

  it('구성 요소 예산이 문단 가운데서 끊기면 그 run 까지만 색인하고 그린다', () => {
    const runs = Array.from({ length: 20 }, (_, i) => run(`a${i}`)).join('');
    const r = processPptx(deckZip({ slides: [{ xml: sld(sp({ xfrm: box(), body: para(runs) })) }] }), 'a.pptx', {
      nodes: 10,
    });
    const m = checkInvariants(r);
    // 도형 1 + 문단 1 + run 8
    expect(r.pages[0]!.text).toBe('a0a1a2a3a4a5a6a7');
    expect(modelNodes(m)).toBe(10);
    expect(r.truncated).toContain('구성 요소가 많아');
  });

  it('자동 번호: startAt 은 1..32767 로 묶고, 알파벳은 같은 글자가 네 번을 넘으면 숫자로 쓴다', () => {
    const an = (type: string, startAt: string): string => `<a:pPr><a:buAutoNum type="${type}" startAt="${startAt}"/></a:pPr>`;
    const one = (t: string, pPr: string): string => sp({ xfrm: box(), body: para(run(t), pPr) });
    const xml = sld(
      one('a', an('alphaUcPeriod', '2000000000')) +
        one('b', an('alphaUcPeriod', '100000000000')) +
        one('c', an('alphaLcPeriod', '27')) +
        one('d', an('alphaLcPeriod', '53')) +
        one('e', an('alphaLcParenR', '104')) +
        one('f', an('alphaLcParenR', '105')) +
        one('g', an('romanUcPeriod', '32767')),
    );
    const r = processPptx(deckZip({ slides: [{ xml }] }), 'a.pptx');
    const m = checkInvariants(r);
    expect(textShapes(m.pages[0]!).map((s) => s.paras[0]!.bullet)).toEqual([
      '32767.',
      '32767.',
      'aa.',
      'aaa.',
      'zzzz)',
      '105)',
      '32767.',
    ]);
    expect(r.pages[0]!.text).toBe('a\nb\nc\nd\ne\nf\ng');
    expect(r.truncated).toBeNull();
  });

  it('장식은 슬라이드 자신의 도형 상한을 쓰지 않고 따로 센다(장식이 많아도 슬라이드 글자는 색인)', () => {
    const slides = [0, 1, 2].map((i) => ({ xml: sld(sp({ xfrm: box(), body: para(run(`본문${i}`)) })), rels: LAYOUT_REL }));
    const r = processPptx(deckZip({ slides, extra: decorFiles(300) }), 'a.pptx', {
      shapesPerSlide: 1,
      decorPerSlide: 200,
      decorTotal: 450,
    });
    const m = checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(['본문0', '본문1', '본문2']);
    // 슬라이드마다 장식 200개까지, 모든 슬라이드 합 450개까지 + 자기 도형 1개
    expect(m.pages.map((p) => p.shapes.length)).toEqual([201, 201, 51]);
    expect(textShapes(m.pages[2]!)[50]!.paras[0]!.runs[0]!.t).toBe('본문2');
    expect(r.truncated).toContain('장식 도형이 많아');
    expect(r.truncated).not.toContain('개 도형만');
  });

  it('기본 상한에서도 장식 2,000개짜리 마스터가 슬라이드 글자를 밀어내지 않는다', () => {
    const r = processPptx(
      deckZip({ slides: [{ xml: sld(sp({ xfrm: box(), body: para(run('본문')) })), rels: LAYOUT_REL }], extra: decorFiles(2000) }),
      'a.pptx',
    );
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('본문');
    expect(m.pages[0]!.shapes).toHaveLength(PPTX_LIMITS.decorPerSlide + 1);
  });

  it('장식은 슬라이드의 색 대응표 덮어쓰기를 따른다(장식 캐시는 색 대응표별)', () => {
    const ovr =
      '<a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent2" accent2="accent1" ' +
      'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
    const plain = sld(sp({ xfrm: box(), body: para(run('보통')) }));
    const swapped = plain.replace('<a:masterClrMapping/>', ovr);
    const r = processPptx(deckZip({ withMaster: true, slides: [{ xml: plain }, { xml: swapped }, { xml: plain }] }), 'a.pptx');
    const m = checkInvariants(r);
    expect(m.pages.map((p) => (p.shapes[0] as SlideTextShape).fill)).toEqual(['#4472c4', '#ed7d31', '#4472c4']);
  });

  it('푼 XML 합이 상한을 넘길 슬라이드부터는 넣지 않는다(슬라이드 경계에서 색인과 모델이 함께 끝남)', () => {
    const big = (t: string): string =>
      sld(sp({ xfrm: box(), body: para(run(t)) })).replace('<p:cSld>', `<p:cSld><!--${'x'.repeat(50_000)}-->`);
    const r = processPptx(deckZip({ slides: [{ xml: big('하나') }, { xml: big('둘') }, { xml: big('셋') }] }), 'a.pptx', {
      xmlTotalBytes: 120_000,
    });
    const m = checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(['하나', '둘']);
    expect(m.pages).toHaveLength(2);
    expect(r.truncated).toContain('슬라이드 2까지만');
  });

  it('태그가 상한보다 많은 XML 부분은 해석하지 않고 그 슬라이드만 읽지 못한 쪽으로 둔다', () => {
    const r = processPptx(
      deckZip({
        slides: [
          { xml: sld(sp({ xfrm: box(), body: para(run('작음')) })) },
          { xml: sld(sp({ xfrm: box(), body: '<a:p/>'.repeat(500) + para(run('큼')) })) },
          { xml: sld(sp({ xfrm: box(), body: para(run('뒤')) })) },
        ],
      }),
      'a.pptx',
      { tagsPerPart: 300 },
    );
    checkInvariants(r);
    expect(r.pages.map((p) => p.text)).toEqual(['작음', '', '뒤']);
    expect(r.truncated).toContain('슬라이드 2을(를) 읽지 못해');
  });

  it('렌더 JSON 이 문자열 길이 한계(RangeError)에 닿으면 OfficeParseError 로 바꾼다', () => {
    const buf = deckZip({ slides: [{ xml: sld(sp({ xfrm: box(), body: para(run('a')) })) }] });
    const spy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new RangeError('Invalid string length');
    });
    try {
      expect(() => processPptx(buf, 'a.pptx')).toThrow(OfficeParseError);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────── 정규화, 수식, 엔티티 ───────────────────────────────

const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const A14_NS = 'http://schemas.microsoft.com/office/drawing/2010/main';
const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

describe('processPptx: run 경계 정규화, 수식, 엔티티', () => {
  it('결합 문자로 시작하는 run 은 앞 run 에 붙여 다시 정규화한다(쪽 글자 NFC 유지, 줄바꿈 뒤는 붙이지 않음)', () => {
    const xml = sld(
      sp({ xfrm: box(), body: para(run('\u{1112}') + run('\u{1161}\u{11AB}')) }) +
        sp({ xfrm: box(), body: para(run('cafe') + run('\u{301}', '<a:rPr lang="fr-FR" b="1"/>')) }) +
        sp({ xfrm: box(), body: para(`${run('x')}<a:br/>${run('\u{301}')}`) }),
    );
    const r = processPptx(deckZip({ slides: [{ xml }] }), 'a.pptx');
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('\u{D55C}\ncaf\u{E9}\nx\n\u{301}');
    expect(r.pages[0]!.text.includes('한')).toBe(true);
    expect(textShapes(m.pages[0]!).map((s) => s.paras[0]!.runs.map((x) => [x.t, x.o]))).toEqual([
      [['\u{D55C}', 0]],
      [['caf\u{E9}', 2]],
      [
        ['x', 7],
        ['\n', 8],
        ['\u{301}', 9],
      ],
    ]);
  });

  it('결합 문자로 시작하는 run 이 아주 많아도 모아서 한 번만 정규화한다 (예전에는 run 마다 앞 글자 전체를 다시 정규화)', () => {
    const N = 30_000;
    const xml = sld(sp({ xfrm: box(), body: para(run('a') + run('\u{301}').repeat(N)) }));
    const t0 = performance.now();
    const r = processPptx(deckZip({ slides: [{ xml }] }), 'a.pptx');
    const ms = performance.now() - t0;
    expect(r.pages[0]!.text).toBe(normalizeText('a' + '\u{301}'.repeat(N)));
    expect(r.pages[0]!.text.startsWith('\u{E1}')).toBe(true);
    expect(checkInvariants(r).pages[0]).toBeDefined();
    expect(ms).toBeLessThan(1500);
  });

  it('그림 잘라 내기(a:srcRect)는 모델 crop 으로 싣고, 잘라 내지 않은 그림에는 없다', () => {
    const cropped =
      `<p:pic>${nv('pic')}<p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000" r="30000" b="25000"/>` +
      `<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm(0, 0, 600000, 300000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    const xml = sld(cropped + pic('rId2', 0, 400000, 600000, 300000));
    const r = processPptx(
      deckZip({ slides: [{ xml, rels: [['rId2', 'image', '../media/crop.png']] }], extra: { 'ppt/media/crop.png': PNG_1PX } }),
      'a.pptx',
    );
    const m = checkInvariants(r);
    const pics = m.pages[0]!.shapes.filter((s) => s.type === 'pic');
    expect(pics).toHaveLength(2);
    expect(pics[0]).toMatchObject({ type: 'pic', media: 0, crop: { l: 0.1, t: 0, r: 0.3, b: 0.25 } });
    expect(pics[1]).not.toHaveProperty('crop');
  });

  it('수식(a14:m)은 m:t 를 이은 기울임 run 으로 색인하고 그린다(도형 갈래, 문단 갈래 모두)', () => {
    const mr = (t: string): string =>
      `<m:r><a:rPr lang="en-US" i="1"><a:latin typeface="Cambria Math"/></a:rPr><m:t>${t}</m:t></m:r>`;
    const frac =
      `<a14:m><m:oMathPara xmlns:m="${MATH_NS}"><m:oMath><m:f><m:num>${mr('(140−age)×wt')}</m:num>` +
      `<m:den>${mr('72×Cr')}</m:den></m:f></m:oMath></m:oMathPara></a14:m>`;
    const choiceSp = sp({ xfrm: box(), body: `<a:p>${run('CrCl = ')}${frac}<a:endParaRPr lang="ko-KR"/></a:p>` });
    const shapeAlt =
      `<mc:AlternateContent xmlns:mc="${MC_NS}"><mc:Choice xmlns:a14="${A14_NS}" Requires="a14">${choiceSp}</mc:Choice>` +
      `<mc:Fallback>${pic('rId2', 0, 0, 10, 10)}</mc:Fallback></mc:AlternateContent>`;
    const sup = `<a14:m><m:oMath xmlns:m="${MATH_NS}"><m:sSup><m:e>${mr('x')}</m:e><m:sup>${mr('2')}</m:sup></m:sSup></m:oMath></a14:m>`;
    const inlineSp = sp({
      xfrm: box(),
      body:
        `<a:p>${run('식: ')}<mc:AlternateContent xmlns:mc="${MC_NS}"><mc:Choice xmlns:a14="${A14_NS}" Requires="a14">` +
        `${sup}</mc:Choice><mc:Fallback/></mc:AlternateContent></a:p>`,
    });
    const r = processPptx(deckZip({ slides: [{ xml: sld(shapeAlt + inlineSp) }] }), 'a.pptx');
    const m = checkInvariants(r);
    expect(r.pages[0]!.text).toBe('CrCl = (140−age)×wt72×Cr\n식: x2');
    const [eq, inline] = textShapes(m.pages[0]!);
    expect(eq!.paras[0]!.runs[0]!.i).toBeUndefined();
    expect(eq!.paras[0]!.runs[1]).toMatchObject({ t: '(140−age)×wt72×Cr', i: true, font: 'Cambria Math' });
    expect(inline!.paras[0]!.runs[1]).toMatchObject({ t: 'x2', i: true });
  });

  it('글자 엔티티는 한 번만 풀고, XML 이 허용하지 않는 글자 참조(서로게이트 반쪽, NUL)는 U+FFFD 로 바꾼다', () => {
    const body = para(run('a &#38;lt; b')) + para(run('A&#xD800;B&#0;C&#xDC00;')) + para(run('&#x1F600;&#128512;&amp;amp;'));
    const r = processPptx(deckZip({ slides: [{ xml: sld(sp({ xfrm: box(), body })) }] }), 'a.pptx');
    checkInvariants(r);
    expect(r.pages[0]!.text).toBe('a &lt; b\nA\u{FFFD}B\u{FFFD}C\u{FFFD}\n\u{1F600}\u{1F600}&amp;');
  });
});
