/**
 * Office 형식(Word, Excel, PowerPoint, 한글 hwpx, 텍스트) 판본 뷰어 페인
 *
 * PdfViewerPane 과 같은 동작을 PDF 가 아닌 판본에 준다. 화면은 서버가 업로드 때 만든 렌더 모델 JSON 만
 * 그리고(FlowView, SheetView, SlidesView, PlainView), 원본 바이트는 브라우저가 해석하지 않는다.
 *
 * 위치 계약: 렌더러의 글자 조각마다 data-o(그 쪽 page_text 안 시작 오프셋)가 있고 쪽 뿌리에 data-page 가 있다.
 * - 드래그 선택 → 쪽별 정본 지역 범위(domOffsets.rangeToLocal) → page_text 에서 인용과 전역 오프셋을 잘라
 *   POST /api/anchors 로 보낸다. 좌표(rects)는 보내지 않는다(서버가 오프셋 구간의 글자와 인용을 대조한다).
 * - 앵커의 전역 오프셋 → 쪽 지역 범위 → 조각 글자 노드 위 Range 의 사각형(localToPieceRects) → 하이라이트.
 *   퍼지 매칭이 없어 선택한 글자와 다시 그린 하이라이트가 글자 단위로 같다.
 *
 * PdfViewerPane 과 같게 둔 것: 하이라이트 색과 굵은 밑줄, 여백 배지(같은 줄대 묶음, 라벨 형식), 인용 문항
 * 팝오버, 매핑 모드 테두리와 안내줄, 플로팅 툴바와 색 메뉴, 60% 겹침 제안, 토스트 문구, 캡처 단계 Enter/Esc.
 * 클래스도 pvp-* 를 그대로 써서 두 뷰어가 같아 보인다.
 *
 * 구조: .pvp-root.ovp-root > .ovp-scroll(스크롤) > .ovp-content(좌표 기준) > [.ovp-zoom(렌더러), .ovp-overlay]
 * - 하이라이트 층(.ovp-overlay)은 하나이고 확대 상자 밖에 있어 배지 글자가 확대율을 따라 작아지지 않는다.
 *   좌표 = 화면 사각형 - .ovp-content 의 화면 위치 (스크롤해도 변하지 않는다).
 * - 흐름 문서의 쪽이 페인보다 넓으면 .ovp-zoom 에 CSS zoom(최소 0.5)을 걸어 폭에 맞춘다. 텍스트 쪽은
 *   폭이 페인을 따라가고(최대 840px), 시트와 슬라이드는 렌더러가 스스로 폭에 맞춘다.
 *   쓸 수 있는 폭은 세로 스크롤 막대가 늘 있다고 보고 잰다(officepane.css 의 scrollbar-gutter: stable).
 *   막대가 생길 때마다 폭이 줄면 줄인 확대율이 넘침을 없애 막대가 사라지고, 다시 커진 확대율이 넘침을 만드는
 *   고리를 돈다(고전 스크롤 막대를 쓰는 Windows).
 * - 사용자 확대/축소(viewerZoom.ts): 맨 위 단추 줄(ZoomBar), Ctrl+휠, Ctrl+드래그로 고른 배율을 같은 .ovp-zoom 에 건다.
 *   '폭 맞춤'은 흐름 문서를 칸 폭에 정확히 맞추고, 숫자 배율은 모든 형식에 건다. 스크롤 상자는 단추 줄 아래에서 시작한다.
 * - 페인, 쪽 크기, 글꼴 로드, 확대율, 시트 전환, 시트 행 렌더, 렌더러 안쪽 스크롤 때 하이라이트를 다시 잰다.
 * - 하이라이트 조각은 조각 조상이 자르는 상자(overflow, clip-path, paint containment)로 자른다. 보이지 않게 잘린
 *   글자 위로 하이라이트가 번지지 않는다(시트의 잘린 한 줄 칸 .osv-c.osv-clip, 흐름 문서의 높이 고정 칸 등).
 * - 매핑 모드에서는 스크롤 상자를 안내줄(.pvp-mapbar) 아래에서 시작한다. PDF 는 쪽 여백이 줄 밑에 들어가지만
 *   시트는 열 머리와 고정 행이 늘 맨 위에 붙어 있어 줄에 가려지기 때문이다.
 *
 * 시트(SheetView)는 격자가 자기 스크롤 상자(.osv-scroll) 안에서 움직이고 열 머리, 행 머리, 틀 고정 칸이
 * sticky 로 떠 있다. SheetView 머리 주석의 층 규칙(고정 열 1, 고정 행 2, 둘 다 3, 행 머리 5 이상, 열 머리 7 이상)에
 * 맞춰 하이라이트 층은 styles.css, officepane.css 의 z-index 그대로 그린다(검색 3, 조각 4, 배지 6: 고정 칸 위,
 * 행/열 머리 아래). 그래서 시트의 하이라이트 조각은
 * - 그 스크롤 상자의 보이는 영역과 칸의 보이는 글자 상자로 자르고(위의 조상 자르기),
 * - 고정 띠 아래로 지나가는 칸이면 쪽 요소의 data-sticky-top, data-sticky-left 띠 밖으로 자른다. 고정 행 칸은
 *   왼쪽 띠만, 고정 열 칸은 위쪽 띠만 자르고, 둘 다인 칸은 자르지 않는다(td[data-frozen] 이 r, c, rc).
 * - 포커스 이동은 SheetView 의 scrollToCell 로 시트를 바꾸고 가상화된 행을 먼저 그리게 한 뒤, 고정 띠 아래
 *   20px 자리로 맞춘다.
 * - 가상화된 시트에서 드래그가 자동 스크롤로 시작 행을 지나치면 그 행이 DOM 에서 빠지고 브라우저가 선택의
 *   기준점을 조각 밖으로 옮긴다. 그래서 누른 직후의 기준점을 정본 위치로 붙잡아 두고, 놓을 때 기준점이 옮겨졌으면
 *   그 값으로 범위의 시작(뒤로 끌었으면 끝)을 되돌린다.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ApiError,
  addPassageLink,
  createAnchor,
  fetchVersionAnchors,
  removePassageLink,
  versionDownloadUrl,
  versionMediaUrl,
  type AnchorInfo,
  type AnchorOverlapInfo,
  type AnchorQuestionRef,
  type CreateAnchorRequest,
  type FileKind,
} from '../api';
import { useAuth } from '../auth';
import { chipGlyph } from '../components/EvidenceCards';
import { errorMessage } from '../util';
import type { MapTargetQuestion, PdfViewerPaneProps } from '../pdf/PdfViewerPane';
import { loadPageText, pageIndexAt, quoteFields, toGlobalOffset, type PageTextData } from '../pdf/pageText';
import QuestionPicker, { type PickedQuestion } from '../pdf/QuestionPicker';
import {
  localToPieceRects,
  mergeLineBoxes,
  pieceIndex,
  pointToLocal,
  rangeToLocal,
  type Box,
  type LocalPoint,
  type LocalRange,
  type PieceInfo,
} from './domOffsets';
import FlowView from './FlowView';
import ZoomBar from './ZoomBar';
import { clampZoom, loadZoom, saveZoom, stepZoom, useZoomGestures, zoomPercent, type ZoomMode } from './viewerZoom';
import type { RenderModel, SheetPage } from './model';
import PlainView from './PlainView';
import { loadRenderModel } from './renderCache';
import SheetView, { type SheetScrollTarget } from './SheetView';
import SlidesView from './SlidesView';
import { num } from './text-utils';
import './officepane.css';

// ── 공개 타입 ────────────────────────────────────────────────────────────────

export interface OfficeViewerPaneProps extends PdfViewerPaneProps {
  /** 판본 원본 형식 (PDF 는 PdfViewerPane, 그림은 ImageViewerPane 이 맡는다) */
  fileKind: Exclude<FileKind, 'pdf' | 'image'>;
  /** 처음 열 때 찾아서 노랑으로 보이고 그 자리로 옮겨 갈 검색어 */
  initialQuery?: string;
}

// ── 하이라이트 색 팔레트 (PdfViewerPane 과 같은 값) ──────────────────────────

const HL_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'] as const;
type HlColor = (typeof HL_COLORS)[number];

const COLOR_BG: Record<string, string> = {
  yellow: 'rgba(255, 233, 168, 0.75)', // --y-half (반 형광)
  green: 'rgba(134, 239, 172, 0.5)',
  blue: 'rgba(147, 197, 253, 0.5)',
  pink: 'rgba(249, 168, 212, 0.5)',
  orange: 'rgba(253, 186, 116, 0.55)',
};
const COLOR_LINE: Record<string, string> = {
  yellow: '#d97706',
  green: '#15803d',
  blue: '#1d4ed8',
  pink: '#be185d',
  orange: '#c2410c',
};
const COLOR_NAME: Record<string, string> = {
  yellow: '노랑',
  green: '초록',
  blue: '파랑',
  pink: '분홍',
  orange: '주황',
};

function snip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

/** 서버 400 의 details 문구가 있으면 그것을, 아니면 일반 오류 문구 */
function apiErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 400) {
    const d = e.body?.details;
    if (typeof d === 'string' && d.trim() !== '') return d;
  }
  return errorMessage(e);
}

// ── 상수 ─────────────────────────────────────────────────────────────────────

/** 배지 묶음: 같은 줄대로 보는 세로 근접 px */
const CLUSTER_PX = 18;
/** 포커스 펄스 유지 시간 (CSS hl-pulse 0.7s × 2 회 + 여유) */
const PULSE_MS = 1600;
/** 포커스, 검색 이동 때 대상 사각형을 스크롤 상자 위끝에서 띄우는 px */
const REVEAL_MARGIN = 20;
/** 쪽으로 이동할 때 쪽 위끝 여백 px */
const PAGE_MARGIN = 8;
/** 확대 하한 */
const MIN_ZOOM = 0.5;
/** 흐름 문서 바깥 여백(.ofv-flow padding 16px × 2) + 쪽 테두리 여유 */
const FLOW_GUTTER = 34;
/** 흐름 문서 쪽 너비를 모를 때 (A4 96dpi) */
const FLOW_DEFAULT_W = 794;
/** 슬라이드 보기의 덱 좌우 여백 합(.osl-deck padding 16px × 2)과 슬라이드 최대 폭(.osl-slide max-width, slidesview.css) */
const SLIDE_DECK_PAD_X = 32;
const SLIDE_MAX_W = 1280;
/** DOM 준비를 기다리며 다시 시도하는 간격과 횟수 */
const RETRY_MS = 100;
const RETRY_MAX = 60;

