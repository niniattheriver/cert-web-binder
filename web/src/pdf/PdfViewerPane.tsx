/**
 * 재사용 PDF 뷰어 페인 (설계서 §3.2 매핑 루프, §3.3 양방향 표시 / WEB_CONTRACT)
 *
 * - 앵커 오버레이: 하이라이트 배경 + 굵은 밑줄(border-bottom 3px, passage.color) + 여백 배지(클러스터)
 * - 배지/하이라이트 클릭 → 인용 문항 팝오버([열기]·[+ 다른 문항에도 연결]·[연결 해제…])
 * - 매핑 모드: 주황 테두리 + 안내줄, 드래그 선택 → 플로팅 툴바 → POST /api/anchors
 *   (겹침 ≥60% 응답 시 "기존 하이라이트에 추가" 제안) → 성공 후 뷰어 유지(연속 매핑)
 * - focusAnchorId: 해당 페이지 스크롤 + 2회 펄스(.hl-pulse)
 * - 확대/축소(office/viewerZoom.ts): 위쪽 단추 줄, Ctrl+휠, Ctrl+드래그. pdf.js 뷰어의 배율을 직접 바꾸고(Ctrl 조작은
 *   커서 자리를 고정점으로 updateScale), RPHE 가 칸 크기가 바뀔 때마다 다시 넣는 pdfScaleValue 에는 지금 배율을 돌려주는
 *   객체를 넘긴다(RPHE 8.1.0 은 그 값의 toString() 만 쓴다). 그래야 칸 폭을 바꿔도 고른 배율이 'auto' 로 되돌아가지 않는다.
 *
 * RPHE 8.1.0 groupHighlightsByPage 버그 회피:
 *   rect 에 pageNumber 가 있으면 같은 페이지에 중복 렌더되고, pageNumber 를 제거하면
 *   그룹 필터(`pageNumber === rect.pageNumber`)가 rects 를 전부 걸러내 렌더가 사라진다.
 *   → 뷰 하이라이트는 "앵커×페이지당 1건"으로 분해하되 position.rects 는 빈 배열로 두고
 *   (rect pageNumber 자체가 존재하지 않음 → 그룹당 정확 1건), 정규화 rects(nrects)는
 *   커스텀 필드로 갖고 컨테이너에서 직접 렌더한다(페이지 크기 = textLayer 크기 × 비율).
 *   StrictMode 미사용 유지.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';
// CDN 금지 — 로컬 워커 번들(?url). cMaps/standard_fonts 는 /pdfjs/ 정적 경로.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  PdfHighlighter,
  PdfLoader,
  useHighlightContainerContext,
  type Highlight,
  type PdfHighlighterProps,
  type PdfHighlighterUtils,
  type PdfScaleValue,
  type PdfSelection,
  type ScaledPosition,
} from 'react-pdf-highlighter-extended';
import {
  ApiError,
  addPassageLink,
  createAnchor,
  fetchVersionAnchors,
  removePassageLink,
  versionFileUrl,
  type AnchorInfo,
  type AnchorQuestionRef,
  type AnchorRectTuple,
  type CreateAnchorRequest,
  type AnchorOverlapInfo,
} from '../api';
import { useAuth } from '../auth';
import { chipGlyph } from '../components/EvidenceCards';
import ZoomBar from '../office/ZoomBar';
import {
  clampZoom,
  loadZoom,
  saveZoom,
  stepZoom,
  useZoomGestures,
  zoomPercent,
  type ZoomMode,
} from '../office/viewerZoom';
import { errorMessage } from '../util';
import { findQuoteInPages, loadPageText, pageIndexAt, quoteFields, type PageTextData } from './pageText';
import QuestionPicker, { type PickedQuestion } from './QuestionPicker';

GlobalWorkerOptions.workerSrc = workerUrl;

// ── 공개 타입 (Phase 2 담당이 그대로 사용) ──────────────────────────────────

export interface MapTargetQuestion {
  id: number;
  questionNo: string;
}

export interface PdfViewerPaneProps {
  versionId: number;
  mode: 'view' | 'map';
  /** mode='map' 일 때 선택이 연결될 대상 문항 */
  mapTargetQuestion?: MapTargetQuestion;
  /** 지정 시 해당 앵커 페이지로 스크롤 + 2회 펄스 */
  focusAnchorId?: number | null;
  /** 앵커 생성/링크 추가·해제 성공 시 호출(부모 목록 갱신용) */
  onLinked?: () => void;
  /** 팝오버 [열기] — 미지정 시 버튼 숨김 */
  onBadgeOpenQuestion?: (questionId: number) => void;
  /** 최초 로드 시 스크롤할 페이지(1-기준) */
  initialPage?: number;
  /** 현재 문항의 근거 칩 순번 (anchorId → 근거 배열 인덱스) — 배지에 ①②③ 병기 (Phase 2).
   *  미지정 시(문서 뷰어 등) 기존 라벨 그대로. */
  chipOrdinals?: Map<number, number>;
  /** 연결 안내줄 끝에 붙일 문구. 연결을 끝내거나 바꾸는 방법이 화면마다 달라 부르는 쪽이 정한다
   *  (문서 뷰어: '끝내려면 Esc', 문항 상세: [자료 닫기] 안내). 없으면 붙이지 않는다 */
  mapHint?: string;
}

