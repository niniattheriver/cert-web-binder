// ============================================================================
// 문항 PDF 서식 패턴 — 실물 인증기관 서식 전용.
//   대상: 대한진단검사의학회·진단검사의학재단 「2026 우수검사실 신임인증 심사점검표」(14개 분야 파일)
//
// ★ 서식이 도착·변경되면 **이 파일만 교체**한다. index.ts(파싱 흐름)와 types.ts(결과 모델)는
//   서식과 무관하게 유지하는 것이 설계 원칙이다. (설계서 §6.2-1) 합성(가상) 서식 규칙은 폐기했다.
//
// 실물 서식(pdfjs legacy 추출 텍스트 기준) 요약 ─ 아래 규칙은 14파일 실측으로 검증됨:
//   p.1 표지     : "90"(분야 첫 그룹) / "우수검사실" / "신임인증 심사점검표" / [분야명] / 발행기관 / "2026. 01"
//   p.2~ 개정표  : "2026 년 개정판 변경내역 요약" · "(Summary of Changes)" · [분야명]
//                  "• 신규"  → 헤더행 "문항번호 사유"     → 데이터행 "[번호] [사유]"      (없으면 "-")
//                  "• 수정"  → 헤더행 "문항번호 수정유형" → 데이터행 "[번호] [수정유형]"  (없으면 "-")
//                  "• 삭제"  → 헤더행 "문항번호 사유"     → 데이터행 "[번호] [사유]"      (없으면 "-")
//                  ※ 다분야 파일(임상미생물=30~36, 수혈=40·43·46 등)은 소분야마다 3섹션이 반복된다.
//   분류체계     : "• 문항분류체계" 섹션(핵심C/필요R/기본B 설명표) → 무시.
//                  주의: 개정표 데이터행 "…문항분류체계 수정" 은 분류체계 페이지가 아니다 →
//                  분류체계 경계는 반드시 줄 선두 "• 문항분류체계"(불릿) 로만 판정한다.
//   목차         : "목 차" → 무시.
//   본문 문항 블록(반복):
//        "문항"                                   (단독 줄; 유형기호 줄과 걸침 → 다음 줄 병합)
//        "[기본B|필요R|핵심C] [번호] [본문 첫 줄…]"
//        "[본문 이어지는 줄…]"
//        "배점"   또는   "예"                       (배점 앵커 — 핵심 필수문항은 "예"/"(필수)")
//        "(N)"    또는   "(필수)"   또는  "권장" "(N점" "예정)"   (배점 값; 비표준 "권장 (N점 예정)"는 숫자만 추출)
//        "아니오"
//        "해당" "없음"   (또는 "해당없음")           (해당없음 허용 시 — 줄 걸침 가능)
//        "설명"   또는   "설명  없음"
//        " [설명 불릿…]"                            (맨 앞 공백+글머리; 설명은 본문에 포함)
//   페이지 상단  : "쪽번호"(단독 숫자 또는 "N / M") + 선택적 "[분야명]" 반복 → 제거.
// ============================================================================

import type { ParsedQuestion, RevisionRow } from './types.js';

// ---------------------------------------------------------------------------
// 문항번호
// ---------------------------------------------------------------------------

/** 정규화된 문항번호 정식 형태: NN.XXX.NNN (중간 그룹 영숫자 대문자 허용, 예 90.A01.080) */
export const QUESTION_NO_RE = /^\d{2}\.[0-9A-Z]{3}\.\d{3}$/;

/**
 * 관용(느슨) 문항번호 — 전각 숫자(０-９)·전각 마침표(．)·내부 공백 허용. 중간 그룹은 영숫자 대문자.
 * 매칭 후 반드시 normalizeQuestionNo로 정규화한다.
 */
export const QUESTION_NO_LOOSE_SRC =
  '[0-9０-９]{2}\\s*[.．]\\s*[0-9A-Z０-９]{3}\\s*[.．]\\s*[0-9０-９]{3}';

/** 전각 숫자·전각 마침표 → 반각 변환 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/．/g, '.');
}

/**
 * 문항번호 정규화: 모든 공백 제거 + 전각→반각. (도메인/옴니박스에서도 재사용 — index.ts가 재export)
 * 예: "９０.Ａ０１ . ０８０" → "90.A01.080"
 */
