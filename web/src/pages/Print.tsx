/**
 * 인쇄 뷰 `/print/:categoryId` (범위 `?q=`) — 종이 바인더 대체 (설계서 §6.4, §4 #11)
 *
 * 구성: 표지 → 목차(집계·문항 목록) → 문항별 블록(번호·유형·본문·배점·선택·점수 →
 *   답변 → 근거[인용문 + 출처행 "제목 v라벨, p.N"] → 지적/권장사항 → 자유형식 문서).
 *   화면에선 [인쇄] 버튼(window.print()), 인쇄 시 @media print(print.css)로 페이지 분할·바닥글.
 *
 * 데이터: 기존 API만 조립 — bootstrap(설정·주기·분야 집계) + categories/:id/questions(목록) +
 *   questions/:id(답변 평문) + questions/:id/evidence(근거). 새 서버 코드 없음.
 *   `?q=`는 클라이언트에서 문항번호·본문·지적사항 부분일치로 범위를 좁힌다(별도 검색 API 미사용).
 *
 * v1 한계: 자유형식 문서(richdoc)는 현재 근거 목록에 제목·메모만 제공되는 API여서 전문(표·이미지)은
 *   출력하지 않는다. 발췌 하이라이트 크롭 이미지도 v1 생략(인용문+출처행으로 대체).
 */
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  fetchBootstrap,
  fetchCategoryQuestions,
  fetchQuestion,
  fetchQuestionEvidence,
  type AnswerChoice,
  type AppSettings,
  type CategorySummary,
  type EvidenceItem,
  type EvidencePassageItem,
  type QuestionListItem,
} from '../api';
import { errorMessage, fixBullets, fmtNum, truthy } from '../util';
import QuestionBody from '../components/QuestionBody';
import '../print.css';

// ── 표시 규약(상세 화면과 동일) ───────────────────────────────────────────────
const TYPE_META: Record<'core' | 'required' | 'basic', { cls: string; symbol: string; label: string }> = {
  core: { cls: 'badge-core', symbol: 'C', label: '핵심' },
  required: { cls: 'badge-required', symbol: 'R', label: '필요' },
  basic: { cls: 'badge-basic', symbol: 'B', label: '기본' },
};

