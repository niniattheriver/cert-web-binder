/**
 * 옴니박스 (설계서 §4 마지막 행 — Day 2 그룹 확장)
 * - Ctrl+K 또는 / 로 열림(단축키 바인딩은 AppShell 담당), 300ms 디바운스로 GET /api/search.
 * - 번호 패스트패스: fastpath 가 있으면 첫 항목 "바로 이동" 강조 — Enter 즉시 이동.
 * - 결과 그룹: 문항 / 발췌(passages) / 지침서 본문(pages) / 문서(docs) — 그룹 헤더와 함께 렌더.
 *   발췌 클릭 → /docs/:id?hl=앵커 (검색 응답에 좌표가 없어 클릭 시 해석 — api-day2-extra),
 *   지침서 본문 클릭 → /docs/:id?v=판본&page=쪽 (DocViewer 딥링크), 문서 클릭 → /docs/:id.
 * - ↑↓ 탐색, Enter 이동, Esc 닫기.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchAll, type SearchResponse } from '../api';
import { resolvePassageTarget } from '../api-day2-extra';
import { errorMessage } from '../util';

type OmniItem =
  | {
      kind: 'question';
      key: string;
      questionId: number;
      questionNo: string;
      categoryCode?: string;
      snippet?: string;
      fastpath: boolean;
    }
  | {
      kind: 'passage';
      key: string;
      passageId: number;
      quote: string;
      docTitle: string;
      questionNos: string[];
    }
  | {
      kind: 'page';
      key: string;
      documentId: number;
      versionId: number;
      docTitle: string;
      pageNo: number;
      year: number | null;
      snippet: string;
    }
  | { kind: 'doc'; key: string; docId: number; title: string };

interface Props {
  open: boolean;
  onClose: () => void;
}

const GROUP_LABEL: Record<OmniItem['kind'], string> = {
  question: '문항',
  passage: '발췌',
  page: '지침서 본문',
  doc: '문서',
};

export default function Omnibox({ open, onClose }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [resolving, setResolving] = useState(false);
  const seqRef = useRef(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // 닫힐 때 상태 초기화
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResult(null);
      setError(null);
      setSearching(false);
      setActiveIndex(0);
      setResolving(false);
      seqRef.current += 1; // 진행 중 요청 무효화
    }
  }, [open]);

  // 300ms 디바운스 검색
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResult(null);
      setError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++seqRef.current;
    const timer = window.setTimeout(() => {
      searchAll(q)
        .then((r) => {
          if (seqRef.current !== seq) return;
          setResult(r);
          setError(null);
          setActiveIndex(0);
        })
        .catch((e) => {
          if (seqRef.current !== seq) return;
          setResult(null);
          setError(errorMessage(e));
        })
        .finally(() => {
          if (seqRef.current === seq) setSearching(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  const items = useMemo<OmniItem[]>(() => {
    if (!result) return [];
    const out: OmniItem[] = [];
    if (result.fastpath) {
      out.push({
        kind: 'question',
        key: `fp-${result.fastpath.questionId}`,
        questionId: result.fastpath.questionId,
        questionNo: result.fastpath.questionNo,
        fastpath: true,
      });
    }
    for (const q of result.questions ?? []) {
      if (result.fastpath && q.id === result.fastpath.questionId) continue; // 중복 제거
      out.push({
        kind: 'question',
        key: `q-${q.id}`,
        questionId: q.id,
        questionNo: q.questionNo,
        categoryCode: q.categoryCode,
        snippet: q.snippet,
        fastpath: false,
      });
    }
    for (const p of result.passages ?? []) {
      out.push({
        kind: 'passage',
        key: `p-${p.passageId}`,
        passageId: p.passageId,
        quote: p.quote,
        docTitle: p.docTitle,
        questionNos: p.questionNos ?? [],
      });
    }
    for (const pg of result.pages ?? []) {
      out.push({
        kind: 'page',
        key: `pg-${pg.versionId}-${pg.pageNo}`,
        documentId: pg.documentId,
        versionId: pg.versionId,
        docTitle: pg.docTitle,
        pageNo: pg.pageNo,
        year: pg.year,
        snippet: pg.snippet,
      });
    }
    for (const d of result.docs ?? []) {
      out.push({ kind: 'doc', key: `d-${d.id}`, docId: d.id, title: d.title });
    }
    return out;
  }, [result]);

  // 활성 항목이 보이도록 스크롤 (그룹 헤더가 끼어 있어 data-idx 로 탐색)
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector(`[data-idx="${activeIndex}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, items.length]);

  if (!open) return null;

  const go = (item: OmniItem | undefined) => {
    if (!item || resolving) return;
    if (item.kind === 'question') {
      onClose();
      navigate(`/q/${item.questionId}`);
      return;
    }
    if (item.kind === 'doc') {
      onClose();
      navigate(`/docs/${item.docId}`);
      return;
    }
    if (item.kind === 'page') {
      // 지침서 본문 페이지 — DocViewer 판본·페이지 딥링크
      onClose();
      navigate(`/docs/${item.documentId}?v=${item.versionId}&page=${item.pageNo}`);
      return;
    }
    // 발췌: 검색 응답에 문서/앵커 좌표가 없어 클릭 시 해석
    setResolving(true);
    setError(null);
    const seq = ++seqRef.current;
    resolvePassageTarget(item.passageId, item.docTitle)
      .then((target) => {
        if (seqRef.current !== seq) return;
        setResolving(false);
        if (!target) {
          setError('발췌 위치를 찾지 못했습니다. (문서가 삭제되었거나 판본이 교체되었을 수 있습니다)');
          return;
        }
        onClose();
        const qs = new URLSearchParams();
        if (target.versionId != null) qs.set('v', String(target.versionId));
        if (target.anchorId != null) qs.set('hl', String(target.anchorId));
        const suffix = qs.toString();
        navigate(`/docs/${target.documentId}${suffix ? `?${suffix}` : ''}`);
      })
      .catch((e) => {
        if (seqRef.current !== seq) return;
        setResolving(false);
        setError(errorMessage(e));
      });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(items[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // 렌더 목록: 그룹 경계에 헤더 삽입
  const rendered: React.ReactNode[] = [];
  let prevKind: OmniItem['kind'] | null = null;
  items.forEach((item, i) => {
    if (item.kind !== prevKind) {
      prevKind = item.kind;
      // 문항 그룹은 패스트패스 배지가 헤더 역할을 겸하므로 문항이 첫 그룹이면 생략
      if (!(item.kind === 'question' && i === 0)) {
        rendered.push(
          <li key={`h-${item.kind}`} className="omni-group-head" aria-hidden="true">
            {GROUP_LABEL[item.kind]}
          </li>,
        );
      }
    }
    rendered.push(
      <li
        key={item.key}
        role="option"
        aria-selected={i === activeIndex}
        data-idx={i}
        className={
          'omni-item' +
          (i === activeIndex ? ' is-active' : '') +
          (item.kind === 'question' && item.fastpath ? ' is-fastpath' : '')
        }
        onMouseEnter={() => setActiveIndex(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => go(item)}
      >
        {item.kind === 'question' && (
          <>
            <span className="omni-no">{item.questionNo}</span>
            {item.fastpath ? (
              <span className="omni-fastpath-badge">바로 이동 ⏎</span>
            ) : (
              <span className="omni-snippet">
                {item.categoryCode ? `[${item.categoryCode}] ` : ''}
                {item.snippet ?? ''}
              </span>
            )}
          </>
        )}
        {item.kind === 'passage' && (
          <span className="omni-passage">
            <span className="omni-snippet">“{item.quote}”</span>
            <span className="omni-passage-meta">
              {item.docTitle}
              {item.questionNos.length > 0 && ` · ${item.questionNos.join(' · ')}`}
            </span>
          </span>
        )}
        {item.kind === 'page' && (
          <>
            <span className="omni-doc-icon" aria-hidden="true">
              📄
            </span>
            <span className="omni-passage">
              <span className="omni-passage-meta">
                {item.docTitle} · p.{item.pageNo}
                {item.year != null && <span className="year-chip">{item.year}</span>}
              </span>
              {/* 스니펫은 평문 렌더(문서 내용 XSS 방지) */}
              <span className="omni-snippet">{item.snippet}</span>
            </span>
          </>
        )}
        {item.kind === 'doc' && (
          <>
            <span className="omni-doc-icon" aria-hidden="true">
              📘
            </span>
            <span className="omni-snippet">{item.title}</span>
          </>
        )}
      </li>,
    );
  });

  return (
    <div
      className="omni-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="검색"
    >
      <div className="omni-panel">
        <input
          className="omni-input"
          type="text"
          value={query}
          placeholder="번호 또는 검색어 · Ctrl+K"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="번호 또는 검색어"
        />
        <div className="omni-body">
          {error && <div className="omni-msg omni-error">{error}</div>}
          {resolving && <div className="omni-msg">발췌 위치 확인 중…</div>}
          {!error && query.trim() === '' && (
            <div className="omni-msg">
              문항 번호(예: 50.210.420, 210420) 또는 검색어를 입력하세요.
            </div>
          )}
          {!error && query.trim() !== '' && searching && items.length === 0 && (
            <div className="omni-msg">검색 중…</div>
          )}
          {!error && query.trim() !== '' && !searching && items.length === 0 && (
            <div className="omni-msg">검색 결과가 없습니다.</div>
          )}
          {items.length > 0 && (
            <ul className="omni-list" ref={listRef} role="listbox">
              {rendered}
            </ul>
          )}
        </div>
        <div className="omni-footer">↑↓ 이동 · Enter 열기 · Esc 닫기</div>
      </div>
    </div>
  );
}
