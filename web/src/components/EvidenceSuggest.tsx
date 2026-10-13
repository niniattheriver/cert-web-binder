/**
 * 근거 추천 패널 (v1.5 Phase 5 — C-1)
 * 문항 주제/본문 키워드로 현재판본 지침서를 전문 검색해 근거 후보 페이지를 추천한다.
 * 결과 클릭 → 지침서 뷰어 해당 페이지 새 탭(작업 중 문항 화면 유지). 연결은 뷰어에서
 * 드래그로 직접 수행(자동 매핑 아님 — 추천은 후보 제시까지만).
 * 링크에는 그 쪽에서 일치한 첫 검색어를 ?q= 로 붙인다: Word, Excel 같은 판본의 뷰어가 그 낱말을 찾아 깜빡인다.
 */
import { useState } from 'react';
import {
  suggestEvidence,
  type EvidenceSuggestHit,
  type EvidenceSuggestResponse,
} from '../api-phase1';
import { pageRefLabel } from '../office/pageLabel';
import { errorMessage } from '../util';
import Icon from './Icon';

/**
 * 이 히트에서 실제로 일치한 첫 검색어. 서버는 쪽마다 처음 일치한 검색어로 스니펫을 만들므로
 * 검색어 순서대로 스니펫에 든 것을 고른다. 스니펫에서 못 찾으면 null (링크에 q 를 붙이지 않음).
 */
function firstMatchedKeyword(hit: EvidenceSuggestHit, keywords: string[]): string | null {
  const snippet = hit.snippet.toLowerCase();
  return keywords.find((kw) => kw.trim() !== '' && snippet.includes(kw.toLowerCase())) ?? null;
}

/** 지침서 뷰어 딥링크: 판본, 쪽, (있으면) 깜빡일 검색어 */
function hitHref(hit: EvidenceSuggestHit, keywords: string[]): string {
  const kw = firstMatchedKeyword(hit, keywords);
  const q = kw ? `&q=${encodeURIComponent(kw)}` : '';
  return `/docs/${hit.documentId}?v=${hit.versionId}&page=${hit.pageNo}${q}`;
}

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
          title="문항에서 핵심 단어를 뽑아, 올려 둔 근거자료에서 근거가 될 만한 쪽을 찾아 줍니다."
        >
          {busy ? '검색 중…' : open && data ? '추천 닫기' : (
              <>
                <Icon name="search" size={14} /> 근거 추천
              </>
            )}
        </button>
        {open && data && data.keywords.length > 0 && (
          <span className="evd-suggest-kws">검색어: {data.keywords.join(', ')}</span>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      {open && data && (
        <div className="evd-suggest-body">
          {data.hits.length === 0 ? (
            <p className="dim">
              추천할 쪽을 찾지 못했습니다. 근거자료를 올렸는지 확인하거나,
              검색창(Ctrl+K)에서 직접 찾아보세요.
            </p>
          ) : (
            <ul className="evd-suggest-list">
              {data.hits.map((h) => (
                <li key={`${h.versionId}-${h.pageNo}`}>
                  <a
                    href={hitHref(h, data.keywords)}
                    target="_blank"
                    rel="noreferrer"
                    title="새 탭에서 이 쪽을 엽니다. 근거로 쓰려면 그 화면에서 문장을 드래그해 연결하세요."
                  >
                    <span className="evd-suggest-meta">
                      {h.docTitle}, {pageRefLabel(h.fileKind, h.pageNo, h.pageLabel)}
                      {h.matched > 1 ? `, 검색어 ${h.matched}개 일치` : ''}
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
