/**
 * 지침서 판본 비교 /docs/:id/compare (v1.5 Phase 4 — jsdiff)
 * 두 판본의 추출 텍스트를 줄 단위로 비교해 추가(초록)/삭제(빨강 취소선)를 표시한다.
 * 기본값: 이전 판본(구) ↔ 현재 판본(신). ?a=&b= 로 임의 판본 쌍 지정 가능.
 * 기본은 "달라진 부분만"(±컨텍스트 2줄) — 전체 보기 토글 제공.
 * 판본 형식(PDF, Word, Excel 등)을 선택지에 함께 적는다. 형식이 다른 두 판본은 줄바꿈 위치가
 * 서로 달라 줄 단위 비교가 거의 전부를 바뀐 것으로 보이므로, 공백을 하나로 고른 글자를 단어 단위로 비교한다.
 * 단어 비교는 큰 문서에서 몇 초 걸릴 수 있어(합성 30만 자, 3% 수정에 약 2초) 조금씩 나눠 계산한다: 계산하는
 * 동안에도 판본 선택과 전체 보기 단추가 그대로 반응한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { diffLines, type ChangeObject } from 'diff';
import {
  fetchDoc,
  fetchVersionPageText,
  type DocDetailResponse,
  type DocVersionInfo,
  type FileKind,
} from '../api';
import { FILE_KIND_LABEL } from '../office/pageLabel';
import '../office/library.css';
import { errorMessage } from '../util';

/** 페이지 텍스트를 통짜 문자열로 (페이지 경계는 빈 줄 — diff 안정성 위해 단순 연결) */
function joinPages(pages: Array<{ pageNo: number; text: string }>): string {
  return pages.map((p) => p.text).join('\n');
}

/** 판본 형식 (값이 없는 예전 판본은 PDF) */
function kindOf(v: DocVersionInfo | undefined): FileKind {
  return v?.fileKind ?? 'pdf';
}

/** 비교할 두 판본의 글자 (어느 판본 쌍의 것인지 함께) */
interface PairTexts {
  aId: number;
  bId: number;
  a: string;
  b: string;
}

// ── 형식이 다른 판본: 단어 단위 비교 ─────────────────────────────────────────

/** 공백(줄바꿈, 탭 포함)을 빈칸 하나로 고른다: 형식마다 다른 줄바꿈, 들여쓰기를 비교에서 뺀다 */
function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 단어 토큰: 글자 덩어리, 공백 덩어리, 그 밖의 한 글자(문장부호).
 * jsdiff 의 diffWordsWithSpace 와 같은 토큰 규칙인데 글자 범위만 유니코드 문자 전체(\p{L}, \p{N}, \p{M})로
 * 넓혔다. diffWordsWithSpace 는 라틴 문자만 단어 글자로 보아 한글은 음절 하나하나가 토큰이 된다: 결과가
 * 글자 단위로 잘게 쪼개지고(예: '검체' 대신 '체'), 합성 한국어 6만 자 문서에서 4배 느렸다(2.4초 대 0.6초).
 */
