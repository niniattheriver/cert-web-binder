// 문항 파서 단위 테스트 — 실물 인증기관 서식의 "레이아웃"만 재현한 픽스처.
// 문항 본문·설명은 전부 가상 문구다(실제 인증 문항 텍스트는 저작물이라 저장소에 두지 않는다).
// 검증 대상은 서식 파싱(헤더/배점 앵커/해당없음 줄병합/유형/개정표)이지 내용이 아니다.
import { describe, expect, it } from 'vitest';
import { normalizeQuestionNo, parseQuestionPdf, type ParserPageInput } from './index.js';
import { normalizeText } from '../normalize.js';

function page(pageNo: number, lines: string[]): ParserPageInput {
  return { pageNo, text: lines.join('\n') };
}

/** 표지(p.1): "90 / 우수검사실 / 신임인증 심사점검표 / [분야명] / 발행기관 / 2026. 01" */
function cover(cat: string): ParserPageInput {
  return page(1, ['90', '우수검사실', '신임인증 심사점검표', cat, '대한진단검사의학회ㆍ진단검사의학재단', '2026. 01']);
}

/** 개정표(p.2): 3섹션(신규/수정/삭제). 각 섹션 rows가 비면 "-" 한 줄. */
function revisionPage(
  cat: string,
  s: { 신규?: string[]; 수정?: string[]; 삭제?: string[] },
): ParserPageInput {
  const sec = (title: string, header: string, rows?: string[]): string[] => [
    `• ${title}`,
    header,
    ...(rows && rows.length ? rows : ['-']),
  ];
  return page(2, [
    '2026 년 개정판 변경내역 요약',
    '(Summary of Changes)',
    cat,
    '아래 심사문항들은 본 개정판에 신규 도입, 주요 문항/설명 수정 또는 삭제된 문항들입니다.',
    ...sec('신규', '문항번호 사유', s.신규),
    ...sec('수정', '문항번호 수정유형', s.수정),
    ...sec('삭제', '문항번호 사유', s.삭제),
  ]);
}

/** 최소 본문 페이지(bodyStartPage 확보용) — 1문항. */
function miniBody(pageNo: number, no = '99.010.010'): ParserPageInput {
  return page(pageNo, [String(pageNo), '문항 ', `기본B ${no} 본문 질문인가?`, '배점', '(1)', '아니오', '설명', ' 확인.']);
}

describe('정상 문항 블록 (2줄 헤더 · 해당없음 줄 병합)', () => {
  const r = parseQuestionPdf([
    cover('분자진단검사'),
    revisionPage('분자진단검사', { 수정: ['90.010.090 설명 수정'] }),
    page(6, [
      '6',
      '분자진단검사',
      '2 심사범위',
      '문항 ',
      '기본B 90.010.090 가상 항목에 대한 조치를 이행하였음을',
      '증빙할 수 있는가?',
      '배점',
      '(8) ',
      '아니오 ',
      '해당',
      '없음',
      '설명',
      ' 가상 예시 설명 문장으로,',
      '두 줄에 걸쳐 이어진다.',
    ]),
  ]);

  it('번호·배점·해당없음·유형/등급', () => {
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]).toMatchObject({
      questionNo: '90.010.090',
      maxScore: 8,
      allowNa: true,
      questionType: 'basic',
      gradeSymbol: 'B',
    });
  });

  it('본문 = 질문문 + 설명(줄 결합), 배점 창은 제외', () => {
    expect(r.questions[0]!.body).toBe(
      '가상 항목에 대한 조치를 이행하였음을\n증빙할 수 있는가?\n가상 예시 설명 문장으로,\n두 줄에 걸쳐 이어진다.',
    );
  });

  it('표지 분야명 추출, categoryCode는 파서 추론 폐기(null)', () => {
    expect(r.categoryName).toBe('분자진단검사');
    expect(r.categoryCode).toBeNull();
  });

  it('페이지 상단 쪽번호·분야명 반복은 본문에 스미지 않음, 경고 없음', () => {
    expect(r.questions[0]!.body).not.toContain('분자진단검사');
    expect(r.questions[0]!.body).not.toMatch(/(^|\n)6($|\n)/);
    expect(r.warnings).toEqual([]);
  });
});

