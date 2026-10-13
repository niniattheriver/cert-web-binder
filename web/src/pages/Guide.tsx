/**
 * 사용 안내 /guide
 * 처음 쓰는 사람 눈높이의 정적 안내. 왼쪽 목차는 장별로 묶고 상자 없이 본문과 같은 높이에서 시작하며,
 * 읽는 위치를 따라 현재 항목을 표시한다(스크롤 위치 추적). 본문은 한 줄이 너무 길지 않게 폭을 제한한다.
 * 화면 캡처는 web/public/guide/*.png(가상 데모 데이터). 다시 찍는 절차는 seed/guide-shots.mjs 머리말에 있다.
 * 캡처를 누르면 같은 창 위에 확대창이 뜬다: 축소/확대 단추와 +, -, 0 키, 그림을 누르면 누른
 * 자리를 중심으로 2배(다시 누르면 맞춤), 확대한 그림은 끌어서 옮긴다. 그림 바깥을 누르거나 Esc 로 닫는다.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../auth';

interface Shot {
  src: string;
  alt: string;
  caption: string;
}

/** 캡처의 픽셀 크기(seed/guide-shots.mjs 가 출력). 그림이 늦게 읽혀도 자리가 흔들리지 않게 img 에 준다 */
const SHOT_SIZE: Record<string, [number, number]> = {
  '/guide/login.png': [492, 390],
  '/guide/home.png': [1280, 800],
  '/guide/dashboard.png': [1280, 800],
  '/guide/questions.png': [1280, 800],
  '/guide/detail.png': [1280, 800],
  '/guide/evidence.png': [1280, 800],
  '/guide/docs.png': [1280, 800],
  '/guide/review.png': [1280, 800],
  '/guide/reconnect.png': [1280, 800],
  '/guide/summary.png': [1280, 800],
  '/guide/import.png': [1280, 800],
  '/guide/import-preview.png': [1280, 800],
  '/guide/year2027-detail.png': [1280, 800],
  '/guide/org.png': [1280, 800],
  '/guide/users.png': [1280, 800],
  '/guide/search.png': [1280, 800],
};

type GroupId = 'start' | 'prep' | 'year' | 'admin' | 'more';

const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'start', label: '시작하기' },
  { id: 'prep', label: '심사 준비' },
  { id: 'year', label: '새 연도' },
  { id: 'admin', label: '관리' },
  { id: 'more', label: '참고' },
];

interface Section {
  id: string;
  group: GroupId;
  title: string;
  /** 제목 옆 작은 표시(이 기능을 쓸 수 있는 역할) */
  role?: string;
  body: ReactNode;
  /** 본문 아래 화면 캡처(가상 데모 데이터) */
  shots?: Shot[];
}

