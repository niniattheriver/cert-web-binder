/**
 * docx 추출 상한과 안내 문구. 색인과 표시는 언제나 같은 범위다.
 */
export const MAX_PARAGRAPHS = 50_000;
export const MAX_TEXT = 3_000_000;
export const MAX_PAGES = 2_000;
/** 표 중첩 깊이 상한: 더 깊은 표는 칸 안 문단으로 펼친다 */
export const MAX_TABLE_DEPTH = 8;
/** 글상자 중첩 깊이 상한 */
export const MAX_BOX_DEPTH = 4;

// 머리말/꼬리말 상한. 표시 전용이지만 쪽마다 모델에 되풀이되므로(같은 부분을 쪽 수만큼 직렬화) 따로 묶는다.
// 실물 88개: 그린 부분 하나의 최대는 문단 2, 글자 65, 그림 0. 문서 하나의 머리말/꼬리말 JSON 합 최대 14KB,
// 머리말/꼬리말 부분(XML) 합 최대 26KB.

/** 부분 하나에 남기는 글자 수 */
export const MAX_HEADER_CHARS = 4000;
/** 부분 하나에 남기는 문단, 표 행, 표 칸 수 (합) */
export const MAX_HEADER_UNITS = 400;
/** 부분 하나에 남기는 그림 수 */
export const MAX_HEADER_IMAGES = 20;
/** 풀어 읽는 머리말/꼬리말 부분(관계 파일 포함) 바이트 합. 넘는 부분은 빈 부분으로 본다 */
export const MAX_HEADER_SOURCE = 16 * 1024 * 1024;
/** 모델에 싣는 머리말/꼬리말 JSON 바이트 합. 넘으면 그 뒤 쪽에는 머리말/꼬리말을 싣지 않는다 */
export const MAX_CHROME_JSON = 8 * 1024 * 1024;

export const DOCX_LIMITS = {
  paragraphs: MAX_PARAGRAPHS,
  text: MAX_TEXT,
  pages: MAX_PAGES,
} as const;

export const TRUNC_PARAS = `문단이 많아 앞 ${MAX_PARAGRAPHS.toLocaleString('ko-KR')}개 문단만 색인하고 보여줍니다.`;
export const TRUNC_TEXT = `글자가 많아 앞부분 ${MAX_TEXT.toLocaleString('ko-KR')}자만 색인하고 보여줍니다.`;
export const TRUNC_PAGES = `쪽이 많아 앞 ${MAX_PAGES.toLocaleString('ko-KR')}쪽만 색인하고 보여줍니다.`;

export const ERR_ZIP = 'Word (docx) 파일의 압축 구조를 읽지 못했습니다(손상 가능성). Word에서 다시 저장해 올려 주세요.';
export const ERR_DOCUMENT =
  'Word (docx) 본문(word/document.xml)을 읽지 못했습니다(손상되었거나 너무 큽니다). Word에서 다시 저장해 올려 주세요.';
export const ERR_STRUCTURE =
  'Word (docx) 문서 구조를 해석하지 못했습니다(비정상적인 구조). Word에서 다시 저장해 올려 주세요.';

/** 쪽 정보가 없는 문서(Word 가 저장하지 않은 docx)의 대체 쪽 나눔 */
export const FALLBACK_SPLIT_OVER = 6000;
export const FALLBACK_TARGET = 4500;