const IGNORABLE_RE = /[\s​-‍﻿]/;

// ── 정본 오프셋 도우미 ───────────────────────────────────────────────────────

/** 전역 구간 [gs, ge) → 쪽별 지역 범위 (page_text 의 startOffset 기준, 글자 없는 쪽 구간은 뺀다) */
function globalToLocalRanges(data: PageTextData, gs: number, ge: number): LocalRange[] {
  const pages = data.pages;
  let lo = 0;
  let hi = pages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid]!;
    if (p.startOffset + p.text.length > gs) hi = mid;
    else lo = mid + 1;
  }
  const out: LocalRange[] = [];
  for (let i = lo; i < pages.length; i += 1) {
    const p = pages[i]!;
    if (p.startOffset >= ge) break;
    const s = Math.max(gs, p.startOffset) - p.startOffset;
    const e = Math.min(ge, p.startOffset + p.text.length) - p.startOffset;
    if (e > s) out.push({ pageNo: p.pageNo, start: s, end: e });
  }
  return out;
}

/** 검색용 그림자: 공백, 제로폭을 빼고 소문자로 (pageText.ts 의 그림자와 같은 생각, 길이가 바뀌는 글자는 그대로) */
function foldShadow(s: string): { shadow: string; map: number[] } {
  const map: number[] = [];
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    if (IGNORABLE_RE.test(ch)) continue;
    const low = ch.toLowerCase();
    out += low.length === 1 ? low : ch;
    map.push(i);
  }
  return { shadow: out, map };
}

/** 쪽 글자에서 검색어가 나오는 모든 자리 (대소문자, 공백 무시, 겹치지 않게, 최대 200) */
function findQueryInText(text: string, query: string): { start: number; end: number }[] {
  const needle = foldShadow(query.normalize('NFC')).shadow;
  if (needle.length === 0) return [];
  const hay = foldShadow(text);
  const out: { start: number; end: number }[] = [];
  let from = 0;
  while (out.length < 200) {
    const at = hay.shadow.indexOf(needle, from);
    if (at === -1) break;
    const s = hay.map[at];
    const e = hay.map[at + needle.length - 1];
    if (s === undefined || e === undefined) break;
    out.push({ start: s, end: e + 1 });
    from = at + needle.length;
  }
  return out;
}

/** 시트 쪽에서 지역 오프셋을 품은 칸 (구분자 자리면 다음 칸) */
function cellAtOffset(page: SheetPage, off: number): { r: number; c: number } | null {
  let next: { r: number; c: number } | null = null;
  for (const row of page.rows) {
    for (const cell of row.cells) {
      if (typeof cell.o !== 'number' || typeof cell.t !== 'string' || cell.t.length === 0) continue;
      if (off >= cell.o && off < cell.o + cell.t.length) return { r: row.r, c: cell.c };
      if (cell.o > off && next === null) next = { r: row.r, c: cell.c };
    }
  }
  return next;
}

// ── DOM 도우미 ───────────────────────────────────────────────────────────────

function isScrollable(el: HTMLElement): boolean {
  const cs = window.getComputedStyle(el);
  const y = /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
  const x = /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
  return x || y;
}

/** el 에서 stop(포함)까지 올라가며 스크롤 상자를 안쪽부터 */
function scrollChain(el: Element, stop: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n === stop) {
      out.push(n);
      break;
    }
    if (isScrollable(n)) out.push(n);
  }
  return out;
}

/**
 * 시트 스크롤 상자 위, 왼쪽에 떠서 내용을 가리는 띠의 두께 (열 머리 + 고정 행, 행 머리 + 고정 열).
 * 대상 칸이 고정 행(열)이면 세로(가로)로 옮길 필요가 없어 null.
 * 클래스 이름은 SheetView 머리 주석의 층 규칙(osv-fr, osv-fc, osv-frb, osv-fcb, osv-rh)을 따른다.
 */
function stickyBands(sc: HTMLElement, target: Element): { top: number | null; left: number | null } {
  const page = target.closest('[data-page]');
  if (!page || !sc.contains(page)) return { top: 0, left: 0 };
  const td = target.closest('td');
  const frozenRow = td?.classList.contains('osv-fr') ?? false;
  const frozenCol = td?.classList.contains('osv-fc') ?? false;
  const box = sc.getBoundingClientRect();
  const visTop = box.top + sc.clientTop;
  const visLeft = box.left + sc.clientLeft;
  let top = 0;
  const head = page.querySelector('thead');
  if (head) top = Math.max(top, head.getBoundingClientRect().bottom - visTop);
  for (const b of Array.from(page.querySelectorAll('td.osv-frb, th.osv-frb'))) {
    top = Math.max(top, b.getBoundingClientRect().bottom - visTop);
  }
  let left = 0;
  const rh = page.querySelector('th.osv-rh');
  if (rh) left = Math.max(left, rh.getBoundingClientRect().right - visLeft);
  for (const b of Array.from(page.querySelectorAll('td.osv-fcb'))) {
    left = Math.max(left, b.getBoundingClientRect().right - visLeft);
  }
  return { top: frozenRow ? null : top, left: frozenCol ? null : left };
}

/**
 * 대상 사각형이 각 스크롤 상자의 보이는 위끝에서 margin px 아래에 오도록 안쪽 상자부터 옮긴다.
 * 가로는 보이지 않을 때만 옮긴다. sheet 이면 렌더러 안쪽 스크롤 상자에서 떠 있는 띠(stickyBands) 아래를 위끝으로 본다.
 */
function revealRect(
  el: Element,
  getRect: () => DOMRect | null,
  stop: HTMLElement,
  margin: number,
  sheet: boolean,
): void {
  for (const sc of scrollChain(el, stop)) {
    const r = getRect();
    if (!r) return;
    const bands = sheet && sc !== stop ? stickyBands(sc, el) : { top: 0, left: 0 };
    const box = sc.getBoundingClientRect();
    if (bands.top !== null) {
      const visTop = box.top + sc.clientTop + bands.top;
      sc.scrollTop += r.top - visTop - margin;
    }
    if (bands.left !== null) {
      const visLeft = box.left + sc.clientLeft + bands.left;
      const visRight = box.left + sc.clientLeft + sc.clientWidth;
      if (r.left < visLeft || r.right > visRight) sc.scrollLeft += r.left - visLeft - margin;
    }
  }
}

/** 지역 범위의 첫(가장 위, 그다음 왼쪽) 화면 사각형과 그 조각 요소 */
function firstPieceRect(pageEl: Element, start: number, end: number): { rect: DOMRect; el: Element } | null {
  let best: { rect: DOMRect; el: Element } | null = null;
  for (const pr of localToPieceRects(pageEl, start, end)) {
    for (const r of pr.rects) {
      const b = best?.rect;
      if (!b || r.top < b.top - 1 || (Math.abs(r.top - b.top) <= 1 && r.left < b.left)) {
        best = { rect: r, el: pr.piece.el };
      }
    }
  }
  return best;
}

// ── 보이는 영역 자르기 (하이라이트 조각을 화면에 실제로 보이는 글자 위로만) ─────

/** 두 자르기 상자의 교집합 (null = 자르지 않음). 겹치지 않으면 뒤집힌 상자가 되어 clipBox 가 버린다 */
function intersectBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/** overflow 와 paint containment 가 자손을 자르지 않는 display (인라인 상자, 상자 없음, 표의 행/열 묶음) */
const NO_CLIP_DISPLAY = /^(inline|contents|none|table-(row|row-group|header-group|footer-group|column|column-group))$/;

/** el 의 화면 크기 / 배치 크기 (CSS zoom, transform 배율). 배치 크기가 0 이면 1 */
function boxScale(el: HTMLElement, r: DOMRect): { sx: number; sy: number } {
  return {
    sx: el.offsetWidth > 0 ? r.width / el.offsetWidth : 1,
    sy: el.offsetHeight > 0 ? r.height / el.offsetHeight : 1,
  };
}

/** clip-path 의 inset(...) 만큼 테두리 상자를 줄인 상자. 다른 모양은 테두리 상자로 어림한다 */
function clipPathBox(value: string, r: DOMRect, sx: number, sy: number): Box {
  const box: Box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  const m = /^inset\(([^)]*)\)/.exec(value.trim());
  if (!m) return box;
  const vals = ((m[1] ?? '').split(/\s+round\s+/)[0] ?? '').trim().split(/\s+/).filter((v) => v !== '');
  const len = (v: string | undefined, ref: number, scale: number): number => {
    if (!v) return 0;
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    return v.endsWith('%') ? (n / 100) * ref : n * scale;
  };
  const [t, rt = t, b = t, l = rt] = vals;
  box.top += len(t, r.height, sy);
  box.right -= len(rt, r.width, sx);
  box.bottom -= len(b, r.height, sy);
  box.left += len(l, r.width, sx);
  return box;
}

/**
 * el 자신이 그림을 자르는 상자 (뷰포트 좌표, 자르지 않는 축은 무한대). 자르지 않으면 null.
 * overflow 가 visible 이 아닌 축과 paint containment(contain: paint, content-visibility: auto)는 안쪽 여백 상자,
 * clip-path 는 그 모양(inset 만 정확히, 나머지는 테두리 상자)으로 자른다.
 */
function ownClip(el: Element): Box | null {
  if (!(el instanceof HTMLElement)) return null;
  const cs = window.getComputedStyle(el);
  const boxless = NO_CLIP_DISPLAY.test(cs.display);
  const paint =
    !boxless &&
    (/\b(paint|strict|content)\b/.test(cs.contain) || cs.getPropertyValue('content-visibility') === 'auto');
  const clipX = paint || (!boxless && cs.overflowX !== 'visible');
  const clipY = paint || (!boxless && cs.overflowY !== 'visible');
  const path = cs.clipPath;
  const hasPath = !!path && path !== 'none' && cs.display !== 'contents' && cs.display !== 'none';
  if (!clipX && !clipY && !hasPath) return null;
  const r = el.getBoundingClientRect();
  const { sx, sy } = boxScale(el, r);
  let box: Box | null = null;
  if (clipX || clipY) {
    const left = r.left + el.clientLeft * sx;
    const top = r.top + el.clientTop * sy;
    box = {
      left: clipX ? left : -Infinity,
      right: clipX ? left + el.clientWidth * sx : Infinity,
      top: clipY ? top : -Infinity,
      bottom: clipY ? top + el.clientHeight * sy : Infinity,
    };
  }
  if (hasPath) box = intersectBox(box, clipPathBox(path, r, sx, sy));
  return box;
}

