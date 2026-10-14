/**
 * Word 문서(docx) → 정본 쪽 글자 + 흐름(flow) 렌더 모델
 *
 * 서버가 업로드 때 한 번 해석한다. 브라우저는 원본 바이트가 아니라 이 JSON 모델만 그린다.
 * 단계: ① XML → IR (build.ts) ② IR → 쪽 (paginate.ts, Word 가 저장한 쪽 나눔. 표지가 모자란 쪽은
 * estimate.ts 가 높이를 어림해 가른다) ③ 쪽 → 모델 블록 + 정본 글자 + 오프셋 (emit.ts).
 * 쪽 글자는 모델에서만 만들어지므로 색인과 표시는 언제나 같은 범위다.
 *
 * 실물 확인 (실물 docx 88개, 그중 Word 가 만든 PDF 짝 7개. 글자 내용은 보지 않고 수와 구조만 셈)
 * - lastRenderedPageBreak 만으로는 PDF 쪽 수보다 모자랐다(빈 문단, 빈 표 행으로 시작하는 쪽, 긴 표, 앞 몇 쪽에만
 *   적고 멈춘 문서). docProps/app.xml <Pages> 는 PDF 쪽 수와 6개 모두 같았다. 그래서 <Pages> 를 목표로 어림해
 *   가른다. 최종: PDF 짝 7개 모두 쪽 수가 같고, <Pages> 가 있는 75개 모두 그 수와 같다.
 * - 표 칸 맨 앞의 w:br type="page" 도 Word 는 그 행 앞에서 새 쪽을 시작했다(paginate.ts 머리 주석).
 *
 * 읽는 부분: word/document.xml(필수), word/_rels/document.xml.rels, styles.xml, numbering.xml,
 * settings.xml(defaultTabStop, evenAndOddHeaders), theme/theme1.xml, 머리말/꼬리말, footnotes.xml,
 * endnotes.xml, word/media/*(그림 경로만: 바이트는 화면이 따로 받는다).
 *
 * 머리말/꼬리말은 표시 전용인데 쪽마다 모델에 되풀이되므로 따로 묶는다: 부분마다 MAX_HEADER_* 까지만 남기고,
 * 풀어 읽는 부분 크기 합은 MAX_HEADER_SOURCE, 모델에 싣는 JSON 합은 MAX_CHROME_JSON 까지(넘으면 그 뒤 쪽에는
 * 싣지 않는다). 상한 없이 7KB 짜리 docx 가 419MB 렌더 JSON 을 만들었다. 실물 최대는 문서당 14KB 였다.
 *
 * 쪽 이름표: Word 쪽 정보(lastRenderedPageBreak)가 있으면 null(화면은 'p.N'), 없으면 글자 수로 나눈 '구간 N'.
 * 다만 lrpb 가 없어도 docProps/app.xml 의 쪽 수가 표지(쪽 나눔, 구역) 쪽 수와 같고 쪽마다 6000자 이하면
 * (한 쪽짜리 Word 문서가 이렇다) Word 쪽으로 보고 null.
 */
import { OfficeParseError } from '../errors.js';
import { RENDER_MODEL_VERSION, type FlowModel, type FlowPage, type OfficeExtractResult } from '../model.js';
import { childEl } from '../xml.js';
import { Builder, readSections, readSettings } from './build.js';
import { blocksHeight, estimatePages } from './estimate.js';
import { HeaderPart, expandList, layoutList, noteBlocks, noteKeys, type LayoutState, type PreBlock } from './emit.js';
import type { SectInfo } from './ir.js';
import {
  ERR_DOCUMENT,
  ERR_STRUCTURE,
  ERR_ZIP,
  FALLBACK_SPLIT_OVER,
  MAX_CHROME_JSON,
  MAX_PAGES,
  TRUNC_PAGES,
  TRUNC_TEXT,
} from './limits.js';
import { NumberingDefs } from './numbering.js';
import { DocxPackage, MAIN_PART, MAX_MAIN_BYTES } from './package.js';
import { listTextLen, paginate, splitBySize, type PageIR } from './paginate.js';
import { Styles, type ColorCtx } from './styles.js';
import { readTheme } from './theme.js';
import { twipsToPx } from './units.js';

export { DOCX_LIMITS } from './limits.js';

export const DOCX_EXTRACTOR = 'docx-v1';

/** docProps/app.xml 의 <Pages>: Word 가 저장할 때 센 쪽 수 */
function appPages(pkg: DocxPackage): number | undefined {
  const xml = pkg.bytes('docProps/app.xml', 1024 * 1024)?.toString('utf8');
  const m = xml ? /<(?:\w+:)?Pages>\s*(\d+)\s*<\//.exec(xml) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function pickHeader(
  refs: SectInfo['headers'],
  first: boolean,
  titlePg: boolean,
  even: boolean,
  evenAndOdd: boolean,
): string | undefined {
  if (first && titlePg) return refs.first;
  if (evenAndOdd && even) return refs.even;
  return refs.default;
}