const WORD_TOKEN_RE = /[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu;

function tokenizeWords(s: string): string[] {
  return s.match(WORD_TOKEN_RE) ?? [];
}

/** 단어 비교 제한 시간: 넘기면 결과 대신 안내를 보인다. 계산 중에도 화면은 멈추지 않는다 */
const WORD_DIFF_TIMEOUT_MS = 20000;
/** 한 번에 계산하는 시간(ms). 이만큼 계산하면 브라우저에 차례를 넘겨 입력과 그리기를 처리하게 한다 */
const WORD_DIFF_SLICE_MS = 12;

type EditKind = 'same' | 'add' | 'del';
/** 편집 경로의 한 구간. 같은 종류가 이어지면 count 만 늘리고, prev 로 앞 구간을 잇는다(연결 목록) */
interface EditRun {
  kind: EditKind;
  count: number;
  prev: EditRun | null;
}
/** 대각선 하나에서 가장 멀리 간 경로. x 는 지금까지 지나온 이전 판본 토큰 수 */
interface PathEnd {
  x: number;
  runs: EditRun | null;
}

function pushRun(runs: EditRun | null, kind: EditKind, n: number): EditRun {
  return runs && runs.kind === kind
    ? { kind, count: runs.count + n, prev: runs.prev }
    : { kind, count: n, prev: runs };
}

/**
 * 토큰 배열 두 개의 최소 편집 비교(Myers 1986 의 O(ND) 탐욕 알고리즘, 동점 처리는 jsdiff 와 같다)를 조금씩
 * 나눠 계산한다. WORD_DIFF_SLICE_MS 만큼 계산하면 MessageChannel 로 차례를 넘기므로(기다림 없음) 큰 문서도
 * 계산 시간은 거의 그대로이고 화면은 멈추지 않는다.
 * jsdiff 의 비동기 모드(callback)는 쓰지 않는다: 편집 거리 한 단계마다 setTimeout 을 거는데 브라우저는 중첩된
 * setTimeout 을 4ms 이상으로 늘리므로, 합성 6만 자 문서(2% 수정)에서 0.24초 걸리던 비교에 단계 1,298번 x 4ms,
 * 곧 5초 남짓이 더 붙는다.
 * 결과는 jsdiff 와 같은 ChangeObject 모양이다(같은 부분의 글자는 새 판본 쪽). 제한 시간을 넘기면 null.
 * 돌려준 함수를 부르면 계산을 멈추고 onDone 도 부르지 않는다(판본 쌍이 바뀌거나 화면을 떠날 때).
 */
function diffTokensInSlices(
  oldT: readonly string[],
  newT: readonly string[],
  timeoutMs: number,
  onDone: (changes: ChangeObject<string>[] | null) => void,
): () => void {
  const N = oldT.length;
  const M = newT.length;
  const deadline = performance.now() + timeoutMs;
  // V[k + M]: 대각선 k(= x - y, -M..N)에서 지금까지 가장 멀리 간 경로
  const V = new Array<PathEnd | undefined>(N + M + 1);

  /** 대각선 k 위 x0 에서 같은 토큰이 이어지는 만큼 나아간다 */
  const slide = (x0: number, k: number, runs: EditRun | null): PathEnd => {
    let x = x0;
    let y = x0 - k;
    while (x < N && y < M && oldT[x] === newT[y]) {
      x++;
      y++;
    }
    return { x, runs: x > x0 ? pushRun(runs, 'same', x - x0) : runs };
  };

  // 살펴볼 대각선 범위. 대각선 k 의 경로가 이전 판본 끝(오른쪽 가장자리)에 닿으면 남은 편집은 넣기뿐이라 k 보다
  // 위 대각선은 더 짧은 답을 낼 수 없고, 새 판본 끝(아래 가장자리)에 닿으면 남은 편집은 지우기뿐이라 k 보다 아래
  // 대각선이 그렇다. 그 대각선들은 더 계산하지 않는다(jsdiff 와 같은 가지치기). 이것이 없으면 두 판본의 길이
  // 차이가 클 때(예: 10쪽에서 100쪽) 계산이 길이 차이의 제곱으로 늘어난다
  let minK = -M;
  let maxK = N;

  /** 편집 거리 d 한 단계. 두 배열 끝에 닿은 경로가 있으면 그 경로, 아니면 null */
  const step = (d: number): PathEnd | null => {
    if (d === 0) {
      const p = slide(0, 0, null);
      V[M] = p;
      if (p.x >= N && p.x >= M) return p;
      if (p.x >= N) maxK = -1;
      if (p.x >= M) minK = 1;
      return null;
    }
    let k = Math.max(-d, minK);
    if ((k + d) % 2 !== 0) k++; // 단계 d 의 대각선은 d 와 홀짝이 같다
    for (; k <= Math.min(d, maxK); k += 2) {
      const del = V[k - 1 + M]; // 대각선 k-1 에서 이전 판본 토큰 하나를 지우고 온다
      const add = V[k + 1 + M]; // 대각선 k+1 에서 새 판본 토큰 하나를 넣고 온다
      const canDel = del !== undefined && del.x < N;
      const canAdd = add !== undefined && add.x - (k + 1) < M;
      let next: PathEnd | undefined;
      if (add && canAdd && (!canDel || (del !== undefined && del.x < add.x))) {
        next = slide(add.x, k, pushRun(add.runs, 'add', 1));
      } else if (del && canDel) {
        next = slide(del.x + 1, k, pushRun(del.runs, 'del', 1));
      }
      V[k + M] = next;
      if (!next) continue;
      const atRight = next.x >= N;
      const atBottom = next.x - k >= M;
      if (atRight && atBottom) return next;
      if (atRight) maxK = Math.min(maxK, k - 1);
      if (atBottom) minK = Math.max(minK, k + 1);
    }
    return null;
  };

  const build = (last: EditRun | null): ChangeObject<string>[] => {
    const runs: EditRun[] = [];
    for (let r = last; r; r = r.prev) runs.push(r);
    runs.reverse();
    const out: ChangeObject<string>[] = [];
    let x = 0;
    let y = 0;
    for (const r of runs) {
      if (r.kind === 'del') {
        out.push({ value: oldT.slice(x, x + r.count).join(''), added: false, removed: true, count: r.count });
        x += r.count;
      } else {
        out.push({
          value: newT.slice(y, y + r.count).join(''),
          added: r.kind === 'add',
          removed: false,
          count: r.count,
        });
        y += r.count;
        if (r.kind === 'same') x += r.count;
      }
    }
    return out;
  };

  let cancelled = false;
  let d = 0;
  const channel = new MessageChannel();
  const stop = () => {
    cancelled = true;
    channel.port1.onmessage = null;
    channel.port1.close();
  };
  const run = () => {
    if (cancelled) return;
    const sliceEnd = performance.now() + WORD_DIFF_SLICE_MS;
    for (;;) {
      const end = step(d);
      if (end) {
        stop();
        onDone(build(end.runs));
        return;
      }
      d++;
      const now = performance.now();
      if (now > deadline) {
        stop();
        onDone(null);
        return;
      }
      if (now >= sliceEnd) {
        channel.port2.postMessage(null);
        return;
      }
    }
  };
  channel.port1.onmessage = run;
  channel.port2.postMessage(null);
  return stop;
}

interface WordPiece {
  kind: 'add' | 'del' | 'same';
  text: string;
}

type WordBlock = { kind: 'hunk'; pieces: WordPiece[]; key: number } | { kind: 'gap'; key: number };

/** 앞에서 n 자 남짓(단어 경계에서 자름) */
function headOf(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(' ', n);
  return s.slice(0, cut > n / 2 ? cut : n);
}

/** 뒤에서 n 자 남짓(단어 경계에서 자름) */
function tailOf(s: string, n: number): string {
  if (s.length <= n) return s;
  const start = s.length - n;
  const sp = s.indexOf(' ', start);
  return s.slice(sp !== -1 && sp - start < n / 2 ? sp + 1 : start);
}

/**
 * 단어 diff → 표시 블록. changedOnly 면 바뀐 곳마다 앞뒤 context 자만 남긴 덩어리(hunk)로 나누고,
 * 그 사이 생략은 gap 블록 하나로 둔다. 전체 보기면 덩어리 하나.
 */
function toWordBlocks(
  changes: ChangeObject<string>[],
  changedOnly: boolean,
  context = 80,
): WordBlock[] {
  const pieces: WordPiece[] = changes.map((c) => ({
    kind: c.added ? 'add' : c.removed ? 'del' : 'same',
    text: c.value,
  }));
  if (!changedOnly) return pieces.length > 0 ? [{ kind: 'hunk', pieces, key: 0 }] : [];
  const blocks: WordBlock[] = [];
  let cur: WordPiece[] = [];
  let key = 0;
  const pushHunk = () => {
    if (cur.some((p) => p.kind !== 'same')) blocks.push({ kind: 'hunk', pieces: cur, key: key++ });
    cur = [];
  };
  const pushGap = () => {
    if (blocks[blocks.length - 1]?.kind !== 'gap') blocks.push({ kind: 'gap', key: key++ });
  };
  pieces.forEach((p, i) => {
    if (p.kind !== 'same') {
      cur.push(p);
      return;
    }
    const keepHead = i > 0; // 앞 변경의 뒤 문맥
    const keepTail = i < pieces.length - 1; // 다음 변경의 앞 문맥
    const budget = (keepHead ? context : 0) + (keepTail ? context : 0);
    if (p.text.length <= budget) {
      cur.push(p);
      return;
    }
    if (keepHead) cur.push({ kind: 'same', text: headOf(p.text, context) });
    pushHunk();
    pushGap();
    if (keepTail) cur.push({ kind: 'same', text: tailOf(p.text, context) });
  });
  pushHunk();
  return blocks;
}

/** 바뀐 조각의 단어 수 */
function countWords(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
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
  // 어느 판본 쌍의 글자인지 함께 둔다: 쌍을 바꾼 직후 이전 쌍의 글자로 (무거운) 비교를 돌리지 않게
  const [texts, setTexts] = useState<PairTexts | null>(null);
  // 단어 단위 비교 결과(형식이 다른 쌍). 어느 글자 쌍의 결과인지 함께 둔다. changes 가 null 이면 제한 시간 초과
  const [wordResult, setWordResult] = useState<{
    texts: PairTexts;
    changes: ChangeObject<string>[] | null;
  } | null>(null);
  const textSeqRef = useRef(0);
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
    // 쌍을 빠르게 바꿀 때 늦게 온 이전 응답이 화면을 덮지 않게 최신 요청만 받는다
    const seq = ++textSeqRef.current;
    Promise.all([fetchVersionPageText(aId), fetchVersionPageText(bId)])
      .then(([ra, rb]) => {
        if (textSeqRef.current === seq) {
          setTexts({ aId, bId, a: joinPages(ra.pages), b: joinPages(rb.pages) });
        }
      })
      .catch((e) => {
        if (textSeqRef.current === seq) setError(errorMessage(e));
      });
  }, [aId, bId]);

  useEffect(loadTexts, [loadTexts]);

  // 형식이 다른 쌍은 단어 단위로 비교한다
  const aKind = kindOf(versions.find((v) => v.id === aId));
  const bKind = kindOf(versions.find((v) => v.id === bId));
  const crossKind = aKind !== bKind;
  const pairTexts = texts && texts.aId === aId && texts.bId === bId ? texts : null;

  // diff 계산(무거움)과 행 필터(가벼움)를 분리 메모: "전체 보기" 토글 시 diff 재계산 방지.
  // 줄 단위(형식이 같은 쌍)는 바로 계산한다
  const lineChanges = useMemo(
    () => (pairTexts && !crossKind ? diffLines(pairTexts.a, pairTexts.b) : null),
    [pairTexts, crossKind],
  );

  // 단어 단위(형식이 다른 쌍)는 조금씩 나눠 계산한다. 쌍이 바뀌거나 화면을 떠나면 하던 계산을 멈춘다
  useEffect(() => {
    if (!pairTexts || !crossKind) return;
    return diffTokensInSlices(
      tokenizeWords(normalizeSpace(pairTexts.a)),
      tokenizeWords(normalizeSpace(pairTexts.b)),
      WORD_DIFF_TIMEOUT_MS,
      (changes) => setWordResult({ texts: pairTexts, changes }),
    );
  }, [pairTexts, crossKind]);

  // 단어 비교가 제한 시간을 넘기면 changes 는 null. 아직 계산 중이면 diff 자체가 null
  const diff = useMemo<
    | { mode: 'line'; changes: ChangeObject<string>[] }
    | { mode: 'word'; changes: ChangeObject<string>[] | null }
    | null
  >(() => {
    if (!pairTexts) return null;
    if (!crossKind) return lineChanges ? { mode: 'line', changes: lineChanges } : null;
    return wordResult && wordResult.texts === pairTexts
      ? { mode: 'word', changes: wordResult.changes }
      : null;
  }, [pairTexts, crossKind, lineChanges, wordResult]);

  const rows = useMemo(
    () => (diff?.mode === 'line' ? toRows(diff.changes, changedOnly) : null),
    [diff, changedOnly],
  );
  const wordBlocks = useMemo(
    () => (diff?.mode === 'word' && diff.changes ? toWordBlocks(diff.changes, changedOnly) : null),
    [diff, changedOnly],
  );

  const stats = useMemo(() => {
    if (rows) {
      let add = 0;
      let del = 0;
      for (const r of rows) {
        if (r.kind === 'add') add++;
        else if (r.kind === 'del') del++;
      }
      return { add, del, unit: '줄' };
    }
    if (diff?.mode === 'word' && diff.changes) {
      let add = 0;
      let del = 0;
      for (const c of diff.changes) {
        if (c.added) add += countWords(c.value);
        else if (c.removed) del += countWords(c.value);
      }
      return { add, del, unit: '단어' };
    }
    return null;
  }, [rows, diff]);

  const labelOf = (vid: number): string =>
    versions.find((v) => v.id === vid)?.versionLabel ?? `#${vid}`;
  /** 선택지 표시: 판본 라벨 (형식) */
  const optionLabel = (v: DocVersionInfo): string =>
    `${v.versionLabel} (${FILE_KIND_LABEL[kindOf(v)]})`;

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
            근거자료
          </Link>
          <span className="crumb-sep">›</span>
          <Link to={`/docs/${detail.doc.id}`} className="crumb">
            {detail.doc.title}
          </Link>
          <span className="crumb-sep">›</span>
          버전 비교
        </h1>
      </div>

      {versions.length < 2 ? (
        <div className="empty-state">
          <p className="empty-title">비교할 버전이 없습니다.</p>
          <p>버전이 2개 이상 등록된 문서만 비교할 수 있습니다. (현재 {versions.length}개)</p>
        </div>
      ) : (
        <>
          <div className="doccmp-toolbar">
            <label>
              이전(구){' '}
              <select value={aId} onChange={(e) => setPair('a', Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {optionLabel(v)}
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
                    {optionLabel(v)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="chip" onClick={() => setChangedOnly((v) => !v)}>
              {changedOnly ? '전체 보기' : '달라진 부분만'}
            </button>
            {stats && (
              <span className="doccmp-stats">
                <span className="doccmp-add">
                  +{stats.add}
                  {stats.unit}
                </span>{' '}
                <span className="doccmp-del">
                  −{stats.del}
                  {stats.unit}
                </span>
                {stats.add === 0 &&
                  stats.del === 0 &&
                  (crossKind
                    ? ' (공백을 빼면 두 버전의 텍스트가 같습니다)'
                    : ' (두 버전의 텍스트가 동일합니다)')}
              </span>
            )}
          </div>

          {crossKind && (
            <p className="notice-inline doccmp-kind-note" role="note">
              형식이 다른 버전끼리는 줄 단위 대신 단어 단위로 비교합니다. 공백과 줄바꿈 차이는 세지
              않습니다.
            </p>
          )}

          {!diff ? (
            <div className="page-status">텍스트 비교 중…</div>
          ) : diff.mode === 'word' ? (
            wordBlocks == null ? (
              <div className="empty-state">
                <p className="empty-title">단어 단위 비교를 끝내지 못했습니다</p>
                <p>
                  두 버전의 차이가 커서 제한 시간({WORD_DIFF_TIMEOUT_MS / 1000}초) 안에 비교하지
                  못했습니다. 두 버전을 각각 열어 확인해 주세요.
                </p>
              </div>
            ) : (
              <div
                className="card doccmp-body doccmp-words"
                aria-label={`${labelOf(aId)} 대비 ${labelOf(bId)} 변경 내용(단어 단위)`}
              >
                {wordBlocks.map((b) =>
                  b.kind === 'gap' ? (
                    <div key={`g${b.key}`} className="doccmp-gap">
                      ⋯ 생략 ⋯
                    </div>
                  ) : (
                    <div key={b.key} className="doccmp-hunk">
                      {b.pieces.map((p, i) =>
                        p.kind === 'add' ? (
                          <ins key={i} className="doccmp-w-add">
                            {p.text}
                          </ins>
                        ) : p.kind === 'del' ? (
                          <del key={i} className="doccmp-w-del">
                            {p.text}
                          </del>
                        ) : (
                          <span key={i}>{p.text}</span>
                        ),
                      )}
                    </div>
                  ),
                )}
              </div>
            )
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
