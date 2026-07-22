// 문항 PDF 파서 — 설계서 §6.2-1·2
// 서식 의존 규칙(정규식·레이아웃)은 전부 patterns.ts에 있다. 실물 서식 도착 시 그 파일만 교체.
// 이 파일은 파싱 흐름만 담당: 페이지 스트림 → 표지 분야명 + 개정 요약표 + 본문 문항 블록 + warnings.

import {
  COVER_TITLE_RE,
  PAGE_NUMBER_RE,
  QUESTION_NO_RE,
  REVISION_CLASSIFICATION_RE,
  REVISION_HEADER_ROW_RE,
  REVISION_KIND_MAP,
  REVISION_PAGE_RE,
  REVISION_ROW_RE,
  REVISION_SECTION_RE,
  SUMMARY_OF_CHANGES_RE,
  TOC_RE,
  chapterMatchKey,
  extractScore,
  extractSubItems,
  extractThresholdCandidate,
  isSectionTitle,
  matchChapterHeading,
  matchExplanationAnchor,
  matchQuestionHeader,
  matchScoreAnchor,
  normalizeQuestionNo,
  parseTocEntries,
  type TocEntry,
} from './patterns.js';
import type { ParsedQuestion, ParseResult, RevisionRow } from './types.js';

export { normalizeQuestionNo } from './patterns.js';
export type { ParsedQuestion, ParseResult, RevisionRow } from './types.js';

export interface ParserPageInput {
  pageNo: number; // 1-기준
  text: string; // 정규화된 페이지 텍스트(extract.ts 산출물)
}

export function parseQuestionPdf(pages: ParserPageInput[]): ParseResult {
  const warnings: string[] = [];

  const categoryName = extractCategoryName(pages);
  if (categoryName === null) warnings.push('표지에서 분야명을 찾지 못함');

  const bodyStartPage = findBodyStartPage(pages);
  if (bodyStartPage === null) warnings.push('본문 문항 헤더(유형기호+번호)를 한 건도 찾지 못함');

  const frontMatter = bodyStartPage === null ? pages : pages.filter((p) => p.pageNo < bodyStartPage);
  const bodyPages = bodyStartPage === null ? [] : pages.filter((p) => p.pageNo >= bodyStartPage);

  const revisionSummary = parseRevision(frontMatter, warnings);
  // 목차 파싱 실패(빈 Map) 시 챕터는 전부 null — UI가 문항번호 접두 그룹핑으로 폴백하고,
  // 드라이런 리포트가 "챕터 없음"을 집계해 알린다 (파서 경고로는 남기지 않음 — 픽스처 소음 방지)
  const toc = parseToc(frontMatter);
  const usedTocKeys = new Set<string>();
  const questions = parseBody(bodyPages, categoryName, toc, usedTocKeys, warnings);
  // 본문에서 한 번도 매칭되지 않은 목차 챕터 = 그 구간 문항이 직전 챕터로 오배정됐다는 신호
  // (미탐의 실패 모드는 null 이 아니라 '상속'이라 카운트로는 안 잡힌다 — 반드시 경고로 가시화)
  if (questions.length > 0) {
    for (const [key, entry] of toc) {
      if (!usedTocKeys.has(key)) warnings.push(`목차 챕터가 본문에서 미매칭: "${entry.title}"`);
    }
  }

  // 교차검증(§6.2-4): 개정표 '삭제' 문항이 본문에 존재하면 확인 필요
  const bodyNos = new Set(questions.map((q) => q.questionNo));
  for (const r of revisionSummary) {
    if (r.kind === 'deleted' && bodyNos.has(r.questionNo)) {
      warnings.push(`개정표 '삭제' 문항 ${r.questionNo}이(가) 본문에 존재 — 확인 필요`);
    }
  }

  return { categoryCode: null, categoryName, revisionSummary, questions, warnings };
}

// ---------------------------------------------------------------------------
// 표지 분야명
// ---------------------------------------------------------------------------

/** 표지 "…심사점검표" 다음 비어있지 않은 줄 = 분야명. 폴백: 개정표 "(Summary of Changes)" 다음 줄. */
function extractCategoryName(pages: ParserPageInput[]): string | null {
  for (const p of pages.slice(0, 2)) {
    const lines = p.text.split('\n').map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (COVER_TITLE_RE.test(lines[i]!)) {
        const next = lines.slice(i + 1).find((l) => l.length > 0);
        if (next) return next;
      }
    }
  }
  for (const p of pages.slice(0, 3)) {
    const lines = p.text.split('\n').map((l) => l.trim());
    const idx = lines.findIndex((l) => SUMMARY_OF_CHANGES_RE.test(l));
    if (idx >= 0) {
      const next = lines.slice(idx + 1).find((l) => l.length > 0);
      if (next) return next;
    }
  }
  return null;
}

