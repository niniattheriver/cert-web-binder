/**
 * 문서 뷰어 /docs/:id (설계서 §3.3 역방향 화면, §4 #7)
 * - 현재 판본 뷰어(mode='view') + 우측 레일(페이지순 앵커 색인 — 클릭 시 펄스)
 * - 판본 드롭다운(과거 판본을 당시 앵커 그대로 열람) + ?hl=anchorId 딥링크 + ?v= ?page=
 * - 매핑 모드 토글 M: 문항 퀵피커로 대상 지정 → 드래그 매핑(현재 판본에서만)
 * - 배지 [열기] → /q/:id 네비게이션 (Phase 2 에서 인라인 교체로 대체 가능하도록
 *   onBadgeOpenQuestion 콜백으로 구현)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  fetchDoc,
  fetchDocs,
  fetchVersionAnchors,
  type AnchorInfo,
  type DocDetailResponse,
} from '../api';
import { docSourceFileUrl } from '../api-phase2';
import { useAuth } from '../auth';
import { errorMessage, truthy } from '../util';
import PdfViewerPane, { type MapTargetQuestion } from '../pdf/PdfViewerPane';
import QuestionPicker from '../pdf/QuestionPicker';

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

function snip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function parsePageParam(sp: URLSearchParams): number | undefined {
  const p = Number(sp.get('page'));
  return Number.isFinite(p) && p >= 1 ? p : undefined;
}

function anchorStatusChip(status: string): { label: string; cls: string } | null {
  if (status === 'needs_review') return { label: '확인 필요', cls: 'badge-recheck' };
  if (status === 'unresolved') return { label: '미해결', cls: 'badge-recheck' };
  if (status === 'resolved_fuzzy') return { label: '확인 필요', cls: 'badge-mod' };
  return null;
}

export default function DocViewer() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const canEdit = user != null && user.role !== 'viewer';

  const [detail, setDetail] = useState<DocDetailResponse | null>(null);
  const [currentVid, setCurrentVid] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selVid, setSelVid] = useState<number | null>(null);

  const [railAnchors, setRailAnchors] = useState<AnchorInfo[] | null>(null);
  const [railError, setRailError] = useState<string | null>(null);

  const [mapMode, setMapMode] = useState(false);
  const [mapTarget, setMapTarget] = useState<MapTargetQuestion | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [focusId, setFocusId] = useState<number | null>(null);
  const hlAppliedRef = useRef(false);
  /** ?page= 이동 상태 — epoch 이 바뀌면 뷰어를 다시 열어 그 페이지로 이동한다 */
  const [pageNav, setPageNav] = useState<{ page: number | undefined; epoch: number }>(() => ({
    page: parsePageParam(searchParams),
    epoch: 0,
  }));
  const lastPageParamRef = useRef<number | undefined>(pageNav.page);

  // ── 문서 상세 + 현재판본 판별 (docs 목록의 currentVersion 이 1차 근거) ─────
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setDetail(null);
    setLoadError(null);
    setSelVid(null);
    setCurrentVid(null);
    hlAppliedRef.current = false;
    Promise.all([fetchDoc(id), fetchDocs().catch(() => null)])
      .then(([det, docsRes]) => {
        if (!alive) return;
        setDetail(det);
        const fromList = docsRes?.docs.find((d) => d.id === det.doc.id)?.currentVersion?.id;
        const fromDetail =
          det.doc.currentVersionId ??
          det.versions.find((v) => truthy(v.isCurrent as 0 | 1 | undefined) || v.status === 'current')
            ?.id;
        const cur = fromList ?? fromDetail ?? det.versions[0]?.id ?? null;
        setCurrentVid(cur);
        // ?v= 딥링크가 유효하면 그 판본, 아니면 현재 판본
        const vParam = Number(searchParams.get('v'));
        const validV =
          Number.isFinite(vParam) && det.versions.some((v) => v.id === vParam) ? vParam : null;
        setSelVid(validV ?? cur);
      })
      .catch((e) => {
        if (alive) setLoadError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
    // searchParams 는 초기 딥링크만 사용 — id 변경 시에만 재실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── URL 파라미터 변화에 반응 (이미 열려 있는 문서로의 재이동 — 통합 검색 등) ──
  // 같은 문서가 열린 채 ?page= 가 새 값으로 바뀌면 뷰어를 그 페이지로 다시 연다.
  // ?v= 가 유효한 다른 판본으로 바뀌면 판본을 전환한다(판본 전환과 같은 재마운트 경로).
  useEffect(() => {
    const p = parsePageParam(searchParams);
    if (p !== lastPageParamRef.current) {
      lastPageParamRef.current = p;
      if (p != null) setPageNav((prev) => ({ page: p, epoch: prev.epoch + 1 }));
    }
    if (detail) {
      const vParam = Number(searchParams.get('v'));
      if (Number.isFinite(vParam) && detail.versions.some((v) => v.id === vParam)) {
        setSelVid((cur) => (cur === vParam ? cur : vParam));
      }
    }
  }, [searchParams, detail]);

  // ── 우측 레일 앵커 색인 ────────────────────────────────────────────────────
  const reloadRail = useCallback(() => {
    if (selVid == null) return;
    setRailError(null);
    fetchVersionAnchors(selVid)
      .then((r) => setRailAnchors(r.anchors ?? []))
      .catch((e) => setRailError(errorMessage(e)));
  }, [selVid]);

  useEffect(() => {
    setRailAnchors(null);
    reloadRail();
  }, [reloadRail]);

  const sortedRail = useMemo(() => {
    if (!railAnchors) return null;
    return [...railAnchors].sort(
      (a, b) => (a.pageStart ?? Number.MAX_SAFE_INTEGER) - (b.pageStart ?? Number.MAX_SAFE_INTEGER),
    );
  }, [railAnchors]);

  // ── ?hl= 딥링크: 레일 앵커 로드 후 1회 포커스 ─────────────────────────────
  useEffect(() => {
    if (hlAppliedRef.current || !sortedRail) return;
    const hl = Number(searchParams.get('hl'));
    if (Number.isFinite(hl) && hl > 0 && sortedRail.some((a) => a.anchorId === hl)) {
      hlAppliedRef.current = true;
      setFocusId(hl);
    } else if (sortedRail.length >= 0) {
      hlAppliedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedRail]);

  const jumpTo = useCallback(
    (anchorId: number) => {
      // 같은 앵커 재클릭에도 다시 펄스되도록 null → id 2단계 갱신
      setFocusId(null);
      window.requestAnimationFrame(() => setFocusId(anchorId));
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('hl', String(anchorId));
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // ── 매핑 모드 (M 토글 · Esc 종료) ─────────────────────────────────────────
  const isCurrentSelected = selVid != null && selVid === currentVid;

  const toggleMapMode = useCallback(() => {
    if (!canEdit || !isCurrentSelected) return;
    if (mapMode) {
      setMapMode(false);
      return;
    }
    if (mapTarget) setMapMode(true);
    else setPickerOpen(true);
  }, [canEdit, isCurrentSelected, mapMode, mapTarget]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleMapMode();
      } else if (e.key === 'Escape') {
        // 페인이 선택/팝오버를 소비하면(캡처 stopPropagation) 여기 도달하지 않음
        if (pickerOpen) setPickerOpen(false);
        else if (mapMode) setMapMode(false);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [toggleMapMode, pickerOpen, mapMode]);

  const changeVersion = (vid: number) => {
    setSelVid(vid);
    setMapMode(false);
    setFocusId(null);
    // 판본을 바꾸면 이전의 페이지 이동 지정은 잊는다 (새 판본을 첫 페이지부터)
    setPageNav((prev) => ({ page: undefined, epoch: prev.epoch }));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('v', String(vid));
        next.delete('hl');
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  // ── 렌더 ──────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="error-card">
        <p>{loadError}</p>
        <Link className="btn" to="/docs">
          지침서 라이브러리로
        </Link>
      </div>
    );
  }
  if (!detail || selVid == null) {
    return <div className="page-status">문서 불러오는 중…</div>;
  }

  const selVersion = detail.versions.find((v) => v.id === selVid);
  const paneMode: 'view' | 'map' = mapMode && mapTarget && isCurrentSelected ? 'map' : 'view';

  return (
    <div className="docv-page">
      <div className="docv-head">
        <div className="docv-head-main">
          <span className="q-crumb">
            <Link to="/docs">지침서</Link>
            <span className="crumb-sep">›</span>
          </span>
          <h1 className="docv-title">{detail.doc.title}</h1>
          <select
            className="docv-version"
            value={selVid}
            onChange={(e) => changeVersion(Number(e.target.value))}
            aria-label="판본 선택"
          >
            {detail.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.versionLabel}
                {v.year != null ? ` · ${v.year}년` : ''}
                {v.id === currentVid ? ' (현재)' : ''}
              </option>
            ))}
          </select>
          {!isCurrentSelected && <span className="badge badge-mod">과거 판본 — 열람 전용</span>}
          {truthy(
            typeof selVersion?.textWarning === 'string'
              ? 1
              : (selVersion?.textWarning as 0 | 1 | undefined),
          ) && <span className="badge badge-mod">텍스트 저밀도 경고</span>}
          {detail.needsReviewCount > 0 && (
            <span className="badge badge-recheck">위치 확인 필요 {detail.needsReviewCount}건</span>
          )}
        </div>
        <div className="docv-head-actions">
          {selVersion?.sourceName && (
            <a
              className="btn"
              href={docSourceFileUrl(selVersion.id)}
              title={`원본 파일 내려받기 — ${selVersion.sourceName} (매핑은 PDF 사본, 편집은 원본으로)`}
            >
              원본 내려받기
            </a>
          )}
          {canEdit && isCurrentSelected && (
            <>
              {mapMode && mapTarget && (
                <button type="button" className="btn" onClick={() => setPickerOpen(true)}>
                  대상 변경 (「{mapTarget.questionNo}」)
                </button>
              )}
              <button
                type="button"
                className={'btn' + (mapMode ? ' btn-primary' : '')}
                onClick={toggleMapMode}
                title="단축키 M"
              >
                {mapMode ? '매핑 종료 (Esc)' : '매핑 모드 (M)'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="docv-body">
        <div className="docv-viewer">
          <PdfViewerPane
            key={`${selVid}:${pageNav.epoch}`}
            versionId={selVid}
            mode={paneMode}
            mapTargetQuestion={mapTarget ?? undefined}
            focusAnchorId={focusId}
            onLinked={reloadRail}
            onBadgeOpenQuestion={(qid) => navigate(`/q/${qid}`)}
            initialPage={pageNav.page}
          />
        </div>

        <aside className="docv-rail">
          <div className="docv-rail-head">
            매핑 색인{sortedRail ? ` (${sortedRail.length})` : ''}
          </div>
          {railError ? (
            <div className="docv-rail-msg">
              {railError}{' '}
              <button type="button" className="btn pvp-btn-sm" onClick={reloadRail}>
                다시 시도
              </button>
            </div>
          ) : sortedRail === null ? (
            <div className="docv-rail-msg">불러오는 중…</div>
          ) : sortedRail.length === 0 ? (
            <div className="docv-rail-msg">
              아직 매핑된 근거가 없습니다.
              {canEdit && isCurrentSelected && ' 매핑 모드(M)에서 드래그로 연결하세요.'}
            </div>
          ) : (
            <ul className="docv-rail-list">
              {sortedRail.map((a) => {
                const chip = anchorStatusChip(a.status);
                const clickable = a.rects != null && a.rects.length > 0;
                return (
                  <li key={a.anchorId}>
                    <button
                      type="button"
                      className="docv-rail-item"
                      disabled={!clickable}
                      onClick={() => jumpTo(a.anchorId)}
                      title={clickable ? '클릭하면 해당 위치로 이동 + 펄스' : '위치 미확정 앵커'}
                    >
                      <span className="docv-rail-top">
                        <span className="docv-rail-page">
                          {a.pageStart != null ? `p.${a.pageStart}` : 'p.—'}
                        </span>
                        {chip && <span className={`badge ${chip.cls}`}>{chip.label}</span>}
                        <span className="docv-rail-nos">
                          {a.questions.map((q) => q.questionNo).join(' · ') || '문항 없음'}
                        </span>
                      </span>
                      <span className="docv-rail-quote">{snip(a.label || a.quote, 72)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>

      {pickerOpen && (
        <QuestionPicker
          title="매핑 대상 문항 지정 — 이후 드래그 선택이 이 문항에 연결됩니다"
          onPick={(q) => {
            setMapTarget(q);
            setMapMode(true);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
