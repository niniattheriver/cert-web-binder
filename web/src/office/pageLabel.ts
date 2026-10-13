/**
 * 문서 쪽 표기와 업로드 형식 공통 도우미
 *
 * 검사실 자료는 PDF 말고도 Word, Excel, PowerPoint, 한글(hwpx), 텍스트를 받는다. 형식마다 "쪽"이
 * 가리키는 것이 달라서(시트, 슬라이드, 구간) 근거 카드, 인쇄, 검색 결과, 업로드 요약이 모두 이 한곳의
 * 규칙으로 쪽을 부르게 한다. 화면 표시 전용이며 정본(page_text)과 오프셋은 건드리지 않는다.
 */

/** document_version.file_kind (server/src/office/model.ts 의 FileKind 와 같은 값) */
export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'hwpx' | 'text';

/** 형식 이름 (목록, 배지 표시용) */
export const FILE_KIND_LABEL: Readonly<Record<FileKind, string>> = {
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  hwpx: '한글',
  text: '텍스트',
};

/** 앞뒤 공백을 뗀 라벨. 비었거나 공백뿐이면 없는 것으로 본다 (서버 office/page-label.ts 와 같은 규칙) */
function usableLabel(label: string | null | undefined): string | null {
  const s = typeof label === 'string' ? label.trim() : '';
  return s !== '' ? s : null;
}

/**
 * 쪽 참조 표기: "어디"를 가리키는 짧은 말 (근거 카드, 인쇄, 검색 결과).
 * - 쪽 번호가 없으면 빈 문자열
 * - xlsx, 그리고 라벨이 있는 text(csv, tsv: 라벨 = 시트 이름) → `시트 이름` (라벨이 없으면 번호)
 * - 그 밖에 라벨이 있으면 라벨 그대로 (pptx '슬라이드 N', docx '구간 N')
 * - hwpx, 라벨 없는 text(txt, md) → `구간 N`
 * - 나머지 (pdf, 라벨 없는 docx, 형식 모름) → `p.N`
 */
export function pageRefLabel(
  fileKind: FileKind | null | undefined,
  pageNo: number | null | undefined,
  label?: string | null,
): string {
  if (pageNo == null) return '';
  const lbl = usableLabel(label);
  if (fileKind === 'xlsx' || (fileKind === 'text' && lbl !== null)) return `시트 ${lbl ?? pageNo}`;
  if (lbl !== null) return lbl;
  if (fileKind === 'hwpx' || fileKind === 'text') return `구간 ${pageNo}`;
  return `p.${pageNo}`;
}

/**
 * 쪽 수를 세는 단위 ("12쪽", "3시트", "8슬라이드", "5구간"). pageRefLabel 과 같은 단위가 되도록 첫 쪽의
 * 이름표를 함께 본다: 이름표가 있는 text(csv, tsv)는 시트, Word 쪽 정보가 없어 크기로 나눈 docx('구간 1')는 구간.
 */
export function pageUnit(
  fileKind: FileKind | null | undefined,
  firstPageLabel?: string | null,
): string {
  const named = usableLabel(firstPageLabel) !== null;
  switch (fileKind) {
    case 'xlsx':
      return '시트';
    case 'pptx':
      return '슬라이드';
    case 'hwpx':
      return '구간';
    case 'text':
      return named ? '시트' : '구간';
    case 'docx':
      return named ? '구간' : '쪽';
    case 'pdf':
    default:
      return '쪽';
  }
}

/** 근거자료 라이브러리가 받는 확장자 (서버 detect.ts ACCEPTED_EXTENSIONS 와 같은 목록) */
const DOC_UPLOAD_EXTS = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'hwpx', 'hwp', 'txt', 'csv', 'tsv', 'md'] as const;

/** 파일 선택 창의 accept 값: '.pdf,.docx,.doc,.xlsx,.xls,.pptx,.hwpx,.hwp,.txt,.csv,.tsv,.md' */
export const DOC_UPLOAD_ACCEPT: string = DOC_UPLOAD_EXTS.map((ext) => `.${ext}`).join(',');

/** 받을 수 있는 파일 이름인가 (끝 확장자, 대소문자 무시). g 플래그가 없어 test() 를 거듭 불러도 안전하다 */
export const DOC_UPLOAD_EXT_RE = new RegExp(`\\.(?:${DOC_UPLOAD_EXTS.join('|')})$`, 'i');

/** 파일 이름 끝의 업로드 확장자 하나를 뗀다 ('지침.PDF' → '지침'). 목록에 없는 확장자는 그대로 둔다 */
export function stripDocExtension(name: string): string {
  return name.replace(DOC_UPLOAD_EXT_RE, '');
}