// ── 하이라이트 색 팔레트 ─────────────────────────────────────────────────────

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

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

// ── 앵커 → 뷰 하이라이트 분해 ────────────────────────────────────────────────

interface PaneHighlight extends Highlight {
  anchorId: number;
  page: number;
  /** 정규화(0..1) [x0,y0,x1,y1] — 컨테이너가 직접 렌더 */
  nrects: AnchorRectTuple[];
  color: string;
  topY: number;
  /** 클러스터 대표만 배지 렌더 */
  badge?: { label: string; anchorIds: number[] };
}

/** 같은 줄대로 보는 세로 근접 임계(페이지 높이 비율) */
const CLUSTER_Y = 0.02;

function buildPaneHighlights(
  anchors: AnchorInfo[],
  chipOrdinals?: Map<number, number>,
): PaneHighlight[] {
  const out: PaneHighlight[] = [];
  const anchorMap = new Map(anchors.map((a) => [a.anchorId, a]));
  for (const a of anchors) {
    if (!a.rects || !Array.isArray(a.rects) || a.rects.length === 0) continue;
    if (!String(a.status ?? '').startsWith('resolved')) continue;
    for (const pg of a.rects) {
      if (!pg || typeof pg.page !== 'number' || !Array.isArray(pg.rects) || pg.rects.length === 0)
        continue;
      const x1 = Math.min(...pg.rects.map((r) => r[0]));
      const y1 = Math.min(...pg.rects.map((r) => r[1]));
      const x2 = Math.max(...pg.rects.map((r) => r[2]));
      const y2 = Math.max(...pg.rects.map((r) => r[3]));
      out.push({
        id: `a${a.anchorId}p${pg.page}`,
        type: 'text',
        // rects 는 의도적으로 빈 배열 — RPHE 8.1.0 그룹 버그 회피(파일 상단 주석)
        position: {
          boundingRect: { x1, y1, x2, y2, width: 1, height: 1, pageNumber: pg.page },
          rects: [],
        },
        anchorId: a.anchorId,
        page: pg.page,
        nrects: pg.rects,
        color: a.color || 'yellow',
        topY: y1,
      });
    }
  }

  // 여백 배지 — 페이지별 같은 줄대(topY 근접) 클러스터, 대표 1건이 배지 렌더 (설계서 §3.3)
  const byPage = new Map<number, PaneHighlight[]>();
  for (const h of out) {
    const list = byPage.get(h.page);
    if (list) list.push(h);
    else byPage.set(h.page, [h]);
  }
  for (const list of byPage.values()) {
    list.sort((p, q) => p.topY - q.topY);
    let cluster: PaneHighlight[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const nos: string[] = [];
      for (const h of cluster) {
        for (const q of anchorMap.get(h.anchorId)?.questions ?? []) {
          if (!nos.includes(q.questionNo)) nos.push(q.questionNo);
        }
      }
      const base =
        nos.length === 0
          ? '근거'
          : nos.length <= 2
            ? nos.join(', ')
            : `${nos.slice(0, 2).join(', ')} +${nos.length - 2}`;
      const anchorIds: number[] = [];
      for (const h of cluster) if (!anchorIds.includes(h.anchorId)) anchorIds.push(h.anchorId);
      // 현재 문항의 근거 칩 순번 병기 (①②③ — 카드 칩과 동일 번호. Phase 2)
      const ords = anchorIds
        .map((aid) => chipOrdinals?.get(aid))
        .filter((n): n is number => n != null)
        .sort((a, b) => a - b);
      const prefix = ords.map(chipGlyph).join('');
      const label = prefix ? `${prefix} ${base}` : base;
      // cluster.length > 0 은 위에서 보장
      cluster[0]!.badge = { label, anchorIds };
      cluster = [];
    };
    for (const h of list) {
      if (cluster.length > 0 && h.topY - cluster[0]!.topY > CLUSTER_Y) flush();
      cluster.push(h);
    }
    flush();
  }
  return out;
}

