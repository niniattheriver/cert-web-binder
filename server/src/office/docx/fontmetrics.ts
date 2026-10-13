/**
 * Word 의 '한 줄' 높이: 줄 간격 배수 1 일 때 한 줄이 차지하는 높이 / 글자 크기
 *
 * 규칙 (Windows Word, 글꼴 세로 지표에서 계산)
 * - 보통 글꼴: winAscent + winDescent + GDI 외부 행간. 외부 행간은
 *   max(0, hhea.lineGap - ((winAscent + winDescent) - (hhea.ascender - hhea.descender))).
 * - 한중일 코드 페이지(OS/2 ulCodePageRange1 의 JIS, GB2312, 완성형, Big5, 조합형 비트)를 가진 글꼴은
 *   max(위 값, 1.3 x (winAscent + winDescent)): 맑은 고딕이 유난히 넓은 까닭이다(1.33 x 1.3 = 1.729).
 *
 * 실측 (Word 가 만든 PDF 짝, 문단 안 줄 간격 / (배수 x 글자 크기). 글자와 파일 이름은 보지 않았다)
 * - 맑은 고딕: 검사실 지침서 7개 1.731(8, 9, 10, 14, 20pt, 배수 1, 1.13, 1.15 모두), 다른 Word 문서 24개 1.733
 *   (문단 1,716개, 10-90 백분위 1.725-1.740). 위 규칙 값 1.729 와 맞는다.
 * - Arial: 1.149 (문단 623개). 규칙 값 1.1499.
 * - 그 밖의 값(바탕, 굴림, 돋움, 궁서 1.3, Calibri 1.2207 등)은 Windows 글꼴 파일 지표에 같은 규칙을 적용한
 *   값이고 Word 출력과는 대조하지 못했다(실물 짝에 그 글꼴로 된 여러 줄 문단이 없었다).
 *
 * 표에 없는 글꼴: 동아시아 글자가 든 조각이거나 이름에 한글, 한자가 있으면 1.3(바탕, 굴림류), 아니면 1.15
 * (Arial, Times New Roman 류, 화면 기본 배율과 같다). Word 는 없는 글꼴을 다른 글꼴로 바꿔 그리므로 어림이다.
 */

/** 글꼴 이름(소문자) → '한 줄' 높이 / 글자 크기 */
const FACTORS: Readonly<Record<string, number>> = {
  '맑은 고딕': 1.7291,
  'malgun gothic': 1.7291,
  '굴림': 1.3,
  '굴림체': 1.3,
  '돋움': 1.3,
  '돋움체': 1.3,
  '바탕': 1.3,
  '바탕체': 1.3,
  '궁서': 1.3,
  '궁서체': 1.3,
  gulim: 1.3,
  gulimche: 1.3,
  dotum: 1.3,
  dotumche: 1.3,
  batang: 1.3,
  batangche: 1.3,
  gungsuh: 1.3,
  gungsuhche: 1.3,
  '함초롬바탕': 1.69,
  '함초롬돋움': 1.69,
  'hcr batang': 1.69,
  'hcr dotum': 1.69,
  'ms gothic': 1.3,
  'ms pgothic': 1.3,
  simsun: 1.3,
  nsimsun: 1.3,
  'microsoft yahei': 1.7158,
  'yu gothic': 1.6732,
  arial: 1.1499,
  'arial narrow': 1.1475,
  'arial black': 1.4102,
  'times new roman': 1.1499,
  calibri: 1.2207,
  'calibri light': 1.2207,
  cambria: 1.1724,
  candara: 1.2207,
  constantia: 1.2207,
  corbel: 1.2207,
  'courier new': 1.1328,
  consolas: 1.1709,
  'lucida console': 1,
  verdana: 1.2153,
  tahoma: 1.207,
  'segoe ui': 1.3301,
  georgia: 1.1362,
  'trebuchet ms': 1.1611,
  garamond: 1.125,
  'book antiqua': 1.2056,
  'palatino linotype': 1.3491,
  century: 1.2021,
  'century gothic': 1.2261,
  'franklin gothic medium': 1.1338,
  'comic sans ms': 1.3936,
  impact: 1.2197,
  symbol: 1.2251,
  wingdings: 1.1099,
  webdings: 1,
};

/** 표에 없는 동아시아 글꼴 */
const CJK_DEFAULT = 1.3;
/** 표에 없는 그 밖의 글꼴 */
const LATIN_DEFAULT = 1.15;
/** 이름에 한글, 한자, 가나가 있는 글꼴 */
const CJK_NAME_RE = /[ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힣]/;

/** '한 줄' 높이 / 글자 크기. eastAsian = 그 조각에 동아시아 글자가 있는가(표에 없는 글꼴을 가를 때만 쓴다) */
export function lineFactor(font: string | undefined, eastAsian: boolean): number {
  const key = font?.trim().toLowerCase();
  if (key && Object.prototype.hasOwnProperty.call(FACTORS, key)) return FACTORS[key]!;
  return eastAsian || (key !== undefined && CJK_NAME_RE.test(key)) ? CJK_DEFAULT : LATIN_DEFAULT;
}

/** 글자 크기 pt 의 '한 줄' 높이 px (96dpi) */
export function singleLinePx(font: string | undefined, sizePt: number, eastAsian: boolean): number {
  return lineFactor(font, eastAsian) * sizePt * (96 / 72);
}