/** 첫 문항 헤더(단일 줄·줄 걸침 모두)가 등장하는 페이지(=본문 시작). 없으면 null. */
function findBodyStartPage(pages: ParserPageInput[]): number | null {
  for (const p of pages) {
    const lines = p.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matchQuestionHeader(lines[i]!, lines[i + 1])) return p.pageNo;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 개정 요약표 (신규/수정/삭제 3섹션 — 다분야 파일은 소분야별 반복분을 모두 누적)
// ---------------------------------------------------------------------------

function parseRevision(frontMatter: ParserPageInput[], warnings: string[]): RevisionRow[] {
  const rows: RevisionRow[] = [];
  let started = false;
  let stopped = false;
  let section: RevisionRow['kind'] | null = null;

  for (const p of frontMatter) {
    if (stopped) break;
    const lines = p.text.split('\n').map((l) => l.trim());
    if (!started) {
      if (REVISION_PAGE_RE.test(p.text)) started = true;
      else continue;
    }
    // 개정표가 여러 페이지에 걸칠 때, 목차 페이지 앞에서 종료
    const firstNonEmpty = lines.find((l) => l.length > 0) ?? '';
    if (TOC_RE.test(firstNonEmpty)) break;

    for (const l of lines) {
      if (REVISION_CLASSIFICATION_RE.test(l)) {
        stopped = true; // "• 문항분류체계" 도달 — 개정표 종료
        break;
      }
      const sm = REVISION_SECTION_RE.exec(l);
      if (sm) {
        section = REVISION_KIND_MAP[sm[1]!] ?? null;
        continue;
      }
      if (REVISION_HEADER_ROW_RE.test(l)) continue; // "문항번호 사유/수정유형"
      if (l === '-') continue; // 빈 섹션
      const rm = REVISION_ROW_RE.exec(l);
      if (rm && section) {
        const no = normalizeQuestionNo(rm[1]!);
        if (!QUESTION_NO_RE.test(no)) warnings.push(`개정표 문항번호 형식 이상: "${no}"`);
        rows.push({ kind: section, questionNo: no, note: rm[2]!.trim() });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 목차 → 챕터 (Phase 3b)
// ---------------------------------------------------------------------------

/** frontMatter에서 "목 차" 페이지 이후의 목차 항목을 수집한다(키 = 무공백 매칭 키). 실패 시 빈 Map. */
function parseToc(frontMatter: ParserPageInput[]): Map<string, TocEntry> {
  const byKey = new Map<string, TocEntry>();
  let started = false;
  for (const p of frontMatter) {
    const lines = p.text.split('\n').map((l) => l.trim());
    if (!started) {
      const idx = lines.findIndex((l) => TOC_RE.test(l));
      if (idx < 0) continue;
      started = true;
      for (const e of parseTocEntries(lines.slice(idx + 1))) byKey.set(chapterMatchKey(e.title), e);
      continue;
    }
    // 목차가 다음 페이지로 이어지는 경우("목 차" 헤더 없이 항목 계속)
    for (const e of parseTocEntries(lines)) byKey.set(chapterMatchKey(e.title), e);
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// 본문 문항 블록 (상태기계)
// ---------------------------------------------------------------------------

type BodyState = 'body' | 'score' | 'expl' | 'between';

interface OpenQuestion {
  questionNo: string;
  questionType: NonNullable<ParsedQuestion['questionType']>;
  gradeSymbol: string;
  bodyLines: string[];
  scoreLines: string[];
  explLines: string[];
  scoreAnchorSeen: boolean;
  loc: string;
  chapterMajor: string | null; // 헤더 등장 시점의 현재 챕터 (Phase 3b)
  chapterMinor: string | null;
}

interface FlatLine {
  pageNo: number;
  lineNo: number;
  text: string;
}

function parseBody(
  bodyPages: ParserPageInput[],
  categoryName: string | null,
  toc: Map<string, TocEntry>,
  usedTocKeys: Set<string>,
  warnings: string[],
): ParsedQuestion[] {
  const flat = flattenBody(bodyPages, categoryName);
  const questions: ParsedQuestion[] = [];
  const seen = new Set<string>();

  let open: OpenQuestion | null = null;
  let state: BodyState = 'between';
  // 현재 챕터 (본문 섹션 헤더 중 목차에 존재하는 제목만 경계로 인정 — Phase 3b)
  let curMajor: string | null = null;
  let curMinor: string | null = null;

  const finalize = () => {
    if (!open) return;
    const trimmedBodyLines = open.bodyLines.map((s) => s.trim()).filter((s) => s.length > 0);
    const trimmedExplLines = open.explLines.map((s) => s.trim()).filter((s) => s.length > 0);
    const body = [...trimmedBodyLines, ...trimmedExplLines].join('\n').trim();
    const topic = trimmedBodyLines.join('\n').trim(); // 질문문만 — 설명 제외 (Phase 3b)
    const score = extractScore(open.scoreLines);
    const subItems = extractSubItems(trimmedExplLines);
    // 합산표가 있으면 임계표는 항목 하위 중첩분 — 독립 자동배점 후보로 중복 보고하지 않는다
    const autoCandidate = subItems ? null : extractThresholdCandidate(trimmedExplLines);

    if (!open.scoreAnchorSeen) {
      warnings.push(`${open.loc}: 배점/예 앵커 없음 (${open.questionNo})`);
    } else if (score.missing) {
      warnings.push(`${open.loc}: 배점 값 미검출 (${open.questionNo})`);
    }
    if (score.nonstandard) {
      warnings.push(`${open.loc}: 비표준 배점 표기 — ${open.questionNo} 배점 ${score.maxScore} 추출(권장/예정)`);
    }
    if (!QUESTION_NO_RE.test(open.questionNo)) {
      warnings.push(`${open.loc}: 문항번호 형식 이상 "${open.questionNo}"`);
    }
    if (seen.has(open.questionNo)) {
      warnings.push(`${open.loc}: 중복 문항번호 ${open.questionNo}`);
    }
    seen.add(open.questionNo);
    if (body.length === 0) warnings.push(`${open.loc}: 본문 없는 문항 ${open.questionNo}`);

    questions.push({
      questionNo: open.questionNo,
      body,
      maxScore: score.maxScore,
      allowNa: score.allowNa,
      questionType: open.questionType,
      gradeSymbol: open.gradeSymbol,
      topic: topic.length > 0 ? topic : null,
      chapterMajor: open.chapterMajor,
      chapterMinor: open.chapterMinor,
      subItems,
      autoCandidate,
    });
    open = null;
  };

  for (let i = 0; i < flat.length; i++) {
    const cur = flat[i]!;
    const t = cur.text.trim();

    // 문항 헤더는 상태와 무관하게 최우선 판정(줄 걸침 2줄 병합)
    const hm = matchQuestionHeader(cur.text, flat[i + 1]?.text);
    if (hm) {
      finalize();
      open = {
        questionNo: hm.questionNo,
        questionType: hm.questionType,
        gradeSymbol: hm.gradeSymbol,
        bodyLines: hm.restBody.length > 0 ? [hm.restBody] : [],
        scoreLines: [],
        explLines: [],
        scoreAnchorSeen: false,
        loc: `p${cur.pageNo} 행${cur.lineNo}`,
        chapterMajor: curMajor,
        chapterMinor: curMinor,
      };
      state = 'body';
      if (hm.consumed === 2) i++; // 유형기호+번호 줄 소비
      continue;
    }

    // 챕터 경계 — 목차에 존재하는 대/중분류 제목만 인정 (상태 무관: 목차 대조가 오인식을 차단.
    // body/score 상태에서 도달했다면 설명 앵커 없이 문항이 끝난 것 — 경고 후 경계 처리)
    if (toc.size > 0) {
      const ch = matchChapterHeading(t, toc, usedTocKeys);
      if (ch) {
        if (open && (state === 'body' || state === 'score')) {
          warnings.push(`${cur.pageNo}p: 설명 앵커 없이 챕터 경계 도달 (${open.questionNo})`);
        }
        if (ch.kind === 'major') {
          curMajor = ch.title;
          curMinor = null; // 새 대분류 → 중분류 초기화
        } else {
          curMinor = ch.title;
        }
        if (state !== 'between') state = 'between'; // 설명/배점 수집 종료
        continue;
      }
    }

    if (!open) continue; // 첫 헤더 이전(잔여 표지/목차·안내문)
    if (t.length === 0) continue;

    if (state === 'body') {
      const sa = matchScoreAnchor(t);
      if (sa) {
        open.scoreAnchorSeen = true;
        if (sa.inline.length > 0) open.scoreLines.push(sa.inline);
        state = 'score';
        continue;
      }
      const ex = matchExplanationAnchor(t);
      if (ex) {
        if (ex.inline.length > 0) open.explLines.push(ex.inline);
        state = 'expl'; // 배점 앵커 없이 설명으로 진입(비정상) — finalize에서 경고
        continue;
      }
      open.bodyLines.push(t);
      continue;
    }
    if (state === 'score') {
      const ex = matchExplanationAnchor(t);
      if (ex) {
        if (ex.inline.length > 0) open.explLines.push(ex.inline);
        state = 'expl';
        continue;
      }
      open.scoreLines.push(t);
      continue;
    }
    if (state === 'expl') {
      if (isSectionTitle(t)) state = 'between'; // 다음 문항까지 대·중분류 제목/안내문 건너뜀
      else open.explLines.push(t);
      continue;
    }
    // state === 'between': 문항 블록 사이 — 다음 "문항" 헤더까지 건너뜀
  }
  finalize();
  return questions;
}

/** 본문 페이지들을 한 스트림으로 평탄화하며 페이지 상단 헤더(쪽번호 + 분야명 반복)를 제거한다. */
function flattenBody(bodyPages: ParserPageInput[], categoryName: string | null): FlatLine[] {
  const flat: FlatLine[] = [];
  for (const p of bodyPages) {
    const raw = p.text.split('\n');
    let s = 0;
    if (raw[s] !== undefined && PAGE_NUMBER_RE.test(raw[s]!.trim())) s++;
    if (categoryName !== null && raw[s]?.trim() === categoryName) s++;
    for (let i = s; i < raw.length; i++) {
      flat.push({ pageNo: p.pageNo, lineNo: i + 1, text: raw[i]! });
    }
  }
  return flat;
}
