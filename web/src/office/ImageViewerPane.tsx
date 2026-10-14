/**
 * 그림 판본 뷰어 페인 (png, jpg, gif, webp, bmp)
 *
 * 그림 파일은 글자를 읽지 않으므로(OCR 없음) 드래그로 문장을 고르는 대신 그림 전체를 문항의 근거로 잇는다.
 * - 보기: 그림을 페인 폭에 맞춰 보이고, 맨 위 단추 줄(ZoomBar), Ctrl+휠, Ctrl+드래그로 확대/축소한다(viewerZoom.ts). 근거로 연결된 그림이면
 *   테두리와 배지(연결 문항 번호)를 붙이고, 배지를 누르면 PDF, Office 뷰어와 같은 팝오버(열기, 연결 해제,
 *   다른 문항에도 연결)가 뜬다.
 * - 연결(mode='map'): 안내줄의 [이 그림 연결](Enter)을 누르면 POST /api/anchors/image. 그 그림에 이미 근거가
 *   있으면 서버가 같은 발췌에 문항을 더한다(그림 하나에 근거 하나).
 * - 새 버전으로 바뀌어 확인 필요로 넘어온 근거는 그림 아래에 모아 보이고, 편집자는 [이 그림으로 확인]으로 확정한다
 *   (POST /api/anchors/:id/confirm-image). 지난 버전을 볼 때는 확인 단추를 보이지 않는다.
 * 그림은 /api/docs/versions/:vid/media/0 으로 받는다(서버가 앞머리를 다시 판정한 래스터만 내준다).
 * 클래스는 pvp-*(바깥 틀, 매핑 테두리와 안내줄, 배지, 팝오버, 토스트)를 그대로 써서 다른 뷰어와 같아 보인다.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ApiError,
  addPassageLink,
  confirmImageAnchor,
  createImageAnchor,
  fetchVersionAnchors,
  fetchVersionMeta,
  removePassageLink,
  versionDownloadUrl,
  versionMediaUrl,
  type AnchorInfo,
  type AnchorQuestionRef,
} from '../api';
import { useAuth } from '../auth';
import { chipGlyph } from '../components/EvidenceCards';
import type { PdfViewerPaneProps } from '../pdf/PdfViewerPane';
import QuestionPicker, { type PickedQuestion } from '../pdf/QuestionPicker';
import { errorMessage } from '../util';
import ZoomBar from './ZoomBar';
import { clampZoom, loadZoom, saveZoom, stepZoom, useZoomGestures, zoomPercent, type ZoomMode } from './viewerZoom';
import './imagepane.css';

export type ImageViewerPaneProps = PdfViewerPaneProps;

/** 근거 테두리 색 (PdfViewerPane, OfficeViewerPane 의 밑줄 색과 같은 값) */
const COLOR_LINE: Record<string, string> = {
  yellow: '#d97706',
  green: '#15803d',
  blue: '#1d4ed8',
  pink: '#be185d',
  orange: '#c2410c',
};
/** 포커스 펄스 유지 시간 (CSS hl-pulse 0.7s × 2 회 + 여유) */
const PULSE_MS = 1600;

function isResolved(a: AnchorInfo): boolean {
  return String(a.status ?? '').startsWith('resolved');
}

function needsCheck(a: AnchorInfo): boolean {
  return a.status === 'needs_review' || a.status === 'unresolved';
}

function snip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 서버 400 의 details 문구가 있으면 그것을, 아니면 일반 오류 문구 */
function apiErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 400) {
    const d = e.body?.details;
    if (typeof d === 'string' && d.trim() !== '') return d;
  }
  return errorMessage(e);
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

/** 이 뷰어와 무관한 모달(첨부 미리보기, 검색 창 등)이 떠 있으면 그 모달의 키다 */
function isBehindModal(root: HTMLElement | null): boolean {
  if (!root) return false;
  for (const d of document.querySelectorAll('[aria-modal="true"]')) {
    if (!d.contains(root) && !root.contains(d)) return true;
  }
  return false;
}

