/**
 * 구형 흐름 문서(doc, hwp) 공용: docx 중간 표현(IR) → 쪽 → 흐름 모델 + 정본 쪽 글자
 *
 * doc 과 hwp 해석기는 문서를 docx 와 같은 IR(문단, 표, 쪽 경계 표지)로 바꾼다. 그 뒤는 docx 추출기와 같은 단계를
 * 그대로 쓴다: paginate(쪽 경계 표지로 나누기) → (표지가 없으면) 저장된 쪽 수로 쪽을 믿을지 정하고, 못 믿으면
 * splitBySize(글자 수로 '구간') → expandList/layoutList(모델 블록, 정본 글자, 오프셋).
 * 쪽을 믿는 경우 (docx index.ts 의 표지 없는 문서 규칙과 같고, 높이 어림을 하나 더 쓴다)
 * - 저장된 쪽 수가 나눈 쪽 수와 같고 쪽마다 글자가 대체 기준(6000자) 이하.
 * - 저장된 쪽 수가 더 많으면 estimatePages 로 그 수를 맞춰 보고, 정확히 맞으면 그 쪽들을 쓴다.
 * 그 밖(쪽 수를 1로만 적은 문서가 많다: 실물 doc 756개 중 616개)은 쪽 번호처럼 보이지 않게 '구간'으로 나눈다.
 * 그래서 정본 글자 규칙(블록 '\n', 표 행 '\n', 칸 '\t', 빈 칸 제외)과 글자 상한이 docx 와 똑같다.
 */
import { expandList, layoutList, noteBlocks, noteKeys, type LayoutState } from '../docx/emit.js';
import { estimatePages } from '../docx/estimate.js';
import type { IRBlock, SectInfo } from '../docx/ir.js';
import { FALLBACK_SPLIT_OVER, MAX_PAGES, TRUNC_PAGES, TRUNC_TEXT } from '../docx/limits.js';
import { listTextLen, paginate, splitBySize, type PageIR } from '../docx/paginate.js';
import type { FlowPage } from '../model.js';

export interface FlowOut {
  pages: FlowPage[];
  texts: string[];
  /** 쪽 이름표: 저장된 조판의 쪽(표지가 있거나 쪽 수로 어림)이면 null(화면 'p.N'), 글자 수로 나눴으면 '구간 N' */
  labels: (string | null)[];
  truncated: string | null;
}

export interface FlowOpts {
  /** IR 에 저장된 조판의 쪽 경계 표지(lrpb)가 있다: 그대로 나눈다 */
  marks: boolean;
  /** 문서가 저장할 때 센 쪽 수 (요약 정보). 표지가 없을 때 쪽을 믿을지 정하고, 더 많으면 이 수를 목표로 높이를 어림한다 */
  appPages?: number;
  /** 기본 탭 간격 px */
  tab: number;
  /** 각주 글: 열쇠('f:0') → 블록. 참조가 처음 나온 쪽 끝에 붙인다 (docx index.ts 와 같다) */
  notes?: Map<string, IRBlock[]>;
}

/** A4 세로, Word 기본 여백(1인치)과 머리말 거리(0.5인치) px */
export const DEFAULT_SECT: SectInfo = {
  w: 793.7,
  h: 1122.5,
  margin: [96, 96, 96, 96],
  headerDist: 48,
  footerDist: 48,
  type: 'nextPage',
  titlePg: false,
  headers: {},
  footers: {},
};

export function layoutFlow(blocks: IRBlock[], sections: SectInfo[], opts: FlowOpts): FlowOut {
  const sects = sections.length > 0 ? sections : [DEFAULT_SECT];
  let pages: PageIR[] = paginate(blocks, sects);
  let fallback = false;
  if (!opts.marks) {
    const app = opts.appPages;
    let trusted = app !== undefined && app === pages.length && pages.every((pg) => listTextLen(pg.blocks) <= FALLBACK_SPLIT_OVER);
    if (!trusted && app !== undefined && app > 1 && app !== pages.length) {
      const est = estimatePages(pages, {
        sections: sects,
        appPages: app,
        chrome: (si) => {
          const s = sects[Math.min(si, sects.length - 1)]!;
          return { top: s.margin[0], bottom: s.margin[2] };
        },
        tab: opts.tab,
      }).pages;
      if (est.length === app) {
        pages = est;
        trusted = true;
      }
    }
    if (!trusted) {
      fallback = true;
      pages = pages.flatMap(splitBySize);
    }
  }
  let pageCut = false;
  if (pages.length > MAX_PAGES) {
    pages = pages.slice(0, MAX_PAGES);
    pageCut = true;
  }
  const st: LayoutState = { total: 0, stopped: false, cut: false };
  const out: FlowPage[] = [];
  const texts: string[] = [];
  const emittedNotes = new Set<string>();
  for (const pg of pages) {
    if (st.stopped) break;
    const sect = sects[Math.min(Math.max(pg.sect, 0), sects.length - 1)]!;
    const pre = expandList(pg.blocks, true);
    if (opts.notes && opts.notes.size > 0) {
      const keys = noteKeys(pg.blocks).filter((k) => !emittedNotes.has(k) && opts.notes!.has(k));
      for (const k of keys) emittedNotes.add(k);
      for (const b of noteBlocks(keys, opts.notes)) pre.push(b);
    }
    const laid = layoutList(pre, 0, st);
    if (st.stopped && laid.blocks.length === 0 && laid.text === '' && out.length > 0) break;
    out.push({
      pageNo: out.length + 1,
      w: sect.w,
      h: sect.h,
      margin: [...sect.margin],
      blocks: laid.blocks,
      headerDist: sect.headerDist,
      footerDist: sect.footerDist,
    });
    texts.push(laid.text);
    st.total += laid.text.length;
  }
  if (out.length === 0) {
    const s = sects[0]!;
    out.push({ pageNo: 1, w: s.w, h: s.h, margin: [...s.margin], blocks: [], headerDist: s.headerDist, footerDist: s.footerDist });
    texts.push('');
  }
  const truncated = st.cut ? TRUNC_TEXT : pageCut ? TRUNC_PAGES : null;
  return { pages: out, texts, labels: texts.map((_, i) => (fallback ? `구간 ${i + 1}` : null)), truncated };
}
