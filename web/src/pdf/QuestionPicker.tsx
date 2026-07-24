/**
 * 문항 퀵피커 — 번호/키워드 검색 후 대상 문항 지정 (설계서 §3.2 'PDF에서 출발' 경로).
 * 매핑 모드 대상 지정(DocViewer)과 "+ 다른 문항에도 연결"(PdfViewerPane 팝오버)에서 공용.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchAll, type SearchResponse } from '../api';
import { errorMessage } from '../util';

export interface PickedQuestion {
  id: number;
  questionNo: string;
}

interface PickItem extends PickedQuestion {
  key: string;
  snippet?: string;
  categoryCode?: string;
  fastpath: boolean;
}

interface Props {
  title: string;
  onPick: (q: PickedQuestion) => void;
  onClose: () => void;
}

export default function QuestionPicker({ title, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const seqRef = useRef(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
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
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const items = useMemo<PickItem[]>(() => {
    if (!result) return [];
    const out: PickItem[] = [];
    if (result.fastpath) {
      out.push({
        key: `fp-${result.fastpath.questionId}`,
        id: result.fastpath.questionId,
        questionNo: result.fastpath.questionNo,
        fastpath: true,
      });
    }
    for (const q of result.questions ?? []) {
      if (result.fastpath && q.id === result.fastpath.questionId) continue;
      out.push({
        key: `q-${q.id}`,
        id: q.id,
        questionNo: q.questionNo,
        categoryCode: q.categoryCode,
        snippet: q.snippet,
        fastpath: false,
      });
    }
    return out;
  }, [result]);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex];
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, items.length]);

  const pick = (item: PickItem | undefined) => {
    if (!item) return;
    onPick({ id: item.id, questionNo: item.questionNo });
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
      e.stopPropagation();
      pick(items[activeIndex]);
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
      aria-label={title}
    >
      <div className="qpick-panel">
        <div className="qpick-title">{title}</div>
        <input
          className="omni-input"
          type="text"
          value={query}
          placeholder="문항 번호 또는 키워드 (예: 210420, 파기)"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="문항 번호 또는 키워드"
        />
        <div className="omni-body">
          {error && <div className="omni-msg omni-error">{error}</div>}
          {!error && query.trim() === '' && (
            <div className="omni-msg">번호(예: 50.210.420) 또는 키워드를 입력하세요.</div>
          )}
          {!error && query.trim() !== '' && searching && items.length === 0 && (
            <div className="omni-msg">검색 중…</div>
          )}
          {!error && query.trim() !== '' && !searching && items.length === 0 && (
            <div className="omni-msg">검색 결과가 없습니다.</div>
          )}
          {items.length > 0 && (
            <ul className="omni-list" ref={listRef} role="listbox">
              {items.map((item, i) => (
                <li
                  key={item.key}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={
                    'omni-item' +
                    (i === activeIndex ? ' is-active' : '') +
                    (item.fastpath ? ' is-fastpath' : '')
                  }
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(item)}
                >
                  <span className="omni-no">{item.questionNo}</span>
                  {item.fastpath ? (
                    <span className="omni-fastpath-badge">바로 지정 ⏎</span>
                  ) : (
                    <span className="omni-snippet">
                      {item.categoryCode ? `[${item.categoryCode}] ` : ''}
                      {item.snippet ?? ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="omni-footer">↑↓ 이동 · Enter 지정 · Esc 닫기</div>
      </div>
    </div>
  );
}