describe('헤더 변형', () => {
  it('단일 줄 헤더 "문항 기본B …번호 …본문"', () => {
    const r = parseQuestionPdf([
      cover('분자진단검사'),
      revisionPage('분자진단검사', {}),
      page(6, [
        '6',
        '문항 기본B 90.301.040 가상 기록이 보관되어 있는가?',
        '배점',
        '(1)',
        '아니오',
        '설명',
        ' 가상 설명 문장입니다.',
      ]),
    ]);
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]).toMatchObject({ questionNo: '90.301.040', maxScore: 1, allowNa: false });
    expect(r.questions[0]!.body).toBe('가상 기록이 보관되어 있는가?\n가상 설명 문장입니다.');
  });

  it('영숫자 중간 그룹(90.A01.080) + 필요R → required/R', () => {
    const r = parseQuestionPdf([
      cover('분자진단검사'),
      revisionPage('분자진단검사', {}),
      page(6, [
        '6',
        '문항 ',
        '필요R 90.A01.080 가상 항목의 성능을 평가하는가?',
        '배점',
        '(4)',
        '아니오',
        '설명',
        ' 가상 검증 자료를 확인한다.',
      ]),
    ]);
    expect(r.questions[0]).toMatchObject({
      questionNo: '90.A01.080',
      maxScore: 4,
      questionType: 'required',
      gradeSymbol: 'R',
    });
  });

  it('핵심 필수문항(예/(필수)) → core/C, maxScore null', () => {
    const r = parseQuestionPdf([
      cover('분자진단검사'),
      revisionPage('분자진단검사', {}),
      page(6, [
        '6',
        '문항 ',
        '핵심C 90.702.022 가상 책임자가 관장하고 있는가?',
        '예',
        '(필수) ',
        '아니오',
        '설명 ',
        ' 가상 필수문항 설명입니다.',
      ]),
    ]);
    expect(r.questions[0]).toMatchObject({
      questionNo: '90.702.022',
      maxScore: null,
      allowNa: false,
      questionType: 'core',
      gradeSymbol: 'C',
    });
    expect(r.warnings).toEqual([]); // 필수는 정상(배점 없음 경고 아님)
  });
});

describe('배점 창 변형', () => {
  it('해당없음이 한 줄로 나오는 경우', () => {
    const r = parseQuestionPdf([
      cover('진단혈액'),
      revisionPage('진단혈액', {}),
      page(6, ['6', '문항 ', '기본B 60.010.010 검체를 확인하는가?', '배점', '(2)', '아니오', '해당없음', '설명', ' 확인.']),
    ]);
    expect(r.questions[0]).toMatchObject({ maxScore: 2, allowNa: true });
  });

  it('소수 배점(2.5)도 파싱', () => {
    const r = parseQuestionPdf([
      cover('진단혈액'),
      revisionPage('진단혈액', {}),
      page(6, ['6', '문항 ', '기본B 60.010.020 안전조치를 이행하는가?', '배점', '(2.5)', '아니오', '해당', '없음', '설명', ' 확인.']),
    ]);
    expect(r.questions[0]).toMatchObject({ maxScore: 2.5, allowNa: true });
  });

  it('"권장 (N점 예정)" 비표준 표기 → 숫자 추출 + 경고', () => {
    const r = parseQuestionPdf([
      cover('검사실운영'),
      revisionPage('검사실운영', {}),
      page(6, [
        '6',
        '문항 ',
        '기본B 01.010.070 위탁기관은 기준을 준수하는가?',
        '배점',
        '권장',
        '(16점',
        '예정)',
        '아니오',
        '설명',
        ' 할인율 위반정도를 평가한다.',
      ]),
    ]);
    expect(r.questions[0]!.maxScore).toBe(16);
    expect(r.warnings.some((w) => w.includes('비표준 배점') && w.includes('01.010.070'))).toBe(true);
  });

  it('배점/예 앵커가 없으면 maxScore null + 경고(파싱은 계속)', () => {
    const r = parseQuestionPdf([
      cover('진단혈액'),
      revisionPage('진단혈액', {}),
      page(6, ['6', '문항 ', '기본B 60.010.030 본문 질문인가?', '설명', ' 배점 표 없이 설명만 있는 경우.']),
    ]);
    expect(r.questions[0]).toMatchObject({ questionNo: '60.010.030', maxScore: null });
    expect(r.warnings.some((w) => w.includes('배점/예 앵커 없음'))).toBe(true);
  });
});

