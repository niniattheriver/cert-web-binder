/**
 * 근거 추천 패널 (v1.5 Phase 5 — C-1)
 * 문항 주제/본문 키워드로 현재판본 지침서를 전문 검색해 근거 후보 페이지를 추천한다.
 * 결과 클릭 → 지침서 뷰어 해당 페이지 새 탭(작업 중 문항 화면 유지). 연결은 뷰어에서
 * 드래그로 직접 수행(자동 매핑 아님 — 추천은 후보 제시까지만).
 */
import { useState } from 'react';
import { suggestEvidence, type EvidenceSuggestResponse } from '../api-phase1';
import { errorMessage } from '../util';

export default function EvidenceSuggest({ questionId }: { questionId: number }) {
  const [data, setData] = useState<EvidenceSuggestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await suggestEvidence(questionId);
      setData(r);
      setOpen(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="evd-suggest">
      <div className="evd-suggest-head">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => (open && data ? setOpen(false) : void run())}
          disabled={busy}
          title="문항 내용에서 핵심 단어를 뽑아, 업로드된 지침서에서 근거가 될 만한 페이지를 검색해 추천합니다."
        >
          {busy ? '검색 중…' : open && data ? '추천 닫기' : '🔍 근거 추천'}
        </button>
        {open && data && data.keywords.length > 0 && (
          <span className="evd-suggest-kws">검색어: {data.keywords.join(' · ')}</span>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      {open && data && (
        <div className="evd-suggest-body">
          {data.hits.length === 0 ? (
            <p className="dim">
              추천할 페이지를 찾지 못했습니다. 지침서 메뉴에서 지침서를 먼저
              업로드했는지 확인하거나, 검색창(Ctrl+K)으로 직접 찾아보세요.
            </p>
          ) : (
            <ul className="evd-suggest-list">
              {data.hits.map((h) => (
                <li key={`${h.versionId}-${h.pageNo}`}>
                  <a
                    href={`/docs/${h.documentId}?v=${h.versionId}&page=${h.pageNo}`}
                    target="_blank"
                    rel="noreferrer"
                    title="새 탭에서 지침서 뷰어의 해당 페이지를 엽니다. 근거로 쓰려면 뷰어에서 문장을 드래그해 이 문항에 연결하세요."
                  >
                    <span className="evd-suggest-meta">
                      {h.docTitle} · p.{h.pageNo}
                      {h.matched > 1 ? ` · 검색어 ${h.matched}개 일치` : ''}
                    </span>
                    {/* 스니펫은 평문 렌더(문서 내용 XSS 방지) */}
                    <span className="evd-suggest-snippet">{h.snippet}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