// ── 하이라이트 컨테이너 (하이라이트 1건 = 앵커×페이지 1건) ─────────────────

function AnchorHighlightContainer({
  onOpen,
}: {
  onOpen: (anchorIds: number[], ev: { clientX: number; clientY: number }) => void;
}) {
  const { highlight, isScrolledTo, highlightBindings } =
    useHighlightContainerContext<PaneHighlight>();
  const pageEl = highlightBindings?.textLayer;
  const w = pageEl?.clientWidth ?? 0;
  const h = pageEl?.clientHeight ?? 0;
  if (!w || !h) return null;

  const bg = COLOR_BG[highlight.color] ?? COLOR_BG.yellow;
  const line = COLOR_LINE[highlight.color] ?? COLOR_LINE.yellow;

  return (
    <>
      {highlight.nrects.map((r, i) => (
        <div
          key={i}
          className={'pvp-part' + (isScrolledTo ? ' hl-pulse' : '')}
          style={{
            left: r[0] * w,
            top: r[1] * h,
            width: Math.max((r[2] - r[0]) * w, 2),
            height: Math.max((r[3] - r[1]) * h, 2),
            background: bg,
            borderBottom: `3px solid ${line}`,
          }}
          onClick={(e) => onOpen([highlight.anchorId], e)}
          title="누르면 이 근거를 쓴 문항을 봅니다"
        />
      ))}
      {highlight.badge && (
        <button
          type="button"
          className={'pvp-badge' + (isScrolledTo ? ' hl-pulse' : '')}
          style={{ top: highlight.topY * h, left: w - 6 }}
          onClick={(e) => onOpen(highlight.badge!.anchorIds, e)}
          title="이 근거를 인용한 문항 보기"
        >
          {highlight.badge.label}
        </button>
      )}
    </>
  );
}

// ── pdf.js 뷰어 정리 ─────────────────────────────────────────────────────────

/**
 * PdfHighlighter 에 언마운트 정리를 더한 것. RPHE 8.1.0 은 언마운트 때 자기가 만든 pdf.js PDFViewer 를
 * 정리하지 않는다. 그 뷰어가 문서마다 만드는 주석 편집 관리자(AnnotationEditorUIManager)는 window 의
 * keydown/keyup 과 document 의 copy, cut, paste, dragover, drop, selectionchange 리스너를 걸어 두어서,
 * 미리보기를 열고 닫거나 판본을 바꿀 때마다 리스너와 뷰어가 쌓였다.
 * viewer.setDocument(null) 이 그 관리자와 글자 층의 문서 리스너를 함께 거둔다.
 */
