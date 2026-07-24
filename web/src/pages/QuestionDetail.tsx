/**
 * 문항 상세 — 3분할 핵심 화면 (설계서 §4 #4·#5, §3.3, §5 — 임무 D 전면 개편)
 *
 *  A: 접이식 문항 레일(같은 분야, j/k 이동, ●◐○+✓ 상태)
 *  B: 문항(배점·개정 배지) + 채점 위젯(자동 저장 600ms) + 답변/지적(자동 저장 1.5s, 409 비교 다이얼로그)
 *     + 근거 카드(EvidenceCards — 칩 ①②③=숫자키, 드래그 재정렬, 메모, 연결 해제)
 *  C: 교체형 PdfViewerPane — 열람 시 근거 ① 자동 로드+펄스, 칩/카드 클릭 시 교체+펄스,
 *     뷰어 배지 팝오버 [열기] → B를 그 문항으로 상태 교체(라우팅 아님), Backspace 복귀(스택),
 *     H → 문서 선택(최근순·타이핑 필터) → 매핑 모드(연속 매핑).
 *  단축키: j/k·1–9·E·H·Backspace·Esc·? (keyboard.ts — 입력창 포커스 중 비활성)
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  categoryLabel,
  ConflictError,
  fetchCategoryQuestions,
  fetchDocs,
  fetchQuestion,
  fetchQuestionEvidence,
  patchQuestion,
  removePassageLink,
  searchDocsFulltext,
  type AnswerChoice,
  type DocSearchHit,
  type DocSummary,
  type EvidenceItem,
  type EvidencePassageItem,
  type QuestionFull,
  type QuestionListItem,
  type QuestionPatch,
  type QuestionType,
  versionFileUrl,
} from '../api';
import { patchQuestionEvidenceItems } from '../api-day2-extra';
import { patchScoringMode, type ScoringMode } from '../api-phase3';
import { createRichDoc, unlinkRichDoc } from '../api-rich';
import { useAuth } from '../auth';
import AttachmentsPanel, { type AttachmentsPanelHandle } from '../components/AttachmentsPanel';
import ConflictDialog, { type ConflictInfo } from '../components/ConflictDialog';
import EvidenceCards, { evidenceItemKey, isPassageItem } from '../components/EvidenceCards';
import EvidenceSuggest from '../components/EvidenceSuggest';
import QuestionBody from '../components/QuestionBody';
import RichDocPane from '../components/RichDocPane';
import { chapterLabel } from './CategoryList';
import ScoreWidget from '../components/ScoreWidget';
import ScoringPanel from '../components/ScoringPanel';
import ShortcutOverlay from '../components/ShortcutOverlay';
import StatusGlyph from '../components/StatusGlyph';
import { useShortcuts } from '../keyboard';
import PdfViewerPane from '../pdf/PdfViewerPane';
import { errorMessage, fmtDate, fmtNum, revisionNoteLabel, truthy } from '../util';

// ── 문항 유형 배지 (핵심=빨강 C · 필요=주황 R · 기본=회색 B) ──────────────────
const TYPE_BADGE: Record<QuestionType, { cls: string; symbol: string; label: string }> = {
  core: { cls: 'badge-core', symbol: 'C', label: '핵심' },
  required: { cls: 'badge-required', symbol: 'R', label: '필요' },
  basic: { cls: 'badge-basic', symbol: 'B', label: '기본' },
};

/** 유형 칩. 미분류(null)면 렌더하지 않는다. */
function TypeBadge({
  type,
  symbol,
}: {
  type?: QuestionType | null;
  symbol?: string | null;
}) {
  if (!type) return null;
  const b = TYPE_BADGE[type];
  return (
    <span
      className={`badge badge-type ${b.cls}`}
      title={`${b.label}(${b.symbol}) 문항 — 인증 문항집이 표기한 문항 유형입니다.`}
    >
      {symbol ?? b.symbol} {b.label}
    </span>
  );
}

// ── 페인/스택 타입 ───────────────────────────────────────────────────────────

type PaneState =
  | { kind: 'none' }
  | {
      kind: 'anchor';
      versionId: number;
      anchorId: number;
      documentId: number;
      docTitle: string;
      versionLabel: string | null;
    }
  | { kind: 'doc'; versionId: number; documentId: number; docTitle: string }
  | {
      kind: 'map';
      versionId: number;
      documentId: number;
      docTitle: string;
      /** 본문 검색 히트로 진입 시 처음 펼칠 페이지 (⑤) */
      page?: number;
    }
  | { kind: 'rich'; richDocId: number; title: string }; // 자유형식 문서 읽기전용 대형 표시 (Phase 2)

interface StackEntry {
  qid: number;
  pane: PaneState;
  activeKey: string | null;
}

type SaveField = 'score' | 'answer' | 'findings';

type ConflictField = 'answerPlain' | 'findingsText';

interface ConflictState {
  field: ConflictField;
  mine: string;
  server: QuestionFull;
}

// ── 소소한 헬퍼 ──────────────────────────────────────────────────────────────