/**
 * docx 하나를 해석한다. 던지는 것은 OfficeParseError(사용자에게 보일 한국어 문장)뿐이다: 예상하지 못한 구조로
 * 해석이 깨지면(비정상적으로 깊은 중첩 등) 그것도 '읽지 못한 문서'로 알린다.
 */
export function processDocx(buf: Buffer, fileName: string): OfficeExtractResult {
  try {
    return extract(buf, fileName);
  } catch (e) {
    if (e instanceof OfficeParseError) throw e;
    throw new OfficeParseError(ERR_STRUCTURE);
  }
}

function extract(buf: Buffer, _fileName: string): OfficeExtractResult {
  const pkg = DocxPackage.open(buf);
  if (!pkg) throw new OfficeParseError(ERR_ZIP);
  if (!pkg.has(MAIN_PART)) throw new OfficeParseError(ERR_DOCUMENT);
  const docRoot = pkg.xml(MAIN_PART, MAX_MAIN_BYTES);
  if (!docRoot) throw new OfficeParseError(ERR_DOCUMENT);

  const part = (type: string, fallback: string): string => pkg.relByType(MAIN_PART, type) ?? fallback;
  const settings = readSettings(pkg.xml(part('settings', 'word/settings.xml')));
  const theme = readTheme(pkg.xml(part('theme', 'word/theme/theme1.xml')), settings.eastAsiaLang);
  const cc: ColorCtx = { theme, clrMap: settings.clrMap };
  const styles = new Styles(pkg.xml(part('styles', 'word/styles.xml')), cc);
  const numDefs = new NumberingDefs(pkg.xml(part('numbering', 'word/numbering.xml')), styles);
  const body = childEl(docRoot, 'w:body');
  const sections = readSections(body, pkg);

  // ① XML → IR
  const builder = new Builder(pkg, styles, numDefs, cc, theme, settings, sections);
  const blocks = builder.body(body);
  const footnotes = builder.notes('foot');
  const endnotes = builder.notes('end');

  // ② 쪽 나눔: Word 표지 → (표지가 모자란 쪽) 높이 어림
  const tabPx = twipsToPx(settings.defaultTab);
  const app = appPages(pkg);
  let pages: PageIR[] = paginate(blocks, sections);
  let fallback = false;
  if (builder.lrpbCount === 0) {
    // lrpb 가 하나도 없다: 한 쪽짜리 Word 문서도 이렇다(넘어간 쪽이 없으니). docProps/app.xml 의 쪽 수가
    // 표지 쪽 수와 같고 어느 쪽도 대체 쪽 나눔 기준(6000자)을 넘지 않으면 Word 쪽으로 믿는다
    const trusted = app !== undefined && app === pages.length && pages.every((pg) => listTextLen(pg.blocks) <= FALLBACK_SPLIT_OVER);
    if (!trusted) {
      fallback = true;
      pages = pages.flatMap(splitBySize);
    }
  } else {
    // 머리말/꼬리말이 여백보다 크면 본문이 그만큼 밀린다 (구역, 첫 쪽 여부별로 한 번만 어림).
    // 부분 높이는 부분, 너비마다 한 번만 잰다. 한 부분을 너비가 다른 구역 8개 넘게 쓰면(비정상 문서) 처음 잰
    // 높이를 쓴다: 구역이 아주 많아도 같은 부분을 되풀이해 재지 않는다
    const chromeCache = new Map<string, { top: number; bottom: number }>();
    const partHeight = new Map<string, Map<number, number>>();
    const heightOf = (path: string | undefined, width: number): number => {
      if (!path) return 0;
      let byWidth = partHeight.get(path);
      if (!byWidth) {
        byWidth = new Map();
        partHeight.set(path, byWidth);
      }
      let h = byWidth.get(width);
      if (h === undefined) {
        const first = byWidth.values().next();
        h = byWidth.size >= 8 && !first.done ? first.value : blocksHeight(builder.header(path), width, tabPx);
        if (byWidth.size < 8) byWidth.set(width, h);
      }
      return h;
    };
    const chrome = (si: number, first: boolean): { top: number; bottom: number } => {
      const key = `${si}:${first ? 1 : 0}`;
      const hit = chromeCache.get(key);
      if (hit) return hit;
      const s = sections[Math.min(si, sections.length - 1)]!;
      const width = Math.max(48, s.w - s.margin[1] - s.margin[3]);
      const hh = heightOf(pickHeader(s.headers, first, s.titlePg, false, settings.evenAndOdd), width);
      const fh = heightOf(pickHeader(s.footers, first, s.titlePg, false, settings.evenAndOdd), width);
      const out = { top: Math.max(s.margin[0], s.headerDist + hh), bottom: Math.max(s.margin[2], s.footerDist + fh) };
      chromeCache.set(key, out);
      return out;
    };
    pages = estimatePages(pages, { sections, appPages: app, chrome, tab: tabPx }).pages;
  }
  let pageCut = false;
  if (pages.length > MAX_PAGES) {
    pages = pages.slice(0, MAX_PAGES);
    pageCut = true;
  }

  // ③ 모델 + 정본 글자
  const st: LayoutState = { total: 0, stopped: false, cut: false };
  const outPages: FlowPage[] = [];
  const texts: string[] = [];
  const emittedNotes = new Set<string>();
  const headerParts = new Map<string, HeaderPart>();
  const headerOf = (path: string | undefined): HeaderPart | undefined => {
    if (!path) return undefined;
    let hp = headerParts.get(path);
    if (!hp) {
      hp = new HeaderPart(expandList(builder.header(path)));
      headerParts.set(path, hp);
    }
    return hp;
  };
  const total = pages.length;
  const sectionPageCount = new Map<number, number>();
  for (const pg of pages) sectionPageCount.set(pg.sect, (sectionPageCount.get(pg.sect) ?? 0) + 1);
  let pageNumber = 0;
  let chromeLeft = MAX_CHROME_JSON;

  for (let i = 0; i < pages.length; i += 1) {
    if (st.stopped) break;
    const pg = pages[i]!;
    const sect = sections[Math.min(pg.sect, sections.length - 1)]!;
    const firstOfSect = i === 0 || pages[i - 1]!.sect !== pg.sect;
    pageNumber = firstOfSect && sect.pgStart !== undefined ? sect.pgStart : i === 0 ? 1 : pageNumber + 1;

    const pre: PreBlock[] = expandList(pg.blocks, true);
    const keys = noteKeys(pg.blocks).filter((k) => !emittedNotes.has(k) && footnotes.has(k));
    for (const k of keys) emittedNotes.add(k);
    const notes = noteBlocks(keys, footnotes);
    if (i === pages.length - 1 && !pageCut) {
      const ends = [...endnotes.keys()].filter((k) => !emittedNotes.has(k));
      for (const k of ends) emittedNotes.add(k);
      for (const b of noteBlocks(ends, endnotes)) notes.push(b);
    }
    for (const b of notes) pre.push(b);
    const laid = layoutList(pre, 0, st);
    // 글자 상한으로 멈춘 뒤 아무것도 남지 않은 쪽은 내지 않는다
    if (st.stopped && laid.blocks.length === 0 && laid.text === '' && outPages.length > 0) break;
    const page: FlowPage = {
      pageNo: outPages.length + 1,
      w: sect.w,
      h: sect.h,
      margin: [...sect.margin],
      blocks: laid.blocks,
      headerDist: sect.headerDist,
      footerDist: sect.footerDist,
    };
    const nums = {
      page: pageNumber,
      total,
      sectionPages: sectionPageCount.get(pg.sect) ?? 1,
      ...(sect.pgFmt ? { sectFmt: sect.pgFmt } : {}),
    };
    const even = pageNumber % 2 === 0;
    const hp = headerOf(pickHeader(sect.headers, firstOfSect, sect.titlePg, even, settings.evenAndOdd));
    const fp = headerOf(pickHeader(sect.footers, firstOfSect, sect.titlePg, even, settings.evenAndOdd));
    // 머리말/꼬리말은 쪽마다 모델에 되풀이된다. JSON 합이 상한을 넘으면 이 쪽부터 끝까지 싣지 않는다
    // (표시 전용이라 정본 글자와 색인에는 영향이 없다)
    if (chromeLeft > 0) {
      const h = hp && !hp.empty() ? hp.renderSized(nums) : undefined;
      const f = fp && !fp.empty() ? fp.renderSized(nums) : undefined;
      const need = (h?.bytes ?? 0) + (f?.bytes ?? 0);
      if (need <= chromeLeft) {
        chromeLeft -= need;
        if (h) page.header = h.blocks;
        if (f) page.footer = f.blocks;
      } else {
        chromeLeft = 0;
      }
    }
    outPages.push(page);
    texts.push(laid.text);
    st.total += laid.text.length;
  }

  const truncated = st.cut ? TRUNC_TEXT : pageCut ? TRUNC_PAGES : builder.stop;
  const labels = texts.map((_, i) => (fallback ? `구간 ${i + 1}` : null));
  const model: FlowModel = {
    v: RENDER_MODEL_VERSION,
    kind: 'flow',
    media: builder.media,
    truncated,
    defaultTab: tabPx,
    pages: outPages,
  };
  return {
    fileKind: 'docx',
    extractor: DOCX_EXTRACTOR,
    pages: texts.map((text, i) => ({ pageNo: i + 1, text, label: labels[i] ?? null })),
    render: Buffer.from(JSON.stringify(model), 'utf8'),
    renderMime: 'application/json',
    truncated,
  };
}