describe('설명 병합 · 안내문 스킵 · 페이지 경계', () => {
  it('"설명  없음" → 설명 없음, 배점 창 오염 없음', () => {
    const r = parseQuestionPdf([
      cover('분자진단검사'),
      revisionPage('분자진단검사', {}),
      page(6, ['6', '문항 ', '기본B 90.220.900 복사본은 보관되는가?', '배점', '(2)', '아니오', '해당', '없음', '설명  없음']),
    ]);
    expect(r.questions[0]).toMatchObject({ maxScore: 2, allowNa: true });
    expect(r.questions[0]!.body).toBe('복사본은 보관되는가?');
  });

  it('"설명  [내용]" 병합 줄 → 설명 내용은 본문에 포함, 해당없음 오검출 없음', () => {
    const r = parseQuestionPdf([
      cover('수혈의학'),
      revisionPage('수혈의학', {}),
      page(6, [
        '6',
        '문항 ',
        '기본B 40.010.010 업무 인계 문서가 있는가?',
        '배점',
        '(1)',
        '아니오',
        '설명  업무 인계에 대한 문서가 구비되어 있어야 한다.',
      ]),
    ]);
    expect(r.questions[0]).toMatchObject({ maxScore: 1, allowNa: false });
    expect(r.questions[0]!.body).toBe('업무 인계 문서가 있는가?\n업무 인계에 대한 문서가 구비되어 있어야 한다.');
  });

  it('문항 사이 대·중분류 제목과 안내문은 건너뛴다', () => {
    const r = parseQuestionPdf([
      cover('분자진단검사'),
      revisionPage('분자진단검사', {}),
      page(6, [
        '6',
        '문항 ',
        '기본B 90.210.020 가상 지침 문서가 준비되어 있는가?',
        '배점',
        '(1)',
        '아니오',
        '설명',
        ' 가상 지침을 확인한다.',
        '2. 기록 및 문서',
        '가상 중분류 안내문으로 문항이 아니다.',
        '문항 ',
        '기본B 90.220.900 복사본은 보관되는가?',
        '배점',
        '(2)',
        '아니오',
        '해당없음',
        '설명',
        ' 보관 상태를 확인한다.',
      ]),
    ]);
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0]!.body).toBe('가상 지침 문서가 준비되어 있는가?\n가상 지침을 확인한다.');
    expect(r.questions[1]).toMatchObject({ questionNo: '90.220.900', maxScore: 2, allowNa: true });
    expect(r.questions[1]!.body).toBe('복사본은 보관되는가?\n보관 상태를 확인한다.');
  });

  it('본문이 페이지 경계에 걸치면 이어붙인다(쪽번호 제거 후)', () => {
    const r = parseQuestionPdf([
      cover('개인정보보호'),
      revisionPage('개인정보보호', {}),
      page(6, ['6', '문항 ', '기본B 50.030.010 보유기간이 경과한 개인정보를 지체 없이 파기하는 절차를 수립하여']),
      page(7, ['7', '이행하고 있는가?', '배점', '(3)', '아니오', '설명', ' 파기 절차를 확인한다.']),
    ]);
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]).toMatchObject({ questionNo: '50.030.010', maxScore: 3 });
    expect(r.questions[0]!.body).toBe('보유기간이 경과한 개인정보를 지체 없이 파기하는 절차를 수립하여\n이행하고 있는가?\n파기 절차를 확인한다.');
  });

  it('"N / M" 형식 쪽번호와 분야명 반복 제거', () => {
    const r = parseQuestionPdf([
      cover('분자진단검사'),
      revisionPage('분자진단검사', {}),
      page(6, ['6 / 47', '분자진단검사', '문항 ', '기본B 90.010.010 본문 질문인가?', '배점', '(1)', '아니오', '설명', ' 확인.']),
    ]);
    expect(r.questions[0]!.body).toBe('본문 질문인가?\n확인.');
    expect(r.questions[0]!.body).not.toContain('47');
  });
});