function nowHM(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 서버 400 검증 메시지(details 문자열) 우선 표시 */
function apiErrorText(e: unknown): string {
  if (e instanceof ApiError && e.body && typeof e.body.details === 'string') {
    return e.body.details;
  }
  return errorMessage(e);
}

function openableItem(it: EvidenceItem): it is EvidencePassageItem {
  return isPassageItem(it) && it.anchorId != null && it.versionId != null;
}

/** 완성도 파생 (CategoryList 와 동일 기준 — 저장 안 함. 합산/자동은 score 존재 = 채점됨) */
function railStatus(q: QuestionListItem): 'full' | 'partial' | 'none' {
  const graded =
    q.scoringMode && q.scoringMode !== 'simple' ? q.score != null : q.answerChoice != null;
  const answered = truthy(q.hasAnswer);
  if (graded && answered) return 'full';
  if (graded || answered) return 'partial';
  return 'none';
}

function choiceLabel(choice: AnswerChoice | null): string {
  switch (choice) {
    case 'yes':
      return '예';
    case 'no':
      return '아니오';
    case 'na':
      return '해당없음';
    default:
      return '미채점';
  }
}

// ── 문서 선택 오버레이 (H — 최근순·타이핑 필터 + 본문 검색 ⑤) ────────────────

function DocPicker({
  onPick,
  onClose,
}: {
  /** page 지정 시 그 페이지를 펼친 채 매핑 시작 (본문 검색 히트) */
  onPick: (doc: DocSummary, page?: number) => void;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // 본문 검색 (⑤) — 2자 이상 입력 시 300ms 디바운스로 현재 판본 전문 검색
  const [hits, setHits] = useState<DocSearchHit[] | null>(null);
  const [hitsLoading, setHitsLoading] = useState(false);
  const hitSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    fetchDocs()
      .then((r) => {
        if (!alive) return;
        const sorted = [...r.docs].sort((a, b) => {
          const ta = a.currentVersion?.uploadedAt ?? '';
          const tb = b.currentVersion?.uploadedAt ?? '';
          return tb.localeCompare(ta); // 최근 업로드 우선
        });
        setDocs(sorted);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const f = filter.trim();
    if (f.length < 2) {
      hitSeqRef.current += 1; // 진행 중 요청 무효화
      setHits(null);
      setHitsLoading(false);
      return;
    }
    setHitsLoading(true);
    const seq = ++hitSeqRef.current;
    const timer = window.setTimeout(() => {
      searchDocsFulltext(f)
        .then((r) => {
          if (hitSeqRef.current !== seq) return;
          setHits(r.hits ?? []);
        })
        .catch(() => {
          if (hitSeqRef.current !== seq) return;
          setHits([]); // 본문 검색 실패는 소절만 생략 — 제목 필터는 계속 동작
        })
        .finally(() => {
          if (hitSeqRef.current === seq) setHitsLoading(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filter]);

  const shown = useMemo(() => {
    if (!docs) return [];
    const f = filter.trim().toLowerCase();
    if (!f) return docs;
    return docs.filter(
      (d) =>
        d.title.toLowerCase().includes(f) || (d.code ?? '').toLowerCase().includes(f),
    );
  }, [docs, filter]);

  const shownHits = filter.trim().length >= 2 ? (hits ?? []) : [];
  const total = shown.length + shownHits.length;
  const showHitSection = filter.trim().length >= 2 && (hitsLoading || shownHits.length > 0);

  useEffect(() => {
    setActiveIndex(0);
  }, [filter]);

  useEffect(() => {
    // 소절 헤더가 끼어 있어 children 인덱스 대신 data-idx 로 탐색
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, shown.length, shownHits.length]);

  const pick = (d: DocSummary | undefined) => {
    if (!d) return;
    if (!d.currentVersion) return; // 판본 없는 문서는 매핑 불가
    onPick(d);
  };

  /** 본문 히트 선택 — 검색은 현재 판본만 대상이므로 versionId=현재 판본으로 문서를 찾는다 */
  const pickHit = (h: DocSearchHit | undefined) => {
    if (!h) return;
    const doc = docs?.find((d) => d.currentVersion?.id === h.versionId);
    if (!doc || !doc.currentVersion) {
      setError('해당 지침서를 목록에서 찾지 못했습니다. 창을 닫고 다시 열어 주세요.');
      return;
    }
    onPick(doc, h.pageNo);
  };

  const pickAt = (i: number) => {
    if (i < shown.length) pick(shown[i]);
    else pickHit(shownHits[i - shown.length]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(total - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      pickAt(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="qpick-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="매핑할 문서 선택"
    >
      <div className="qpick-panel">
        <div className="qpick-title">매핑할 지침서 선택 — 이후 드래그 선택이 이 문항에 연결됩니다</div>
        <input
          className="omni-input"
          type="text"
          value={filter}
          placeholder="제목·코드 또는 본문 내용으로 검색"
          autoFocus
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="지침서 검색"
        />
        <div className="omni-body">
          {error && <div className="omni-msg omni-error">{error}</div>}
          {!error && docs === null && <div className="omni-msg">문서 목록 불러오는 중…</div>}
          {!error && docs !== null && shown.length === 0 && !showHitSection && (
            <div className="omni-msg">
              {docs.length === 0
                ? '등록된 지침서가 없습니다. 지침서 라이브러리에서 먼저 업로드하세요.'
                : '조건에 맞는 지침서가 없습니다.'}
            </div>
          )}
          {(shown.length > 0 || showHitSection) && (
            <ul className="omni-list" ref={listRef} role="listbox">
              {shown.map((d, i) => (
                <li
                  key={d.id}
                  role="option"
                  aria-selected={i === activeIndex}
                  data-idx={i}
                  className={
                    'omni-item' +
                    (i === activeIndex ? ' is-active' : '') +
                    (d.currentVersion ? '' : ' is-dead')
                  }
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(d)}
                >
                  <span className="docpick-title">{d.title}</span>
                  <span className="omni-snippet">
                    {d.currentVersion
                      ? `${d.currentVersion.versionLabel} · ${d.currentVersion.pageCount}p · 매핑 문항 ${d.mappedQuestionCount}`
                      : '판본 없음'}
                  </span>
                </li>
              ))}
              {showHitSection && (
                <li className="omni-group-head" aria-hidden="true">
                  본문 일치
                </li>
              )}
              {showHitSection && hitsLoading && shownHits.length === 0 && (
                <li className="docpick-loading dim" aria-hidden="true">
                  본문 검색 중…
                </li>
              )}
              {shownHits.map((h, j) => {
                const idx = shown.length + j;
                return (
                  <li
                    key={`hit-${h.versionId}-${h.pageNo}-${j}`}
                    role="option"
                    aria-selected={idx === activeIndex}
                    data-idx={idx}
                    className={'omni-item' + (idx === activeIndex ? ' is-active' : '')}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickHit(h)}
                  >
                    <span className="omni-passage">
                      <span className="omni-passage-meta">
                        {h.docTitle} · p.{h.pageNo}
                        {h.year != null && <span className="year-chip">{h.year}</span>}
                      </span>
                      {/* 스니펫은 평문 렌더(문서 내용 XSS 방지) */}
                      <span className="omni-snippet">{h.snippet}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="omni-footer">↑↓ 이동 · Enter 선택 · Esc 닫기</div>
      </div>
    </div>
  );
}

// ── 본체 ─────────────────────────────────────────────────────────────────────

export default function QuestionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user != null && user.role !== 'viewer';

  // B에 표시 중인 문항 (라우트와 분리 — 배지 [열기]는 상태 교체)
  const [viewQid, setViewQid] = useState<number | null>(null);
  const [stack, setStack] = useState<StackEntry[]>([]);
  const restoreRef = useRef<StackEntry | null>(null);

  const [q, setQ] = useState<QuestionFull | null>(null);
  const [qError, setQError] = useState<string | null>(null);
  const serverRef = useRef<QuestionFull | null>(null);

  const [siblings, setSiblings] = useState<{ catId: number; list: QuestionListItem[] } | null>(
    null,
  );
  const [railOpen, setRailOpen] = useState(true);

  // A(레일) 폭 — 경계 드래그로 조절, 더블클릭 시 기본 폭 복원, localStorage 지속 (요청)
  // B↔C 리사이저와 동일 패턴. 대분류·소분류를 함께 표기하면서 목차 라벨이 길어져 폭 조절이 필요.
  const railRef = useRef<HTMLElement>(null);
  const [railWidth, setRailWidth] = useState<number | null>(() => {
    const v = Number(localStorage.getItem('qd3-rail-w'));
    return Number.isFinite(v) && v >= 160 ? v : null;
  });
  const onRailResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = railRef.current?.getBoundingClientRect().width ?? railWidth ?? 220;
      const clamp = (w: number) => Math.min(480, Math.max(160, w));
      const move = (ev: PointerEvent) => setRailWidth(clamp(startW + (ev.clientX - startX)));
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.userSelect = '';
        localStorage.setItem('qd3-rail-w', String(Math.round(clamp(startW + (ev.clientX - startX)))));
      };
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [railWidth],
  );
  const resetRailWidth = useCallback(() => {
    setRailWidth(null);
    localStorage.removeItem('qd3-rail-w');
  }, []);

  // 잘린 목차 라벨 위 호버 툴팁 (요청) — 오버플로 클리핑과 무관하게 body 포털로 즉시 표시.
  // 실제로 잘린(scrollWidth>clientWidth) 라벨에만 뜬다.
  const [labelTip, setLabelTip] = useState<
    { text: string; left: number; top: number; bottom?: undefined }
    | { text: string; left: number; bottom: number; top?: undefined }
    | null
  >(null);
  const showLabelTip = useCallback((e: React.MouseEvent<HTMLElement>, text: string) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth + 1) return; // 안 잘렸으면 툴팁 없음
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 372));
    // 아래 공간이 부족하면 위로 띄운다 — 뷰포트 하단 잘림 방지(툴팁은 여러 줄일 수 있음)
    if (window.innerHeight - r.bottom < 120) {
      setLabelTip({ text, left, bottom: Math.round(window.innerHeight - r.top + 4) });
    } else {
      setLabelTip({ text, left, top: Math.round(r.bottom + 4) });
    }
  }, []);
  const hideLabelTip = useCallback(() => setLabelTip(null), []);

  // B(문항)↔C(근거) 분할 폭 — 경계 드래그로 조절, localStorage 지속 (설계서 §4, 요청 5.8)
  const mainRef = useRef<HTMLElement>(null);
  const [mainWidth, setMainWidth] = useState<number | null>(() => {
    const v = Number(localStorage.getItem('qd3-main-w'));
    return Number.isFinite(v) && v >= 380 ? v : null;
  });
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = mainRef.current?.getBoundingClientRect().width ?? mainWidth ?? 560;
      const clamp = (w: number) => Math.min(1000, Math.max(380, w));
      const move = (ev: PointerEvent) => setMainWidth(clamp(startW + (ev.clientX - startX)));
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.userSelect = '';
        localStorage.setItem('qd3-main-w', String(Math.round(clamp(startW + (ev.clientX - startX)))));
      };
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [mainWidth],
  );

  const [evidence, setEvidence] = useState<EvidenceItem[] | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [evdStatus, setEvdStatus] = useState<string | null>(null);
  const [evdBusy, setEvdBusy] = useState(false);
  // 첨부파일+링크 개수 (근거 카드 빈 상태 문구용 — AttachmentsPanel 이 로드/변경 시 알려줌)
  const [auxCount, setAuxCount] = useState(0);
  const onAuxCounts = useCallback((files: number, links: number) => {
    setAuxCount(files + links);
  }, []);

  const [pane, setPane] = useState<PaneState>({ kind: 'none' });
  const [focusId, setFocusId] = useState<number | null>(null);
  const [paneEpoch, setPaneEpoch] = useState(0);

  const [docPickerOpen, setDocPickerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // 편집 초안 + 저장 상태
  const [draftChoice, setDraftChoice] = useState<AnswerChoice | null>(null);
  const [draftScore, setDraftScore] = useState<number | null>(null);
  const [draftAutofilled, setDraftAutofilled] = useState(false); // 예→만점 자동 채움 미확인 (Phase 2)
  const [scoreStatus, setScoreStatus] = useState<string | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [answerStatus, setAnswerStatus] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [findingsText, setFindingsText] = useState('');
  const [findingsOpen, setFindingsOpen] = useState(false); // 내용 파생 + '+추가'로만 펼침 (Phase 2)
  const [findingsStatus, setFindingsStatus] = useState<string | null>(null);
  const [findingsError, setFindingsError] = useState<string | null>(null);

  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const conflictRef = useRef<ConflictState | null>(null);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);
  // 레일을 언마운트/가리는 상태 변화(문항 이동·모달 오픈)에는 정지된 포인터에
  // mouseleave 가 안 오므로(React) 떠 있던 목차 툴팁을 확실히 내린다.
  useEffect(() => {
    setLabelTip(null);
  }, [viewQid, shortcutsOpen, docPickerOpen, conflict]);

  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const timersRef = useRef<Partial<Record<SaveField, number>>>({});
  const pendingRef = useRef<Partial<Record<SaveField, () => void>>>({});

  const editable = canEdit;

  // ── 저장 상태 표시 헬퍼 ───────────────────────────────────────────────────
  const setFieldStatus = useCallback((field: SaveField, text: string | null) => {
    if (field === 'score') setScoreStatus(text);
    else if (field === 'answer') setAnswerStatus(text);
    else setFindingsStatus(text);
  }, []);
  const setFieldError = useCallback((field: SaveField, text: string | null) => {
    if (field === 'score') setScoreError(text);
    else if (field === 'answer') setAnswerError(text);
    else setFindingsError(text);
  }, []);

  // ── 레일 동기화 (저장 성공 시 목록 행 로컬 갱신) ─────────────────────────
  const syncRail = useCallback((updated: QuestionFull) => {
    setSiblings((prev) => {
      if (!prev) return prev;
      const i = prev.list.findIndex((s) => s.id === updated.id);
      if (i < 0) return prev;
      const cur = prev.list[i];
      if (!cur) return prev;
      const nextItem: QuestionListItem = {
        ...cur,
        answerChoice: updated.answerChoice,
        score: updated.score,
        scoringMode: updated.scoringMode,
        reviewed: updated.reviewed,
        needsRecheck: updated.needsRecheck,
        findingsText: updated.findingsText,
        updatedAt: updated.updatedAt,
        updatedByName: updated.updatedByName ?? cur.updatedByName,
        hasAnswer:
          (updated.answerPlain != null && updated.answerPlain.trim() !== '') ||
          updated.answerJson != null,
      };
      const list = [...prev.list];
      list[i] = nextItem;
      return { ...prev, list };
    });
  }, []);

  // ── 직렬화 자동 저장 파이프라인 (낙관적 잠금 §5) ──────────────────────────
  const performSave = useCallback(
    (field: SaveField, fields: Omit<QuestionPatch, 'rowVersion'>) => {
      const target = serverRef.current;
      if (!target) return;
      const targetId = target.id;
      setFieldStatus(field, '저장 중…');
      setFieldError(field, null);
      chainRef.current = chainRef.current.then(async () => {
        // 해당 필드가 충돌 다이얼로그로 대기 중이면 자동 저장 억제(조용한 덮어쓰기 금지)
        const cf = conflictRef.current;
        if (
          cf &&
          ((field === 'answer' && cf.field === 'answerPlain') ||
            (field === 'findings' && cf.field === 'findingsText'))
        ) {
          setFieldStatus(field, '충돌 해결 대기 중');
          return;
        }
        const base =
          serverRef.current && serverRef.current.id === targetId ? serverRef.current : target;
        try {
          const updated = await patchQuestion(targetId, {
            rowVersion: base.rowVersion,
            ...fields,
          });
          if (serverRef.current && serverRef.current.id === targetId) {
            serverRef.current = updated;
            setQ((prev) => (prev && prev.id === targetId ? updated : prev));
            syncRail(updated);
          }
          setFieldStatus(field, `저장됨 ${nowHM()}`);
        } catch (e) {
          if (e instanceof ConflictError) {
            const server = e.server as QuestionFull;
            if (field === 'score') {
              // 채점 충돌은 서버본 채택 + 안내 (§5 — 텍스트 비교가 무의미)
              if (serverRef.current && serverRef.current.id === targetId) {
                serverRef.current = server;
                setQ((prev) => (prev && prev.id === targetId ? server : prev));
                setDraftChoice(server.answerChoice);
                setDraftScore(server.score);
                setDraftAutofilled(server.scoreAutofilled === true);
                syncRail(server);
              }
              setFieldError(
                'score',
                '다른 사용자가 먼저 저장했습니다 — 최신 값을 불러왔습니다.',
              );
              setFieldStatus('score', null);
            } else {
              const fieldKey: ConflictField =
                field === 'answer' ? 'answerPlain' : 'findingsText';
              const mine =
                fieldKey === 'answerPlain'
                  ? String(fields.answerPlain ?? '')
                  : String(fields.findingsText ?? '');
              setConflict({ field: fieldKey, mine, server });
              setFieldStatus(field, '충돌 해결 대기 중');
            }
          } else {
            setFieldError(field, apiErrorText(e));
            setFieldStatus(field, null);
          }
        }
      });
    },
    [setFieldStatus, setFieldError, syncRail],
  );

  const scheduleSave = useCallback((field: SaveField, delay: number, run: () => void) => {
    const t = timersRef.current;
    const existing = t[field];
    if (existing != null) window.clearTimeout(existing);
    pendingRef.current[field] = run;
    t[field] = window.setTimeout(() => {
      t[field] = undefined;
      pendingRef.current[field] = undefined;
      run();
    }, delay);
  }, []);

  const flushField = useCallback((field: SaveField) => {
    const t = timersRef.current;
    const existing = t[field];
    if (existing != null) {
      window.clearTimeout(existing);
      t[field] = undefined;
    }
    const run = pendingRef.current[field];
    pendingRef.current[field] = undefined;
    run?.();
  }, []);

  const flushPending = useCallback(() => {
    flushField('score');
    flushField('answer');
    flushField('findings');
  }, [flushField]);

  // 언마운트 시 미저장분 즉시 전송
  useEffect(() => () => flushPending(), [flushPending]);

  // ── 라우트 → viewQid 동기화 ───────────────────────────────────────────────
  useEffect(() => {
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) return;
    setStack([]);
    restoreRef.current = null;
    setViewQid(idNum);
  }, [id]);

  // ── 근거 자동 로드/열기 — 통합 배열 순서상 첫 '열 수 있는' 항목(근거 ①) 우선 (설계서 §3.3) ──
  const autoOpenFirst = useCallback((items: EvidenceItem[]) => {
    const it = items.find(
      (x) =>
        openableItem(x) ||
        (x.type === 'richdoc' && (x as { richDocId?: unknown }).richDocId != null),
    );
    if (it && openableItem(it)) {
      setActiveKey(evidenceItemKey(it));
      setPane({
        kind: 'anchor',
        versionId: it.versionId,
        anchorId: it.anchorId as number,
        documentId: it.documentId,
        docTitle: it.docTitle,
        versionLabel: it.versionLabel,
      });
      setFocusId(it.anchorId);
      return;
    }
    if (it) {
      // 첫 열람 가능 항목이 자유형식 문서 (Phase 2 — 칩 ① 번호와 자동 로드 일치)
      const richDocId = Number((it as Record<string, unknown>).richDocId);
      setActiveKey(evidenceItemKey(it));
      setPane({
        kind: 'rich',
        richDocId,
        title: String((it as Record<string, unknown>).title ?? '자유형식'),
      });
      setFocusId(null);
      return;
    }
    setActiveKey(null);
    setPane({ kind: 'none' });
    setFocusId(null);
  }, []);

  // ── 문항 + 근거 로드 (viewQid 변경 시) ────────────────────────────────────
  useEffect(() => {
    if (viewQid == null) return;
    let alive = true;
    flushPending(); // 직전 문항의 미저장분 먼저 전송(대상 id는 큐에 캡처됨)
    setQError(null);
    setConflict(null);
    setScoreError(null);
    setAnswerError(null);
    setFindingsError(null);
    setScoreStatus(null);
    setAnswerStatus(null);
    setFindingsStatus(null);
    setEvdStatus(null);
    setAuxCount(0); // 이전 문항의 첨부·링크 개수가 잠깐 남는 것 방지 — 로드 후 다시 통지됨

    fetchQuestion(viewQid)
      .then((d) => {
        if (!alive) return;
        serverRef.current = d;
        setQ(d);
        setDraftChoice(d.answerChoice);
        setDraftScore(d.score);
        setDraftAutofilled(d.scoreAutofilled === true);
        setAnswerText(d.answerPlain ?? '');
        setFindingsText(d.findingsText ?? '');
        setFindingsOpen(false); // 내용 존재 여부에서 파생 — 빈 문항은 '+추가' 버튼만
      })
      .catch((e) => {
        if (alive) setQError(errorMessage(e));
      });

    setEvidence(null);
    fetchQuestionEvidence(viewQid)
      .then((r) => {
        if (!alive) return;
        setEvidence(r.items);
        const restore = restoreRef.current;
        if (restore && restore.qid === viewQid) {
          restoreRef.current = null;
          setPane(restore.pane);
          setActiveKey(restore.activeKey);
          if (restore.pane.kind === 'anchor') {
            const aid = restore.pane.anchorId;
            setFocusId(null);
            window.requestAnimationFrame(() => setFocusId(aid));
          } else {
            setFocusId(null);
          }
        } else {
          autoOpenFirst(r.items); // 열람 시 근거 ① 자동 로드 + 펄스 (설계서 §3.3)
        }
      })
      .catch((e) => {
        if (alive) setEvdStatus(errorMessage(e));
      });

    return () => {
      alive = false;
    };
  }, [viewQid, autoOpenFirst, flushPending]);

  // ── 레일 로드 (분야 변경 시) ──────────────────────────────────────────────
  const catId = q?.category.id;
  useEffect(() => {
    if (catId == null) return;
    if (siblings?.catId === catId) return;
    let alive = true;
    fetchCategoryQuestions(catId)
      .then((r) => {
        if (alive) setSiblings({ catId, list: r.questions });
      })
      .catch(() => {
        /* 레일만 비표시 — 치명적 아님 */
      });
    return () => {
      alive = false;
    };
  }, [catId, siblings?.catId]);

  // 레일 활성 항목 가시화
  useEffect(() => {
    if (viewQid == null) return;
    const el = document.getElementById(`rail-q-${viewQid}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [viewQid, siblings]);

  const railIndex = useMemo(() => {
    if (!siblings || viewQid == null) return -1;
    return siblings.list.findIndex((s) => s.id === viewQid);
  }, [siblings, viewQid]);

  const moveRail = useCallback(
    (delta: number) => {
      if (!siblings || railIndex < 0) return;
      const next = siblings.list[railIndex + delta];
      if (!next) return;
      navigate(`/q/${next.id}`);
    },
    [siblings, railIndex, navigate],
  );

  // ── 근거 상호작용 ─────────────────────────────────────────────────────────
  const activeIndex = useMemo(() => {
    if (!evidence || activeKey == null) return null;
    const i = evidence.findIndex((it) => evidenceItemKey(it) === activeKey);
    return i >= 0 ? i : null;
  }, [evidence, activeKey]);

  // 근거 칩 순번 (anchorId → 전체 근거 배열 인덱스) — PDF 배지에 ①②③ 병기 (Phase 2).
  // richdoc 항목도 칩 번호를 차지하므로 반드시 전체 인덱스를 쓴다(카드 칩과 번호 일치).
  const anchorOrdinals = useMemo(() => {
    const m = new Map<number, number>();
    evidence?.forEach((it, i) => {
      if (isPassageItem(it) && it.anchorId != null) m.set(it.anchorId, i);
    });
    return m;
  }, [evidence]);

  const reloadEvidence = useCallback(async (): Promise<EvidenceItem[] | null> => {
    if (viewQid == null) return null;
    try {
      const r = await fetchQuestionEvidence(viewQid);
      setEvidence(r.items);
      return r.items;
    } catch (e) {
      setEvdStatus(errorMessage(e));
      return null;
    }
  }, [viewQid]);

  const openChip = useCallback(
    (i: number) => {
      const it = evidence?.[i];
      if (!it) return;
      // 자유형식 문서 칩 → 읽기전용 페인 (Phase 2)
      if (it.type === 'richdoc') {
        const richDocId = Number((it as Record<string, unknown>).richDocId);
        if (!Number.isFinite(richDocId)) return;
        setActiveKey(evidenceItemKey(it));
        setFocusId(null);
        setPane({
          kind: 'rich',
          richDocId,
          title: String((it as Record<string, unknown>).title ?? '자유형식'),
        });
        return;
      }
      if (!openableItem(it)) return;
      const aid = it.anchorId as number;
      setActiveKey(evidenceItemKey(it));
      const sameViewer =
        pane.kind !== 'none' && pane.kind !== 'rich' && pane.versionId === it.versionId;
      setPane({
        kind: 'anchor',
        versionId: it.versionId,
        anchorId: aid,
        documentId: it.documentId,
        docTitle: it.docTitle,
        versionLabel: it.versionLabel,
      });
      if (sameViewer) {
        // 같은 뷰어 안 재클릭에도 다시 펄스 — null → id 2단계 갱신
        setFocusId(null);
        window.requestAnimationFrame(() => setFocusId(aid));
      } else {
        setFocusId(aid);
      }
    },
    [evidence, pane],
  );

  const reorderEvidence = useCallback(
    (from: number, to: number) => {
      if (!evidence || viewQid == null) return;
      const items = [...evidence];
      const moved = items.splice(from, 1)[0];
      if (!moved) return;
      items.splice(to, 0, moved);
      setEvidence(items); // 낙관적 갱신
      setEvdStatus('순서 저장 중…');
      const payload = items.map((it, idx) =>
        it.type === 'passage'
          ? { type: 'passage' as const, passageId: it.passageId, sort: idx + 1 }
          : {
              type: 'richdoc' as const,
              richDocId: Number((it as Record<string, unknown>).richDocId),
              sort: idx + 1,
            },
      );
      patchQuestionEvidenceItems(viewQid, payload)
        .then((res) => {
          setEvidence(res.items);
          setEvdStatus(`순서 저장됨 ${nowHM()}`);
        })
        .catch((e) => {
          setEvdStatus(`순서 저장 실패: ${apiErrorText(e)}`);
          void reloadEvidence();
        });
    },
    [evidence, viewQid, reloadEvidence],
  );

  const saveNote = useCallback(
    (i: number, note: string) => {
      const it = evidence?.[i];
      if (!it || viewQid == null) return;
      const trimmed = note.trim() === '' ? null : note;
      const item = isPassageItem(it)
        ? { type: 'passage' as const, passageId: it.passageId, sort: it.sort, note: trimmed }
        : {
            type: 'richdoc' as const,
            richDocId: Number((it as Record<string, unknown>).richDocId),
            sort: it.sort,
            note: trimmed,
          };
      setEvdStatus('메모 저장 중…');
      patchQuestionEvidenceItems(viewQid, [item])
        .then((res) => {
          setEvidence(res.items);
          setEvdStatus(`메모 저장됨 ${nowHM()}`);
        })
        .catch((e) => setEvdStatus(`메모 저장 실패: ${apiErrorText(e)}`));
    },
    [evidence, viewQid],
  );

  const unlinkEvidence = useCallback(
    async (i: number) => {
      const it = evidence?.[i];
      if (!it || viewQid == null || !q) return;

      // 자유형식 근거 해제 — 문서 자체는 삭제하지 않고 링크만 끊는다
      if (!isPassageItem(it)) {
        const richDocId = Number((it as Record<string, unknown>).richDocId);
        const rTitle = String((it as { title?: unknown }).title ?? '자유형식');
        if (
          !window.confirm(
            `「${q.questionNo}」에서 자유형식 문서 「${rTitle}」 연결을 해제할까요?\n(문서 자체는 삭제되지 않습니다.)`,
          )
        ) {
          return;
        }
        setEvdBusy(true);
        try {
          await unlinkRichDoc(richDocId, viewQid);
          setEvdStatus('연결을 해제했습니다.');
          const items = await reloadEvidence();
          if (
            items &&
            (activeKey == null || !items.some((x) => evidenceItemKey(x) === activeKey))
          ) {
            autoOpenFirst(items);
          }
        } catch (e) {
          setEvdStatus(`연결 해제 실패: ${apiErrorText(e)}`);
        } finally {
          setEvdBusy(false);
        }
        return;
      }

      if (
        !window.confirm(
          `「${q.questionNo}」에서 이 근거 연결을 해제할까요?\n“${(it.quote ?? '').slice(0, 60)}…”`,
        )
      ) {
        return;
      }
      setEvdBusy(true);
      try {
        try {
          await removePassageLink(it.passageId, viewQid);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && e.body?.error === 'last_link') {
            const ok = window.confirm(
              '이 발췌의 마지막 연결입니다. 해제하면 발췌(하이라이트)도 함께 삭제됩니다. 계속할까요?',
            );
            if (!ok) return;
            await removePassageLink(it.passageId, viewQid, true);
          } else {
            throw e;
          }
        }
        setEvdStatus('연결을 해제했습니다.');
        const items = await reloadEvidence();
        // 뷰어 오버레이 갱신(앵커 변동) — 페인 재마운트
        setPaneEpoch((n) => n + 1);
        if (items && (activeKey == null || !items.some((x) => evidenceItemKey(x) === activeKey))) {
          autoOpenFirst(items);
        }
      } catch (e) {
        setEvdStatus(`연결 해제 실패: ${apiErrorText(e)}`);
      } finally {
        setEvdBusy(false);
      }
    },
    [evidence, viewQid, q, activeKey, reloadEvidence, autoOpenFirst],
  );

  // ── 자유형식 근거 (설계서 §4 #8) ──────────────────────────────────────────
  const openRichDoc = useCallback(
    (richDocId: number) => {
      if (Number.isInteger(richDocId)) navigate(`/rich/${richDocId}`);
    },
    [navigate],
  );

  const addRichDoc = useCallback(async () => {
    if (!editable || viewQid == null) return;
    setEvdStatus('자유형식 문서 만드는 중…');
    try {
      const doc = await createRichDoc({
        title: '제목없음',
        contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
        contentPlain: '',
        questionId: viewQid,
      });
      navigate(`/rich/${doc.id}`);
    } catch (e) {
      setEvdStatus(`자유형식 문서 생성 실패: ${apiErrorText(e)}`);
    }
  }, [editable, viewQid, navigate]);

  // [파일 첨부]·[링크 추가] — 근거 카드에 임베드된 첨부 패널의 입력을 연다 (Phase 2)
  const attachRef = useRef<AttachmentsPanelHandle>(null);
  const onAddFile = useCallback(() => {
    attachRef.current?.openPicker();
  }, []);
  const onAddLink = useCallback(() => {
    attachRef.current?.openLinkForm();
  }, []);

  // ── 매핑 모드 (H) ─────────────────────────────────────────────────────────
  const startMapping = useCallback(() => {
    if (!editable) return;
    setDocPickerOpen(true);
  }, [editable]);

  const onPickDoc = useCallback((doc: DocSummary, page?: number) => {
    setDocPickerOpen(false);
    const vid = doc.currentVersion?.id;
    if (vid == null) return;
    setActiveKey(null);
    setFocusId(null);
    // 본문 히트로 진입 시: 같은 판본이 이미 열려 있어도 그 페이지로 이동하도록 페인 재마운트
    if (page != null) setPaneEpoch((n) => n + 1);
    setPane({ kind: 'map', versionId: vid, documentId: doc.id, docTitle: doc.title, page });
  }, []);

  const exitMapMode = useCallback(() => {
    if (pane.kind !== 'map') return;
    // 같은 문서를 열람 모드로 유지 — 방금 만든 하이라이트가 그대로 보인다
    setPane({
      kind: 'doc',
      versionId: pane.versionId,
      documentId: pane.documentId,
      docTitle: pane.docTitle,
    });
  }, [pane]);

  // ── 배지 [열기] — B 상태 교체 + Backspace 스택 ────────────────────────────
  const openQuestionInline = useCallback(
    (qid: number) => {
      if (viewQid == null || qid === viewQid) return;
      setStack((prev) => [...prev, { qid: viewQid, pane, activeKey }]);
      setViewQid(qid);
    },
    [viewQid, pane, activeKey],
  );

  const popStack = useCallback(() => {
    setStack((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      restoreRef.current = last;
      setViewQid(last.qid);
      return prev.slice(0, -1);
    });
  }, []);

  // ── 통합 채점 (Phase 3a) ──────────────────────────────────────────────────
  // ScoringPanel 의 변경은 question.rowVersion 을 올린다 — 서버본만 재동기화하고
  // 편집 중인 텍스트 초안(answerText/findingsText)은 건드리지 않는다(자동저장 409 방지).
  const refreshQuestionMeta = useCallback(
    (rowVersion?: number) => {
      if (viewQid == null) return;
      // 채점 응답의 최신 rowVersion 을 즉시(동기) 반영 — 대기 중 자동저장이 스테일 버전으로
      // 나가 자기 변경에 409 를 맞는 창을 최소화한다 (검토 반영)
      if (rowVersion != null && serverRef.current && serverRef.current.id === viewQid) {
        serverRef.current = { ...serverRef.current, rowVersion };
      }
      fetchQuestion(viewQid)
        .then((d) => {
          if (serverRef.current && serverRef.current.id === d.id) {
            serverRef.current = d;
            setQ(d);
            setDraftChoice(d.answerChoice);
            setDraftScore(d.score);
            setDraftAutofilled(d.scoreAutofilled === true);
            syncRail(d);
          }
        })
        .catch(() => {
          setScoreError('변경 사항을 다시 불러오지 못했습니다 — 새로고침 해주세요.');
        });
    },
    [viewQid, syncRail],
  );

  const onModeChange = useCallback(
    (mode: ScoringMode) => {
      if (viewQid == null || !serverRef.current) return;
      if (mode === (serverRef.current.scoringMode ?? 'simple')) return;
      if (
        !window.confirm(
          '채점 방식을 전환하면 현재 선택/점수가 초기화됩니다(이전 값은 변경 이력에 보존). 계속할까요?',
        )
      )
        return;
      patchScoringMode(viewQid, mode)
        .then(() => refreshQuestionMeta())
        .catch((e) => setScoreError(apiErrorText(e)));
    },
    [viewQid, refreshQuestionMeta],
  );

  // ── 편집 핸들러 ───────────────────────────────────────────────────────────
  const onScoreChange = useCallback(
    (choice: AnswerChoice | null, score: number | null, autofilled: boolean) => {
      if (!editable) return;
      setDraftChoice(choice);
      setDraftScore(score);
      setDraftAutofilled(autofilled);
      setScoreError(null);
      setScoreStatus('저장 대기…');
      scheduleSave('score', 600, () =>
        performSave('score', { answerChoice: choice, score, scoreAutofilled: autofilled }),
      );
    },
    [editable, scheduleSave, performSave],
  );

  const onFindingsChange = useCallback(
    (v: string) => {
      setFindingsText(v);
      // 편집 중 전체 삭제로 값이 ''가 돼도 textarea가 언마운트되지 않게 열림 고정 —
      // 접힘은 onBlur('비운 채 이탈')에서만 (검토 반영)
      if (v === '') setFindingsOpen(true);
      if (!editable) return;
      setFindingsError(null);
      setFindingsStatus('저장 대기…');
      scheduleSave('findings', 1500, () =>
        performSave('findings', { findingsText: v === '' ? null : v }),
      );
    },
    [editable, scheduleSave, performSave],
  );

  // ── 충돌 다이얼로그 액션 (§5) ─────────────────────────────────────────────
  const conflictLoadServer = useCallback(() => {
    const c = conflict;
    if (!c) return;
    const s = c.server;
    serverRef.current = s;
    setQ(s);
    setDraftChoice(s.answerChoice);
    setDraftScore(s.score);
    setDraftAutofilled(s.scoreAutofilled === true);
    syncRail(s);
    if (c.field === 'answerPlain') {
      setAnswerText(s.answerPlain ?? '');
      setAnswerStatus('최신 내용을 불러왔습니다');
    } else {
      setFindingsText(s.findingsText ?? '');
      setFindingsStatus('최신 내용을 불러왔습니다');
    }
    setConflict(null);
  }, [conflict, syncRail]);

  const conflictOverwrite = useCallback(() => {
    const c = conflict;
    if (!c) return;
    setConflictBusy(true);
    const fields: Omit<QuestionPatch, 'rowVersion'> =
      c.field === 'answerPlain'
        ? { answerPlain: c.mine === '' ? null : c.mine }
        : { findingsText: c.mine === '' ? null : c.mine };
    patchQuestion(c.server.id, { rowVersion: c.server.rowVersion, ...fields })
      .then((updated) => {
        serverRef.current = updated;
        setQ(updated);
        syncRail(updated);
        setConflict(null);
        const status = `내 내용으로 저장됨 ${nowHM()}`;
        if (c.field === 'answerPlain') setAnswerStatus(status);
        else setFindingsStatus(status);
      })
      .catch((e) => {
        if (e instanceof ConflictError) {
          // 그 사이 또 저장됨 — 서버본 갱신해 다시 비교
          setConflict({ ...c, server: e.server as QuestionFull });
        } else {
          setConflict(null);
          if (c.field === 'answerPlain') setAnswerError(apiErrorText(e));
          else setFindingsError(apiErrorText(e));
        }
      })
      .finally(() => setConflictBusy(false));
  }, [conflict, syncRail]);

  const conflictClose = useCallback(() => {
    const c = conflict;
    setConflict(null);
    if (!c) return;
    const msg = '저장 안 됨 — 충돌 미해결 (내용을 수정하면 다시 저장을 시도합니다)';
    if (c.field === 'answerPlain') setAnswerStatus(msg);
    else setFindingsStatus(msg);
  }, [conflict]);

  // ── 단축키 (설계서 §4 전도) ───────────────────────────────────────────────
  const chipKeyHandlers = useMemo(() => {
    const out: Record<string, (e: KeyboardEvent) => void> = {};
    for (let n = 1; n <= 9; n++) {
      out[String(n)] = (e) => {
        e.preventDefault();
        openChip(n - 1);
      };
    }
    return out;
  }, [openChip]);

  useShortcuts({
    j: (e) => {
      e.preventDefault();
      moveRail(1);
    },
    k: (e) => {
      e.preventDefault();
      moveRail(-1);
    },
    h: (e) => {
      if (!editable) return;
      e.preventDefault();
      startMapping();
    },
    '?': (e) => {
      e.preventDefault();
      setShortcutsOpen((v) => !v);
    },
    Backspace: (e) => {
      if (stack.length === 0) return;
      e.preventDefault();
      popStack();
    },
    Escape: (e) => {
      // 뷰어 페인이 캡처 단계에서 소비한 Esc 는 여기 오지 않는다
      if (shortcutsOpen) {
        e.preventDefault();
        setShortcutsOpen(false);
      } else if (docPickerOpen) {
        e.preventDefault();
        setDocPickerOpen(false);
      } else if (conflict) {
        e.preventDefault();
        conflictClose();
      } else if (pane.kind === 'map') {
        e.preventDefault();
        exitMapMode();
      }
    },
    ...chipKeyHandlers,
  });

  // ── 렌더 ──────────────────────────────────────────────────────────────────
  if (qError) {
    return (
      <div className="page">
        <div className="error-card">
          <p>{qError}</p>
          <Link to="/" className="btn">
            연도별 인증심사로
          </Link>
        </div>
      </div>
    );
  }
  if (!q) return <div className="page-status">불러오는 중…</div>;

  const mapTarget = { id: q.id, questionNo: q.questionNo };
  const scoringMode: ScoringMode = q.scoringMode ?? 'simple';
  const paneKey =
    pane.kind === 'none'
      ? 'none'
      : pane.kind === 'rich'
        ? `rich:${pane.richDocId}:${paneEpoch}`
        : `${pane.versionId}:${paneEpoch}`;

  return (
    <div className="qd3-page">
      <div className="qd3-body">
        {/* ── A: 문항 레일 ── */}
        {railOpen && (
          <>
          <aside
            className="qd3-rail"
            ref={railRef}
            style={railWidth ? { width: `${railWidth}px` } : undefined}
          >
            <div className="qd3-rail-head">
              <Link to={`/c/${q.category.id}`} className="qd3-rail-cat" title="문항 목록으로">
                {categoryLabel(q.category)}
              </Link>
              <button
                type="button"
                className="btn btn-ghost qd3-btn-sm"
                onClick={() => setRailOpen(false)}
                title="레일 접기"
                aria-label="레일 접기"
              >
                ⟨
              </button>
            </div>
            {!siblings || siblings.catId !== q.category.id ? (
              <div className="qd3-rail-msg dim">목록 불러오는 중…</div>
            ) : (
              <ul className="qd3-rail-list" onScroll={hideLabelTip}>
                {siblings.list.map((s, si) => {
                  const st = railStatus(s);
                  // 챕터 구분 헤더 (Phase 3b) — 렌더 전용 삽입: j/k 인덱스는 list 기준 유지
                  const label = chapterLabel(s);
                  const prevLabel = si > 0 ? chapterLabel(siblings.list[si - 1]!) : null;
                  const header =
                    label !== prevLabel ? (
                      <li
                        key={`h:${s.id}`}
                        className="qd3-rail-chapter"
                        onMouseEnter={(e) => showLabelTip(e, label)}
                        onMouseLeave={hideLabelTip}
                      >
                        {label}
                      </li>
                    ) : null;
                  return (
                    <React.Fragment key={s.id}>
                      {header}
                      <li>
                      <button
                        type="button"
                        id={`rail-q-${s.id}`}
                        className={'qd3-rail-item' + (s.id === viewQid ? ' is-active' : '')}
                        onClick={() => navigate(`/q/${s.id}`)}
                        title={s.body}
                      >
                        <StatusGlyph kind={st} />
                        <span className="qd3-rail-no">{s.questionNo}</span>
                        {truthy(s.reviewed) && <span className="status-check">✓</span>}
                        {(s.revisionStatus === 'new' || s.revisionStatus === 'modified') && (
                          <span
                            className={
                              'qd3-rail-rev ' +
                              (s.revisionStatus === 'new' ? 'badge-new' : 'badge-mod')
                            }
                            title={
                              s.revisionStatus === 'new'
                                ? '올해 새로 생긴 문항입니다.'
                                : '전년도 대비 내용이 변경된 문항입니다.'
                            }
                          >
                            {s.revisionStatus === 'new' ? '신' : '변'}
                          </span>
                        )}
                      </button>
                      </li>
                    </React.Fragment>
                  );
                })}
              </ul>
            )}
            <div className="qd3-rail-foot dim">j/k 로 이동</div>
          </aside>
          {/* A↔B 폭 조절 리사이저 — 드래그로 조절, 더블클릭 시 기본 폭 복원 (요청) */}
          <div
            className="qd3-resizer qd3-resizer-rail"
            onPointerDown={onRailResizeStart}
            onDoubleClick={resetRailWidth}
            role="separator"
            aria-orientation="vertical"
            aria-label="문항 목차 폭 조절 (더블클릭: 기본 폭)"
            title="드래그해서 목차 폭 조절 · 더블클릭하면 기본 폭으로"
          />
          </>
        )}
        {!railOpen && (
          <button
            type="button"
            className="qd3-rail-collapsed"
            onClick={() => setRailOpen(true)}
            title="문항 레일 펼치기"
            aria-label="문항 레일 펼치기"
          >
            ⟩
          </button>
        )}

        {/* ── B: 문항/점수/근거자료/지적 ── */}
        <section
          className="qd3-main"
          ref={mainRef}
          style={mainWidth ? { flex: `0 0 ${mainWidth}px` } : undefined}
        >
          <div className="qd3-main-scroll">
            <div className="qd3-head">
              <div className="q-crumb">
                {q.cycle?.year != null ? (
                  <Link to={`/y/${q.cycle.year}`} className="crumb">
                    {q.cycle.name}
                  </Link>
                ) : (
                  <Link to="/" className="crumb">
                    연도별 인증심사
                  </Link>
                )}
                <span className="crumb-sep">›</span>
                <Link to={`/c/${q.category.id}`} className="crumb">
                  {categoryLabel(q.category)}
                </Link>
              </div>
              <div className="qd3-title-row">
                <h1 className="q-title">{q.questionNo}</h1>
                {stack.length > 0 && (
                  <button
                    type="button"
                    className="btn qd3-btn-sm"
                    onClick={popStack}
                    title="이전 문항으로 복귀 (Backspace)"
                  >
                    ← 복귀 (⌫)
                  </button>
                )}
                <span className="qd3-pager">
                  <button
                    type="button"
                    className="btn qd3-btn-sm"
                    disabled={railIndex <= 0}
                    onClick={() => moveRail(-1)}
                    title="이전 문항 (k)"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn qd3-btn-sm"
                    disabled={
                      !siblings || railIndex < 0 || railIndex >= siblings.list.length - 1
                    }
                    onClick={() => moveRail(1)}
                    title="다음 문항 (j)"
                  >
                    ↓
                  </button>
                  {railIndex >= 0 && siblings && (
                    <span className="q-pager-pos">
                      {railIndex + 1}/{siblings.list.length}
                    </span>
                  )}
                </span>
              </div>
              <div className="q-meta">
                <TypeBadge type={q.questionType} symbol={q.gradeSymbol} />
                <span className="meta-chip">
                  배점 {q.maxScore != null ? `${fmtNum(q.maxScore)}점` : '—'}
                </span>
                {truthy(q.allowNa) && <span className="meta-chip">해당없음 선택 가능</span>}
                {q.autoCandidate === true && (
                  <span
                    className="badge badge-autoscore"
                    title="자동배점 문항 — 기관이 직접 채점하지 않고, 제출 자료나 기관 지표에 따라 점수가 자동으로 정해지는 문항입니다."
                  >
                    자동배점
                  </span>
                )}
                {q.revisionStatus === 'new' && (
                  <span
                    className="badge badge-new"
                    title={revisionNoteLabel(q.revisionNote) ?? '올해 새로 생긴 문항입니다.'}
                  >
                    신규
                  </span>
                )}
                {q.revisionStatus === 'modified' && (
                  <span
                    className="badge badge-mod"
                    title={revisionNoteLabel(q.revisionNote) ?? '전년도 대비 내용이 변경된 문항입니다.'}
                  >
                    변경
                  </span>
                )}
                {truthy(q.needsRecheck) && (
                  <span
                    className="badge badge-recheck"
                    title="문항 개정·배점 변경 등으로 채점을 다시 확인해야 하는 문항입니다. 확인 후 '확인 필요' 메뉴에서 완료 처리하세요."
                  >
                    재확인
                  </span>
                )}
                {canEdit ? (
                  <button
                    type="button"
                    className={
                      'meta-chip meta-chip-link' + (truthy(q.reviewed) ? ' meta-ok' : '')
                    }
                    onClick={() => performSave('score', { reviewed: !truthy(q.reviewed) })}
                    title={
                      truthy(q.reviewed)
                        ? '검토완료 표시를 해제합니다.'
                        : '이 문항의 확인을 마쳤다는 표시를 남깁니다 — 목록에 ✓로 보이고, 검토완료 필터로 모아 볼 수 있습니다.'
                    }
                  >
                    {truthy(q.reviewed) ? '✓ 검토완료' : '검토완료 표시'}
                  </button>
                ) : (
                  truthy(q.reviewed) && (
                    <span
                      className="meta-chip meta-ok"
                      title="담당자가 검토완료 표시를 한 문항입니다."
                    >
                      ✓ 검토완료
                    </span>
                  )
                )}
                {q.carriedFromId != null && (
                  <button
                    type="button"
                    className="meta-chip meta-chip-link"
                    onClick={() => navigate(`/q/${q.carriedFromId}`)}
                    title="이 문항은 지난 연도에서 답변·근거 연결을 물려받았습니다. 지난 연도 문항을 열어 나란히 비교할 수 있습니다."
                  >
                    ← {q.carriedFromYear != null ? `${q.carriedFromYear}년 문항 보기` : '전년도 문항 보기'}
                  </button>
                )}
                {q.carriedToId != null && (
                  <button
                    type="button"
                    className="meta-chip meta-chip-link"
                    onClick={() => navigate(`/q/${q.carriedToId}`)}
                    title="이 문항을 물려받은 새 연도의 문항을 엽니다."
                  >
                    {q.carriedToYear != null ? `${q.carriedToYear}년 문항 보기` : '새 연도 문항 보기'} →
                  </button>
                )}
              </div>
            </div>

            <section className="card qd3-card">
              <h2 className="card-title">문항</h2>
              <QuestionBody text={q.body} />
            </section>

            <section className="card qd3-card">
              <div className="qd3-card-head">
                <h2 className="card-title">점수</h2>
                {editable && (
                  <select
                    className="scoring-mode-select"
                    value={scoringMode}
                    onChange={(e) => onModeChange(e.target.value as ScoringMode)}
                    aria-label="채점 방식"
                    title="채점 방식 — 전환 시 선택/점수가 초기화됩니다 (이전 값은 변경 이력에 보존)"
                  >
                    <option value="simple">단순 (예/아니오)</option>
                    <option value="composite">합산 (세부항목)</option>
                    <option value="auto">자동 (기관 지표)</option>
                  </select>
                )}
              </div>
              {scoringMode !== 'simple' ? (
                <ScoringPanel
                  key={`${q.id}:${scoringMode}`}
                  questionId={q.id}
                  canEdit={canEdit}
                  onQuestionChanged={refreshQuestionMeta}
                />
              ) : editable ? (
                <ScoreWidget
                  maxScore={q.maxScore}
                  allowNa={truthy(q.allowNa)}
                  choice={draftChoice}
                  score={draftScore}
                  autofilled={draftAutofilled}
                  statusText={scoreStatus}
                  errorText={scoreError}
                  onChange={onScoreChange}
                />
              ) : (
                <div className="qd3-grade-ro">
                  선택: <strong>{choiceLabel(draftChoice)}</strong>
                  {draftChoice === 'yes' && (
                    <>
                      {' '}
                      · 점수:{' '}
                      <strong>
                        {fmtNum(draftScore)} / {fmtNum(q.maxScore)}
                      </strong>
                    </>
                  )}
                  {draftChoice === 'no' && (
                    <>
                      {' '}
                      · 점수: <strong>0 / {fmtNum(q.maxScore)}</strong>
                    </>
                  )}
                  {draftChoice === 'na' && <> · 집계 분모 제외</>}
                </div>
              )}
            </section>

            <section className="card qd3-card">
              {evidence === null ? (
                <>
                  <h2 className="card-title">근거 자료</h2>
                  <p className="dim">근거 자료 불러오는 중…</p>
                </>
              ) : (
                <>
                  <EvidenceCards
                    items={evidence}
                    activeIndex={activeIndex}
                    canEdit={canEdit}
                    busy={evdBusy}
                    statusText={evdStatus}
                    onOpen={openChip}
                    onReorder={reorderEvidence}
                    onNoteSave={saveNote}
                    onUnlink={(i) => void unlinkEvidence(i)}
                    onStartMapping={startMapping}
                    onOpenRichDoc={openRichDoc}
                    onAddRichDoc={addRichDoc}
                    onAddFile={onAddFile}
                    onAddLink={onAddLink}
                    auxCount={auxCount}
                  />
                  {/* 첨부·링크 — 근거 자료 카드에 통합 표시 (⑥) */}
                  <AttachmentsPanel
                    ref={attachRef}
                    questionId={q.id}
                    canEdit={canEdit}
                    embedded
                    onCountsChange={onAuxCounts}
                  />
                  {/* 근거 추천 (C-1) */}
                  {viewQid != null && <EvidenceSuggest questionId={viewQid} />}
                </>
              )}
            </section>

            {/* 지적/권장사항 — 표시는 내용 존재 여부에서 파생 (검토 반영: 별도 체크박스·불리언 금지).
                내용이 있으면 무조건 펼침, 없으면 '+추가' 버튼만 — 기존 지적이 있는 행이 숨는 사고 방지.
                비편집(viewer)에서는 내용이 있을 때만 섹션 렌더 */}
            {(findingsText !== '' || editable) && (
              <section className="card qd3-card">
                <div className="qd3-card-head">
                  <h2 className="card-title">지적/권장사항</h2>
                  {editable && (findingsText !== '' || findingsOpen) && (
                    <span className={'save-status' + (findingsError ? ' is-error' : '')}>
                      {findingsError ?? findingsStatus ?? '자동 저장'}
                    </span>
                  )}
                </div>
                {editable && (findingsText !== '' || findingsOpen) ? (
                  <textarea
                    className="qd3-textarea"
                    rows={4}
                    value={findingsText}
                    autoFocus={findingsOpen && findingsText === ''}
                    placeholder="심사 지적/권장사항 메모 — 입력을 멈추면 자동 저장됩니다."
                    onChange={(e) => onFindingsChange(e.target.value)}
                    onBlur={() => {
                      flushField('findings');
                      if (findingsText === '') setFindingsOpen(false); // 비운 채 이탈 → 접힘
                    }}
                  />
                ) : editable ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setFindingsOpen(true)}
                  >
                    + 지적/권장사항 추가
                  </button>
                ) : findingsText ? (
                  <div className="prose">{findingsText}</div>
                ) : (
                  <p className="dim">기록된 지적/권장사항이 없습니다.</p>
                )}
              </section>
            )}

            <div className="qd3-foot dim">
              최종 수정 {fmtDate(q.updatedAt)}
              {q.updatedByName ? ` · ${q.updatedByName}` : ''} · 단축키 안내: ?
            </div>
          </div>
        </section>

        {/* B↔C 폭 조절 리사이저 — 더블클릭 시 기본 폭 복원 */}
        <div
          className="qd3-resizer"
          onPointerDown={onResizeStart}
          onDoubleClick={() => {
            setMainWidth(null);
            localStorage.removeItem('qd3-main-w');
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="문항/근거 자료 폭 조절 (더블클릭: 기본 폭)"
          title="드래그해서 폭 조절 · 더블클릭하면 기본 폭으로"
        />

        {/* ── C: 교체형 뷰어 ── */}
        <section className="qd3-pane">
          {pane.kind === 'none' ? (
            <div className="qd3-pane-empty">
              <p>연결된 근거 자료를 선택하면 여기에 열립니다.</p>
              {editable && (
                <button type="button" className="btn" onClick={startMapping}>
                  + 지침서 연결 (H)
                </button>
              )}
            </div>
          ) : pane.kind === 'rich' ? (
            <>
              <div className="qd3-pane-head">
                <span className="qd3-pane-title">📝 {pane.title}</span>
                <Link
                  className="qd3-pane-link"
                  to={`/rich/${pane.richDocId}`}
                  title={canEdit ? '편집기에서 열기' : '전체 화면으로 열기'}
                >
                  {canEdit ? '편집기로 열기 ↗' : '전체 화면 ↗'}
                </Link>
              </div>
              <div className="qd3-pane-viewer">
                <RichDocPane key={paneKey} richDocId={pane.richDocId} />
              </div>
            </>
          ) : (
            <>
              <div className={'qd3-pane-head' + (pane.kind === 'map' ? ' is-map' : '')}>
                {pane.kind === 'map' ? (
                  <>
                    <span className="qd3-pane-title">
                      매핑 중: {pane.docTitle} → 「{q.questionNo}」
                    </span>
                    <button type="button" className="btn qd3-btn-sm" onClick={exitMapMode}>
                      매핑 종료 (Esc)
                    </button>
                  </>
                ) : (
                  <>
                    <span className="qd3-pane-title">
                      {pane.docTitle}
                      {pane.kind === 'anchor' && pane.versionLabel
                        ? ` · ${pane.versionLabel}`
                        : ''}
                    </span>
                    {/* 원본 보기 — 지침서 PDF 실제 파일을 새 탭 브라우저 내장 뷰어로 */}
                    <a
                      className="qd3-pane-link"
                      href={versionFileUrl(pane.versionId)}
                      target="_blank"
                      rel="noreferrer"
                      title="지침서 원본 PDF 파일을 새 탭에서 엽니다 (인쇄·저장 가능)"
                    >
                      원본 보기 ↗
                    </a>
                  </>
                )}
              </div>
              <div className="qd3-pane-viewer">
                <PdfViewerPane
                  key={paneKey}
                  versionId={pane.versionId}
                  mode={pane.kind === 'map' ? 'map' : 'view'}
                  mapTargetQuestion={pane.kind === 'map' ? mapTarget : undefined}
                  focusAnchorId={pane.kind === 'anchor' ? focusId : null}
                  onLinked={() => void reloadEvidence()}
                  onBadgeOpenQuestion={openQuestionInline}
                  chipOrdinals={anchorOrdinals}
                  initialPage={pane.kind === 'map' ? pane.page : undefined}
                />
              </div>
            </>
          )}
        </section>
      </div>

      {docPickerOpen && (
        <DocPicker onPick={onPickDoc} onClose={() => setDocPickerOpen(false)} />
      )}
      {shortcutsOpen && <ShortcutOverlay onClose={() => setShortcutsOpen(false)} />}
      {conflict && (
        <ConflictDialog
          info={
            {
              fieldLabel: conflict.field === 'answerPlain' ? '답변' : '지적/권장사항',
              mine: conflict.mine,
              server:
                (conflict.field === 'answerPlain'
                  ? conflict.server.answerPlain
                  : conflict.server.findingsText) ?? '',
              serverMeta: `${conflict.server.updatedByName ?? '다른 사용자'} · ${fmtDate(
                conflict.server.updatedAt,
              )}`,
            } satisfies ConflictInfo
          }
          busy={conflictBusy}
          onLoadServer={conflictLoadServer}
          onOverwrite={conflictOverwrite}
          onClose={conflictClose}
        />
      )}
      {/* 잘린 목차 라벨 호버 툴팁 — body 포털(오버플로 클리핑 회피) */}
      {labelTip &&
        createPortal(
          <div
            className="qd3-tip"
            style={{
              left: labelTip.left,
              ...(labelTip.bottom != null
                ? { bottom: labelTip.bottom }
                : { top: labelTip.top }),
            }}
          >
            {labelTip.text}
          </div>,
          document.body,
        )}
    </div>
  );
}
