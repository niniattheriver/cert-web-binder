// 2027 가상 개정판 콘텐츠 — content.mjs(2026)를 원본으로 삼아 "변경분(delta)만" 적용한다.
// 복사본을 따로 두지 않고 변환으로 만들기 때문에 2026 원문이 바뀌면 여기서 즉시 오류가 난다(드리프트 방지).
// 전부 자체 창작 가상 콘텐츠이며 실존 인증기관·심사문항과 무관하다.
//
// 2027 변경 요약 (연차 자동 이관/재연결 데모용):
//   지침서A(개인정보 처리지침): 제12조 ① "지체 없이 파기" → "5일 이내에 파기"
//     → 데모 근거(제12조 인용문)가 신판 전문과 정확 일치하지 않게 됨(검토 목록 데모).
//     제4조는 문구 완전 유지 → 자동 이관 데모. 호수·시행일만 2027로.
//   지침서B(정보보안 운영지침): 제13조(백업 및 복구) 완전 유지(자동 이관 데모).
//     제18조 ②만 경미 수정("별도의 전문 교육" → "연 1회 이상 별도의 전문 교육").
//   문항 50: 신규 50.090.020 · 수정 50.010.010(설명)·50.040.020(배점 3→4) · 삭제 50.020.030.
//   문항 60: 수정 60.060.010(설명)만. 나머지 문항 텍스트는 2026과 동일.
import {
  guidelineA as A2026,
  guidelineB as B2026,
  questions50 as q50_2026,
  questions60 as q60_2026,
  COVER_TITLE,
  PUBLISHER,
} from './content.mjs';

export { COVER_TITLE, PUBLISHER };
export const YEAR_MONTH = '2027. 01';

const clone = (o) => JSON.parse(JSON.stringify(o));

/** 원문에 from이 정확히 1회 존재해야 치환한다 — 2026 원본이 바뀌면 여기서 즉시 실패. */
function mustReplace(s, from, to) {
  const first = s.indexOf(from);
  if (first === -1 || s.indexOf(from, first + 1) !== -1) {
    throw new Error(`2027 delta 적용 실패 — 2026 원문에서 정확히 1회 발견되어야 함: "${from}"`);
  }
  return s.replace(from, to);
}

function findItem(q, num) {
  const it = q.items.find((i) => i.num === num);
  if (!it) throw new Error(`2027 delta 적용 실패 — 2026 문항 없음: ${num}`);
  return it;
}

// ---------------------------------------------------------------------------
// 지침서 A — 개인정보 처리지침 2027 개정판
// ---------------------------------------------------------------------------
export const guidelineA = clone(A2026);
guidelineA.subtitle = '가상기관 규정 제2027-1호 · 2027. 1. 1. 시행';
{
  const art12 = guidelineA.articles.find((a) => a.no === 12);
  art12.paras[0] = mustReplace(art12.paras[0], '지체 없이 파기한다.', '5일 이내에 파기한다.');
}

// ---------------------------------------------------------------------------
// 지침서 B — 정보보안 운영지침 2027 개정판 (제13조 백업 및 복구는 문구 완전 유지)
// ---------------------------------------------------------------------------
export const guidelineB = clone(B2026);
guidelineB.subtitle = '가상기관 규정 제2027-2호 · 2027. 1. 1. 시행';
{
  const art18 = guidelineB.articles.find((a) => a.no === 18);
  art18.paras[1] = mustReplace(art18.paras[1], '별도의 전문 교육을 제공한다.', '연 1회 이상 별도의 전문 교육을 제공한다.');
}

// ---------------------------------------------------------------------------
// 문항 50 — 개인정보 보호 2027 개정판
// ---------------------------------------------------------------------------
export const questions50 = clone(q50_2026);
questions50.yearMonth = YEAR_MONTH;
questions50.revision = {
  new: [{ num: '50.090.020', note: '신규 문항' }],
  modified: [
    { num: '50.010.010', note: '설명 수정' },
    { num: '50.040.020', note: '배점 변경' },
  ],
  deleted: [{ num: '50.020.030', note: '문항 삭제' }],
};
{
  // 수정: 50.010.010 설명 문구 일부 변경
  const it = findItem(questions50, '50.010.010');
  it.expl = mustReplace(it.expl, '대행 근거를 함께 확인한다.', '대행 근거와 지정 기간을 함께 확인한다.');
  // 수정: 50.040.020 배점 변경 3 → 4 ("(N) 아니오" 줄의 배점 숫자가 바뀐다)
  const sc = findItem(questions50, '50.040.020');
  if (sc.score !== '3') throw new Error('2027 delta 적용 실패 — 50.040.020의 2026 배점이 3이 아님');
  sc.score = '4';
  // 삭제: 50.020.030 은 본문에서 제거(개정표 • 삭제에만 남는다)
  const before = questions50.items.length;
  questions50.items = questions50.items.filter((i) => i.num !== '50.020.030');
  if (questions50.items.length !== before - 1) throw new Error('2027 delta 적용 실패 — 50.020.030 제거 안 됨');
  // 신규: 50.090.020 (절 090 "국외 이전"의 새 문항 — 이전 내역 통지)
  questions50.items.push({
    num: '50.090.020', type: 'basic', score: '2', na: true,
    body: '개인정보를 국외로 이전하는 경우 이전받는 자, 이전 항목, 이전 목적을 정보주체에게 알리고 그 내역을 기록하여 관리하고 있는가?',
    expl: '2027년도 신규 문항이다. 국외 이전이 없는 기관은 해당없음으로 처리할 수 있다.',
  });
}

// ---------------------------------------------------------------------------
// 문항 60 — 정보보안 2027 개정판 (수정 1건만)
// ---------------------------------------------------------------------------
export const questions60 = clone(q60_2026);
questions60.yearMonth = YEAR_MONTH;
questions60.revision = {
  new: [],
  modified: [{ num: '60.060.010', note: '설명 수정' }],
  deleted: [],
};
{
  // 수정: 60.060.010 백업 관련 설명 문구 변경
  const it = findItem(questions60, '60.060.010');
  it.expl = mustReplace(it.expl, '보관하는지 확인한다.', '보관하는지와 백업 수행 기록을 함께 확인한다.');
}
