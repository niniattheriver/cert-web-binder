/**
 * Office, 텍스트 추출기의 정본 글자에서 빼는 제어 문자
 *
 * 탭(U+0009), 줄바꿈(U+000A), 복귀(U+000D)를 뺀 C0 제어 문자와 DEL(U+007F), C1(U+0080~U+009F).
 * 글자가 문서에서 처음 들어오는 자리(docx canon, pptx 와 hwpx 의 run 글자, 표 칸 글자, 시트 이름, 텍스트 파일 해독)에서
 * normalizeText 앞에 쓴다. NUL 같은 제어 문자가 정본에 남으면 그 글자를 붙여 넣은 검색어에서 FTS5 구문 해석이 멈추고
 * (500), LIKE 비교는 NUL 뒤를 보지 못하고, 화면 글자에도 보이지 않는 글자가 섞였다.
 *
 * PDF 경로(pdf/normalize.ts)는 바꾸지 않는다: 기존 판본의 정본과 새 정규화가 어긋나는 '조용한 정규화 드리프트'를
 * 막기 위해서다(그 파일 머리 주석). Office 와 텍스트 판본은 이 규칙과 함께 처음 들어오는 형식이다.
 */
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** 정본에 두지 않는 제어 문자를 지운다 (탭, 줄바꿈, 복귀는 남긴다) */
export function stripControls(s: string): string {
  return s.replace(CONTROL_RE, '');
}