/** n 과 그 조상(stop 은 빼고)이 자르는 상자의 교집합. 한 번 잰 사슬 결과는 memo 에 둔다 */
function chainClip(n: Element | null, stop: Element, memo: Map<Element, Box | null>): Box | null {
  if (!n || n === stop) return null;
  const hit = memo.get(n);
  if (hit !== undefined) return hit;
  const v = intersectBox(ownClip(n), chainClip(n.parentElement, stop, memo));
  memo.set(n, v);
  return v;
}

/** 고정 띠가 끝나는 화면 좌표: 위쪽 띠의 아래 끝, 왼쪽 띠의 오른쪽 끝 */
interface StickyEdges {
  top: number;
  left: number;
}

function numAttr(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 쪽 요소의 data-sticky-top, data-sticky-left(스크롤 상자 안쪽 위, 왼쪽에서 고정 띠가 덮는 px: SheetView)를
 * 화면 좌표로. 속성이 없으면 null.
 */
function stickyEdges(pageEl: HTMLElement): StickyEdges | null {
  const t = numAttr(pageEl, 'data-sticky-top');
  const l = numAttr(pageEl, 'data-sticky-left');
  if (t === null && l === null) return null;
  let sc = pageEl.parentElement;
  while (sc) {
    const cs = window.getComputedStyle(sc);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') break;
    sc = sc.parentElement;
  }
  if (!sc) return null;
  const r = sc.getBoundingClientRect();
  const { sx, sy } = boxScale(sc, r);
  return {
    top: r.top + (sc.clientTop + (t ?? 0)) * sy,
    left: r.left + (sc.clientLeft + (l ?? 0)) * sx,
  };
}

/** 고정 띠 밖으로 자르는 상자: 일반 칸은 두 띠, 고정 행 칸(r)은 왼쪽 띠, 고정 열 칸(c)은 위쪽 띠, 둘 다(rc)는 없음 */
function stickyClip(edges: StickyEdges | null, piece: Element, pageEl: Element): Box | null {
  if (!edges) return null;
  const cell = piece.closest('[data-frozen]');
  const frozen = cell && pageEl.contains(cell) ? cell.getAttribute('data-frozen') : null;
  if (frozen === 'rc') return null;
  return {
    left: frozen === 'c' ? -Infinity : edges.left,
    top: frozen === 'r' ? -Infinity : edges.top,
    right: Infinity,
    bottom: Infinity,
  };
}

// ── 확대율, 드래그 선택 도우미 ─────────────────────────────────────────────

let classicBarW: number | null = null;
/** 자리를 차지하는 스크롤 막대의 폭 (겹쳐 그리는 막대면 0). 한 번만 잰다 */
function classicScrollbarWidth(): number {
  if (classicBarW !== null) return classicBarW;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:-10000px;left:0;width:100px;height:100px;overflow:scroll;visibility:hidden';
  document.body.appendChild(probe);
  classicBarW = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return classicBarW;
}

/** 마우스를 누른 자리가 스크롤 막대(또는 테두리) 위인가: 안쪽 여백 상자 밖이면서 테두리 상자 안 */
function onScrollbar(e: MouseEvent): boolean {
  const t = e.target;
  if (!(t instanceof HTMLElement) || t.clientWidth <= 0 || t.clientHeight <= 0) return false;
  const cs = window.getComputedStyle(t);
  if (cs.overflowX === 'visible' && cs.overflowY === 'visible') return false;
  const r = t.getBoundingClientRect();
  const { sx, sy } = boxScale(t, r);
  const x = (e.clientX - r.left) / sx - t.clientLeft;
  const y = (e.clientY - r.top) / sy - t.clientTop;
  return x >= t.clientWidth || y >= t.clientHeight;
}

/** 선택의 기준점(anchor)이 끝점(focus)보다 DOM 순서로 앞인가 (끝점이 범위의 끝 쪽에 있나) */
function selectionIsForward(ws: Selection): boolean {
  const a = ws.anchorNode;
  const f = ws.focusNode;
  if (!a || !f) return true;
  if (a === f) return ws.anchorOffset <= ws.focusOffset;
  try {
    const r = document.createRange();
    r.setStart(a, ws.anchorOffset);
    return r.comparePoint(f, ws.focusOffset) >= 0;
  } catch {
    return true;
  }
}

/** 드래그를 시작한 자리: 누른 직후 선택의 기준점과, 그 끝에서 지킬 정본 위치 */
interface DragStart {
  node: Node;
  offset: number;
  /** 앞으로 끌면 범위의 시작 (두 번, 세 번 눌러 고른 낱말, 문단이면 그 처음) */
  start: LocalPoint | null;
  /** 뒤로 끌면 범위의 끝 (두 번, 세 번 눌러 고른 낱말, 문단이면 그 끝) */
  end: LocalPoint | null;
}

/** 누름에서 놓음까지 한 번의 마우스 동작 */
interface Gesture {
  /** 스크롤 막대를 눌렀다 (선택 동작이 아니다) */
  scrollbar: boolean;
  /** 문서 안에서 누른 드래그의 시작 (누른 직후 비동기로 채운다) */
  drag: DragStart | null;
}

/**
 * 드래그 도중 기준점이 DOM 변경으로 옮겨졌는가. 기준점이 있던 노드가 DOM 에서 빠졌거나(가상화된 시트가 그 행을
 * 내림), 기준점이 바뀌어 글자 조각 밖(옮겨진 부모 자리)에 있으면 그렇다. 낱말, 문단 단위로 늘릴 때 브라우저가
 * 기준점을 그 낱말, 문단의 끝으로 바꾸는 것은 조각 안이거나 붙잡아 둔 값과 같은 결과라 문제가 없다.
 */
function anchorRelocated(ws: Selection, drag: DragStart, content: Element): boolean {
  if (!drag.node.isConnected) return true;
  if (ws.anchorNode === drag.node && ws.anchorOffset === drag.offset) return false;
  const a = ws.anchorNode;
  const el = a ? (a.nodeType === Node.ELEMENT_NODE ? (a as Element) : a.parentElement) : null;
  return !(el && content.contains(el) && el.closest('[data-o]'));
}

function cmpPoint(a: LocalPoint, b: LocalPoint): number {
  return a.pageNo - b.pageNo || a.offset - b.offset;
}

/**
 * 옮겨진 기준점 대신 붙잡아 둔 정본 위치로 범위를 다시 만든다. ranges 는 브라우저 범위를 바꾼 것이고,
 * focusAtEnd 는 그 범위의 끝 쪽에 끝점(focus)이 있는가(기준점이 DOM 순서로 앞인가)다. 끝점 쪽 값은 브라우저 범위의
 * 그 끝을 그대로 쓰고(낱말 단위로 늘린 것도 따른다), 앞으로 끌었는지 뒤로 끌었는지는 정본 위치끼리 견준다
 * (자동 스크롤로 내려갔다가 시작 행 위로 되돌아오면 옮겨진 기준점의 DOM 순서가 실제 방향과 반대가 된다).
 * 만들 수 없으면(쪽이 다르다, 빈 범위) null.
 */
function pinDragStart(ranges: LocalRange[], drag: DragStart, focusAtEnd: boolean): LocalRange[] | null {
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const s = drag.start;
  const e = drag.end;
  if (!first || !last) return null;
  if (focusAtEnd) {
    const f: LocalPoint = { pageNo: last.pageNo, offset: last.end };
    if (s && cmpPoint(f, s) > 0) {
      // 앞으로 끌었다: 시작을 누른 자리로
      if (s.pageNo !== first.pageNo || s.offset >= first.end) return null;
      return [{ pageNo: s.pageNo, start: s.offset, end: first.end }, ...ranges.slice(1)];
    }
    // 끝점이 누른 자리보다 앞: 실제로는 뒤로 끌었다
    if (e && cmpPoint(f, e) < 0 && f.pageNo === e.pageNo) return [{ pageNo: e.pageNo, start: f.offset, end: e.offset }];
    return null;
  }
  const f: LocalPoint = { pageNo: first.pageNo, offset: first.start };
  if (e && cmpPoint(f, e) < 0) {
    // 뒤로 끌었다: 끝을 누른 자리로
    if (e.pageNo !== last.pageNo || e.offset <= last.start) return null;
    return [...ranges.slice(0, -1), { pageNo: e.pageNo, start: last.start, end: e.offset }];
  }
  // 끝점이 누른 자리보다 뒤: 실제로는 앞으로 끌었다
  if (s && cmpPoint(f, s) > 0 && f.pageNo === s.pageNo) return [{ pageNo: s.pageNo, start: s.offset, end: f.offset }];
  return null;
}

function clipBox(b: Box, clip: Box | null): Box | null {
  if (!clip) return b;
  const out = {
    left: Math.max(b.left, clip.left),
    top: Math.max(b.top, clip.top),
    right: Math.min(b.right, clip.right),
    bottom: Math.min(b.bottom, clip.bottom),
  };
  return out.right - out.left > 0.5 && out.bottom - out.top > 0.5 ? out : null;
}

// ── 하이라이트 층 계산 결과 ──────────────────────────────────────────────────

interface OverlayPart {
  key: string;
  anchorId: number;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
}

interface OverlayBadge {
  key: string;
  label: string;
  /** 줄인 라벨일 때 전체 라벨 (툴팁, 화면 읽기 이름). 시트 위 배지만 */
  full?: string;
  anchorIds: number[];
  top: number;
  left: number;
  /** 최대 폭 px: PDF 뷰어의 max-width 46% 와 같은 기준(쪽 폭의 46%). 하이라이트 층은 크기 0 이라 % 가 0 이 된다 */
  maxW: number;
}

interface OverlayBox {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface OverlayState {
  parts: OverlayPart[];
  badges: OverlayBadge[];
  search: OverlayBox[];
}

const EMPTY_OVERLAY: OverlayState = { parts: [], badges: [], search: [] };

function sameOverlay(a: OverlayState, b: OverlayState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 배지 라벨: PdfViewerPane 과 같은 형식 (문항 번호 둘까지 ' · ' 로, 넘치면 ' +N', 없으면 '근거', 앞에 칩 순번) */
function badgeLabel(
  anchorIds: number[],
  anchorMap: Map<number, AnchorInfo>,
  chipOrdinals: Map<number, number> | undefined,
): string {
  const nos: string[] = [];
  for (const aid of anchorIds) {
    for (const q of anchorMap.get(aid)?.questions ?? []) {
      if (!nos.includes(q.questionNo)) nos.push(q.questionNo);
    }
  }
  const base =
    nos.length === 0
      ? '근거'
      : nos.length <= 2
        ? nos.join(', ')
        : `${nos.slice(0, 2).join(', ')} +${nos.length - 2}`;
  const ords = anchorIds
    .map((aid) => chipOrdinals?.get(aid))
    .filter((n): n is number => n != null)
    .sort((x, y) => x - y);
  const prefix = ords.map(chipGlyph).join('');
  return prefix ? `${prefix} ${base}` : base;
}

/**
 * 시트 위 배지의 줄인 라벨: 칩 순번만(없으면 문항 수). 시트는 쪽 여백이 없어 배지가 칸 위에 놓이므로
 * 칸 글자를 덜 가리게 한다(좁은 창에서 전체 라벨이 칸 하나를 다 가렸다). 전체 라벨은 툴팁으로
 */
function compactBadgeLabel(
  anchorIds: number[],
  anchorMap: Map<number, AnchorInfo>,
  chipOrdinals: Map<number, number> | undefined,
): string {
  const ords = anchorIds
    .map((aid) => chipOrdinals?.get(aid))
    .filter((n): n is number => n != null)
    .sort((x, y) => x - y);
  if (ords.length > 0) return ords.map(chipGlyph).join('');
  const nos = new Set<string>();
  for (const aid of anchorIds) {
    for (const q of anchorMap.get(aid)?.questions ?? []) nos.add(q.questionNo);
  }
  return nos.size === 0 ? '근거' : `${nos.size}문항`;
}

/** 그릴 수 있는 앵커: 해석됨(resolved*) + 정본 오프셋 있음 */
function drawable(a: AnchorInfo): a is AnchorInfo & { startOffset: number; endOffset: number } {
  return (
    String(a.status ?? '').startsWith('resolved') &&
    typeof a.startOffset === 'number' &&
    typeof a.endOffset === 'number' &&
    a.endOffset > a.startOffset
  );
}

// ── 본체 ─────────────────────────────────────────────────────────────────────

interface SelState {
  /** 쪽별 정본 지역 범위 (pageNo 오름차순) */
  ranges: LocalRange[];
  /** 페인 기준 툴바 좌표 */
  x: number;
  y: number;
}

/** 화면 이동 요청: 앵커 포커스, 검색 첫 자리, 첫 쪽 */
type RevealReq =
  | { kind: 'range'; pageNo: number; start: number; end: number; anchorId: number | null; tries: number; cellAsked: boolean }
  | { kind: 'page'; pageNo: number; tries: number };

interface SearchMarks {
  pageNo: number;
  ranges: { start: number; end: number }[];
}

/**
 * 이 뷰어를 품지도, 이 뷰어 안에 있지도 않은 모달 대화상자가 떠 있는가.
 * (예: 문항 상세에서 첨부 미리보기를 연 채 Enter 를 누르면 아래 뷰어의 매핑 툴바가 연결을 확정하던 문제)
 */
function isBehindModal(root: HTMLElement | null): boolean {
  if (!root) return false;
  for (const d of document.querySelectorAll('[aria-modal="true"]')) {
    if (!d.contains(root) && !root.contains(d)) return true;
  }
  return false;
}

export default function OfficeViewerPane({
  versionId,
  mode,
  mapTargetQuestion,
  focusAnchorId,
  onLinked,
  onBadgeOpenQuestion,
  initialPage,
  chipOrdinals,
  fileKind,
  initialQuery,
  mapHint,
}: OfficeViewerPaneProps) {
  const { user } = useAuth();
  const canEdit = user != null && user.role !== 'viewer';
  const isMap = mode === 'map' && !!mapTargetQuestion && canEdit;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mapbarRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const pulseTimerRef = useRef<number | null>(null);

  const [model, setModel] = useState<RenderModel | null>(null);
  const [pageData, setPageData] = useState<PageTextData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<AnchorInfo[] | null>(null);
  const [anchorsError, setAnchorsError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelState | null>(null);
  // target: 이 확인 창을 띄운 요청의 문항. [새로 만들기], [기존 하이라이트에 추가]와 그 안내가 모두 이 문항을 쓴다
  const [overlap, setOverlap] = useState<{
    req: CreateAnchorRequest;
    target: MapTargetQuestion;
    info: AnchorOverlapInfo;
  } | null>(null);
  const [popover, setPopover] = useState<{ anchorIds: number[]; x: number; y: number } | null>(
    null,
  );
  const [linkPicker, setLinkPicker] = useState<{ passageId: number } | null>(null);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [color, setColor] = useState<HlColor>('yellow');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** 지금 연결할 문항 (응답을 기다리는 사이에 문항이 바뀌었는지 비동기 콜백이 확인한다) */
  const targetIdRef = useRef<number | null>(null);
  targetIdRef.current = mapTargetQuestion?.id ?? null;
  const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);
  const [pulseId, setPulseId] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  /** 스크롤 상자의 쓸 수 있는 폭(배율 1 기준): 슬라이드의 100% 폭을 정하는 데 쓴다 */
  const [availW, setAvailW] = useState(0);
  const [activeSheet, setActiveSheet] = useState<number>(() =>
    initialPage != null && initialPage >= 1 ? Math.floor(initialPage) : 1,
  );
  const [scrollCell, setScrollCell] = useState<SheetScrollTarget | null>(null);
  const [searchMarks, setSearchMarks] = useState<SearchMarks | null>(null);
  /** 매핑 안내줄 높이: 스크롤 상자를 그 아래에서 시작해 첫 줄(시트의 열 머리, 고정 행)이 줄에 가리지 않게 */
  const [barH, setBarH] = useState(0);

  // ── 최신 값 (rAF, 타이머 콜백이 읽는다) ─────────────────────────────────────
  const live = useRef({
    model: null as RenderModel | null,
    pageData: null as PageTextData | null,
    anchors: null as AnchorInfo[] | null,
    chipOrdinals: undefined as Map<number, number> | undefined,
    searchMarks: null as SearchMarks | null,
    activeSheet: 1,
    isMap: false,
  });
  useLayoutEffect(() => {
    live.current = { model, pageData, anchors, chipOrdinals, searchMarks, activeSheet, isMap };
  });

  const pageElsRef = useRef(new Map<number, HTMLElement>());
  const roRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number | null>(null);
  const revealRef = useRef<RevealReq | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const cellNonceRef = useRef(0);
  const focusPendingRef = useRef<number | null>(null);
  /** 포커스 이동을 한 번이라도 시작했다: 첫 쪽, 검색 이동은 하지 않는다(포커스 우선) */
  const focusStartedRef = useRef(false);
  const initialDoneRef = useRef(false);
  /** 지금 진행 중인 마우스 동작 (누를 때 만들고 놓을 때 읽고 지운다) */
  const gestureRef = useRef<Gesture | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  // ── 하이라이트 층 계산 ─────────────────────────────────────────────────────
  const computeOverlay = useCallback((): OverlayState => {
    const content = contentRef.current;
    const { model: m, pageData: data, anchors: list, chipOrdinals: ords, searchMarks: marks } =
      live.current;
    if (!content || !m || !data) return EMPTY_OVERLAY;
    const cRect = content.getBoundingClientRect();
    const isSheet = m.kind === 'sheet';
    const indexCache = new Map<number, PieceInfo[]>();
    const clipMemo = new Map<Element, Box | null>();
    const edgesCache = new Map<number, StickyEdges | null>();
    const pageEl = (pageNo: number): HTMLElement | null => {
      const el = pageElsRef.current.get(pageNo);
      return el && el.isConnected ? el : null;
    };
    const indexOf = (pageNo: number, el: HTMLElement): PieceInfo[] => {
      let idx = indexCache.get(pageNo);
      if (!idx) {
        idx = pieceIndex(el);
        indexCache.set(pageNo, idx);
      }
      return idx;
    };
    const edgesOf = (pageNo: number, el: HTMLElement): StickyEdges | null => {
      if (!edgesCache.has(pageNo)) edgesCache.set(pageNo, stickyEdges(el));
      return edgesCache.get(pageNo) ?? null;
    };
    /** 쪽 지역 범위 → 화면에 보이는 사각형 (뷰포트 좌표). 조각마다 조상 자르기와 고정 띠로 자른 뒤 같은 줄끼리 잇는다 */
    const segsFor = (pageNo: number, start: number, end: number): Box[] => {
      const el = pageEl(pageNo);
      if (!el) return [];
      const idx = indexOf(pageNo, el);
      const edges = edgesOf(pageNo, el);
      const all: Box[] = [];
      for (const pr of localToPieceRects(el, start, end, idx)) {
        const clip = intersectBox(chainClip(pr.piece.el, content, clipMemo), stickyClip(edges, pr.piece.el, el));
        const boxes: Box[] = [];
        for (const r of pr.rects) {
          const c = clipBox(r, clip);
          if (c) boxes.push(c);
        }
        // 시트는 칸마다 따로 잇는다(이웃 칸 글자와 이어 칸 사이 격자선 위로 칠하지 않게)
        if (isSheet) all.push(...mergeLineBoxes(boxes));
        else all.push(...boxes);
      }
      return isSheet ? all : mergeLineBoxes(all);
    };

    const parts: OverlayPart[] = [];
    const entries: { anchorId: number; pageNo: number; topY: number }[] = [];
    const anchorMap = new Map<number, AnchorInfo>();
    for (const a of list ?? []) {
      anchorMap.set(a.anchorId, a);
      if (!drawable(a)) continue;
      for (const lr of globalToLocalRanges(data, a.startOffset, a.endOffset)) {
        let topY = Infinity;
        segsFor(lr.pageNo, lr.start, lr.end).forEach((b, i) => {
          const top = b.top - cRect.top;
          parts.push({
            key: `a${a.anchorId}p${lr.pageNo}r${i}`,
            anchorId: a.anchorId,
            left: b.left - cRect.left,
            top,
            width: b.right - b.left,
            height: b.bottom - b.top,
            color: a.color || 'yellow',
          });
          topY = Math.min(topY, top);
        });
        if (Number.isFinite(topY)) entries.push({ anchorId: a.anchorId, pageNo: lr.pageNo, topY });
      }
    }

    // 여백 배지: 쪽별 같은 줄대(topY 18px 안) 묶음, 쪽 요소 오른쪽 끝(시트는 보이는 영역 오른쪽 끝)
    const badges: OverlayBadge[] = [];
    const byPage = new Map<number, typeof entries>();
    for (const e of entries) {
      const l = byPage.get(e.pageNo);
      if (l) l.push(e);
      else byPage.set(e.pageNo, [e]);
    }
    for (const [pageNo, l] of byPage) {
      const el = pageEl(pageNo);
      if (!el) continue;
      const pr = el.getBoundingClientRect();
      // 쪽을 자르는 조상(시트의 스크롤 상자)이 있으면 그 보이는 영역의 오른쪽 끝
      const clip = chainClip(el, content, clipMemo);
      const visR = clip ? Math.min(pr.right, clip.right) : pr.right;
      const visW = clip ? Math.max(0, visR - Math.max(pr.left, clip.left)) : pr.width;
      const right = visR - cRect.left - 6;
      const maxW = Math.max(48, Math.round(visW * 0.46));
      l.sort((p, q) => p.topY - q.topY);
      let cluster: typeof entries = [];
      const flush = () => {
        const head = cluster[0];
        if (!head) return;
        const anchorIds: number[] = [];
        for (const h of cluster) {
          if (!anchorIds.includes(h.anchorId)) anchorIds.push(h.anchorId);
        }
        const full = badgeLabel(anchorIds, anchorMap, ords);
        badges.push({
          key: `b${pageNo}:${anchorIds.join(',')}`,
          label: isSheet ? compactBadgeLabel(anchorIds, anchorMap, ords) : full,
          ...(isSheet ? { full } : {}),
          anchorIds,
          top: head.topY,
          left: right,
          maxW,
        });
        cluster = [];
      };
      for (const h of l) {
        const head = cluster[0];
        if (head && h.topY - head.topY > CLUSTER_PX) flush();
        cluster.push(h);
      }
      flush();
    }

    // 검색 자리 (노랑, 배지 없음)
    const search: OverlayBox[] = [];
    if (marks) {
      marks.ranges.forEach((r, ri) => {
        segsFor(marks.pageNo, r.start, r.end).forEach((b, bi) => {
          search.push({
            key: `s${ri}:${bi}`,
            left: b.left - cRect.left,
            top: b.top - cRect.top,
            width: b.right - b.left,
            height: b.bottom - b.top,
          });
        });
      });
    }
    return { parts, badges, search };
  }, []);

  const scheduleRecompute = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const next = computeOverlay();
      setOverlay((prev) => (sameOverlay(prev, next) ? prev : next));
    });
  }, [computeOverlay]);

  // ── 확대율 (흐름 문서만: 쪽이 페인보다 넓으면 폭에 맞춘다) ───────────────────
  const naturalWidth = useMemo(() => {
    if (!model || model.kind !== 'flow') return null;
    let w = 0;
    for (const p of model.pages) w = Math.max(w, num(p.w, 50, 20000) ?? FLOW_DEFAULT_W);
    return w > 0 ? w + FLOW_GUTTER : null;
  }, [model]);
  const naturalWidthRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    naturalWidthRef.current = naturalWidth;
  }, [naturalWidth]);

  // 사용자가 고른 배율(viewerZoom.ts): 'auto' 는 흐름 문서만 넓으면 줄여 맞춤, 'width' 는 흐름 문서를 칸 폭에
  // 정확히 맞춤(키우기도 한다. 시트, 슬라이드, 텍스트는 렌더러가 스스로 맞추므로 1), 숫자는 모든 형식에 그 배율
  const [zoomMode, setZoomMode] = useState<ZoomMode>(() => loadZoom('office'));
  const zoomModeRef = useRef<ZoomMode>(zoomMode);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  /** Ctrl 조작의 고정점: 배율이 바뀐 뒤 그 자리가 커서 밑에 남도록 스크롤을 맞춘다 */
  const zoomOriginRef = useRef<{ x: number; y: number; from: number; sl: number; st: number } | null>(null);

  const updateZoom = useCallback(() => {
    const sc = scrollRef.current;
    const nat = naturalWidthRef.current;
    if (!sc) return;
    // 세로 스크롤 막대가 늘 있다고 보고 잰다: 확대율이 넘침 여부(막대가 있고 없음)를 따르면 고리를 돈다.
    // 흐름 문서는 css 의 scrollbar-gutter: stable 로 막대 자리가 늘 비어 있어 clientWidth 그대로이고,
    // 그 속성을 모르는 브라우저에서 막대가 없을 때만 막대 폭을 뺀다.
    const cs = window.getComputedStyle(sc);
    const borders = (Number.parseFloat(cs.borderLeftWidth) || 0) + (Number.parseFloat(cs.borderRightWidth) || 0);
    const gutter = sc.offsetWidth - borders - sc.clientWidth;
    const avail = gutter > 0.5 ? sc.clientWidth : sc.clientWidth - classicScrollbarWidth();
    setAvailW((prev) => (Math.abs(prev - avail) < 0.5 ? prev : avail));
    const mode = zoomModeRef.current;
    let z = 1;
    if (typeof mode === 'number') z = clampZoom(mode);
    else if (mode === 'width') {
      if (nat && avail > 0) z = clampZoom(Math.floor((avail / nat) * 1000) / 1000);
    } else if (nat && avail > 0 && nat > avail) z = Math.max(MIN_ZOOM, Math.floor((avail / nat) * 1000) / 1000);
    setZoom((prev) => (Math.abs(prev - z) < 0.001 ? prev : z));
  }, []);

  useEffect(() => {
    updateZoom();
  }, [naturalWidth, updateZoom]);

  useLayoutEffect(() => {
    zoomModeRef.current = zoomMode;
    updateZoom();
  }, [zoomMode, updateZoom]);

  // 배율이 바뀐 뒤: Ctrl 조작이면 그 자리를 커서 밑에 남긴다(흐름 문서, 텍스트, 슬라이드. 시트는 격자가 따로 스크롤한다)
  useLayoutEffect(() => {
    const o = zoomOriginRef.current;
    zoomOriginRef.current = null;
    const sc = scrollRef.current;
    if (!o || !sc || o.from <= 0) return;
    const ratio = zoom / o.from;
    const r = sc.getBoundingClientRect();
    const px = o.x - r.left;
    const py = o.y - r.top;
    sc.scrollLeft = (o.sl + px) * ratio - px;
    sc.scrollTop = (o.st + py) * ratio - py;
  }, [zoom]);

  const chooseZoom = useCallback((mode: ZoomMode, origin?: { x: number; y: number }) => {
    const sc = scrollRef.current;
    zoomOriginRef.current =
      origin && sc ? { x: origin.x, y: origin.y, from: zoomRef.current, sl: sc.scrollLeft, st: sc.scrollTop } : null;
    setZoomMode(mode);
    saveZoom('office', mode);
  }, []);
  useZoomGestures(rootRef, {
    getScale: () => zoomRef.current,
    setScale: (s, origin) => chooseZoom(clampZoom(s), origin),
  });
  const onZoomStep = useCallback((dir: 1 | -1) => chooseZoom(stepZoom(zoomRef.current, dir)), [chooseZoom]);
  const onZoomReset = useCallback(() => chooseZoom(1), [chooseZoom]);
  const onToggleFit = useCallback(
    () => chooseZoom(zoomModeRef.current === 'width' ? 'auto' : 'width'),
    [chooseZoom],
  );

  // ── 크기 관찰: 페인과 쪽 요소 ──────────────────────────────────────────────
  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === scrollRef.current) updateZoom();
      }
      scheduleRecompute();
    });
    roRef.current = ro;
    if (scrollRef.current) ro.observe(scrollRef.current);
    for (const el of pageElsRef.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      roRef.current = null;
    };
  }, [scheduleRecompute, updateZoom]);

  const onPageElement = useCallback(
    (pageNo: number, el: HTMLElement | null) => {
      const map = pageElsRef.current;
      const prev = map.get(pageNo);
      if (prev && prev !== el) roRef.current?.unobserve(prev);
      if (el) {
        map.set(pageNo, el);
        roRef.current?.observe(el);
      } else {
        map.delete(pageNo);
      }
      scheduleRecompute();
    },
    [scheduleRecompute],
  );

  // 글꼴 로드 뒤 다시 잰다 (글자 폭이 바뀐다)
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return;
    let alive = true;
    void fonts.ready.then(() => {
      if (alive) scheduleRecompute();
    });
    const onDone = () => scheduleRecompute();
    fonts.addEventListener?.('loadingdone', onDone);
    return () => {
      alive = false;
      fonts.removeEventListener?.('loadingdone', onDone);
    };
  }, [scheduleRecompute]);

  // 렌더러 안쪽 스크롤(시트 격자 등): 바깥 스크롤 상자는 좌표가 변하지 않으므로 제외
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onScroll = (e: Event) => {
      if (e.target === scrollRef.current) return;
      scheduleRecompute();
    };
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, [scheduleRecompute]);

  useEffect(() => {
    scheduleRecompute();
  }, [model, pageData, anchors, chipOrdinals, searchMarks, zoom, activeSheet, scheduleRecompute]);

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
      if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // ── 불러오기: 렌더 모델 + 쪽 글자(필수), 앵커(실패 시 안내줄) ───────────────
  const refreshAnchors = useCallback(async () => {
    try {
      const res = await fetchVersionAnchors(versionId);
      setAnchors(res.anchors ?? []);
      setAnchorsError(null);
    } catch (e) {
      setAnchorsError(errorMessage(e));
    }
  }, [versionId]);

  useEffect(() => {
    let alive = true;
    setModel(null);
    setPageData(null);
    setLoadError(null);
    setAnchors(null);
    setAnchorsError(null);
    setSelection(null);
    setOverlap(null);
    setPopover(null);
    setSearchMarks(null);
    setOverlay(EMPTY_OVERLAY);
    revealRef.current = null;
    initialDoneRef.current = false;
    focusStartedRef.current = false;
    Promise.all([loadRenderModel(versionId), loadPageText(versionId)])
      .then(([m, d]) => {
        if (!alive) return;
        if (m.kind === 'sheet') {
          setActiveSheet((cur) =>
            m.pages.some((p) => p.pageNo === cur) ? cur : (m.pages[0]?.pageNo ?? 1),
          );
        }
        setModel(m);
        setPageData(d);
      })
      .catch((e) => {
        if (alive) setLoadError(errorMessage(e));
      });
    fetchVersionAnchors(versionId)
      .then((res) => {
        if (alive) setAnchors(res.anchors ?? []);
      })
      .catch((e) => {
        if (alive) setAnchorsError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [versionId]);

  // ── 화면 이동 (포커스, 검색, 첫 쪽): DOM 이 준비될 때까지 짧게 다시 시도 ─────
  const startPulse = useCallback((anchorId: number) => {
    setPulseId(anchorId);
    if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => setPulseId(null), PULSE_MS);
  }, []);

  /** 한 번 시도: true = 끝(이동함), false = 다시 시도 (DOM, 시트 전환, 가상화 행이 아직 없다) */
  const revealStep = useCallback((req: RevealReq): boolean => {
    const { model: m, activeSheet: sheetNo } = live.current;
    const sc = scrollRef.current;
    if (!m || !sc) return false;
    const sheet = m.kind === 'sheet';
    if (req.kind === 'page') {
      if (sheet) {
        if (sheetNo === req.pageNo) return true;
        setActiveSheet(req.pageNo);
        return false;
      }
      const el = pageElsRef.current.get(req.pageNo);
      if (!el || !el.isConnected) return false;
      sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - PAGE_MARGIN;
      return true;
    }
    if (sheet && !req.cellAsked) {
      // SheetView 가 시트를 바꾸고 가상화된 행을 먼저 그려 그 칸을 보이게 한다(scrollToCell)
      req.cellAsked = true;
      if (sheetNo !== req.pageNo) setActiveSheet(req.pageNo);
      const page = m.pages.find((p) => p.pageNo === req.pageNo);
      const cell = page ? cellAtOffset(page, req.start) : null;
      if (cell) {
        cellNonceRef.current += 1;
        setScrollCell({ pageNo: req.pageNo, r: cell.r, c: cell.c, nonce: cellNonceRef.current });
        return false;
      }
    }
    if (sheet && sheetNo !== req.pageNo) return false;
    const el = pageElsRef.current.get(req.pageNo);
    if (!el || !el.isConnected) return false;
    const first = firstPieceRect(el, req.start, req.end);
    if (!first) return false;
    revealRect(
      first.el,
      () => firstPieceRect(el, req.start, req.end)?.rect ?? null,
      sc,
      REVEAL_MARGIN,
      sheet,
    );
    return true;
  }, []);

  const runReveal = useCallback(() => {
    if (revealTimerRef.current) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    const req = revealRef.current;
    if (!req) return;
    let done = false;
    try {
      done = revealStep(req);
    } catch {
      done = false;
    }
    if (done) {
      revealRef.current = null;
      if (req.kind === 'range' && req.anchorId != null) startPulse(req.anchorId);
      scheduleRecompute();
      return;
    }
    req.tries += 1;
    if (req.tries >= RETRY_MAX) {
      revealRef.current = null;
      return;
    }
    revealTimerRef.current = window.setTimeout(runReveal, RETRY_MS);
  }, [revealStep, startPulse, scheduleRecompute]);

  const requestReveal = useCallback(
    (req: RevealReq) => {
      revealRef.current = req;
      runReveal();
    },
    [runReveal],
  );

  // 포커스 요청: prop 이 바뀔 때마다 새 요청 (같은 앵커를 다시 보이려면 부모가 null → id 로 바꾼다)
  const tryStartFocus = useCallback(() => {
    const id = focusPendingRef.current;
    const { model: m, pageData: data, anchors: list } = live.current;
    if (id == null || !m || !data || !list) return;
    const a = list.find((x) => x.anchorId === id);
    if (!a) return; // 목록 갱신 뒤 다시 본다
    focusPendingRef.current = null;
    if (!drawable(a)) return;
    const first = globalToLocalRanges(data, a.startOffset, a.endOffset)[0];
    if (!first) return;
    focusStartedRef.current = true; // 포커스가 첫 쪽, 검색 이동보다 우선
    requestReveal({ kind: 'range', ...first, anchorId: a.anchorId, tries: 0, cellAsked: false });
  }, [requestReveal]);

  useEffect(() => {
    focusPendingRef.current = focusAnchorId ?? null;
    tryStartFocus();
  }, [focusAnchorId, tryStartFocus]);

  useEffect(() => {
    tryStartFocus();
  }, [model, pageData, anchors, tryStartFocus]);

  // 첫 이동: 검색어가 있으면 그 자리를 노랑으로 보이고 첫 자리로, 없거나 못 찾으면 initialPage (한 번만).
  // 포커스 이동이 이미 시작됐으면 표시만 하고 옮기지 않는다. 포커스가 뒤에 시작돼도 그 이동이 덮어쓴다.
  useEffect(() => {
    if (!model || !pageData || initialDoneRef.current) return;
    initialDoneRef.current = true;
    const q = initialQuery?.trim();
    if (q) {
      const preferred =
        initialPage != null ? pageData.pages.find((p) => p.pageNo === initialPage) : undefined;
      let hitPage: number | null = null;
      let hits: { start: number; end: number }[] = [];
      if (preferred) {
        hits = findQueryInText(preferred.text, q);
        if (hits.length > 0) hitPage = preferred.pageNo;
      }
      if (hitPage === null) {
        for (const p of pageData.pages) {
          const h = findQueryInText(p.text, q);
          if (h.length > 0) {
            hitPage = p.pageNo;
            hits = h;
            break;
          }
        }
      }
      const firstHit = hits[0];
      if (hitPage !== null && firstHit) {
        setSearchMarks({ pageNo: hitPage, ranges: hits });
        if (!focusStartedRef.current) {
          requestReveal({
            kind: 'range',
            pageNo: hitPage,
            start: firstHit.start,
            end: firstHit.end,
            anchorId: null,
            tries: 0,
            cellAsked: false,
          });
        }
        return;
      }
    }
    if (initialPage != null && initialPage > 1 && !focusStartedRef.current) {
      requestReveal({ kind: 'page', pageNo: Math.floor(initialPage), tries: 0 });
    }
  }, [model, pageData, initialPage, initialQuery, requestReveal]);

  // ── 누름: 스크롤 막대인지, 드래그 시작 기준점의 정본 위치 (놓을 때 handleMouseUp 이 읽는다) ─────
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      gestureRef.current = null;
      const root = rootRef.current;
      const t = e.target;
      if (e.button !== 0 || !root || !(t instanceof Node) || !root.contains(t)) return;
      const gesture: Gesture = { scrollbar: onScrollbar(e), drag: null };
      gestureRef.current = gesture;
      const content = contentRef.current;
      if (gesture.scrollbar || !content || !content.contains(t)) return;
      if (t instanceof Element && t.closest('.pvp-badge, .pvp-part')) return;
      const multi = e.detail >= 2;
      // 브라우저가 누름의 기본 동작(기준점 놓기, 낱말, 문단 고르기)을 마친 뒤에 읽는다
      window.setTimeout(() => {
        const ws = window.getSelection();
        const node = ws?.anchorNode ?? null;
        if (!ws || !node || ws.rangeCount === 0 || !content.isConnected || !content.contains(node)) return;
        const anchor = pointToLocal(node, ws.anchorOffset, content);
        if (!anchor) return;
        let start = anchor.fwd;
        let end = anchor.back;
        if (multi) {
          const r = ws.getRangeAt(0);
          start = pointToLocal(r.startContainer, r.startOffset, content)?.fwd ?? start;
          end = pointToLocal(r.endContainer, r.endOffset, content)?.back ?? end;
        }
        gesture.drag = { node, offset: ws.anchorOffset, start, end };
      }, 0);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, []);

  // ── 선택 → 플로팅 툴바 (매핑 모드), 검색 표시 지우기 (모든 모드) ─────────────
  const handleMouseUp = useCallback((e: MouseEvent) => {
    const t = e.target;
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (t instanceof Element && t.closest('.pvp-toolbar, .pvp-popover, .qpick-overlay')) return;
    // 스크롤 막대를 끈 것은 선택 동작이 아니다. 띄워 둔 툴바와 그 정본 범위를 그대로 둔다(가상화된 시트는
    // 막대로 굴리는 동안 선택의 한쪽 끝이 옮겨져, 다시 읽으면 범위가 틀린다)
    if (gesture?.scrollbar) return;
    window.setTimeout(() => {
      const content = contentRef.current;
      const root = rootRef.current;
      if (!content || !root) return;
      const ws = window.getSelection();
      if (!ws || ws.rangeCount === 0 || ws.isCollapsed) return;
      const range = ws.getRangeAt(0);
      if (!range.intersectsNode(content)) return;
      let ranges = rangeToLocal(range, content);
      const drag = gesture?.drag ?? null;
      if (drag && anchorRelocated(ws, drag, content)) {
        // 드래그 도중 시작 행이 DOM 에서 빠졌다: 브라우저가 옮긴 기준점 대신 누른 자리의 정본 위치로
        const pinned = pinDragStart(ranges, drag, selectionIsForward(ws));
        if (!pinned) {
          if (live.current.isMap) {
            showToast('선택을 시작한 위치가 화면에서 벗어나 범위를 확인하지 못했습니다. 다시 선택해 주세요.');
          }
          return;
        }
        ranges = pinned;
      }
      if (ranges.length === 0) return;
      setSearchMarks(null);
      if (!live.current.isMap) return;
      // 툴바: 선택 끝 줄 아래, 페인 안으로 자른 자리 (PdfViewerPane 과 같은 크기 여유)
      const rr = root.getBoundingClientRect();
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const x = Math.min(Math.max(last.left - rr.left, 8), Math.max(8, rr.width - 460));
      const y = Math.min(Math.max(last.bottom - rr.top + 8, 8), Math.max(8, rr.height - 130));
      setOverlap(null);
      setColorMenuOpen(false);
      setSelection({ ranges, x, y });
    }, 0);
  }, [showToast]);

  useEffect(() => {
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseUp]);

  // 매핑 모드를 벗어나면 툴바를 닫는다
  useEffect(() => {
    if (!isMap) {
      setSelection(null);
      setOverlap(null);
      setColorMenuOpen(false);
    }
  }, [isMap]);

  // 연결할 문항을 바꾸면 앞 문항으로 띄운 겹침 확인 창은 닫는다. 고른 글자는 남겨 툴바가 바뀐 문항으로 다시 뜬다
  const mapTargetId = mapTargetQuestion?.id ?? null;
  useEffect(() => {
    setOverlap(null);
  }, [mapTargetId]);

  // 매핑 안내줄 높이를 재서 스크롤 상자를 그 아래로 내린다 (글자 크기가 바뀌어도 따라간다)
  useLayoutEffect(() => {
    const bar = mapbarRef.current;
    if (!isMap || !bar) {
      setBarH(0);
      return undefined;
    }
    const read = () => setBarH(bar.offsetHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [isMap]);

  const cancelSelection = useCallback(() => {
    setSelection(null);
    setOverlap(null);
    setColorMenuOpen(false);
    window.getSelection()?.removeAllRanges();
  }, []);

  // 시트 탭을 바꾸면 이전 시트의 선택 툴바와 팝오버는 닫는다(그 격자가 화면에서 떨어진다)
  const onActiveSheetChange = useCallback((pageNo: number) => {
    if (live.current.activeSheet === pageNo) return;
    setActiveSheet(pageNo);
    setSelection(null);
    setOverlap(null);
    setColorMenuOpen(false);
    setPopover(null);
  }, []);

  /** 선택 → POST /api/anchors 페이로드 (page_text 에서 인용, 앞뒤 문맥, 전역 오프셋. 좌표 없음) */
  const buildPayload = useCallback(
    (
      data: PageTextData,
      ranges: LocalRange[],
      target: MapTargetQuestion,
      force: boolean,
    ): { req: CreateAnchorRequest } | { error: string } => {
      const first = ranges[0];
      const last = ranges[ranges.length - 1];
      if (!first || !last) return { error: '선택 위치를 계산할 수 없습니다.' };
      const sIdx = data.pages.findIndex((p) => p.pageNo === first.pageNo);
      const eIdx = data.pages.findIndex((p) => p.pageNo === last.pageNo);
      const sPg = data.pages[sIdx];
      const ePg = data.pages[eIdx];
      if (!sPg || !ePg) return { error: '페이지 텍스트 정보가 불완전합니다.' };
      let startLocal = (data.cum[sIdx] ?? 0) + Math.min(first.start, sPg.text.length);
      let endLocal = (data.cum[eIdx] ?? 0) + Math.min(last.end, ePg.text.length);
      // 앞뒤 공백은 뺀다 (PDF 앵커도 공백 없이 글자에서 시작하고 끝난다)
      while (startLocal < endLocal && IGNORABLE_RE.test(data.joined.charAt(startLocal))) startLocal += 1;
      while (endLocal > startLocal && IGNORABLE_RE.test(data.joined.charAt(endLocal - 1))) endLocal -= 1;
      if (endLocal <= startLocal) {
        return { error: '선택한 부분에 글자가 없습니다. 글자를 포함해 다시 선택해 주세요.' };
      }
      const ps = data.pages[pageIndexAt(data, startLocal)];
      const pe = data.pages[pageIndexAt(data, endLocal - 1)];
      if (!ps || !pe) return { error: '페이지 텍스트 정보가 불완전합니다.' };
      const startOffset = toGlobalOffset(data, startLocal);
      const endOffset = toGlobalOffset(data, endLocal - 1) + 1;
      const req: CreateAnchorRequest = {
        documentVersionId: versionId,
        questionIds: [target.id],
        // 인용은 서버 정본 전문에서 자른다: 쪽, 슬라이드, 구간 경계를 걸친 인용의 낱말이 붙지 않게
        ...quoteFields(data, startOffset, endOffset),
        startOffset,
        endOffset,
        pageStart: ps.pageNo,
        pageEnd: pe.pageNo,
        color,
        force,
      };
      return { req };
    },
    [versionId, color],
  );

  /** req 는 target 으로 만든 요청이다: 저장 대상과 안내 문구가 같은 문항을 쓴다 */
  const submitAnchor = useCallback(
    async (req: CreateAnchorRequest, target: MapTargetQuestion) => {
      setBusy(true);
      try {
        const res = await createAnchor(req);
        if ('overlap' in res) {
          // 응답을 기다리는 사이 연결할 문항이 바뀌었으면 앞 문항의 확인 창은 띄우지 않는다(고른 글자는 남는다)
          if (targetIdRef.current === target.id) setOverlap({ req, target, info: res.overlap });
          return;
        }
        window.getSelection()?.removeAllRanges();
        setSelection(null);
        setOverlap(null);
        setColorMenuOpen(false);
        showToast(
          res.nudge
            ? `「${target.questionNo}」에 연결됨 ✓ 문장 단위로 고르면 자료가 개정돼도 위치를 잘 찾습니다`
            : `「${target.questionNo}」에 연결됨 ✓ 이어서 더 고를 수 있습니다`,
        );
        await refreshAnchors();
        onLinked?.();
      } catch (e) {
        showToast(apiErrorText(e));
      } finally {
        setBusy(false);
      }
    },
    [refreshAnchors, onLinked, showToast],
  );

  const confirmLink = useCallback(async () => {
    if (!selection || !mapTargetQuestion || busy) return;
    let data = pageData;
    if (!data) {
      try {
        data = await loadPageText(versionId);
      } catch (e) {
        showToast(`문서 텍스트를 불러오지 못했습니다: ${errorMessage(e)}`);
        return;
      }
    }
    const built = buildPayload(data, selection.ranges, mapTargetQuestion, false);
    if ('error' in built) {
      showToast(built.error);
      return;
    }
    await submitAnchor(built.req, mapTargetQuestion);
  }, [selection, mapTargetQuestion, busy, pageData, versionId, buildPayload, submitAnchor, showToast]);

  const attachToExisting = useCallback(async () => {
    if (!overlap || busy) return;
    const { target } = overlap;
    setBusy(true);
    try {
      await addPassageLink(overlap.info.passageId, target.id);
      window.getSelection()?.removeAllRanges();
      setOverlap(null);
      setSelection(null);
      showToast(`기존 하이라이트에 「${target.questionNo}」 연결을 추가했습니다 ✓`);
      await refreshAnchors();
      onLinked?.();
    } catch (e) {
      showToast(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  }, [overlap, busy, refreshAnchors, onLinked, showToast]);

  // ── 팝오버 ────────────────────────────────────────────────────────────────
  const openPopover = useCallback(
    (anchorIds: number[], ev: { clientX: number; clientY: number }) => {
      const root = rootRef.current;
      if (!root) return;
      const rr = root.getBoundingClientRect();
      const W = 360;
      const x = Math.min(Math.max(ev.clientX - rr.left - 40, 8), Math.max(8, rr.width - W - 12));
      const y = Math.min(Math.max(ev.clientY - rr.top + 12, 8), Math.max(8, rr.height - 160));
      setPopover({ anchorIds, x, y });
    },
    [],
  );

  useEffect(() => {
    if (!popover) return;
    const h = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && (t.closest('.pvp-popover') || t.closest('.pvp-badge'))) return;
      setPopover(null);
    };
    window.addEventListener('mousedown', h, true);
    return () => window.removeEventListener('mousedown', h, true);
  }, [popover]);

  const unlink = useCallback(
    async (a: AnchorInfo, q: AnchorQuestionRef) => {
      if (busy) return;
      setBusy(true);
      try {
        await removePassageLink(a.passageId, q.id);
        showToast(`「${q.questionNo}」 연결을 해제했습니다`);
        await refreshAnchors();
        onLinked?.();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.body?.error === 'last_link') {
          const ok = window.confirm(
            '이 하이라이트를 근거로 쓰는 문항은 이 문항뿐입니다. 연결을 해제하면 문서의 하이라이트도 함께 지워집니다. 계속할까요?',
          );
          if (ok) {
            try {
              await removePassageLink(a.passageId, q.id, true);
              showToast('연결을 해제하고 하이라이트도 지웠습니다');
              setPopover(null);
              await refreshAnchors();
              onLinked?.();
            } catch (e2) {
              showToast(apiErrorText(e2));
            }
          }
        } else {
          showToast(apiErrorText(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshAnchors, onLinked, showToast],
  );

  const onPickLink = useCallback(
    async (q: PickedQuestion) => {
      const p = linkPicker;
      setLinkPicker(null);
      if (!p) return;
      try {
        await addPassageLink(p.passageId, q.id);
        showToast(`「${q.questionNo}」에도 연결했습니다 ✓`);
        await refreshAnchors();
        onLinked?.();
      } catch (e) {
        showToast(apiErrorText(e));
      }
    },
    [linkPicker, refreshAnchors, onLinked, showToast],
  );

  // ── 단축키: Enter 연결 확정, Esc 취소 (캡처 단계, 소비하면 전파 중단) ─────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      // 이 뷰어와 무관한 모달(첨부 미리보기, 검색 창 등)이 떠 있으면 그 모달의 키다
      if (isBehindModal(rootRef.current)) return;
      if (e.key === 'Enter') {
        if (busy) return;
        if (overlap) {
          e.preventDefault();
          e.stopPropagation();
          void attachToExisting();
        } else if (selection && isMap) {
          e.preventDefault();
          e.stopPropagation();
          void confirmLink();
        }
      } else if (e.key === 'Escape') {
        if (colorMenuOpen) {
          e.stopPropagation();
          setColorMenuOpen(false);
        } else if (overlap || selection) {
          e.stopPropagation();
          cancelSelection();
        } else if (linkPicker) {
          e.stopPropagation();
          setLinkPicker(null);
        } else if (popover) {
          e.stopPropagation();
          setPopover(null);
        }
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [
    busy,
    overlap,
    selection,
    isMap,
    colorMenuOpen,
    linkPicker,
    popover,
    attachToExisting,
    confirmLink,
    cancelSelection,
  ]);

  const popAnchors = useMemo(() => {
    if (!popover || !anchors) return [];
    return anchors.filter((a) => popover.anchorIds.includes(a.anchorId));
  }, [popover, anchors]);

  const mediaUrl = useCallback((index: number) => versionMediaUrl(versionId, index), [versionId]);

  // 흐름 문서 쪽 묶음의 이름(화면 읽기 프로그램용): 이름표가 있으면 그것('구간 N'), 이름표 없는 hwpx 는 '구간 N',
  // 그 밖에는 빈 글자를 돌려 FlowView 기본값 'N쪽'을 쓴다. 근거, 검색 결과의 위치 표기와 같은 말이 되게
  const labelByPage = useMemo(
    () => new Map((pageData?.pages ?? []).map((p) => [p.pageNo, p.label] as const)),
    [pageData],
  );
  const flowPageLabel = useCallback(
    (pageNo: number): string => {
      const lbl = labelByPage.get(pageNo)?.trim();
      if (lbl) return lbl;
      return fileKind === 'hwpx' ? `구간 ${pageNo}` : '';
    },
    [labelByPage, fileKind],
  );

  // ── 렌더 ──────────────────────────────────────────────────────────────────
  let viewer: JSX.Element | null = null;
  if (model) {
    switch (model.kind) {
      case 'flow':
        viewer = (
          <FlowView model={model} mediaUrl={mediaUrl} onPageElement={onPageElement} pageLabel={flowPageLabel} />
        );
        break;
      case 'slides':
        viewer = <SlidesView model={model} mediaUrl={mediaUrl} onPageElement={onPageElement} />;
        break;
      case 'plain':
        viewer = <PlainView model={model} onPageElement={onPageElement} />;
        break;
      case 'sheet':
        viewer = (
          <SheetView
            model={model}
            activePage={activeSheet}
            onActivePageChange={onActiveSheetChange}
            onPageElement={onPageElement}
            onRowsRendered={scheduleRecompute}
            scrollToCell={scrollCell}
          />
        );
        break;
      default:
        viewer = null;
    }
  }

  const kindClass = model ? ` ovp-kind-${model.kind}` : '';
  // 슬라이드는 폭이 덱을 따라가는(width:100%) 상자라 zoom 만 주면 덱도 같은 배율로 좁아져 확대가 상쇄된다.
  // 배율이 1이 아니면 배율 1일 때의 슬라이드 폭을 기준 폭(--osl-slide-w)으로 고정하고,
  // 확대 상자가 그 폭과 덱 여백보다 좁아지지 않게 해 가로로 스크롤하게 한다
  const slideBaseW =
    model?.kind === 'slides' && zoom !== 1 && availW > SLIDE_DECK_PAD_X
      ? Math.min(availW - SLIDE_DECK_PAD_X, SLIDE_MAX_W)
      : null;
  const zoomStyle: CSSProperties | undefined =
    zoom === 1
      ? undefined
      : slideBaseW == null
        ? { zoom }
        : ({ zoom, minWidth: slideBaseW + SLIDE_DECK_PAD_X, '--osl-slide-w': `${slideBaseW}px` } as CSSProperties);

  return (
    <div
      ref={rootRef}
      className={'pvp-root ovp-root' + (isMap ? ' is-map' : '')}
      data-file-kind={fileKind}
    >
      <ZoomBar
        percent={model ? zoomPercent(zoom) : null}
        mode={zoomMode}
        onStep={onZoomStep}
        onReset={onZoomReset}
        onToggleFit={onToggleFit}
      />
      <div
        ref={scrollRef}
        className={'ovp-scroll' + kindClass}
        style={{ top: `calc(var(--vzb-h) + ${barH}px)` }}
      >
        {loadError ? (
          <div className="pvp-status pvp-status-error" role="alert">
            문서를 불러올 수 없습니다: {loadError}{' '}
            <a className="btn pvp-btn-sm" href={versionDownloadUrl(versionId)}>
              원본 내려받기
            </a>
          </div>
        ) : !model ? (
          <div className="pvp-status">문서 불러오는 중…</div>
        ) : (
          <div ref={contentRef} className={'ovp-content' + kindClass} translate="no">
            <div className="ovp-zoom" style={zoomStyle}>
              {viewer}
            </div>
            <div className="ovp-overlay">
              {overlay.search.map((s) => (
                <div
                  key={s.key}
                  className="ovp-search"
                  style={{
                    left: s.left,
                    top: s.top,
                    width: s.width,
                    height: s.height,
                  }}
                />
              ))}
              {overlay.parts.map((p) => (
                <div
                  key={p.key}
                  data-anchor={p.anchorId}
                  className={'pvp-part' + (pulseId === p.anchorId ? ' hl-pulse' : '')}
                  style={{
                    left: p.left,
                    top: p.top,
                    width: Math.max(p.width, 2),
                    height: Math.max(p.height, 2),
                    background: COLOR_BG[p.color] ?? COLOR_BG.yellow,
                    borderBottom: `3px solid ${COLOR_LINE[p.color] ?? COLOR_LINE.yellow}`,
                  }}
                  onClick={(e) => openPopover([p.anchorId], e)}
                  title="누르면 이 근거를 쓴 문항을 봅니다"
                />
              ))}
              {overlay.badges.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  className={
                    'pvp-badge' + (pulseId != null && b.anchorIds.includes(pulseId) ? ' hl-pulse' : '')
                  }
                  data-anchors={b.anchorIds.join(',')}
                  style={{ top: b.top, left: b.left, maxWidth: b.maxW }}
                  onClick={(e) => openPopover(b.anchorIds, e)}
                  title={b.full ? `${b.full}: 이 근거를 인용한 문항 보기` : '이 근거를 인용한 문항 보기'}
                  aria-label={b.full}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {isMap && mapTargetQuestion && (
        <>
          <div className="pvp-mapframe" aria-hidden="true" />
          <div ref={mapbarRef} className="pvp-mapbar">
            드래그한 부분이 「{mapTargetQuestion.questionNo}」에 연결됩니다.{mapHint ? ` ${mapHint}` : ''}
          </div>
        </>
      )}

      {anchorsError && (
        <div className="pvp-anchor-error">
          근거 위치를 불러오지 못했습니다: {anchorsError}{' '}
          <button type="button" className="btn pvp-btn-sm" onClick={() => void refreshAnchors()}>
            다시 시도
          </button>
        </div>
      )}

      {/* 플로팅 툴바: 드래그 선택 직후 (설계서 §3.2) */}
      {selection && isMap && mapTargetQuestion && !overlap && (
        <div
          className="pvp-toolbar"
          style={{ left: selection.x, top: selection.y }}
          role="toolbar"
          aria-label="근거 연결"
        >
          <span className="pvp-toolbar-label">
            「{mapTargetQuestion.questionNo}」에 근거로 연결
          </span>
          <button
            type="button"
            className="btn btn-primary pvp-btn-sm"
            disabled={busy}
            onClick={() => void confirmLink()}
          >
            {busy ? '연결 중…' : '연결 ✓ Enter'}
          </button>
          <span className="pvp-color-wrap">
            <button
              type="button"
              className="btn pvp-btn-sm"
              onClick={() => setColorMenuOpen((v) => !v)}
              aria-label="하이라이트 색 선택"
            >
              <span className="pvp-swatch-dot" style={{ background: COLOR_LINE[color] }} /> 색 ▾
            </button>
            {colorMenuOpen && (
              <span className="pvp-color-menu">
                {HL_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={'pvp-swatch' + (c === color ? ' is-on' : '')}
                    style={{ background: COLOR_BG[c], borderColor: COLOR_LINE[c] }}
                    title={COLOR_NAME[c]}
                    aria-label={COLOR_NAME[c]}
                    onClick={() => {
                      setColor(c);
                      setColorMenuOpen(false);
                    }}
                  />
                ))}
              </span>
            )}
          </span>
          <button type="button" className="btn btn-ghost pvp-btn-sm" onClick={cancelSelection}>
            취소 Esc
          </button>
        </div>
      )}

      {/* 겹침 60% 이상: 기존 하이라이트에 추가 제안 (설계서 §3.2 중복 방지) */}
      {overlap && mapTargetQuestion && (
        <div
          className="pvp-toolbar pvp-overlap"
          style={{ left: selection?.x ?? 40, top: selection?.y ?? 40 }}
          role="dialog"
          aria-label="기존 하이라이트와 겹침"
        >
          <div className="pvp-overlap-title">기존 하이라이트와 60% 이상 겹칩니다</div>
          <div className="pvp-overlap-quote">“{snip(overlap.info.quote, 80)}”</div>
          <div className="pvp-overlap-qs dim">
            현재 인용:{' '}
            {overlap.info.questions.map((q) => q.questionNo).join(', ') || '연결 문항 없음'}
          </div>
          <div className="pvp-overlap-actions">
            <button
              type="button"
              className="btn btn-primary pvp-btn-sm"
              disabled={busy}
              onClick={() => void attachToExisting()}
            >
              기존 하이라이트에 「{overlap.target.questionNo}」 추가(Enter)
            </button>
            <button
              type="button"
              className="btn pvp-btn-sm"
              disabled={busy}
              onClick={() => void submitAnchor({ ...overlap.req, force: true }, overlap.target)}
            >
              새로 만들기
            </button>
            <button type="button" className="btn btn-ghost pvp-btn-sm" onClick={cancelSelection}>
              취소 Esc
            </button>
          </div>
        </div>
      )}

      {/* 인용 문항 팝오버 (설계서 §3.3) */}
      {popover && popAnchors.length > 0 && (
        <div
          className="pvp-popover"
          style={{ left: popover.x, top: popover.y }}
          role="dialog"
          aria-label="이 근거를 인용한 문항"
        >
          <div className="pvp-pop-title">이 근거를 인용한 문항</div>
          {popAnchors.map((a) => (
            <div key={a.anchorId} className="pvp-pop-anchor">
              {popAnchors.length > 1 && (
                <div className="pvp-pop-quote">“{snip(a.label || a.quote, 46)}”</div>
              )}
              {a.questions.length === 0 && (
                <div className="pvp-pop-empty dim">연결된 문항이 없습니다.</div>
              )}
              {a.questions.map((q) => (
                <div key={q.id} className="pvp-pop-q">
                  <div className="pvp-pop-q-main">
                    <span className="omni-no">{q.questionNo}</span>
                    <span className="pvp-pop-body">{snip(q.bodyPreview, 40)}</span>
                  </div>
                  {q.answerPreview && (
                    <div className="pvp-pop-preview dim">“{snip(q.answerPreview, 40)}”</div>
                  )}
                  <div className="pvp-pop-q-actions">
                    {onBadgeOpenQuestion && (
                      <button
                        type="button"
                        className="btn pvp-btn-sm"
                        onClick={() => {
                          setPopover(null);
                          onBadgeOpenQuestion(q.id);
                        }}
                      >
                        열기 ↗
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="btn pvp-btn-sm"
                        disabled={busy}
                        onClick={() => void unlink(a, q)}
                      >
                        연결 해제…
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {canEdit && (
                <button
                  type="button"
                  className="btn pvp-btn-sm pvp-pop-add"
                  onClick={() => {
                    setPopover(null);
                    setLinkPicker({ passageId: a.passageId });
                  }}
                >
                  + 다른 문항에도 연결
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {linkPicker && (
        <QuestionPicker
          title="이 하이라이트에 추가로 연결할 문항"
          onPick={(q) => void onPickLink(q)}
          onClose={() => setLinkPicker(null)}
        />
      )}

      {toast && (
        <div className="pvp-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
