/**
 * 논리 쪽의 사람용 위치 표기. web/src/office/pageLabel.ts 의 pageRefLabel 과 같은 규칙.
 *
 * - PDF, Word 가 저장한 쪽 나눔을 따른 docx: 'p.N'
 * - xlsx(그리고 이름이 있는 csv): '시트 이름'
 * - 이름표(label)가 있으면 그대로: pptx '슬라이드 N', 쪽 정보가 없는 docx '구간 N'
 * - hwpx, 이름표 없는 텍스트: '구간 N' (원래 프로그램의 쪽 번호가 아니라는 표시)
 * - 그림 파일: '그림' (한 장뿐이라 번호를 붙이지 않는다)
 */
export function pageRefLabel(
  fileKind: string | null | undefined,
  pageNo: number | null | undefined,
  label?: string | null,
): string {
  if (pageNo == null) return '';
  if (fileKind === 'image') return '그림';
  const name = label?.trim() ? label.trim() : null;
  if (fileKind === 'xlsx' || (fileKind === 'text' && name)) return `시트 ${name ?? pageNo}`;
  if (name) return name;
  if (fileKind === 'hwpx' || fileKind === 'text') return `구간 ${pageNo}`;
  return `p.${pageNo}`;
}
