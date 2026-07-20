/**
 * 지침서 판본 비교 /docs/:id/compare (v1.5 Phase 4 — jsdiff)
 * 두 판본의 추출 텍스트를 줄 단위로 비교해 추가(초록)/삭제(빨강 취소선)를 표시한다.
 * 기본값: 이전 판본(구) ↔ 현재 판본(신). ?a=&b= 로 임의 판본 쌍 지정 가능.
 * 기본은 "달라진 부분만"(±컨텍스트 2줄) — 전체 보기 토글 제공.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { diffLines, type ChangeObject } from 'diff';
import {
  fetchDoc,
  fetchVersionPageText,
  type DocDetailResponse,
  type DocVersionInfo,
} from '../api';
import { errorMessage } from '../util';

/** 페이지 텍스트를 통짜 문자열로 (페이지 경계는 빈 줄 — diff 안정성 위해 단순 연결) */
function joinPages(pages: Array<{ pageNo: number; text: string }>): string {
  return pages.map((p) => p.text).join('\n');
}

interface DiffRow {
  kind: 'add' | 'del' | 'same' | 'gap';
  text: string;
  key: number;
}

/** jsdiff Change[] → 행 목록. changedOnly면 변경 블록 ±context 줄만 남기고 사이는 gap 행 */
function toRows(changes: ChangeObject<string>[], changedOnly: boolean, context = 2): DiffRow[] {
  const all: DiffRow[] = [];
  let key = 0;
  for (const c of changes) {
    const kind: DiffRow['kind'] = c.added ? 'add' : c.removed ? 'del' : 'same';
    // 마지막 빈 줄 분리 방지: trimEnd 후 split
    for (const line of c.value.replace(/\n$/, '').split('\n')) {
      all.push({ kind, text: line, key: key++ });
    }
  }
  if (!changedOnly) return all;
  const keep = new Set<number>();
  for (let i = 0; i < all.length; i++) {
    if (all[i]!.kind === 'add' || all[i]!.kind === 'del') {
      for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) {
        keep.add(j);
      }
    }
  }
  const rows: DiffRow[] = [];
  let inGap = false;
  for (let i = 0; i < all.length; i++) {
    if (keep.has(i)) {
      rows.push(all[i]!);
      inGap = false;
    } else if (!inGap) {
      rows.push({ kind: 'gap', text: '⋯', key: all[i]!.key });
      inGap = true;
    }
  }
  return rows;
}

export default function DocCompare() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const [detail, setDetail] = useState<DocDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [texts, setTexts] = useState<{ a: string; b: string } | null>(null);
  const [changedOnly, setChangedOnly] = useState(true);

  // 판본 목록 (오래된 → 최신 순 정렬은 서버 순서에 의존하지 않고 id 오름차순으로)
  const versions = useMemo<DocVersionInfo[]>(
    () => (detail ? [...detail.versions].sort((x, y) => x.id - y.id) : []),
    [detail],
  );

  // 비교 쌍: ?a=&b= 우선, 없으면 (직전 판본, 현재/최신 판본)
  const aId = Number(searchParams.get('a')) || (versions.length >= 2 ? versions[versions.length - 2]!.id : 0);
  const bId = Number(searchParams.get('b')) || (versions.length >= 1 ? versions[versions.length - 1]!.id : 0);

  const loadDoc = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetchDoc(id)
      .then(setDetail)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(loadDoc, [loadDoc]);

  const loadTexts = useCallback(() => {
    if (!aId || !bId) return;
    setError(null);
    setTexts(null);
    Promise.all([fetchVersionPageText(aId), fetchVersionPageText(bId)])
      .then(([ra, rb]) => setTexts({ a: joinPages(ra.pages), b: joinPages(rb.pages) }))
      .catch((e) => setError(errorMessage(e)));
  }, [aId, bId]);

  useEffect(loadTexts, [loadTexts]);

  // diff 계산(무거움)과 행 필터(가벼움)를 분리 메모 — "전체 보기" 토글 시 diff 재계산 방지
  const changes = useMemo(() => (texts ? diffLines(texts.a, texts.b) : null), [texts]);
  const rows = useMemo(() => (changes ? toRows(changes, changedOnly) : null), [changes, changedOnly]);

  const stats = useMemo(() => {
    if (!rows) return null;
    let add = 0;
    let del = 0;
    for (const r of rows) {
      if (r.kind === 'add') add++;
      else if (r.kind === 'del') del++;
    }
    return { add, del };
  }, [rows]);

  const labelOf = (vid: number): string =>
    versions.find((v) => v.id === vid)?.versionLabel ?? `#${vid}`;

  const setPair = (which: 'a' | 'b', vid: number): void => {
    const next = new URLSearchParams(searchParams);
    next.set('a', String(which === 'a' ? vid : aId));
    next.set('b', String(which === 'b' ? vid : bId));
    setSearchParams(next, { replace: true });
  };

  if (loading) return <div className="page-status">불러오는 중…</div>;
  if (error) {
    return (
      <div className="page">
        <div className="error-card">
          <p>{error}</p>
          {/* 문서 정보 로드 실패면 문서부터, 텍스트 로드 실패면 텍스트만 재시도 */}
          <button type="button" className="btn" onClick={detail == null ? loadDoc : loadTexts}>
            다시 시도
          </button>
        </div>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          <Link to="/docs" className="crumb">
            지침서 업로드
          </Link>
          <span className="crumb-sep">›</span>
          <Link to={`/docs/${detail.doc.id}`} className="crumb">
            {detail.doc.title}
          </Link>
          <span className="crumb-sep">›</span>
          판본 비교
        </h1>
      </div>

      {versions.length < 2 ? (
        <div className="empty-state">
          <p className="empty-title">비교할 판본이 없습니다.</p>
          <p>판본이 2개 이상 등록된 문서만 비교할 수 있습니다. (현재 {versions.length}개)</p>
        </div>
      ) : (
        <>
          <div className="doccmp-toolbar">
            <label>
              이전(구){' '}
              <select value={aId} onChange={(e) => setPair('a', Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.versionLabel}
                  </option>
                ))}
              </select>
            </label>
            <span className="doccmp-arrow">→</span>
            <label>
              이후(신){' '}
              <select value={bId} onChange={(e) => setPair('b', Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.versionLabel}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="chip" onClick={() => setChangedOnly((v) => !v)}>
              {changedOnly ? '전체 보기' : '달라진 부분만'}
            </button>
            {stats && (
              <span className="doccmp-stats">
                <span className="doccmp-add">+{stats.add}줄</span>{' '}
                <span className="doccmp-del">−{stats.del}줄</span>
                {stats.add === 0 && stats.del === 0 && ' — 두 판본의 텍스트가 동일합니다'}
              </span>
            )}
          </div>

          {!texts ? (
            <div className="page-status">텍스트 비교 중…</div>
          ) : (
            <div className="card doccmp-body" aria-label={`${labelOf(aId)} 대비 ${labelOf(bId)} 변경 내용`}>
              {rows!.map((r) =>
                r.kind === 'gap' ? (
                  <div key={`g${r.key}`} className="doccmp-gap">
                    ⋯ 생략 ⋯
                  </div>
                ) : (
                  <div key={r.key} className={`doccmp-line doccmp-${r.kind}`}>
                    <span className="doccmp-sign">
                      {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
                    </span>
                    {r.text || ' '}
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