function useSections(): Section[] {
  const { settings } = useAuth();
  const name = settings.systemName || '우수검사실 신임인증 웹 바인더';
  return [
    {
      id: 'intro',
      group: 'start',
      title: '이 시스템은 무엇인가요?',
      body: (
        <>
          <p>
            <b>{name}</b>에서는 인증심사 준비를 종이 바인더 대신 웹에서 합니다. 문항마다
            점수를 매기고 근거가 되는 자료의 정확한 위치를 연결해 두면, 심사 당일에는 문항 번호만
            넣어 그 화면을 바로 펼칠 수 있습니다.
          </p>
          <ul>
            <li>
              서버 한 대에 설치하고 같은 내부망의 어느 PC에서든 브라우저로 접속해 함께 씁니다.
              근거자료, 근거 연결, 채점이 모두 서버 한곳에 저장되므로 내 PC에서 연결한 근거를 동료
              PC에서도 그대로 봅니다.
            </li>
            <li>모든 자료는 내부망 서버에만 저장됩니다. 인터넷이 없어도 됩니다.</li>
            <li>지우거나 덮어쓴 내용도 변경 이력에 남아 나중에 확인할 수 있습니다.</li>
          </ul>
          <table className="guide-table">
            <thead>
              <tr>
                <th>역할</th>
                <th>할 수 있는 일</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>열람자</td>
                <td>모든 화면을 볼 수 있습니다. 심사위원처럼 보기만 할 사람에게 줍니다.</td>
              </tr>
              <tr>
                <td>편집자</td>
                <td>채점, 근거 연결, 근거자료와 문항 PDF 올리기를 할 수 있습니다.</td>
              </tr>
              <tr>
                <td>관리자</td>
                <td>편집자의 일에 더해 계정 관리, 백업, 자료 점검을 할 수 있습니다.</td>
              </tr>
            </tbody>
          </table>
        </>
      ),
      shots: [
        {
          src: '/guide/login.png',
          alt: '로그인 화면',
          caption: '로그인 화면: 관리자에게 받은 아이디와 비밀번호로 들어옵니다.',
        },
      ],
    },
    {
      id: 'flow',
      group: 'start',
      title: '한눈에 보는 사용 순서',
      body: (
        <ol className="guide-steps">
          <li>
            <b>문항 PDF 가져오기:</b> 인증기관에서 받은 그해의 문항 PDF를 올리면 문항, 배점, 목차가
            자동으로 등록됩니다.
          </li>
          <li>
            <b>근거자료 올리기:</b> 근거자료 메뉴에서 기관 문서 파일(PDF, Word, Excel, PowerPoint, 한글,
            텍스트)을 [근거자료 파일 업로드]로 한꺼번에 올리거나 화면에 끌어다 놓습니다.
          </li>
          <li>
            <b>문항마다 채점하고 근거 연결하기:</b> 문항 상세 화면에서 점수를 고르고 [+ 근거자료
            연결]로 자료의 해당 문장을 연결합니다.
          </li>
          <li>
            <b>빠진 곳 채우기:</b> 연도 화면의 분야 카드에 붙는 <b>근거 연결 전</b>, <b>재확인
            필요</b> 표시와 위쪽 <b>확인 필요</b> 메뉴로 아직 손볼 문항을 찾습니다.
          </li>
          <li>
            <b>심사 전 점검:</b> 결과 요약, 엑셀 내보내기, 인쇄로 전체를 훑어봅니다. 심사 당일에는
            검색창(Ctrl+K)에 문항 번호를 넣어 화면을 바로 펼칩니다.
          </li>
          <li>
            <b>해가 바뀌면</b> 새 연도의 개정 문항 PDF를 올립니다. 지난 연도의 서술 답변과 근거
            연결은 물려받고 예/아니오 선택과 점수는 새로 시작합니다(아래 새 연도로 넘어가기 참고).
          </li>
        </ol>
      ),
    },
    {
      id: 'home',
      group: 'prep',
      title: '연도별 홈',
      body: (
        <>
          <p>
            로그인하면 먼저 연도별 인증심사 목록(2026~2036년)이 보입니다. 문항이 해마다 개정되므로
            준비 상황도 연도별로 나누어 관리합니다. 왼쪽 위 시스템 이름을 누르면 언제든 이 화면으로
            돌아옵니다.
          </p>
          <ul>
            <li>진행 중인 연도에는 <b>현재</b> 표시와 함께 문항 수와 채점 진행률이 보입니다.</li>
            <li>
              아직 문항이 없는 연도를 누르면 그해의 문항 PDF를 올리라는 안내가 나옵니다. 담당자마다
              자기 분야 PDF만 따로 올려도 같은 연도로 합쳐집니다.
            </li>
          </ul>
        </>
      ),
      shots: [
        {
          src: '/guide/home.png',
          alt: '연도별 인증심사 홈 화면',
          caption: '연도를 고르면 그해의 준비 화면으로 들어갑니다.',
        },
      ],
    },
    {
      id: 'dashboard',
      group: 'prep',
      title: '연도 화면',
      body: (
        <>
          <p>연도를 고르면 나오는 화면으로, 그해의 분야별 진행 상황을 한눈에 봅니다.</p>
          <ul>
            <li>
              <b>분야 카드</b>에는 문항 수, 채점 진행률과 함께 아직 손볼 문항 수가 표시됩니다.
              노란 <b>근거 연결 전</b>은 근거가 하나도 없는 문항, 빨간 테두리의 <b>재확인 필요</b>는
              문항 개정이나 배점 변경으로 채점을 다시 봐야 하는 문항입니다. 표시를 누르면 그 문항만
              걸러진 목록이 열립니다.
            </li>
            <li>
              자동배점 문항이 있으면 <b>자동 입력 미확정</b>, <b>지표 미입력</b> 건수가 작은 글씨로
              함께 보입니다. 모두 끝난 분야에는 <b>✓ 모든 문항에 근거 연결</b>이 표시됩니다.
            </li>
            <li>
              오른쪽 위에서 <b>카드</b>와 <b>목록</b> 보기를 바꿀 수 있습니다. 목록 보기에서는
              같은 표시가 <b>확인할 문항</b> 열에 모입니다.
            </li>
            <li>
              근거자료 개정으로 다시 연결해야 할 근거가 생기면 맨 위에 빨간 알림이 나타납니다. [확인
              필요에서 처리]를 누르세요.
            </li>
          </ul>
        </>
      ),
      shots: [
        {
          src: '/guide/dashboard.png',
          alt: '연도 화면',
          caption:
            '분야 카드마다 근거 연결 전, 재확인 필요 문항 수가 표시됩니다. 맨 위 빨간 알림은 근거자료 개정으로 다시 연결할 근거가 있다는 뜻입니다.',
        },
      ],
    },
    {
      id: 'questions',
      group: 'prep',
      title: '문항 목록',
      body: (
        <>
          <ul>
            <li>
              문항은 공식 문항집과 같은 <b>대분류, 소분류, 문항</b> 순서로 보입니다. 대분류 제목을
              누르면 접히고 다시 누르면 펼쳐집니다. 필터 줄 오른쪽의 [모두 접기]도 쓸 수 있습니다.
            </li>
            <li>
              위쪽 <b>필터</b>로 미채점, 변경/신규 문항, 근거 연결 전, 재확인 같은 문항만 골라 봅니다.
              필터에 마우스를 올리면 설명이 나옵니다.
            </li>
            <li>
              행마다 진행 상태가 표시됩니다. 꽉 찬 원(완료)은 채점을 마쳤고 근거가 있는 문항,
              반원(진행 중)은 둘 중 한쪽만 있는 문항, 빈 원(시작 전)은 아직 손대지 않은 문항입니다. ✓는 담당자가
              검토완료 표시를 남긴 문항입니다.
            </li>
            <li>
              <b>자동배점</b> 표시가 붙은 문항은 기관이 직접 채점하지 않고 제출 자료나 기관
              지표(검사 건수 등)에 따라 점수가 정해집니다.
            </li>
            <li>[엑셀 내보내기]로 이 분야의 문항, 채점, 근거 요약을 파일로 받습니다.</li>
          </ul>
        </>
      ),
      shots: [
        {
          src: '/guide/questions.png',
          alt: '문항 목록 화면',
          caption: '문항 PDF에서 등록된 문항이 목차 순서로 보입니다.',
        },
      ],
    },
    {
      id: 'detail',
      group: 'prep',
      title: '문항 상세',
      body: (
        <>
          <p>
            준비 작업 대부분을 하는 화면입니다. 왼쪽은 같은 분야의 문항 목록, 가운데는 문항과 점수,
            근거자료, 오른쪽은 고른 근거자료입니다. 경계선을 끌어 폭을 바꿀 수 있습니다.
          </p>
          <ul>
            <li>
              <b>채점:</b> 예/아니오(문항에 따라 해당없음)를 고르고 점수를 넣습니다. 예를 고르면
              만점이 자동으로 들어가고, 점수를 고치거나 [자동 입력: 눌러서 확정]을 누를 때까지 미확정으로
              남습니다. 문항에 따라 채점 방식을 <b>합산</b>(세부항목 점수를 더함)이나 <b>자동</b>(기관
              지표로 계산)으로 바꿀 수 있습니다.
            </li>
            <li>
              <b>근거자료 연결:</b> [+ 근거자료 연결]을 누르거나 H 키를 누르면 연결할 자료를 고르는
              창이 열립니다. 올려 둔 근거자료를 제목이나 본문으로 찾아 고른 뒤, 오른쪽에 열린 문서에서
              해당 문장을 드래그하고 [연결](또는 Enter)을 누르면 이 문항의 근거로 저장됩니다.
            </li>
            <li>
              <b>내 PC의 파일 첨부:</b> 같은 창 오른쪽 위 [내 PC에서 선택]을 누르면 아직 올리지 않은
              파일을 여러 개 한꺼번에 이 문항에 첨부합니다. 첨부는 이름을 누르면 내려받지 않고 창에서 미리
              봅니다. 웹 주소는 [+ 링크 추가]로 붙입니다.
            </li>
            <li>
              <b>자유형식 문서:</b> [+ 자유형식]으로 표와 그림을 넣을 수 있는 문서를 만들어 근거로
              연결합니다. 기관의 이행 내용을 서술식으로 정리해 두기에 좋습니다.
            </li>
            <li>
              <b>근거 열기:</b> 연결한 근거는 번호(①②③)로 쌓이고 번호나 숫자 키를 누르면 오른쪽에 그
              위치가 열립니다. 근거마다 메모를 남기거나 끌어서 순서를 바꿀 수 있습니다.
            </li>
            <li>
              <b>근거 추천:</b> 근거자료 아래 [근거 추천]을 누르면 문항 내용과 비슷한 자료의 쪽을
              찾아 줍니다. 결과를 누르면 새 탭에서 그 쪽이 열리고 맞으면 거기서 드래그해 연결합니다.
            </li>
            <li>
              <b>지적/권장사항:</b> 심사에서 받은 지적이나 자체 개선 메모를 남깁니다. 입력을 멈추면
              자동으로 저장됩니다.
            </li>
            <li>
              j, k 키로 다음 문항과 이전 문항으로 옮겨 다닙니다. 이 문항을 다 봤다면 [검토완료
              표시]를 눌러 두세요.
            </li>
          </ul>
        </>
      ),
      shots: [
        {
          src: '/guide/detail.png',
          alt: '문항 상세 화면',
          caption: '왼쪽 문항 목록, 가운데 문항과 채점, 근거자료, 오른쪽에 연결된 자료가 열립니다.',
        },
        {
          src: '/guide/evidence.png',
          alt: '근거자료 연결 창',
          caption:
            '[+ 근거자료 연결]을 누르면 열리는 창입니다. 올려 둔 근거자료를 고르거나, 오른쪽 위 [내 PC에서 선택]으로 파일을 바로 첨부합니다.',
        },
      ],
    },
    {
      id: 'docs',
      group: 'prep',
      title: '근거자료',
      body: (
        <>
          <p>
            인증 문항의 근거가 되는 기관 문서를 올리는 곳입니다. 검사지침서, 장비 매뉴얼, SOP, 운영
            규정처럼 부르는 이름이 달라도 근거가 되는 문서라면 모두 여기에 등록합니다.
          </p>
          <ul>
            <li>
              <b>올릴 수 있는 형식:</b> PDF, Word (docx, doc), Excel (xlsx, xls), PowerPoint (pptx),
              한글(hwpx, hwp), 텍스트(txt, csv, tsv, md). 예전 형식인 doc, xls, hwp도 그대로 올리면 되고,
              어느 형식이든 미리보기, 본문 검색, 근거 연결이 됩니다. 구형 PowerPoint(ppt), Word 95 이전(doc),
              Excel 95 이전(xls), 한글 97 이전(hwp 3.0)과 배포용 한글 문서는 원래 프로그램에서 새 형식이나 PDF로
              저장해 올리고, 암호나 문서 보안(DRM)이 걸린 파일은 해제한 뒤 올립니다.
            </li>
            <li>
              <b>근거자료 파일 업로드:</b> 버튼을 누르고 파일을 여러 개(수백 개도 됩니다) 한꺼번에 고르면
              확장자를 뺀 파일 이름이 제목이 되어 차례로 등록됩니다. 같은 이름, 같은 형식의 파일을 다시
              올리면 그 자료의 새 버전으로 쌓이고 내용이 완전히 같은 파일은 건너뜁니다. 그래서 폴더째
              다시 올려도 괜찮습니다.
            </li>
            <li>
              <b>끌어다 놓기:</b> 탐색기에서 파일을 골라 연도 선택 아래의 점선 상자에 끌어다 놓아도 같은
              방식으로 올라갑니다.
            </li>
            <li>
              <b>미리보기:</b> 문서 카드의 [미리보기]를 누르면 메일 첨부파일처럼 창이 떠서 내용을 바로
              확인합니다. 근거 연결은 [뷰어 열기]로 들어가서 합니다.
            </li>
            <li>
              <b>연도:</b> 목록 위 연도 선택(2025~2099년)으로 자료를 연도별로 나누어 봅니다. 업로드는 고른
              연도로 등록되고, 전체를 고른 채 올리면 올해로 등록됩니다.
            </li>
            <li>
              <b>본문 검색:</b> 검색칸에 단어를 넣으면 고른 연도의 자료 본문에서 찾아 문서와
              위치(쪽, 엑셀과 csv 의 시트, 슬라이드, 한글과 txt, md 의 구간)를 보여 줍니다. 결과를 누르면 그 위치가
              열립니다.
            </li>
            <li>
              <b>버전 비교:</b> 문서 카드의 [버전 비교]를 누르면 두 버전 사이에 달라진 문장이
              초록(추가)과 빨강(삭제)으로 표시됩니다.
            </li>
            <li>
              <b>개정판 올리기:</b> 같은 이름의 파일을 다시 올리거나 문서 카드의 [새 버전 업로드]로 새
              버전을 올리면 문항에 걸어 둔 근거 연결이 새 버전으로 옮겨집니다. [새 버전 업로드]에서는
              버전 이름을 직접 정할 수 있습니다. 문장이 바뀌어 자동으로 옮기지 못한 것만 <b>확인 필요</b>에
              모이고 시스템이 틀린 위치로 몰래 옮기지는 않습니다. 형식을 바꿔(예: PDF에서 Word로) 올리면
              대부분이 확인 필요로 남을 수 있습니다.
            </li>
          </ul>
        </>
      ),
      shots: [
        {
          src: '/guide/docs.png',
          alt: '근거자료 화면',
          caption:
            '근거자료 파일을 올리면 제목과 버전이 자동으로 정리됩니다. 연도 선택 아래 점선 상자에 파일을 끌어다 놓아도 됩니다.',
        },
      ],
    },
    {
      id: 'review',
      group: 'prep',
      title: '확인 필요',
      body: (
        <>
          <p>
            시스템이 스스로 판단하지 않고 사람에게 묻는 항목이 모이는 곳입니다. 위 메뉴의 숫자가 남은
            건수입니다. 확인을 마치면 [확인 완료]를 눌러 목록에서 뺍니다.
          </p>
          <ul>
            <li>
              <b>근거자료 연결:</b> 근거자료 개정으로 자동으로 옮기지 못한 근거입니다. 문서를 열어 다시
              드래그해 연결합니다.
            </li>
            <li>
              <b>자동배점:</b> 기관 지표가 바뀌어 점수를 다시 계산해야 하는 문항입니다. 현재 점수와 새
              점수를 비교하고 [다시 계산해 확정]을 누릅니다.
            </li>
            <li>
              <b>재확인:</b> 문항 개정이나 배점 변경으로 채점을 다시 봐야 하는 문항입니다. 확인한 뒤
              [확인 완료]를 누릅니다.
            </li>
          </ul>
        </>
      ),
      shots: [
        {
          src: '/guide/review.png',
          alt: '확인 필요 화면',
          caption: '사람이 다시 봐야 할 항목이 자동으로 모입니다.',
        },
        {
          src: '/guide/reconnect.png',
          alt: '근거자료 뷰어의 위치 확인 필요 표시',
          caption:
            '근거자료 개정 뒤 자동으로 옮기지 못한 근거는 뷰어에 위치 확인 필요로 표시됩니다. 문서를 열어 다시 드래그해 연결하세요.',
        },
      ],
    },
    {
      id: 'summary',
      group: 'prep',
      title: '결과 요약, 인쇄, 엑셀',
      body: (
        <ul>
          <li>
            <b>결과 요약:</b> 모든 분야에서 감점된 문항과 지적/권장사항이 있는 문항만 모아 봅니다.
            심사 대비 회의 자료로 쓰기 좋습니다.
          </li>
          <li>
            <b>엑셀 내보내기:</b> 분야 화면에서는 그 분야를, 연도 화면에서는 연도 전체를 파일로
            받습니다.
          </li>
          <li>
            <b>인쇄:</b> 분야 문항 목록의 [인쇄]를 누르면 인쇄용 화면이 새 탭으로 열립니다. 표지,
            목차, 문항, 근거 요약이 종이 바인더 모양으로 나오고 프린터 대신 PDF로 저장을 고르면
            파일로 남길 수 있습니다.
          </li>
        </ul>
      ),
      shots: [
        {
          src: '/guide/summary.png',
          alt: '결과 요약 화면',
          caption: '감점이나 지적/권장사항이 있는 문항만 모아 봅니다.',
        },
      ],
    },
    {
      id: 'import',
      group: 'year',
      title: '문항 PDF 가져오기',
      role: '편집자 이상',
      body: (
        <ul>
          <li>
            연도 화면의 [+ 새 문항 PDF 가져오기]로 들어옵니다. 먼저 <b>가져올 연도</b>를 고르고
            인증기관이 배포한 문항 PDF를 올립니다. 분야별로 하나씩 올려도 되고 여러 파일을 한 번에
            올려도 됩니다.
          </li>
          <li>
            올리면 문항, 배점, 유형, 목차를 읽어 <b>미리보기</b>를 먼저 보여 줍니다. [가져오기
            실행]을 누르기 전에는 아무것도 바뀌지 않습니다.
          </li>
          <li>
            같은 연도에 다시 올릴 때는 <b>문항 설명만 새로 반영</b>을 고르세요. 문항 설명과 목차만
            바뀌고 이미 해 둔 채점, 답변, 근거는 그대로 남습니다. 배점이 달라진 문항은 덮어쓰지 않고
            재확인 표시를 붙입니다.
          </li>
          <li>가져오기를 실행하기 직전에 전체 자료가 자동으로 백업됩니다(data/backups 폴더).</li>
          <li>
            문항 PDF(「우수검사실 신임인증 심사점검표」)의 저작권은 진단검사의학재단에 있습니다. 가져온 문항은 기관 안의
            신임인증 준비에만 쓰세요(아래 '심사점검표 저작권' 참고).
          </li>
        </ul>
      ),
      shots: [
        {
          src: '/guide/import.png',
          alt: '문항 PDF 가져오기 화면',
          caption: '가져올 연도를 고르고 문항 PDF를 올립니다.',
        },
      ],
    },
    {
      id: 'yearly',
      group: 'year',
      title: '새 연도로 넘어가기',
      body: (
        <>
          <p>
            해마다 문항과 근거자료가 개정되어도 작년에 정리해 둔 것을 다시 입력할 필요가 없습니다.
          </p>
          <ol className="guide-steps">
            <li>연도별 홈에서 새 연도를 고르고 개정 문항 PDF를 올립니다.</li>
            <li>
              미리보기의 <b>지난 연도에서 물려받기</b>에서 같은 문항이 몇 건인지, 답변과 근거 연결이
              몇 건 복사되는지 실행 전에 확인합니다.
            </li>
            <li>
              실행하면 서술 답변, 근거 연결, 첨부는 물려받고 예/아니오 선택과 점수, 검토 표시는 새로
              시작합니다. 새 심사는 새로 채점해야 하기 때문입니다.
            </li>
            <li>
              내용이 바뀐 문항에는 <b>변경</b>, 새로 생긴 문항에는 <b>신규</b> 표시가 붙고 배점이
              바뀐 문항은 재확인 목록에 모입니다. 문항 상세의 [2026년 문항 보기]처럼 지난 연도가 적힌
              버튼으로 작년 문항을 열어 비교할 수 있습니다.
            </li>
            <li>
              근거자료도 같습니다. 개정판 파일을 새 연도로 올리면 같은 제목, 같은 형식의 새 버전으로
              이어지고 근거 연결이 새 버전으로 옮겨집니다. 자동으로 옮기지 못한 것만 확인 필요에
              모입니다.
            </li>
          </ol>
        </>
      ),
      shots: [
        {
          src: '/guide/import-preview.png',
          alt: '새 연도 가져오기 미리보기 화면',
          caption: '새 연도 미리보기: 지난 연도와 같은 문항 수와 복사될 답변, 근거 수를 실행 전에 알려 줍니다.',
        },
        {
          src: '/guide/year2027-detail.png',
          alt: '물려받은 문항 상세 화면',
          caption:
            '물려받은 문항: 지난해 근거 연결이 그대로 들어오고 내용이 바뀐 문항에는 변경 표시가 붙습니다.',
        },
      ],
    },
    {
      id: 'org',
      group: 'admin',
      title: '기관 정보',
      role: '편집자 이상',
      body: (
        <ul>
          <li>기관명과 위쪽 막대에 보이는 시스템 표시명을 바꿀 수 있습니다.</li>
          <li>
            <b>기관 지표:</b> 검사 건수, 직원 수 같은 값을 넣어 두면 자동배점 문항의 점수가 구간표에
            따라 계산됩니다. 지표를 바꾸면 관련 문항이 확인 필요에 올라와 다시 계산할지 묻습니다.
          </li>
        </ul>
      ),
      shots: [
        {
          src: '/guide/org.png',
          alt: '기관 정보 화면',
          caption: '기관명, 시스템 표시명과 자동배점에 쓰는 기관 지표를 관리합니다.',
        },
      ],
    },
    {
      id: 'users',
      group: 'admin',
      title: '사용자 계정 관리',
      role: '관리자 전용',
      body: (
        <>
          <p>
            오른쪽 위 사람 모양 아이콘을 누르면 나오는 [사용자 계정 관리]에서 직원 계정을 만들고
            관리합니다. 같은 메뉴에 [비밀번호 변경]과 [로그아웃]도 있습니다.
          </p>
          <ul>
            <li>
              <b>계정 만들기:</b> 아이디, 이름, 역할을 정하면 초기 비밀번호가 한 번 표시됩니다(비워
              두면 자동으로 만듭니다). 이 화면을 벗어나면 다시 볼 수 없으니 직원에게 안전하게
              전달하고 직원은 첫 로그인 뒤 [비밀번호 변경]으로 바꿉니다.
            </li>
            <li>
              <b>만료일:</b> 심사위원처럼 잠깐 쓸 계정은 열람자로 만들고 만료일을 정하세요. 그날까지만
              로그인할 수 있습니다.
            </li>
            <li>
              <b>비밀번호 재설정:</b> 직원이 비밀번호를 잊으면 관리자가 새로 발급합니다.
            </li>
            <li>
              <b>비활성화:</b> 퇴사자 계정은 지우지 않고 비활성화합니다. 작업 이력이 남고 언제든 다시
              활성화할 수 있습니다.
            </li>
            <li>
              자기 계정은 스스로 비활성화하거나 권한을 낮출 수 없고 마지막 남은 관리자도 보호됩니다.
              관리자가 한 명도 없는 상황을 막기 위해서입니다.
            </li>
          </ul>
        </>
      ),
      shots: [
        {
          src: '/guide/users.png',
          alt: '사용자 계정 관리 화면',
          caption: '오른쪽 위 사람 모양 아이콘을 누르고 [사용자 계정 관리]를 고르면 열립니다.',
        },
      ],
    },
    {
      id: 'adminops',
      group: 'admin',
      title: '운영 점검',
      role: '관리자 전용',
      body: (
        <>
          <p>
            오른쪽 위 사람 모양 아이콘을 누르고 [운영 점검(백업, 점검)]을 고르면 서버 관리 작업을 모두 버튼으로
            할 수 있습니다. 명령어를 입력할 필요가 없습니다.
          </p>
          <ul>
            <li>
              <b>빠른 백업(DB만):</b> 문항, 채점, 근거 연결이 담긴 데이터베이스의 사본(ZIP)을 바로
              만듭니다. 매일 새벽 3시에 자동으로 만들어지는 백업과는 따로 만들어지고 업로드한 원본
              파일(근거자료, 첨부)은 들어가지 않습니다.
            </li>
            <li>
              <b>전체 백업(원본 파일 포함):</b> 데이터베이스와 업로드한 원본 파일을 한 ZIP에 모두
              담습니다. 파일이 많으면 몇 분 걸립니다. 화면에 표시되는 파일을 USB 같은 다른 장치에
              복사해 두세요.
            </li>
            <li>
              <b>자료 점검:</b> [지금 점검 실행]을 누르면 저장된 자료에 깨지거나 어긋난 곳이 없는지
              항목별로 보여 줍니다. 이상이 보이면 화면을 캡처해 시스템 담당자에게 보내 주세요.
            </li>
            <li>
              <b>저장 공간:</b> 디스크에 남은 공간을 보여 주고 부족하면 알려 줍니다.
            </li>
            <li>
              <b>실사 전날 체크리스트:</b> 전체 백업, USB 복사, 자료 점검, 심사위원 계정, 문항 번호 검색
              연습, 엑셀과 인쇄 확인, 재부팅 뒤 접속 확인을 화면에서 하나씩 체크하며 따라갑니다.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'shortcuts',
      group: 'more',
      title: '검색과 단축키',
      body: (
        <>
          <p>
            위쪽 검색창(<kbd>Ctrl</kbd>+<kbd>K</kbd>)은 문항 번호와 문항 내용뿐 아니라 근거자료
            본문(PDF, Word, Excel 등)까지 함께 찾습니다. 문항 번호는 50.210.420처럼 다 넣어도 되고
            210420처럼 줄여 넣어도 됩니다. 문항 상세의 근거자료 연결 창에서도 제목뿐 아니라 본문
            내용으로 근거자료를 찾을 수 있습니다.
          </p>
          <table className="guide-table guide-keys">
            <tbody>
              <tr>
                <td>
                  <kbd>Ctrl</kbd>+<kbd>K</kbd> 또는 <kbd>/</kbd>
                </td>
                <td>어디서든 검색(문항 번호, 문항 내용, 근거자료 본문)</td>
              </tr>
              <tr>
                <td>
                  <kbd>j</kbd> <kbd>k</kbd>
                </td>
                <td>문항 상세에서 다음 문항, 이전 문항</td>
              </tr>
              <tr>
                <td>
                  <kbd>H</kbd>
                </td>
                <td>근거자료 연결 창 열기</td>
              </tr>
              <tr>
                <td>
                  <kbd>1</kbd>~<kbd>9</kbd>
                </td>
                <td>근거 ①~⑨ 열기</td>
              </tr>
              <tr>
                <td>
                  <kbd>Backspace</kbd>
                </td>
                <td>뷰어에서 다른 문항으로 넘어갔을 때 앞서 보던 문항으로 돌아가기</td>
              </tr>
              <tr>
                <td>
                  <kbd>M</kbd>
                </td>
                <td>근거자료 뷰어에서 근거 연결 모드 켜기, 끄기</td>
              </tr>
              <tr>
                <td>
                  <kbd>?</kbd>
                </td>
                <td>문항 상세에서 단축키 안내 열기</td>
              </tr>
            </tbody>
          </table>
        </>
      ),
      shots: [
        {
          src: '/guide/search.png',
          alt: '통합 검색 화면',
          caption: 'Ctrl+K로 문항 번호, 문항 내용, 근거자료 본문을 한 번에 찾습니다.',
        },
      ],
    },
    {
      id: 'safety',
      group: 'more',
      title: '데이터는 안전한가요?',
      body: (
        <>
          <p>
            <b>올린 근거자료는 기관 밖으로 나가지 않습니다.</b> 업로드가 그렇게 동작하도록 만들어져
            있습니다.
          </p>
          <ul>
            <li>
              파일은 기관 내부망에 설치된 이 시스템의 서버 컴퓨터 한 곳(data 폴더)에만 저장됩니다.
              클라우드나 외부 서버로 보내는 경로가 아예 없습니다. 동료들은 그 서버에 접속해 같은
              내용을 보는 것이라 문서가 PC마다 복사되어 돌아다니지도 않습니다.
            </li>
            <li>
              본문 검색을 위한 글자 추출과 색인도 모두 그 서버 안에서 처리합니다. 외부 검색 서비스나
              인터넷 AI에 문서를 보내지 않습니다.
            </li>
            <li>
              그래서 인터넷이 끊겨 있어도 모든 기능이 동작합니다. 글꼴과 프로그램 부품까지 모두 서버에
              들어 있습니다.
            </li>
            <li>보기와 편집은 로그인한 계정으로만 할 수 있고 역할(열람자, 편집자, 관리자)로 구분됩니다.</li>
          </ul>
          <p>그 밖의 안전장치:</p>
          <ul>
            <li>문항 가져오기처럼 큰 변경 전에는 자동 백업이 만들어집니다(백업도 같은 서버 안).</li>
            <li>지운 항목은 숨겨 두는 방식이라 실수해도 되살릴 수 있습니다.</li>
            <li>누가 언제 무엇을 바꿨는지 변경 이력이 모두 남습니다.</li>
            <li>백업과 복구 절차는 docs 폴더의 운영 런북 문서를 참고하세요.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'copyright',
      group: 'more',
      title: '심사점검표 저작권',
      body: (
        <>
          <p>
            문항 PDF로 가져오는 「우수검사실 신임인증 심사점검표」의 저작권은 <b>재단법인 진단검사의학재단</b>에
            있습니다. 재단의 저작권 보호 안내 요지는 다음과 같습니다.
          </p>
          <ul>
            <li>
              재단의 사전 서면 동의 없이 전재, 복제, 배포하거나 2차적 저작물을 만들 수 없고, 상업적으로 쓸 수 없습니다.
            </li>
            <li>
              심사점검표를 정보시스템, 소프트웨어, 애플리케이션이나 상업적 서비스에 싣거나 연동해 쓰려는 업체는 재단과
              미리 협의해 저작물 이용 계약을 맺어야 합니다.
            </li>
            <li>
              의료기관이 검사 업무와 신임인증 준비를 위해 자체 사용 목적으로 직접 만든 프로그램에 활용하는 경우에는
              재단이 따로 알릴 때까지 이 계약 요구를 유예합니다. 유예를 끝낼 때는 재단이 미리 공지합니다.
            </li>
            <li>
              허락 없이 쓰거나 허락된 범위를 벗어나 쓰면 저작권법에 따라 침해 정지 청구, 손해배상 청구 같은 법적 조치를
              받을 수 있습니다.
            </li>
          </ul>
          <p>이 시스템에서 지킬 것:</p>
          <ul>
            <li>
              이 시스템의 배포 파일에는 심사점검표 문항이 들어 있지 않습니다. 각 기관이 받은 문항 PDF를 기관 안의 서버에
              직접 가져와 씁니다.
            </li>
            <li>
              가져온 문항과 문항이 담긴 엑셀 내보내기, 인쇄본은 기관 안의 신임인증 준비에만 쓰고 기관 밖으로 배포하지
              마세요.
            </li>
            <li>쓸 수 있는 범위가 궁금하면 진단검사의학재단에 문의하세요. 재단의 공지가 바뀌면 바뀐 공지를 따릅니다.</li>
          </ul>
        </>
      ),
    },
  ];
}

/** 글을 읽는 스크롤 상자(.app-content). 없으면 문서 전체 */
function scrollBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.app-content');
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** 확대창 배율 단계 (화면에 맞춘 크기 기준) */
const ZOOM_STEPS = [1, 1.5, 2, 3, 4];

/**
 * 캡처 확대창. 처음에는 화면에 맞춘 크기(원래 크기보다 크게 키우지는 않는다)로 보이고, 단추와 키로 단계별로
 * 키우거나 줄인다. 그림을 누르면 누른 자리를 중심으로 2배, 2배 이상에서 누르면 맞춤으로 돌아간다. 확대한 그림은
 * 끌어서 옮기고(5px 넘게 움직이면 누르기가 아니라 끌기), 그림 바깥을 누르거나 Esc 를 누르면 닫는다.
 * 열리면 닫기 단추에 포커스를 두고 Tab 은 창 안 단추들 사이만 돈다. 닫히면 연 캡처로 포커스를 돌려준다.
 * 문서 최상위(body)에 그린다: 본문 스크롤 상자가 만든 쌓임 맥락 안에 두면 위쪽 막대가 창 위로 올라온다.
 */
function ShotLightbox({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitSize, setFitSize] = useState<[number, number] | null>(null);
  const natural = useMemo<[number, number]>(() => SHOT_SIZE[shot.src] ?? [1280, 800], [shot.src]);
  /** 배율을 바꾼 뒤 이 자리(그림 안 비율, 화면 좌표)가 같은 곳에 머물도록 스크롤을 맞춘다 */
  const anchorRef = useRef<{ rx: number; ry: number; x: number; y: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean; id: number } | null>(null);
  /** 누르기를 시작한 곳이 바깥(무대 빈 곳, 막)일 때만 닫는다: 그림을 끌다가 바깥에서 손을 떼도 닫히지 않게 */
  const downOutsideRef = useRef(false);

  // 화면에 맞춘 크기: 무대 크기 안에서 비율을 지키고, 원래 크기보다 키우지 않는다
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const w = Math.max(1, stage.clientWidth - 32);
      const h = Math.max(1, stage.clientHeight - 32);
      const k = Math.min(w / natural[0], h / natural[1], 1);
      const next: [number, number] = [Math.round(natural[0] * k), Math.round(natural[1] * k)];
      setFitSize((cur) => (cur && cur[0] === next[0] && cur[1] === next[1] ? cur : next));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(stage);
    return () => ro?.disconnect();
  }, [natural]);

  // 배율을 바꾼 뒤 기준점이 손가락(포인터) 아래 그대로 있게 스크롤을 옮긴다
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const a = anchorRef.current;
    if (!stage || !a || !fitSize) return;
    anchorRef.current = null;
    const img = stage.querySelector('img');
    if (!img) return;
    const ir = img.getBoundingClientRect();
    stage.scrollLeft += ir.left + a.rx * ir.width - a.x;
    stage.scrollTop += ir.top + a.ry * ir.height - a.y;
  }, [zoom, fitSize]);

  // 열리면 닫기 단추로 포커스, 뒤 화면 스크롤 잠금. 닫히면 둘 다 되돌린다
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const box = scrollBox();
    const prev = box?.style.overflow ?? '';
    if (box) box.style.overflow = 'hidden';
    return () => {
      if (box) box.style.overflow = prev;
      opener?.focus?.();
    };
  }, []);

  /** 배율 단계 이동. 기준점이 없으면 무대 가운데 */
  const zoomTo = (next: number, at?: { x: number; y: number }) => {
    const stage = stageRef.current;
    const img = stage?.querySelector('img');
    if (stage && img) {
      const sr = stage.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      const x = at?.x ?? sr.left + sr.width / 2;
      const y = at?.y ?? sr.top + sr.height / 2;
      anchorRef.current = {
        rx: Math.min(1, Math.max(0, (x - ir.left) / ir.width)),
        ry: Math.min(1, Math.max(0, (y - ir.top) / ir.height)),
        x,
        y,
      };
    }
    setZoom(next);
  };
  const stepIndex = ZOOM_STEPS.indexOf(zoom);
  const zoomIn = () => {
    if (stepIndex < ZOOM_STEPS.length - 1) zoomTo(ZOOM_STEPS[stepIndex + 1]!);
  };
  const zoomOut = () => {
    if (stepIndex > 0) zoomTo(ZOOM_STEPS[stepIndex - 1]!);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomIn();
    } else if (e.key === '-') {
      e.preventDefault();
      zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      zoomTo(1);
    } else if (e.key === 'Tab') {
      // Tab 은 창 안 단추들 사이만 돈다
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next]!.focus();
    }
  };

  // 그림: 누르기(확대/맞춤)와 끌기(옮기기)를 가른다
  const onImgPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (e.button !== 0) return;
    const stage = stageRef.current!;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop, moved: false, id: e.pointerId };
  };
  const onImgPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    const stage = stageRef.current!;
    stage.scrollLeft = d.sl - dx;
    stage.scrollTop = d.st - dy;
  };
  const onImgPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.id !== e.pointerId || d.moved) return;
    if (zoom < 2) zoomTo(2, { x: e.clientX, y: e.clientY });
    else zoomTo(1, { x: e.clientX, y: e.clientY });
  };

  const size = fitSize ? { width: Math.round(fitSize[0] * zoom), height: Math.round(fitSize[1] * zoom) } : undefined;
  const percent = fitSize ? Math.round(((fitSize[0] * zoom) / natural[0]) * 100) : 100;
  return createPortal(
    <div
      ref={dialogRef}
      className="guide-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${shot.alt} 크게 보기`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        downOutsideRef.current = e.target === e.currentTarget || e.target === stageRef.current;
      }}
      onClick={(e) => {
        const outside = e.target === e.currentTarget || e.target === stageRef.current;
        if (outside && downOutsideRef.current) onClose();
        downOutsideRef.current = false;
      }}
    >
      <div className="guide-lightbox-bar">
        <button type="button" className="btn btn-sm" onClick={zoomOut} disabled={stepIndex <= 0} aria-label="축소 (- 키)">
          축소
        </button>
        <span className="guide-lightbox-zoom" aria-live="polite">
          {percent}%
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={zoomIn}
          disabled={stepIndex >= ZOOM_STEPS.length - 1}
          aria-label="확대 (+ 키)"
        >
          확대
        </button>
        <button type="button" className="btn btn-sm" onClick={() => zoomTo(1)} disabled={zoom === 1} aria-label="화면에 맞춤 (0 키)">
          화면에 맞춤
        </button>
        <button ref={closeRef} type="button" className="btn btn-sm guide-lightbox-close" onClick={onClose} aria-label="닫기 (Esc)">
          닫기
        </button>
      </div>
      <div ref={stageRef} className={'guide-lightbox-stage' + (zoom > 1 ? ' is-zoomed' : '')}>
        <img
          src={shot.src}
          alt={shot.alt}
          width={size?.width ?? natural[0]}
          height={size?.height ?? natural[1]}
          style={size}
          draggable={false}
          onPointerDown={onImgPointerDown}
          onPointerMove={onImgPointerMove}
          onPointerUp={onImgPointerUp}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          title={zoom < 2 ? '누르면 그 위치를 2배로 확대합니다' : '누르면 화면에 맞춥니다. 끌어서 옮길 수 있습니다'}
        />
      </div>
      <p className="guide-lightbox-caption">{shot.caption}</p>
    </div>,
    document.body,
  );
}