describe('개정 요약표 (신규/수정/삭제 3섹션)', () => {
  it('세 섹션 데이터행을 kind별로 수집(수정유형 원문 보존)', () => {
    const r = parseQuestionPdf([
      cover('수혈의학'),
      revisionPage('수혈의학', {
        신규: ['43.010.010 신규 도입'],
        수정: ['40.010.090 설명 수정', '40.210.420 문항 수정, 배점 변경'],
        삭제: ['46.999.999 문항 삭제'],
      }),
      miniBody(6),
    ]);
    expect(r.revisionSummary).toEqual([
      { kind: 'new', questionNo: '43.010.010', note: '신규 도입' },
      { kind: 'modified', questionNo: '40.010.090', note: '설명 수정' },
      { kind: 'modified', questionNo: '40.210.420', note: '문항 수정, 배점 변경' },
      { kind: 'deleted', questionNo: '46.999.999', note: '문항 삭제' },
    ]);
  });

  it('전 섹션이 "-" 이면 revisionSummary 빈 배열', () => {
    const r = parseQuestionPdf([cover('현장검사'), revisionPage('현장검사', {}), miniBody(6)]);
    expect(r.revisionSummary).toEqual([]);
  });

  it('다분야 파일: 소분야별로 반복된 3섹션을 모두 누적', () => {
    const r = parseQuestionPdf([
      cover('임상미생물'),
      page(2, [
        '2026 년 개정판 변경내역 요약',
        '(Summary of Changes)',
        '임상미생물',
        '• 신규',
        '문항번호 사유',
        '-',
        '• 수정',
        '문항번호 수정유형',
        '30.010.090 설명 수정',
        '30.400.000 대분류 안내문 수정',
        '• 삭제',
        '문항번호 사유',
        '-',
        '• 신규',
        '문항번호 사유',
        '-',
        '• 수정',
        '문항번호 수정유형',
        '31.601.010 배점 변경, 설명 수정',
        '• 삭제',
        '문항번호 사유',
        '-',
      ]),
      miniBody(6, '30.010.010'),
    ]);
    expect(r.revisionSummary.map((x) => x.questionNo)).toEqual(['30.010.090', '30.400.000', '31.601.010']);
    expect(r.revisionSummary.every((x) => x.kind === 'modified')).toBe(true);
  });

  it('데이터행의 "문항분류체계 수정"은 수정행으로 보존, 섹션 머리 "• 문항분류체계"에서만 종료', () => {
    const r = parseQuestionPdf([
      cover('검사실운영'),
      page(2, [
        '2026 년 개정판 변경내역 요약',
        '(Summary of Changes)',
        '검사실운영',
        '• 신규',
        '문항번호 사유',
        '-',
        '• 수정',
        '문항번호 수정유형',
        '01.702.020 문항분류체계 수정, 설명 수정',
        '01.702.050 문항 수정',
        '• 삭제',
        '문항번호 사유',
        '-',
        '• 문항분류체계',
        '핵심문항 : C',
        '기본문항 : B',
      ]),
      miniBody(6, '01.010.010'),
    ]);
    expect(r.revisionSummary).toEqual([
      { kind: 'modified', questionNo: '01.702.020', note: '문항분류체계 수정, 설명 수정' },
      { kind: 'modified', questionNo: '01.702.050', note: '문항 수정' },
    ]);
  });

  it("개정표 '삭제' 문항이 본문에 존재하면 교차검증 경고", () => {
    const r = parseQuestionPdf([
      cover('수혈의학'),
      revisionPage('수혈의학', { 삭제: ['40.030.050 문항 삭제'] }),
      page(6, ['6', '문항 ', '기본B 40.030.050 삭제되었어야 할 문항인가?', '배점', '(2)', '아니오', '설명', ' 확인.']),
    ]);
    expect(r.warnings.some((w) => w.includes('40.030.050') && w.includes('삭제'))).toBe(true);
  });
});

describe('경고 케이스 (파싱은 계속)', () => {
  it('중복 문항번호 → 경고, 두 블록 모두 유지', () => {
    const r = parseQuestionPdf([
      cover('분자진단검사'),
      revisionPage('분자진단검사', {}),
      page(6, [
        '6',
        '문항 ',
        '기본B 90.010.010 첫 본문.',
        '배점',
        '(1)',
        '아니오',
        '설명',
        ' A.',
        '문항 ',
        '기본B 90.010.010 둘째 본문.',
        '배점',
        '(2)',
        '아니오',
        '설명',
        ' B.',
      ]),
    ]);
    expect(r.questions).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('중복 문항번호 90.010.010'))).toBe(true);
  });
});

