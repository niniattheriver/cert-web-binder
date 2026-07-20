/** 공통 유틸 — 표시 포맷터 (UI 전용, 도메인 로직 없음) */

/** SQLite 정수 불리언(0/1)과 JS boolean을 모두 허용해 참/거짓으로 변환 */
export function truthy(v: boolean | 0 | 1 | number | null | undefined): boolean {
  return !!v;
}

/** ISO 일시 → 'YYYY-MM-DD HH:mm' (파싱 실패 시 원문 반환) */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 점수 표시 — 정수는 그대로, 소수는 한 자리(0.5 간격 채점) */
export function fmtNum(v: number | null | undefined): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

/** 오류 → 사용자 표시용 한국어 메시지 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 글머리기호 글리프 교정(표시용): 일부 PDF가 글머리기호를 사설영역(PUA) 코드포인트로 내보내
 * 표준 폰트에서 "두부(▯)"로 깨져 보인다. 알려진 불릿 PUA(U+F09F, U+F0B7)를
 * 마크다운 불릿 크기의 작은 동그라미 •(U+2022)로 치환한다(인라인 표시용).
 * 상세 본문은 QuestionBody가 이 문자를 감지해 들여쓰기+CSS 동그라미로 렌더한다.
 * 저장 텍스트는 건드리지 않는다(canon_norm 무접촉) — 표시 계층 전용.
 */
const BULLET_PUA_RE = new RegExp('[\\uF09F\\uF0B7]', 'g');
export function fixBullets(s: string | null | undefined): string {
  return s == null ? '' : s.replace(BULLET_PUA_RE, '•');
}