/**
 * 지금 읽는 장. 위쪽 기준선(120px)을 지난 마지막 장이고, 맨 아래까지 내렸으면 마지막 장이다.
 * 목차를 눌러 옮긴 직후에는 그 장을 잠시 고정한다: 끝쪽의 짧은 장은 화면 위까지 올라오지 못해
 * 재기만 하면 다른 장으로 잡히기 때문이다. 사용자가 직접 스크롤하면 고정을 푼다.
 */
function useActiveSection(ids: string[]): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0] ?? '');
  const pinRef = useRef<number>(0);
  useEffect(() => {
    const box = scrollBox();
    const target: HTMLElement | Window = box ?? window;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (performance.now() < pinRef.current) return;
      const top = box ? box.getBoundingClientRect().top : 0;
      const atBottom = box
        ? box.scrollTop + box.clientHeight >= box.scrollHeight - 4
        : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom && ids.length > 0) {
        setActive(ids[ids.length - 1]!);
        return;
      }
      let current = ids[0] ?? '';
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top - top <= 120) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    const release = () => {
      pinRef.current = 0;
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    target.addEventListener('wheel', release, { passive: true });
    target.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', release);
    // 캡처가 늦게 읽혀 글 길이가 바뀌어도 다시 잰다
    const article = document.querySelector('.guide-article');
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    if (ro && article) ro.observe(article);
    measure();
    return () => {
      target.removeEventListener('scroll', onScroll);
      target.removeEventListener('wheel', release);
      target.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', release);
      ro?.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [ids]);
  const select = useCallback((id: string) => {
    pinRef.current = performance.now() + 1200;
    setActive(id);
  }, []);
  return [active, select];
}