function PdfHighlighterWithTeardown({ utilsRef, ...rest }: PdfHighlighterProps) {
  const ownUtils = useRef<PdfHighlighterUtils | null>(null);
  useEffect(
    () => () => {
      try {
        // 타입 선언은 문서만 받지만 pdf.js 는 null 을 '문서 없음'으로 처리한다 (pdf_viewer.mjs setDocument)
        ownUtils.current?.getViewer()?.setDocument(null as never);
      } catch (e) {
        console.warn('PDF 뷰어 정리 실패:', e);
      }
    },
    [],
  );
  return (
    <PdfHighlighter
      {...rest}
      utilsRef={(u) => {
        ownUtils.current = u;
        utilsRef(u);
      }}
    />
  );
}

// ── 본체 ─────────────────────────────────────────────────────────────────────

interface SelState {
  text: string;
  position: ScaledPosition;
  /** 페인 기준 툴바 좌표 */
  x: number;
  y: number;
}

/** 배율 상태 → pdf.js currentScaleValue ('auto', 'page-width', '1.25') */
function pdfScaleString(mode: ZoomMode): string {
  if (typeof mode === 'number') return String(mode);
  return mode === 'width' ? 'page-width' : 'auto';
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

export default function PdfViewerPane({
  versionId,
  mode,
  mapTargetQuestion,
  focusAnchorId,
  onLinked,
  onBadgeOpenQuestion,
  initialPage,
  chipOrdinals,
  mapHint,
}: PdfViewerPaneProps) {
  const { user } = useAuth();
  const canEdit = user != null && user.role !== 'viewer';
  const isMap = mode === 'map' && !!mapTargetQuestion && canEdit;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const utilsRef = useRef<PdfHighlighterUtils | null>(null);
  const pageDataRef = useRef<PageTextData | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const initialAppliedRef = useRef(false);

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

  const documentInit = useMemo<DocumentInitParameters>(
    () => ({
      url: versionFileUrl(versionId),
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
    }),
    [versionId],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3500);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // ── 앵커 로드/갱신 ─────────────────────────────────────────────────────────
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
    setAnchors(null);
    setAnchorsError(null);
    setSelection(null);
    setOverlap(null);
    setPopover(null);
    pageDataRef.current = null;
    initialAppliedRef.current = false;
    fetchVersionAnchors(versionId)
      .then((res) => {
        if (!alive) return;
        setAnchors(res.anchors ?? []);
      })
      .catch((e) => {
        if (alive) setAnchorsError(errorMessage(e));
      });
    // 페이지 텍스트 선로드(선택→오프셋 계산용, 모듈 캐시)
    loadPageText(versionId)
      .then((d) => {
        if (alive) pageDataRef.current = d;
      })
      .catch(() => {
        /* 매핑 시점에 재시도 */
      });
    return () => {
      alive = false;
    };
  }, [versionId]);

  const paneHighlights = useMemo(
    () => (anchors ? buildPaneHighlights(anchors, chipOrdinals) : []),
    [anchors, chipOrdinals],
  );

  // ── 뷰어 준비 폴링 유틸 ───────────────────────────────────────────────────
  const whenViewerReady = useCallback((fn: () => boolean) => {
    let tries = 0;
    const tick = () => {
      let done = false;
      try {
        done = fn();
      } catch {
        done = false;
      }
      if (!done && ++tries < 80) window.setTimeout(tick, 150);
    };
    tick();
  }, []);

  // ── 확대/축소 (office/viewerZoom.ts) ──────────────────────────────────────
  const [zoomMode, setZoomMode] = useState<ZoomMode>(() => loadZoom('pdf'));
  const [zoomPct, setZoomPct] = useState<number | null>(null);
  /** RPHE 가 칸 크기가 바뀔 때마다 currentScaleValue 에 넣는 값. toString() 이 지금 고른 배율을 돌려준다 */
  const scaleValueRef = useRef<string>(pdfScaleString(zoomMode));
  const scaleProxy = useMemo(
    () => ({ toString: () => scaleValueRef.current }) as unknown as PdfScaleValue,
    [],
  );
  const viewerScale = useCallback((): number => utilsRef.current?.getViewer()?.currentScale || 1, []);

  const applyZoom = useCallback((mode: ZoomMode, origin?: { x: number; y: number }) => {
    scaleValueRef.current = pdfScaleString(mode);
    setZoomMode(mode);
    saveZoom('pdf', mode);
    const viewer = utilsRef.current?.getViewer();
    if (!viewer?.pdfDocument) return; // 준비되면 RPHE 가 pagesinit 때 scaleProxy 값으로 맞춘다
    if (typeof mode === 'number' && origin && viewer.currentScale > 0) {
      // 커서 자리를 고정점으로 (pdf.js 가 그 자리가 그대로 남도록 스크롤을 맞춘다). pdf.js 4.10 은 origin 에서
      // container.offsetLeft/offsetTop 을 빼서 쓰므로(pdf_viewer.mjs updateScale, containerTopLeft) 화면 좌표를 그 기준으로 옮긴다.
      // 화면 좌표를 그대로 넘기면 뷰어가 화면 오른쪽에 있을 때 그 거리만큼 오른쪽으로 밀린다
      const c = viewer.container;
      const r = c.getBoundingClientRect();
      const o: [number, number] = [origin.x - r.left + c.offsetLeft, origin.y - r.top + c.offsetTop];
      viewer.updateScale({ scaleFactor: mode / viewer.currentScale, origin: o, drawingDelay: 250 });
    } else {
      viewer.currentScaleValue = scaleValueRef.current;
    }
  }, []);

  // 뷰어가 준비되면 배율이 바뀔 때마다 퍼센트를 적는다
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    whenViewerReady(() => {
      if (cancelled) return true;
      const viewer = utilsRef.current?.getViewer();
      if (!viewer?.pdfDocument) return false;
      const onScale = (e: { scale: number }) => setZoomPct(zoomPercent(e.scale));
      viewer.eventBus.on('scalechanging', onScale);
      off = () => viewer.eventBus.off('scalechanging', onScale);
      if (viewer.currentScale > 0) setZoomPct(zoomPercent(viewer.currentScale));
      return true;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [versionId, whenViewerReady]);

  useZoomGestures(rootRef, {
    getScale: viewerScale,
    setScale: (s, origin) => applyZoom(clampZoom(s), origin),
  });
  const onZoomStep = useCallback((dir: 1 | -1) => applyZoom(stepZoom(viewerScale(), dir)), [applyZoom, viewerScale]);
  const onZoomReset = useCallback(() => applyZoom(1), [applyZoom]);
  const onToggleFit = useCallback(
    () => applyZoom(zoomMode === 'width' ? 'auto' : 'width'),
    [applyZoom, zoomMode],
  );

  // 최초 페이지 스크롤
  useEffect(() => {
    if (!initialPage || initialPage <= 1 || initialAppliedRef.current) return;
    whenViewerReady(() => {
      const viewer = utilsRef.current?.getViewer();
      if (!viewer) return false;
      viewer.scrollPageIntoView({ pageNumber: initialPage });
      initialAppliedRef.current = true;
      return true;
    });
  }, [initialPage, versionId, whenViewerReady]);

  // 앵커 포커스: 스크롤 + 펄스
  useEffect(() => {
    if (focusAnchorId == null || paneHighlights.length === 0) return;
    const target = paneHighlights.find((hl) => hl.anchorId === focusAnchorId);
    if (!target) return;
    initialAppliedRef.current = true; // 포커스가 initialPage 보다 우선
    whenViewerReady(() => {
      const utils = utilsRef.current;
      if (!utils?.getViewer()) return false;
      utils.scrollToHighlight(target);
      return true;
    });
  }, [focusAnchorId, paneHighlights, whenViewerReady]);

  // ── 매핑 모드: 드래그 선택 → 플로팅 툴바 ─────────────────────────────────
  const onSelection = useCallback((sel: PdfSelection) => {
    const root = rootRef.current;
    if (!root) return;
    let x = 24;
    let y = 24;
    const ws = window.getSelection();
    if (ws && ws.rangeCount > 0) {
      const r = ws.getRangeAt(0).getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      x = Math.min(Math.max(r.left - rr.left, 8), Math.max(8, rr.width - 460));
      y = Math.min(Math.max(r.bottom - rr.top + 8, 8), Math.max(8, rr.height - 130));
    }
    setOverlap(null);
    setColorMenuOpen(false);
    setSelection({ text: sel.content.text ?? '', position: sel.position, x, y });
  }, []);

  const cancelSelection = useCallback(() => {
    setSelection(null);
    setOverlap(null);
    setColorMenuOpen(false);
    window.getSelection()?.removeAllRanges();
  }, []);

  // 연결할 문항을 바꾸면 앞 문항으로 띄운 겹침 확인 창은 닫는다. 고른 글자는 남겨 툴바가 바뀐 문항으로 다시 뜬다
  const mapTargetId = mapTargetQuestion?.id ?? null;
  useEffect(() => {
    setOverlap(null);
  }, [mapTargetId]);

  /** 선택 → POST /api/anchors 페이로드 (rects 정규화 + page-text 캐시에서 quote/오프셋 산출) */
  const buildPayload = useCallback(
    (
      data: PageTextData,
      sel: SelState,
      target: MapTargetQuestion,
      force: boolean,
    ): { req: CreateAnchorRequest } | { error: string } => {
      const srcRects =
        sel.position.rects.length > 0 ? sel.position.rects : [sel.position.boundingRect];
      const byPage = new Map<number, AnchorRectTuple[]>();
      for (const r of srcRects) {
        const page = r.pageNumber ?? sel.position.boundingRect.pageNumber;
        if (!page || !r.width || !r.height) continue;
        const tup: AnchorRectTuple = [
          clamp01(r.x1 / r.width),
          clamp01(r.y1 / r.height),
          clamp01(r.x2 / r.width),
          clamp01(r.y2 / r.height),
        ];
        const list = byPage.get(page);
        if (list) list.push(tup);
        else byPage.set(page, [tup]);
      }
      if (byPage.size === 0) return { error: '선택 좌표를 계산할 수 없습니다.' };
      const rects = [...byPage.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([page, rs]) => ({ page, rects: rs }));

      const first = rects[0]!; // byPage.size > 0 보장
      const pFrom = first.page;
      const pTo = rects[rects.length - 1]!.page;
      // 위치 사전확률 — 첫 페이지 첫 rect 의 세로 비율로 문자 위치 추정(중복 문구 판별)
      const pIdx = Math.min(Math.max(pFrom - 1, 0), Math.max(data.pages.length - 1, 0));
      const firstTop = Math.min(...first.rects.map((t) => t[1]));
      const expected = (data.cum[pIdx] ?? 0) + firstTop * (data.pages[pIdx]?.text.length ?? 0);

      const m = findQuoteInPages(data, sel.text, pFrom, pTo, expected);
      if (!m) {
        return {
          error: '선택한 문구를 문서 텍스트에서 찾지 못했습니다. (스캔 페이지일 수 있습니다)',
        };
      }
      const sIdx = pageIndexAt(data, m.startLocal);
      const eIdx = pageIndexAt(data, Math.max(m.startLocal, m.endLocal - 1));
      const sPage = data.pages[sIdx];
      const ePage = data.pages[eIdx];
      if (!sPage || !ePage) return { error: '페이지 텍스트 정보가 불완전합니다.' };
      const startOffset = sPage.startOffset + (m.startLocal - (data.cum[sIdx] ?? 0));
      const endOffset = ePage.startOffset + (m.endLocal - (data.cum[eIdx] ?? 0));
      const req: CreateAnchorRequest = {
        documentVersionId: versionId,
        questionIds: [target.id],
        // 인용은 서버 정본 전문에서 자른다: 쪽 경계를 걸친 인용의 낱말이 붙지 않게 (pageText.ts quoteFields)
        ...quoteFields(data, startOffset, endOffset),
        startOffset,
        endOffset,
        pageStart: sPage.pageNo,
        pageEnd: ePage.pageNo,
        rects,
        color,
        geometryPrimary: 0,
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
        showToast(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [refreshAnchors, onLinked, showToast],
  );

  const confirmLink = useCallback(async () => {
    if (!selection || !mapTargetQuestion || busy) return;
    let data = pageDataRef.current;
    if (!data) {
      try {
        data = await loadPageText(versionId);
        pageDataRef.current = data;
      } catch (e) {
        showToast(`문서 텍스트를 불러오지 못했습니다: ${errorMessage(e)}`);
        return;
      }
    }
    const built = buildPayload(data, selection, mapTargetQuestion, false);
    if ('error' in built) {
      showToast(built.error);
      return;
    }
    await submitAnchor(built.req, mapTargetQuestion);
  }, [selection, mapTargetQuestion, busy, versionId, buildPayload, submitAnchor, showToast]);

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
      showToast(errorMessage(e));
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
              showToast(errorMessage(e2));
            }
          }
        } else {
          showToast(errorMessage(e));
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
        showToast(errorMessage(e));
      }
    },
    [linkPicker, refreshAnchors, onLinked, showToast],
  );

  // ── 단축키: Enter 연결 확정 · Esc 취소 (캡처 — 소비 시 전파 중단) ─────────
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

  // ── 렌더 ──────────────────────────────────────────────────────────────────
  return (
    <div ref={rootRef} className={'pvp-root' + (isMap ? ' is-map' : '')}>
      <ZoomBar percent={zoomPct} mode={zoomMode} onStep={onZoomStep} onReset={onZoomReset} onToggleFit={onToggleFit} />
      <PdfLoader
        key={versionId}
        document={documentInit}
        workerSrc={workerUrl}
        beforeLoad={() => <div className="pvp-status">PDF 불러오는 중…</div>}
        errorMessage={(err) => (
          <div className="pvp-status pvp-status-error">PDF를 불러올 수 없습니다: {err.message}</div>
        )}
        onError={(err) => console.error('PDF 로드 오류:', err)}
      >
        {(pdfDocument) => (
          <PdfHighlighterWithTeardown
            pdfDocument={pdfDocument}
            highlights={paneHighlights}
            onSelection={isMap ? onSelection : undefined}
            pdfScaleValue={scaleProxy}
            textSelectionColor={isMap ? 'rgba(255, 213, 46, 0.45)' : undefined} /* --y-chip */
            utilsRef={(u) => {
              utilsRef.current = u;
            }}
          >
            <AnchorHighlightContainer onOpen={openPopover} />
          </PdfHighlighterWithTeardown>
        )}
      </PdfLoader>

      {isMap && mapTargetQuestion && (
        <>
          <div className="pvp-mapframe" aria-hidden="true" />
          <div className="pvp-mapbar">
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

      {/* 플로팅 툴바 — 드래그 선택 직후 (설계서 §3.2) */}
      {selection && isMap && mapTargetQuestion && !overlap && (
        <div className="pvp-toolbar" style={{ left: selection.x, top: selection.y }}>
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

      {/* 겹침 ≥60% — 기존 하이라이트에 추가 제안 (설계서 §3.2 중복 방지) */}
      {overlap && mapTargetQuestion && (
        <div
          className="pvp-toolbar pvp-overlap"
          style={{ left: selection?.x ?? 40, top: selection?.y ?? 40 }}
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
            <button
              type="button"
              className="btn btn-ghost pvp-btn-sm"
              onClick={cancelSelection}
            >
              취소 Esc
            </button>
          </div>
        </div>
      )}

      {/* 인용 문항 팝오버 (설계서 §3.3 — 유일하게 허용된 팝업) */}
      {popover && popAnchors.length > 0 && (
        <div className="pvp-popover" style={{ left: popover.x, top: popover.y }}>
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

      {toast && <div className="pvp-toast">{toast}</div>}
    </div>
  );
}