function choiceLabel(c: AnswerChoice | null): string {
  switch (c) {
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

function isPassage(it: EvidenceItem): it is EvidencePassageItem {
  return it.type === 'passage';
}

/** 발췌 출처행 "제목 v라벨, p.N" */
function sourceLine(it: EvidencePassageItem): string {
  let s = it.docTitle;
  if (it.versionLabel) s += ` v${it.versionLabel}`;
  if (it.pageStart != null) s += `, p.${it.pageStart}`;
  return s;
}

/** 자유형식 근거 항목(현재 API는 제목·메모만 노출) */
interface RichdocView {
  richDocId?: number;
  title?: string;
  note?: string | null;
}

function truncate(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 채점 집계 — bootstrap 분야 카드와 동일 공식(na 제외 취득/만점) */
function computeTotals(items: QuestionListItem[]): {
  obtained: number;
  max: number;
  graded: number;
  total: number;
  rate: number;
} {
  let obtained = 0;
  let max = 0;
  let graded = 0;
  for (const q of items) {
    // 합산/자동 모드는 answer_choice 없이 score 가 유효 총점 (bootstrap 집계와 동일 정의 — Phase 3a)
    const nonSimple = q.scoringMode != null && q.scoringMode !== 'simple';
    if (q.answerChoice != null || (nonSimple && q.score != null)) graded += 1;
    if (q.answerChoice === 'yes' || q.answerChoice === 'no' || nonSimple) obtained += q.score ?? 0;
    if (q.answerChoice !== 'na') max += q.maxScore ?? 0;
  }
  const rate = max > 0 ? Math.round((obtained / max) * 1000) / 10 : 0;
  return { obtained, max, graded, total: items.length, rate };
}

/** 동시 실행 상한을 둔 map — 대분야(문항 100+)에서 요청 폭주 방지 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

interface PrintQuestion {
  item: QuestionListItem;
  answerPlain: string | null;
  evidence: EvidenceItem[];
}

interface CategoryRef {
  id: number;
  code: string;
  name: string;
}

export default function Print() {
  const { categoryId } = useParams<{ categoryId: string }>();
  const [search] = useSearchParams();
  const q = search.get('q') ?? '';

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [cycleName, setCycleName] = useState<string | null>(null);
  const [category, setCategory] = useState<CategoryRef | null>(null);
  const [summary, setSummary] = useState<CategorySummary | null>(null);
  const [questions, setQuestions] = useState<PrintQuestion[]>([]);

  useEffect(() => {
    let alive = true;
    setPhase('loading');
    setError(null);

    (async () => {
      const catList = await fetchCategoryQuestions(categoryId!);
      // 분야가 속한 주기(연도) 기준으로 집계를 가져온다 — 다른 연도의 분야도
      // 주기명·분야 요약이 올바르게 나온다 (활성 주기 고정이면 다른 연도에서 어긋남)
      const boot = await fetchBootstrap(catList.cycle?.id);
      if (!alive) return;

      setSettings(boot.settings);
      setCycleName(catList.cycle?.name ?? boot.activeCycle?.name ?? null);
      setCategory(catList.category);
      setSummary(boot.categories.find((c) => c.id === catList.category.id) ?? null);

      // ?q= 범위: 문항번호·본문·지적사항 부분일치(대소문자 무시)
      const needle = q.trim().toLowerCase();
      const filtered = needle
        ? catList.questions.filter(
            (it) =>
              it.questionNo.toLowerCase().includes(needle) ||
              it.body.toLowerCase().includes(needle) ||
              (it.findingsText ?? '').toLowerCase().includes(needle),
          )
        : catList.questions;

      // 문항별 답변 평문 + 근거 로드(동시 8)
      const loaded = await mapLimit(filtered, 8, async (it): Promise<PrintQuestion> => {
        let answerPlain: string | null = null;
        let evidence: EvidenceItem[] = [];
        try {
          const full = await fetchQuestion(it.id);
          answerPlain = full.answerPlain;
        } catch {
          /* 개별 문항 상세 실패는 빈 값으로 진행 */
        }
        try {
          const ev = await fetchQuestionEvidence(it.id);
          evidence = ev.items;
        } catch {
          /* 근거 조회 실패는 빈 목록으로 진행 */
        }
        return { item: it, answerPlain, evidence };
      });
      if (!alive) return;

      setQuestions(loaded);
      setPhase('ready');
    })().catch((e: unknown) => {
      if (!alive) return;
      setError(errorMessage(e));
      setPhase('error');
    });

    return () => {
      alive = false;
    };
  }, [categoryId, q]);

  if (phase === 'loading') {
    return (
      <div className="pr-root">
        <p className="pr-status">인쇄본을 준비하는 중입니다…</p>
      </div>
    );
  }
  if (phase === 'error' || !category || !settings) {
    return (
      <div className="pr-root">
        <p className="pr-status is-error">인쇄본을 불러오지 못했습니다. {error ?? ''}</p>
        <p className="pr-status">
          <Link to="/">Dashboard로 돌아가기</Link>
        </p>
      </div>
    );
  }

  const totals = computeTotals(questions.map((pq) => pq.item));

  return (
    <div className="pr-root">
      {/* ── 화면 전용 툴바 ── */}
      <div className="print-toolbar no-print">
        <span className="pr-tb-title">
          인쇄 뷰 · {category.name}
          <span className="pr-cover-code"> ({category.code})</span>
        </span>
        <Link className="pr-tb-back" to={`/c/${category.id}`}>
          ← 분야 목록으로
        </Link>
        <span className="pr-tb-spacer" />
        <span className="pr-tb-hint">
          {q ? `범위: “${q}” · ` : ''}
          {questions.length}문항 · Ctrl/⌘+P 로도 인쇄
        </span>
        <button type="button" className="pr-print-btn" onClick={() => window.print()}>
          인쇄
        </button>
      </div>

      <div className="pr-paper">
        {/* ── 표지 ── */}
        <section className="pr-cover">
          {settings.orgName && <div className="pr-cover-org">{settings.orgName}</div>}
          <h1 className="pr-cover-title">{settings.systemName} 인쇄본</h1>
          <div className="pr-cover-cat">
            {category.name}
            <span className="pr-cover-code">({category.code})</span>
          </div>
          <dl className="pr-cover-meta">
            <div>
              <dt>인증 주기</dt>
              <dd>{cycleName ?? '—'}</dd>
            </div>
            <div>
              <dt>문항 수</dt>
              <dd>{totals.total}문항</dd>
            </div>
            <div>
              <dt>채점 완료</dt>
              <dd>
                {totals.graded} / {totals.total}
              </dd>
            </div>
            <div>
              <dt>취득 / 만점</dt>
              <dd>
                {fmtNum(totals.obtained)} / {fmtNum(totals.max)} ({totals.rate}%)
              </dd>
            </div>
            {q && (
              <div>
                <dt>인쇄 범위</dt>
                <dd>“{q}” 검색</dd>
              </div>
            )}
            <div>
              <dt>생성일</dt>
              <dd>{todayStr()}</dd>
            </div>
          </dl>
        </section>

        {/* ── 목차 ── */}
        <section className="pr-toc">
          <h2 className="pr-h2">목차</h2>
          {questions.length === 0 ? (
            <p className="pr-empty">
              {q ? '검색 범위에 해당하는 문항이 없습니다.' : '이 분야에 등록된 문항이 없습니다.'}
            </p>
          ) : (
            <>
              <p className="pr-toc-summary">
                총 <b>{totals.total}</b>문항 · 채점 <b>{totals.graded}</b>문항 · 취득{' '}
                <b>{fmtNum(totals.obtained)}</b> / 만점 <b>{fmtNum(totals.max)}</b> (달성률{' '}
                <b>{totals.rate}%</b>)
                {summary && summary.questionCount !== totals.total
                  ? ` · 분야 전체 ${summary.questionCount}문항 중 발췌`
                  : ''}
              </p>
              <table className="pr-toc-table">
                <thead>
                  <tr>
                    <th className="pr-toc-no">번호</th>
                    <th>문항</th>
                    <th className="pr-toc-choice">선택</th>
                    <th className="pr-toc-score">점수</th>
                  </tr>
                </thead>
                <tbody>
                  {questions.map((pq) => {
                    const it = pq.item;
                    const nonSimple = it.scoringMode != null && it.scoringMode !== 'simple';
                    // 선택 칸: 합산/자동 모드는 '선택'이 없으므로 채점방식을 표기(상세 블록과 동일)
                    const choiceCell =
                      it.scoringMode === 'composite'
                        ? '합산'
                        : it.scoringMode === 'auto'
                          ? '자동'
                          : choiceLabel(it.answerChoice);
                    // 점수 칸: 해당없음 → —, 비-simple 미채점 → '미채점'(0점 오인 방지), 그 외 취득/배점
                    const scoreCell =
                      it.answerChoice === 'na'
                        ? '—'
                        : nonSimple && it.score == null
                          ? `미채점 / ${fmtNum(it.maxScore)}`
                          : `${fmtNum(it.score ?? 0)} / ${fmtNum(it.maxScore)}`;
                    return (
                      <tr key={it.id}>
                        <td className="pr-toc-no">{it.questionNo}</td>
                        <td>{truncate(fixBullets(it.body), 64)}</td>
                        <td className="pr-toc-choice">{choiceCell}</td>
                        <td className="pr-toc-score">{scoreCell}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </section>

        {/* ── 문항 본문 ── */}
        {questions.length > 0 && (
          <section className="pr-body">
            {questions.map((pq) => (
              <QuestionBlock key={pq.item.id} pq={pq} />
            ))}
          </section>
        )}
      </div>

      {/* 인쇄 시 매 페이지 반복되는 바닥글 (분야명) */}
      <div className="pr-footer" aria-hidden="true">
        {category.name} — {settings.systemName} 인쇄본
      </div>
    </div>
  );
}

// ── 문항 블록 ─────────────────────────────────────────────────────────────────
function QuestionBlock({ pq }: { pq: PrintQuestion }) {
  const { item, answerPlain, evidence } = pq;
  const type = item.questionType ? TYPE_META[item.questionType] : null;

  return (
    <article className="pr-q">
      <header className="pr-q-head">
        <div className="pr-q-no">
          {type && (
            <span className={`badge badge-type ${type.cls}`} title={type.label}>
              {item.gradeSymbol ?? type.symbol}
            </span>
          )}
          <span className="pr-q-num">{item.questionNo}</span>
        </div>
        <div className="pr-q-badges">
          {item.revisionStatus === 'new' && <span className="badge badge-new">신규</span>}
          {item.revisionStatus === 'modified' && <span className="badge badge-mod">변경</span>}
          {truthy(item.needsRecheck) && <span className="badge badge-recheck">재확인</span>}
          <span className="pr-q-score">배점 {fmtNum(item.maxScore)}점</span>
        </div>
      </header>

      <div className="pr-q-body">
        <QuestionBody text={item.body} />
      </div>

      <div className="pr-grade">
        {item.scoringMode === 'composite' || item.scoringMode === 'auto' ? (
          <span>
            채점: <b>{item.scoringMode === 'composite' ? '합산(세부항목)' : '자동(기관 지표)'}</b>
          </span>
        ) : (
          <span>
            선택: <b>{choiceLabel(item.answerChoice)}</b>
          </span>
        )}
        <span>
          점수:{' '}
          <b>
            {item.answerChoice === 'na'
              ? '해당없음'
              : item.scoringMode != null && item.scoringMode !== 'simple' && item.score == null
                ? `미채점 / ${fmtNum(item.maxScore)}`
                : `${fmtNum(item.score ?? 0)} / ${fmtNum(item.maxScore)}`}
          </b>
        </span>
        {truthy(item.allowNa) && <span className="pr-na">해당없음 선택 가능</span>}
      </div>

      <div className="pr-field">
        <h3 className="pr-h3">답변</h3>
        {answerPlain && answerPlain.trim() ? (
          <div className="pr-prose">{answerPlain}</div>
        ) : (
          <p className="pr-empty">작성된 답변 없음</p>
        )}
      </div>

      <div className="pr-field">
        <h3 className="pr-h3">근거</h3>
        {evidence.length === 0 ? (
          <p className="pr-empty">연결된 근거 없음</p>
        ) : (
          <ol className="pr-evidence">
            {evidence.map((it, i) => {
              if (isPassage(it)) {
                return (
                  <li className="pr-ev" key={`p${it.passageId}`}>
                    {it.quote ? (
                      <blockquote className="pr-quote">{it.quote}</blockquote>
                    ) : (
                      <p className="pr-empty">인용문 없음(근거 위치 확인 필요)</p>
                    )}
                    <div className="pr-source">{sourceLine(it)}</div>
                    {it.note && <div className="pr-note">메모: {it.note}</div>}
                  </li>
                );
              }
              const rd = it as unknown as RichdocView;
              return (
                <li className="pr-ev pr-ev-rich" key={`r${rd.richDocId ?? i}`}>
                  <div className="pr-source">자유형식 — {rd.title ?? '제목 없음'}</div>
                  {rd.note && <div className="pr-note">메모: {rd.note}</div>}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {item.findingsText && item.findingsText.trim() && (
        <div className="pr-field">
          <h3 className="pr-h3">지적/권장사항</h3>
          <div className="pr-prose">{item.findingsText}</div>
        </div>
      )}
    </article>
  );
}