/** 배지 라벨: 문항 상세의 칩 순번(①②③) + 연결 문항 번호 (OfficeViewerPane 의 badgeLabel 과 같은 규칙) */
function badgeLabel(list: AnchorInfo[], chipOrdinals: Map<number, number> | undefined): string {
  const nos: string[] = [];
  for (const a of list) {
    for (const q of a.questions) if (!nos.includes(q.questionNo)) nos.push(q.questionNo);
  }
  const base =
    nos.length === 0 ? '근거' : nos.length <= 2 ? nos.join(', ') : `${nos.slice(0, 2).join(', ')} +${nos.length - 2}`;
  const prefix = list
    .map((a) => chipOrdinals?.get(a.anchorId))
    .filter((n): n is number => n != null)
    .sort((x, y) => x - y)
    .map(chipGlyph)
    .join('');
  return prefix ? `${prefix} ${base}` : base;
}

export default function ImageViewerPane({
  versionId,
  mode,
  mapTargetQuestion,
  focusAnchorId,
  onLinked,
  onBadgeOpenQuestion,
  chipOrdinals,
  mapHint,
}: ImageViewerPaneProps) {
  const { user } = useAuth();
  const canEdit = user != null && user.role !== 'viewer';
  const isMap = mode === 'map' && !!mapTargetQuestion && canEdit;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const figureRef = useRef<HTMLElement | null>(null);
  const mapbarRef = useRef<HTMLDivElement | null>(null);
  const reviewRefs = useRef(new Map<number, HTMLElement>());
  const toastTimerRef = useRef<number | null>(null);
  const pulseTimerRef = useRef<number | null>(null);

  const [anchors, setAnchors] = useState<AnchorInfo[] | null>(null);
  const [anchorsError, setAnchorsError] = useState<string | null>(null);
  /** 지금 보는 버전이 현재 버전인가 (모르면 null: 확인 단추를 보이지 않는다) */
  const [isCurrent, setIsCurrent] = useState<boolean | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [imgState, setImgState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [naturalW, setNaturalW] = useState(0);
  /** 화면에 그린 그림 폭(px). 배율 표시와 Ctrl 조작의 기준 */
  const [shownW, setShownW] = useState(0);
  /** 배율(viewerZoom.ts): 'auto' 칸보다 크면 줄여 맞춤, 'width' 칸 폭에 맞춤(키우기도), 숫자는 원래 크기 대비 배율 */
  const [zoomMode, setZoomMode] = useState<ZoomMode>(() => loadZoom('image'));
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null);
  const [linkPicker, setLinkPicker] = useState<{ passageId: number } | null>(null);
  const [pulseId, setPulseId] = useState<number | null>(null);
  /** 매핑 안내줄 높이: 스크롤 상자를 그 아래에서 시작한다 */
  const [barH, setBarH] = useState(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    },
    [],
  );

  // ── 불러오기: 근거 목록, 버전 정보(현재 버전인지, 파일 이름) ─────────────────
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
    setIsCurrent(null);
    setFileName(null);
    setImgState('loading');
    setPopover(null);
    fetchVersionAnchors(versionId)
      .then((res) => {
        if (alive) setAnchors(res.anchors ?? []);
      })
      .catch((e) => {
        if (alive) setAnchorsError(errorMessage(e));
      });
    fetchVersionMeta(versionId)
      .then((m) => {
        if (!alive) return;
        setIsCurrent(m.isCurrent);
        setFileName(m.fileName);
      })
      .catch(() => {
        // 버전 정보가 없어도 그림과 근거는 보인다(확인 단추만 숨는다)
      });
    return () => {
      alive = false;
    };
  }, [versionId]);

  // ── 크기: 그린 그림 폭, 매핑 안내줄 높이 ─────────────────────────────────────
  const imgRef = useRef<HTMLImageElement | null>(null);
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const ro = new ResizeObserver(() => setShownW(img.getBoundingClientRect().width));
    ro.observe(img);
    return () => ro.disconnect();
  }, [imgState]);

  // ── 확대/축소 (viewerZoom.ts): 위쪽 단추 줄, Ctrl+휠, Ctrl+드래그 ─────────────
  const scale = naturalW > 0 && shownW > 0 ? shownW / naturalW : 1;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  /** Ctrl 조작의 고정점: 배율이 바뀐 뒤 그 자리가 커서 밑에 남도록 스크롤을 맞춘다 */
  const zoomOriginRef = useRef<{ x: number; y: number; from: number; sl: number; st: number } | null>(null);
  const chooseZoom = useCallback((m: ZoomMode, origin?: { x: number; y: number }) => {
    const sc = scrollRef.current;
    zoomOriginRef.current =
      origin && sc ? { x: origin.x, y: origin.y, from: scaleRef.current, sl: sc.scrollLeft, st: sc.scrollTop } : null;
    setZoomMode(m);
    saveZoom('image', m);
  }, []);
  useLayoutEffect(() => {
    const o = zoomOriginRef.current;
    zoomOriginRef.current = null;
    const sc = scrollRef.current;
    if (!o || !sc || o.from <= 0 || typeof zoomMode !== 'number') return;
    const ratio = zoomMode / o.from;
    const r = sc.getBoundingClientRect();
    const px = o.x - r.left;
    const py = o.y - r.top;
    sc.scrollLeft = (o.sl + px) * ratio - px;
    sc.scrollTop = (o.st + py) * ratio - py;
  }, [zoomMode]);
  useZoomGestures(rootRef, {
    getScale: () => scaleRef.current,
    setScale: (s, origin) => chooseZoom(clampZoom(s), origin),
  });
  const onZoomStep = useCallback((dir: 1 | -1) => chooseZoom(stepZoom(scaleRef.current, dir)), [chooseZoom]);
  const onZoomReset = useCallback(() => chooseZoom(1), [chooseZoom]);
  const onToggleFit = useCallback(
    () => chooseZoom(zoomMode === 'width' ? 'auto' : 'width'),
    [chooseZoom, zoomMode],
  );
  /** 그림 크기 규칙: 숫자 배율이면 원래 폭 × 배율, 폭 맞춤이면 칸 폭, 기본은 칸보다 크면 줄여 맞춤(css) */
  const imgStyle: CSSProperties | undefined =
    typeof zoomMode === 'number' && naturalW > 0
      ? { width: Math.round(naturalW * zoomMode), maxWidth: 'none' }
      : zoomMode === 'width'
        ? { width: '100%' }
        : undefined;

  useLayoutEffect(() => {
    const bar = mapbarRef.current;
    if (!isMap || !bar) {
      setBarH(0);
      return;
    }
    const ro = new ResizeObserver(() => setBarH(bar.offsetHeight));
    ro.observe(bar);
    setBarH(bar.offsetHeight);
    return () => ro.disconnect();
  }, [isMap]);

  const linked = useMemo(() => (anchors ?? []).filter(isResolved), [anchors]);
  const pending = useMemo(() => (anchors ?? []).filter(needsCheck), [anchors]);
  const lineColor = COLOR_LINE[linked[0]?.color ?? 'yellow'] ?? COLOR_LINE.yellow;

  // ── 포커스: 근거 카드, 레일에서 고른 근거를 그 자리로 옮겨 두 번 깜빡인다 ─────
  // 포커스 대상이 바뀔 때 한 번만 한다(연결, 해제로 근거 목록을 다시 받아도 다시 깜빡이지 않는다).
  // 같은 근거를 다시 고르면 부모가 null 을 거쳐 같은 id 를 다시 주므로 그때는 다시 깜빡인다.
  const focusDoneRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusAnchorId == null) {
      focusDoneRef.current = null;
      return;
    }
    if (!anchors || focusDoneRef.current === focusAnchorId) return;
    const a = anchors.find((x) => x.anchorId === focusAnchorId);
    if (!a) return;
    const el = isResolved(a) ? figureRef.current : (reviewRefs.current.get(a.anchorId) ?? null);
    if (!el) return;
    focusDoneRef.current = focusAnchorId;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setPulseId(a.anchorId);
    if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => setPulseId(null), PULSE_MS);
  }, [focusAnchorId, anchors]);

  // ── 연결, 확인, 연결 해제 ───────────────────────────────────────────────────
  const linkImage = useCallback(async () => {
    if (!mapTargetQuestion || busy) return;
    setBusy(true);
    try {
      const res = await createImageAnchor({ documentVersionId: versionId, questionIds: [mapTargetQuestion.id] });
      const added = res.created || (res.added?.length ?? 0) > 0;
      showToast(
        added
          ? `「${mapTargetQuestion.questionNo}」에 이 그림을 근거로 연결했습니다 ✓`
          : `「${mapTargetQuestion.questionNo}」에는 이미 이 그림이 연결되어 있습니다`,
      );
      await refreshAnchors();
      if (added) onLinked?.();
    } catch (e) {
      showToast(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  }, [mapTargetQuestion, busy, versionId, refreshAnchors, onLinked, showToast]);

  const confirmAnchor = useCallback(
    async (a: AnchorInfo) => {
      if (busy) return;
      setBusy(true);
      try {
        await confirmImageAnchor(a.anchorId);
        showToast('이 그림을 근거로 확인했습니다 ✓');
        await refreshAnchors();
        onLinked?.();
      } catch (e) {
        showToast(apiErrorText(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshAnchors, onLinked, showToast],
  );

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
            '이 그림을 근거로 쓰는 문항은 이 문항뿐입니다. 연결을 해제하면 그림의 근거 표시도 함께 지워집니다. 계속할까요?',
          );
          if (ok) {
            try {
              await removePassageLink(a.passageId, q.id, true);
              showToast('연결을 해제하고 그림의 근거 표시도 지웠습니다');
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

  // ── 팝오버: 배지 아래에 띄우고, 바깥을 누르면 닫는다 ─────────────────────────
  const openPopover = useCallback((ev: { clientX: number; clientY: number }) => {
    const root = rootRef.current;
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const W = 360;
    const x = Math.min(Math.max(ev.clientX - rr.left - W + 40, 8), Math.max(8, rr.width - W - 12));
    const y = Math.min(Math.max(ev.clientY - rr.top + 12, 8), Math.max(8, rr.height - 160));
    setPopover({ x, y });
  }, []);

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

  // ── 단축키: Enter 연결(매핑 모드), Esc 팝오버 닫기 (캡처 단계, 쓰면 전파 중단) ───
  // 이 뷰어 안의 단추([원래 크기], 배지 등)에 포커스가 있을 때의 Enter 는 그 단추의 몫이다([이 그림 연결] 단추면 눌러서
  // 같은 일이 된다). 뷰어 밖(연결 창을 연 [+ 근거자료 연결] 단추 등)에 포커스가 남아 있어도 Enter 는 연결이다(다른 뷰어와 같다)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (isBehindModal(rootRef.current)) return;
      const onPaneControl =
        e.target instanceof Element &&
        rootRef.current?.contains(e.target) === true &&
        e.target.closest('button, a[href], select') != null;
      if (e.key === 'Enter' && isMap && !busy && !popover && !linkPicker && !onPaneControl) {
        e.preventDefault();
        e.stopPropagation();
        void linkImage();
      } else if (e.key === 'Escape' && popover && !linkPicker) {
        e.stopPropagation();
        setPopover(null);
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [isMap, busy, popover, linkPicker, linkImage]);

  const alt = fileName ? `근거자료 그림: ${fileName}` : '근거자료 그림';
  const isLinked = linked.length > 0;
  const badgeText = isLinked ? badgeLabel(linked, chipOrdinals) : '';

  return (
    <div ref={rootRef} className={'pvp-root ivp-root' + (isMap ? ' is-map' : '')} data-file-kind="image">
      <ZoomBar
        percent={imgState === 'ok' && naturalW > 0 && shownW > 0 ? zoomPercent(scale) : null}
        mode={zoomMode}
        onStep={onZoomStep}
        onReset={onZoomReset}
        onToggleFit={onToggleFit}
      />
      <div ref={scrollRef} className="ivp-scroll" style={{ top: `calc(var(--vzb-h) + ${barH}px)` }}>
        <div className="ivp-content">
          {imgState === 'error' ? (
            <div className="pvp-status pvp-status-error" role="alert">
              그림을 불러오지 못했습니다.{' '}
              <a className="btn pvp-btn-sm" href={versionDownloadUrl(versionId)}>
                원본 내려받기
              </a>
            </div>
          ) : (
            <figure
              ref={figureRef}
              className={
                'ivp-figure' +
                (typeof zoomMode === 'number' ? ' is-actual' : zoomMode === 'width' ? ' is-fit' : '') +
                (isLinked ? ' is-linked' : '') +
                (pulseId != null && linked.some((a) => a.anchorId === pulseId) ? ' hl-pulse' : '')
              }
              style={isLinked ? ({ '--ivp-line': lineColor } as CSSProperties) : undefined}
              data-anchors={linked.map((a) => a.anchorId).join(',') || undefined}
            >
              <img
                key={versionId}
                ref={imgRef}
                src={versionMediaUrl(versionId, 0)}
                alt={alt}
                style={imgStyle}
                draggable={false}
                onLoad={(e) => {
                  setNaturalW(e.currentTarget.naturalWidth);
                  setImgState('ok');
                }}
                onError={() => setImgState('error')}
              />
              {isLinked && (
                <button
                  type="button"
                  className="pvp-badge ivp-badge"
                  style={{ top: 8, left: 'calc(100% - 8px)' }}
                  onClick={(e) => openPopover(e)}
                  title={`${badgeText}: 이 그림을 근거로 쓴 문항 보기`}
                  aria-label={`이 그림을 근거로 쓴 문항: ${badgeText}`}
                >
                  {badgeText}
                </button>
              )}
              {imgState === 'loading' && <figcaption className="ivp-loading">그림 불러오는 중…</figcaption>}
            </figure>
          )}

          {pending.length > 0 && (
            <section className="ivp-review" aria-label="확인이 필요한 근거">
              <div className="ivp-review-title">
                확인 필요 {pending.length}건: 이전 버전의 근거입니다. 이 그림도 근거로 맞는지 확인해 주세요.
              </div>
              <ul className="ivp-review-list">
                {pending.map((a) => (
                  <li
                    key={a.anchorId}
                    ref={(el) => {
                      if (el) reviewRefs.current.set(a.anchorId, el);
                      else reviewRefs.current.delete(a.anchorId);
                    }}
                    className={'ivp-review-item' + (pulseId === a.anchorId ? ' hl-pulse' : '')}
                  >
                    <span className="ivp-review-qs">
                      {a.questions.length > 0 ? a.questions.map((q) => q.questionNo).join(', ') : '연결 문항 없음'}
                    </span>
                    {a.quote && a.quote.trim() !== '' && (
                      <span className="ivp-review-quote">이전 버전 인용: “{snip(a.quote, 60)}”</span>
                    )}
                    {canEdit && isCurrent === true && (
                      <button
                        type="button"
                        className="btn btn-primary pvp-btn-sm"
                        disabled={busy}
                        onClick={() => void confirmAnchor(a)}
                        title="이 그림 전체를 이 문항들의 근거로 확정합니다"
                      >
                        이 그림으로 확인
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {isMap && mapTargetQuestion && (
        <>
          <div className="pvp-mapframe" aria-hidden="true" />
          <div ref={mapbarRef} className="pvp-mapbar ivp-mapbar">
            <span>
              그림은 글자를 읽지 않아 그림 전체를 「{mapTargetQuestion.questionNo}」의 근거로 연결합니다.
            </span>
            <button type="button" className="btn btn-primary pvp-btn-sm" disabled={busy} onClick={() => void linkImage()}>
              {busy ? '연결 중…' : '이 그림 연결 ✓ Enter'}
            </button>
            {mapHint && <span className="ivp-mapbar-hint">{mapHint}</span>}
          </div>
        </>
      )}

      {anchorsError && (
        <div className="pvp-anchor-error">
          근거를 불러오지 못했습니다: {anchorsError}{' '}
          <button type="button" className="btn pvp-btn-sm" onClick={() => void refreshAnchors()}>
            다시 시도
          </button>
        </div>
      )}

      {/* 이 그림을 근거로 쓴 문항 (설계서 §3.3, 다른 뷰어의 팝오버와 같은 모양) */}
      {popover && linked.length > 0 && (
        <div
          className="pvp-popover"
          style={{ left: popover.x, top: popover.y }}
          role="dialog"
          aria-label="이 그림을 근거로 쓴 문항"
        >
          <div className="pvp-pop-title">이 그림을 근거로 쓴 문항</div>
          {linked.map((a, i) => (
            <div key={a.anchorId} className="pvp-pop-anchor">
              {linked.length > 1 && <div className="pvp-pop-quote">그림 전체 (근거 {i + 1})</div>}
              {a.questions.length === 0 && <div className="pvp-pop-empty dim">연결된 문항이 없습니다.</div>}
              {a.questions.map((q) => (
                <div key={q.id} className="pvp-pop-q">
                  <div className="pvp-pop-q-main">
                    <span className="omni-no">{q.questionNo}</span>
                    <span className="pvp-pop-body">{snip(q.bodyPreview, 40)}</span>
                  </div>
                  {q.answerPreview && <div className="pvp-pop-preview dim">“{snip(q.answerPreview, 40)}”</div>}
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
                      <button type="button" className="btn pvp-btn-sm" disabled={busy} onClick={() => void unlink(a, q)}>
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
          title="이 그림을 근거로 더 연결할 문항"
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