export default function Guide() {
  const sections = useSections();
  // 장 목록은 렌더마다 새 배열이라, 아이디를 이은 문자열로 바뀜 여부를 본다
  const idsKey = sections.map((s) => s.id).join(' ');
  const ids = useMemo(() => idsKey.split(' '), [idsKey]);
  const [active, selectSection] = useActiveSection(ids);

  const goTo = useCallback(
    (id: string, smooth: boolean) => {
      const el = document.getElementById(id);
      if (!el) return;
      selectSection(id);
      el.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto', block: 'start' });
      window.history.replaceState(null, '', `#${id}`);
    },
    [selectSection],
  );

  // 주소에 #장 이 붙어 들어오면 그 장으로 바로 간다
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
    if (id && ids.includes(id)) goTo(id, false);
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTocClick = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    goTo(id, true);
  };

  // 캡처 확대창 (같은 창 위에 띄운다)
  const [zoomShot, setZoomShot] = useState<Shot | null>(null);

  return (
    <div className="page guide-page">
      <header className="guide-header">
        <h1>사용 안내</h1>
        <p className="guide-lead">
          처음 쓰는 분은 위에서부터 차례로 읽어 보세요. 다 읽는 데 5분쯤 걸립니다. 화면 캡처는 가상
          데모 자료로 찍었고 누르면 이 창에서 크게 볼 수 있습니다.
        </p>
      </header>
      <div className="guide-layout">
        <nav className="guide-toc" aria-label="안내 목차">
          {GROUPS.map((g) => {
            const items = sections.filter((s) => s.group === g.id);
            if (items.length === 0) return null;
            return (
              <div key={g.id} className="guide-toc-group">
                <p className="guide-toc-label">{g.label}</p>
                <ul>
                  {items.map((s) => (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        aria-current={active === s.id ? 'true' : undefined}
                        onClick={(e) => onTocClick(e, s.id)}
                      >
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <article className="guide-article">
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="guide-section" aria-labelledby={`${s.id}-title`}>
              <div className="guide-section-head">
                <h2 id={`${s.id}-title`}>{s.title}</h2>
                {s.role && <span className="guide-role">{s.role}</span>}
              </div>
              {s.body}
              {s.shots?.map((shot) => (
                <figure key={shot.src} className="guide-shot">
                  <button
                    type="button"
                    className="guide-shot-btn"
                    onClick={() => setZoomShot(shot)}
                    aria-label={`${shot.alt} 크게 보기`}
                    title="누르면 이 창에서 크게 봅니다"
                  >
                    <img
                      src={shot.src}
                      alt={shot.alt}
                      loading="lazy"
                      width={SHOT_SIZE[shot.src]?.[0]}
                      height={SHOT_SIZE[shot.src]?.[1]}
                    />
                  </button>
                  <figcaption>{shot.caption}</figcaption>
                </figure>
              ))}
            </section>
          ))}
          {/* 한컴 HWP 공개 문서 이용 조건: 도움말에도 출처 문구를 둔다 */}
          <p className="guide-credit">본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.</p>
        </article>
      </div>
      {zoomShot && <ShotLightbox shot={zoomShot} onClose={() => setZoomShot(null)} />}
    </div>
  );
}