describe('normalizeQuestionNo / 표지 폴백', () => {
  it('전각 숫자·전각 마침표·내부 공백 정규화', () => {
    expect(normalizeQuestionNo('９０．０１０．０９０')).toBe('90.010.090');
    expect(normalizeQuestionNo('90 . 010 . 090')).toBe('90.010.090');
    expect(normalizeQuestionNo('９０．A０１．０８０')).toBe('90.A01.080');
  });

  it('표지 제목이 없으면 개정표 "(Summary of Changes)" 다음 줄에서 분야명 폴백', () => {
    const r = parseQuestionPdf([
      page(1, ['90', '우수검사실', '분야 안내']),
      revisionPage('종합검증', {}),
      miniBody(6),
    ]);
    expect(r.categoryName).toBe('종합검증');
  });
});

describe('normalizeText (§3.1-3)', () => {
  it('NFC + 제로폭 제거 + 줄끝 통일, 공백은 붕괴하지 않음', () => {
    const nfd = '한글'.normalize('NFD');
    const input = nfd + '​ ‍테스트\r\n둘째\r셋째  줄';
    const out = normalizeText(input);
    expect(out).toBe('한글 테스트\n둘째\n셋째  줄');
    expect(out).toBe(out.normalize('NFC'));
    expect(out).toContain('  '); // 이중 공백 보존
  });
});