export function normalizeQuestionNo(raw: string): string {
  return toHalfWidth(raw).replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// 문항 헤더 (유형기호 + 번호 + 본문 첫 줄)
// ---------------------------------------------------------------------------

/** "문항" 마커 토큰 */
export const QUESTION_MARKER = '문항';

/** 유형기호(핵심/필요/기본 + C/R/B) → questionType / gradeSymbol */
export const GRADE_MAP: Record<string, { type: NonNullable<ParsedQuestion['questionType']>; symbol: string }> = {
  핵심: { type: 'core', symbol: 'C' },
  필요: { type: 'required', symbol: 'R' },
  기본: { type: 'basic', symbol: 'B' },
};

/** 유형기호+번호+본문 줄: "기본B 90.010.090 지난번 심사에서…" (그룹 1=유형어, 2=기호, 3=번호, 4=본문) */
export const GRADE_NUM_HEADER_RE = new RegExp(
  `^(핵심|필요|기본)([CRB])\\s+(${QUESTION_NO_LOOSE_SRC})\\s*(.*)$`,
);

export interface HeaderMatch {
  questionNo: string; // 정규화 완료
  rawNo: string; // 정규화 전 원문(경고 표기용)
  questionType: NonNullable<ParsedQuestion['questionType']>;
  gradeSymbol: string;
  restBody: string; // 헤더 줄의 본문 첫 조각
  consumed: 1 | 2; // 소비한 줄 수(1=한 줄 헤더, 2=문항/유형기호 줄 걸침)
}

/**
 * 문항 헤더 판정 — "문항" 마커가 있어야 한다(본문/설명 내 유사 문자열 오검출 차단).
 *   · "문항 기본B 90.010.090 본문"  → 한 줄 헤더(consumed 1)
 *   · "문항" + 다음 줄 "기본B 90.010.090 본문"  → 줄 걸침 헤더(consumed 2)
 * curLine이 "문항"으로 시작하지 않거나 유형기호+번호가 없으면 null.
 */
export function matchQuestionHeader(curLine: string, nextLine: string | undefined): HeaderMatch | null {
  const t = curLine.trim();
  if (!t.startsWith(QUESTION_MARKER)) return null;
  const afterMarker = t.slice(QUESTION_MARKER.length).trim();
  let m: RegExpExecArray | null;
  let consumed: 1 | 2;
  if (afterMarker.length > 0) {
    m = GRADE_NUM_HEADER_RE.exec(afterMarker);
    consumed = 1;
  } else {
    m = nextLine !== undefined ? GRADE_NUM_HEADER_RE.exec(nextLine.trim()) : null;
    consumed = 2;
  }
  if (!m) return null;
  const grade = GRADE_MAP[m[1]!]!;
  return {
    rawNo: m[3]!,
    questionNo: normalizeQuestionNo(m[3]!),
    questionType: grade.type,
    gradeSymbol: m[2]!, // 원문 기호(핵심C의 C 등)
    restBody: (m[4] ?? '').trim(),
    consumed,
  };
}

// ---------------------------------------------------------------------------
// 배점 창 (배점 앵커 → 값/해당없음 → 설명)
// ---------------------------------------------------------------------------

/**
 * 배점 앵커 판정 — "배점"(일반) 또는 "예"(핵심 필수문항의 예/아니오 열 머리).
 * 값이 같은 줄에 병합된 "배점 (N)" · "예 (필수)"도 앵커로 보고 병합분을 배점 창으로 넘긴다.
 *   "배점"·"예" → { inline: '' } · "예 (필수)" → { inline: '(필수)' }
 * 반환 null이면 앵커 아님.
 */
export function matchScoreAnchor(t: string): { inline: string } | null {
  if (t === '배점' || t === '예') return { inline: '' };
  if (/^배점\s*\(/.test(t)) return { inline: t.slice('배점'.length).trim() };
  if (/^예\s*\(/.test(t)) return { inline: t.slice('예'.length).trim() };
  return null;
}

/**
 * 설명 앵커 판정 — "설명" 라벨과 그 줄에 병합된 첫 설명 내용을 분리한다(추출 레이아웃 편차 대응).
 *   "설명"·"설명  없음" → { inline: '' }
 *   "설명  업무 인계에 대한 문서가…" → { inline: '업무 인계에 대한 문서가…' }
 *   "설명서를 확인한다"(설명+비공백) → null (앵커 아님)
 * 병합을 분리하지 않으면 설명 전체가 배점 창으로 흘러들어 해당없음/본문이 오염된다.
 */
export function matchExplanationAnchor(t: string): { inline: string } | null {
  if (!t.startsWith('설명')) return null;
  const rest = t.slice('설명'.length);
  if (rest.length === 0) return { inline: '' };
  if (!/^\s/.test(rest)) return null; // "설명서…" — 앵커 아님
  const inline = rest.trim();
  return { inline: inline === '없음' ? '' : inline };
}

export interface ScoreInfo {
  maxScore: number | null;
  allowNa: boolean;
  mandatory: boolean; // 핵심 필수문항 "(필수)" — 배점 없음(정상)
  nonstandard: boolean; // "권장 (N점 예정)" 등 비표준 표기에서 숫자만 추출(경고)
  missing: boolean; // 앵커는 있었으나 배점 값도 "필수"도 찾지 못함(경고)
}

/**
 * 배점 창(앵커 다음 ~ "설명" 전 줄들)에서 배점·해당없음을 추출한다.
 * 설명 내부의 "(1)(2)" 나열은 애초에 이 창에 포함되지 않는다(창을 "설명" 앞에서 끊음).
 *   · "(8)" → 8 · "(필수)" → mandatory(null) · "권장 (4점 예정)" → 4(nonstandard)
 *   · allowNa = 창 텍스트(공백/줄바꿈 무시)에 "해당없음" 존재
 */
export function extractScore(windowLines: string[]): ScoreInfo {
  const merged = windowLines.join(' ');
  const compact = merged.replace(/\s/g, '');
  const allowNa = compact.includes('해당없음');
  if (/필수/.test(compact)) {
    return { maxScore: null, allowNa, mandatory: true, nonstandard: false, missing: false };
  }
  const nm = /(\d+(?:\.\d+)?)/.exec(merged);
  if (nm) {
    return {
      maxScore: Number(nm[1]),
      allowNa,
      mandatory: false,
      nonstandard: /권장|예정/.test(merged),
      missing: false,
    };
  }
  return { maxScore: null, allowNa, mandatory: false, nonstandard: false, missing: true };
}

// ---------------------------------------------------------------------------
// 페이지 헤더/푸터 · 대·중분류 제목(설명 경계)
// ---------------------------------------------------------------------------

/** 페이지 상단 쪽번호: 단독 숫자 또는 "N / M" */
export const PAGE_NUMBER_RE = /^\d{1,3}(?:\s*\/\s*\d{1,3})?$/;

/** 대분류 제목(본문): "3 질관리: 일반", "8 인력", "10 안전" — 숫자 + 공백 + (숫자 아닌) 제목 */
export const MAJOR_SECTION_RE = /^\d{1,2}\s+[^\d\s].*$/;
/** 중분류 제목(본문): "1. 검사지침서", "3. 보정(calibration)" — 숫자 + "." + 공백 + 제목 */
export const MINOR_SECTION_RE = /^\d{1,2}\.\s+\S.*$/;

/** 문항 블록 사이의 대/중분류 제목 여부 — 설명 수집을 여기서 끊고 다음 "문항"까지 안내문을 건너뛴다. */
export function isSectionTitle(t: string): boolean {
  return MAJOR_SECTION_RE.test(t) || MINOR_SECTION_RE.test(t);
}

// ---------------------------------------------------------------------------
// 표지 · 목차
// ---------------------------------------------------------------------------

/** 표지 제목 줄(다음 줄이 분야명) */
export const COVER_TITLE_RE = /심사점검표/;
/** 표지 폴백용: 개정표의 영문 부제 */
export const SUMMARY_OF_CHANGES_RE = /Summary\s+of\s+Changes/;
/** 목차 페이지 첫 줄 */
export const TOC_RE = /^목\s*차$/;

// ---------------------------------------------------------------------------
// 목차 항목 → 챕터 (Phase 3b — 설계서 §6.2)
//   목차행 = 대/중분류 제목 + 끝에 시작 페이지 번호: "3 질관리: 일반 7" / "1. 검사지침서 7"
//   본문 섹션 헤더는 같은 제목에서 페이지 번호만 없다. 본문에서 챕터 경계로 인정하는 것은
//   "목차에 존재하는 제목"뿐 — 임의 줄의 오인식(예: 설명 속 "3 개월 이내…")을 차단한다.
// ---------------------------------------------------------------------------

export interface TocEntry {
  kind: 'major' | 'minor';
  /** 번호 포함 제목 원문 (예: "3 질관리: 일반", "1. 검사지침서") */
  title: string;
}

/** 목차행: (대/중분류 제목) + 공백 + (1~3자리 페이지번호) */
const TOC_ENTRY_RE = /^(.+?)\s+(\d{1,3})$/;

/** 제목 표시용 정규화 — 내부 공백 붕괴 (추출 편차 대응) */
export function normalizeChapterTitle(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * 제목 매칭용 키 — 공백 전부 제거 + 소문자 + NFC.
 * 실물 목차↔본문 편차 실측: "검체채취 및 취급"↔"검체 채취 및 취급"(단어 내 공백),
 * "…검사 (NGS)"↔"…검사(NGS)"(괄호 앞 공백), "(flow …)"↔"(Flow …)"(대소문자) —
 * 공백/대소문자 유무로 미탐되면 문항이 직전 챕터로 조용히 오배정되므로 비교 키를 통일한다.
 */
export function chapterMatchKey(t: string): string {
  return t.replace(/\s+/g, '').toLowerCase().normalize('NFC');
}

/** 매칭 키에서 선두 번호(대: "N", 중: "N.")를 뗀 제목 본문 — 목차↔본문 번호 불일치 폴백용 */
function chapterTitleBodyKey(key: string): string {
  return key.replace(/^\d{1,2}\.?/, '');
}

/** 매칭 키에서 괄호 부제까지 제거 — "…(PNH)"↔"…(paroxysmal…, PNH)" 같은 목차 축약 흡수 */
function chapterCoreKey(key: string): string {
  return chapterTitleBodyKey(key).replace(/[(（].*$/, '');
}

/**
 * 목차 페이지 줄들에서 챕터 항목을 추출한다. 대분류("N 제목")/중분류("N. 제목") 골격만 인정.
 * 반환이 비면 목차 파싱 실패 — 챕터 없이 진행(UI는 문항번호 접두 그룹핑 폴백).
 */
export function parseTocEntries(lines: string[]): TocEntry[] {
  const out: TocEntry[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    const m = TOC_ENTRY_RE.exec(t);
    if (!m) continue;
    const title = normalizeChapterTitle(m[1]!);
    if (MINOR_SECTION_RE.test(title)) out.push({ kind: 'minor', title });
    else if (MAJOR_SECTION_RE.test(title)) out.push({ kind: 'major', title });
  }
  return out;
}

/**
 * 본문 줄이 목차의 챕터 제목이면 그 항목을 반환. 매칭 3단(실물 편차 실측 기반):
 *  1) 무공백 키 완전 일치
 *  2) 접두 일치 — 목차가 축약형이고 본문에 부제가 붙는 경우
 *     (예: 목차 "11 검사실자체개발검사" ↔ 본문 "11 검사실자체개발검사 (laboratory developed test, LDT)")
 *  3) 번호 제외 제목 일치 — 목차와 본문의 챕터 번호가 어긋난 경우
 *     (예: 진단면역 목차 "2 질관리: 일반" ↔ 본문 "1 질관리: 일반")
 * 반환되는 항목은 항상 목차 쪽 제목(정본). 매칭 시 usedKeys 에 목차 키를 기록해
 * '본문에서 한 번도 안 나온 목차 챕터'(= 오배정 신호)를 상위에서 경고할 수 있게 한다.
 */
export function matchChapterHeading(
  t: string,
  tocByKey: Map<string, TocEntry>,
  usedKeys?: Set<string>,
): TocEntry | null {
  if (!isSectionTitle(t)) return null;
  const key = chapterMatchKey(t);
  const exact = tocByKey.get(key);
  if (exact) {
    usedKeys?.add(key);
    return exact;
  }
  const sameKind = MINOR_SECTION_RE.test(t.trim()) ? 'minor' : 'major';
  const bodyTitle = chapterTitleBodyKey(key);
  const bodyCore = chapterCoreKey(key);
  for (const [tocKey, entry] of tocByKey) {
    if (entry.kind !== sameKind) continue; // 대분류↔중분류 혼동 방지
    // 2) 접두: 본문 제목이 목차 제목으로 시작 (부제 허용). 과매칭 방지 최소 길이 4.
    if (tocKey.length >= 4 && key.startsWith(tocKey)) {
      usedKeys?.add(tocKey);
      return entry;
    }
    // 3) 번호 제외 제목 일치 — 목차↔본문 번호가 어긋난 경우
    if (bodyTitle.length >= 3 && chapterTitleBodyKey(tocKey) === bodyTitle) {
      usedKeys?.add(tocKey);
      return entry;
    }
    // 4) 괄호 부제 제거 후 핵심 제목 일치 — 목차 축약(PNH) vs 본문 전개(paroxysmal…, PNH)
    if (bodyCore.length >= 4 && chapterCoreKey(tocKey) === bodyCore) {
      usedKeys?.add(tocKey);
      return entry;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 세부 평가항목 표 (합산 — Phase 3b. 설명 창 내부에 위치)
//   헤더 3형: "평가항목 배점[ 점수]" / "평가항목 배정[ 점수]"      → 행 "[항목명] [배점숫자]"
//             "평가항목 배점 2점 1점 0점" (점수구간 매트릭스)      → 행 "(n) [항목명] [N]점 …조건들"
//             "평가항목 배점 예 아니오"  (체크 매트릭스)           → 행 "(n) [항목명] [N]점"
//   비대상: "평가(점검)항목 예 아니요"(범위 점검표 — '아니요' 표기), "분야 배점 …"(감점 합산표).
//   계약 검증(Σ배점==문항배점 등)은 파서가 아니라 인입 계층이 수행한다.
// ---------------------------------------------------------------------------

/** 표 헤더 — 반드시 "평가항목"으로 시작 + 배점/배정 열 (범위 점검표 "평가(점검)항목"은 불일치) */
const SUBITEM_HEADER_RE = /^평가항목\s+(?:배점|배정)(?:\s|$)/;
/** 단순형 데이터행: "[항목명] [배점숫자]" (항목명에 숫자가 섞여도 끝 토큰만 배점) */
const SUBITEM_ROW_SIMPLE_RE = /^(.+?)\s+(\d+(?:\.\d+)?)$/;
/** 매트릭스형 데이터행: "(n) [항목명] [N]점 …" */
const SUBITEM_ROW_MATRIX_RE = /^\(\d+\)\s+(.+?)\s+(\d+(?:\.\d+)?)점(?:\s|$)/;

export interface ParsedSubItem {
  label: string;
  maxScore: number;
}

/**
 * 설명 창 줄들에서 세부 평가항목 표를 추출한다. 헤더가 없으면 null.
 * 임계표 행(백분율 구간)은 항목 하위 중첩이므로 건너뛰고 계속 수집한다.
 */
export function extractSubItems(explLines: string[]): ParsedSubItem[] | null {
  const headerIdx = explLines.findIndex((l) => SUBITEM_HEADER_RE.test(l.trim()));
  if (headerIdx < 0) return null;
  const items: ParsedSubItem[] = [];
  for (let i = headerIdx + 1; i < explLines.length; i++) {
    const t = explLines[i]!.trim();
    if (t.length === 0) continue;
    if (isThresholdRow(t)) continue; // 항목 하위 임계표 — 항목 아님
    const matrix = SUBITEM_ROW_MATRIX_RE.exec(t);
    if (matrix) {
      items.push({ label: normalizeChapterTitle(matrix[1]!), maxScore: Number(matrix[2]) });
      continue;
    }
    const simple = SUBITEM_ROW_SIMPLE_RE.exec(t);
    if (simple && !/%/.test(simple[1]!)) {
      items.push({ label: normalizeChapterTitle(simple[1]!), maxScore: Number(simple[2]) });
      continue;
    }
    break; // 표 종료 (다음 불릿/문장)
  }
  return items.length > 0 ? items : null;
}

// ---------------------------------------------------------------------------
// 자동배점 임계표 (Phase 3b — 후보 감지 + 추출까지만. 바인딩·활성화는 수동 — A-3)
//   실측 2형(모두 백분율):
//     실시율형: "100% (8)" / "90~99% (7)" / "80-89% (6)" / "60% 미만 (4)"  (구분자 ~/- 혼재)
//     할인율형: "할인율 0% 16" / "할인율 15% 미만 12" / "할인율 15% 이상 30% 미만 8" / "할인율 70% 이상 0"
// ---------------------------------------------------------------------------

const THRESHOLD_RATE_RE =
  /^(\d{1,3})(?:\s*[~\-]\s*(\d{1,3}))?\s*%\s*(미만|이상)?\s*\((\d+(?:\.\d+)?)\)$/;
const THRESHOLD_DISCOUNT_RE =
  /^할인율\s+(\d{1,3})\s*%(?:\s*(미만|이상))?(?:\s+(\d{1,3})\s*%\s*미만)?\s+(\d+(?:\.\d+)?)$/;

export function isThresholdRow(t: string): boolean {
  return THRESHOLD_RATE_RE.test(t) || THRESHOLD_DISCOUNT_RE.test(t);
}

export interface ThresholdCandidate {
  /** 원문 행 — 드라이런 리포트·수동 바인딩 참고용 */
  rows: string[];
}

/** 설명 창에서 임계표 행들을 수집한다(연속일 필요 없음). 2행 이상일 때만 후보로 인정. */
/** "…에 따라 자동 배점된다/자동배점 됩니다" — 외부 제출자료 기반 자동배점 명시 문구 */
export const AUTO_SCORE_PHRASE_RE = /자동\s?배점/;

export function extractThresholdCandidate(explLines: string[]): ThresholdCandidate | null {
  const rows = explLines.map((l) => l.trim()).filter((t) => isThresholdRow(t));
  if (rows.length >= 2) return { rows };
  // 구간표가 없어도 본문이 자동배점을 명시하면 후보로 표시한다 —
  // 예: "점수는 제출하신 전문의 수에 근거하여 자동 배점됩니다." (07.702.220 등 4문항 실측)
  const phrase = explLines.map((l) => l.trim()).find((t) => AUTO_SCORE_PHRASE_RE.test(t));
  return phrase ? { rows: [phrase] } : null;
}

// ---------------------------------------------------------------------------
// 개정 요약표
// ---------------------------------------------------------------------------

/** 개정 요약표 페이지 식별 */
export const REVISION_PAGE_RE = /변경내역\s*요약|Summary\s+of\s+Changes/;
/** 섹션 머리 "• 신규 / • 수정 / • 삭제" (여러 불릿 글리프 허용) */
export const REVISION_SECTION_RE = /^[•·∙・‧]\s*(신규|수정|삭제)$/;
/** 분류체계 경계 "• 문항분류체계" (개정표 종료 신호 — 반드시 불릿 선두로만 판정) */
export const REVISION_CLASSIFICATION_RE = /^[•·∙・‧]\s*문항\s*분류\s*체계/;
/** 섹션 헤더행 "문항번호 사유" / "문항번호 수정유형" (데이터 아님) */
export const REVISION_HEADER_ROW_RE = /^문항번호\s*(?:사유|수정유형)$/;
/** 빈 섹션 표기 "-" */
export const REVISION_EMPTY_ROW = '-';
/** 데이터행 "[번호] [사유/수정유형]" */
export const REVISION_ROW_RE = new RegExp(`^(${QUESTION_NO_LOOSE_SRC})\\s+(.+)$`);
/** 섹션 머리 → RevisionRow.kind */
export const REVISION_KIND_MAP: Record<string, RevisionRow['kind']> = {
  신규: 'new',
  수정: 'modified',
  삭제: 'deleted',
};