describe('Phase 3b — 목차→챕터·topic·세부항목표·자동배점 후보 (가상 픽스처)', () => {
  const tocPage = page(4, [
    '목 차',
    '가상분야',
    '2 심사범위 6',
    '3 품질관리: 일반 7',
    '1. 지침 문서 7',
    '2. 기록 관리 9',
    '4 검사단계 12',
  ]);
  const body = page(6, [
    '6',
    '가상분야',
    '2 심사범위',
    '문항 ',
    '기본B 99.010.010 첫 가상 질문인가?',
    '배점',
    '(4)',
    '아니오',
    '설명',
    ' 첫 설명 문장.',
    '3 품질관리: 일반',
    '1. 지침 문서',
    '문항 ',
    '필요R 99.210.010 두 번째 가상 질문인가?',
    '배점',
    '(16)',
    '아니오',
    '설명',
    ' 다음의 평가(점검)항목 및 배점을 기준으로 한다.',
    '평가항목 배정 점수',
    '가상 항목 하나 1',
    '가상 항목 둘 5',
    '가상 항목 셋 10',
    '2. 기록 관리',
    '문항 ',
    '핵심C 99.220.010 세 번째 가상 질문인가?',
    '배점',
    '(8)',
    '아니오',
    '설명',
    ' 가상 실시율에 따라 배점한다.',
    '100% (8)',
    '80~99% (6)',
    '60-79% (4)',
    '60% 미만 (2)',
  ]);
  const r = parseQuestionPdf([cover('가상분야'), revisionPage('가상분야', {}), tocPage, body]);

  it('본문 섹션 헤더가 목차와 대조되어 챕터로 배정된다 (대분류 전환 시 중분류 초기화)', () => {
    expect(r.questions).toHaveLength(3);
    expect(r.questions[0]).toMatchObject({
      questionNo: '99.010.010',
      chapterMajor: '2 심사범위',
      chapterMinor: null,
    });
    expect(r.questions[1]).toMatchObject({
      chapterMajor: '3 품질관리: 일반',
      chapterMinor: '1. 지침 문서',
    });
    expect(r.questions[2]).toMatchObject({
      chapterMajor: '3 품질관리: 일반',
      chapterMinor: '2. 기록 관리',
    });
  });

  it('topic = 질문문만(설명 제외), body 계약은 종전대로 병합 유지', () => {
    expect(r.questions[0]!.topic).toBe('첫 가상 질문인가?');
    expect(r.questions[0]!.body).toContain('첫 설명 문장.');
  });

  it('세부 평가항목 표 추출 (계약 검증은 인입 계층 몫)', () => {
    expect(r.questions[1]!.subItems).toEqual([
      { label: '가상 항목 하나', maxScore: 1 },
      { label: '가상 항목 둘', maxScore: 5 },
      { label: '가상 항목 셋', maxScore: 10 },
    ]);
    expect(r.questions[0]!.subItems).toBeNull();
  });

  it('자동배점 임계표 후보 감지 (~/- 구분자 혼재 허용, 원문 행 보존)', () => {
    expect(r.questions[2]!.autoCandidate).toEqual({
      rows: ['100% (8)', '80~99% (6)', '60-79% (4)', '60% 미만 (2)'],
    });
    expect(r.questions[1]!.autoCandidate).toBeNull();
  });

  it('설명 속 유사 숫자 줄("3 개월 이내…")은 목차에 없으면 챕터가 되지 않는다 (기존 경계 동작 유지)', () => {
    const r2 = parseQuestionPdf([
      cover('가상분야'),
      tocPage,
      page(6, [
        '6',
        '문항 ',
        '기본B 99.010.010 질문인가?',
        '배점',
        '(1)',
        '아니오',
        '설명',
        ' 첫 설명.',
        '3 개월 이내에 조치한다.', // 목차 밖 섹션형 줄 — v1과 동일하게 설명 경계로만 취급
      ]),
    ]);
    expect(r2.questions[0]!.chapterMajor).toBeNull();
    expect(r2.questions[0]!.body).toContain('첫 설명.');
  });

  it('목차 없으면 챕터 null — 경고 없이 진행 (UI 접두 그룹핑 폴백 전제)', () => {
    const r3 = parseQuestionPdf([cover('가상분야'), miniBody(6)]);
    expect(r3.warnings).toEqual([]);
    expect(r3.questions[0]!.chapterMajor).toBeNull();
    expect(r3.questions[0]!.topic).toBe('본문 질문인가?');
  });

  // 실물 편차 회귀: 목차↔본문의 대소문자·괄호 부제 차이로 챕터가 미매칭되면
  // 문항이 직전 챕터로 조용히 오배정된다 → 매칭 키에 소문자화 + 괄호 부제 제거 폴백.
  it('목차↔본문 대소문자·괄호부제 편차를 흡수해 챕터를 배정한다 (미매칭 경고 없음)', () => {
    const toc = page(4, [
      '목 차',
      '유세포검사',
      '6 검사수행 및 장비 운용 20',
      '2. 유세포분석기(flow cytometer) 24', // 목차: 소문자 flow
      '7. 발작야간혈색소뇨증(PNH) 30', // 목차: 괄호 축약 (PNH)
    ]);
    const bodyPg = page(20, [
      '20',
      '6 검사수행 및 장비 운용',
      '2. 유세포분석기(Flow cytometer)', // 본문: 대문자 Flow — 대소문자 편차
      '문항 ',
      '기본B 99.620.010 유세포 질문인가?',
      '배점',
      '(4)',
      '아니오',
      '설명',
      ' 유세포 설명.',
      '7. 발작야간혈색소뇨증(paroxysmal nocturnal hemoglobinuria, PNH)', // 본문: 괄호 전개
      '문항 ',
      '핵심C 99.720.010 PNH 질문인가?',
      '배점',
      '(6)',
      '아니오',
      '설명',
      ' PNH 설명.',
    ]);
    const rc = parseQuestionPdf([cover('유세포검사'), revisionPage('유세포검사', {}), toc, bodyPg]);
    expect(rc.questions).toHaveLength(2);
    expect(rc.questions[0]).toMatchObject({
      questionNo: '99.620.010',
      chapterMinor: '2. 유세포분석기(flow cytometer)', // 목차 표기로 정규화(대소문자 흡수)
    });
    expect(rc.questions[1]).toMatchObject({
      questionNo: '99.720.010',
      chapterMinor: '7. 발작야간혈색소뇨증(PNH)', // 괄호 부제 제거 폴백으로 매칭
    });
    // 두 중분류 모두 매칭됐으므로 미매칭 경고가 없어야 한다
    expect(rc.warnings.filter((w) => w.includes('미매칭'))).toEqual([]);
  });
});

describe('자동배점 문구 감지', () => {
  it('extractThresholdCandidate: "자동 배점됩니다" 문구만 있어도 후보로 표시한다', async () => {
    const { extractThresholdCandidate } = await import('./patterns.js');
    const lines = [
      '점수는 제출하신 전문의 수에 근거하여 자동 배점됩니다.',
      '검사실 전년도 검사수 : 건 / 상근 진단검사의학과 전문의 수 명',
    ];
    expect(extractThresholdCandidate(lines)).toEqual({
      rows: ['점수는 제출하신 전문의 수에 근거하여 자동 배점됩니다.'],
    });
    // 문구도 구간표도 없으면 null
    expect(extractThresholdCandidate(['파기 절차 문서를 확인한다.'])).toBeNull();
  });
});
