/**
 * 단색 선화 아이콘 — 컬러 이모지(🔍 📄 🔗 …) 대체.
 *
 * 규칙: 검정 잉크 한 색, 균일한 가는 monoline(굵기 1.6), 둥근 끝·이음,
 * 면 채움·그라데이션·그림자 없음. 색은 언제나 currentColor 를 따라간다 — 아이콘이
 * 스스로 색을 갖지 않으므로 노랑 뱃지 위에서도 경고 라벨 옆에서도 그대로 읽힌다.
 *
 * 외부 아이콘 패키지를 쓰지 않는다 — 내부망 런타임에 외부 요청이 없어야 하고(설계서 §1 오프라인 원칙),
 * 여기서 쓰는 도형은 몇 개뿐이라 직접 그리는 편이 의존성보다 싸다.
 */

export type IconName =
  | 'search'
  | 'file'
  | 'link'
  | 'book'
  | 'note'
  | 'warn'
  | 'check'
  | 'download'
  | 'close';

const PATHS: Record<IconName, JSX.Element> = {
  // 돋보기
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.4 15.4 L20.5 20.5" />
    </>
  ),
  // 문서(모서리 접힌 종이)
  file: (
    <>
      <path d="M14 3.2H7a1.8 1.8 0 0 0-1.8 1.8v14a1.8 1.8 0 0 0 1.8 1.8h10a1.8 1.8 0 0 0 1.8-1.8V8z" />
      <path d="M14 3.2V8h4.8" />
    </>
  ),
  // 사슬 고리
  link: (
    <>
      <path d="M10 13.8a3.6 3.6 0 0 0 5.2.3l3-3a3.6 3.6 0 1 0-5.1-5.1l-1.7 1.7" />
      <path d="M14 10.2a3.6 3.6 0 0 0-5.2-.3l-3 3a3.6 3.6 0 1 0 5.1 5.1l1.7-1.7" />
    </>
  ),
  // 책(지침서)
  book: (
    <>
      <path d="M4.6 4.4A1.8 1.8 0 0 1 6.4 2.6H19v18.8H6.4a1.8 1.8 0 0 1-1.8-1.8z" />
      <path d="M4.6 17.6h13.2" />
    </>
  ),
  // 연필(자유형식 문서)
  note: (
    <>
      <path d="M4.5 19.5h3.2L18.4 8.8a2.2 2.2 0 0 0-3.2-3.2L4.5 16.3z" />
      <path d="M14.2 6.6l3.2 3.2" />
    </>
  ),
  // 주의 삼각형
  warn: (
    <>
      <path d="M12 4.2 21 19.6H3z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.1v.1" />
    </>
  ),
  // 체크
  check: <path d="M4.8 12.6 9.6 17.4 19.2 6.6" />,
  // 내려받기(아래 화살표 + 받침)
  download: (
    <>
      <path d="M12 3.6v11.2" />
      <path d="M7.4 10.4 12 15l4.6-4.6" />
      <path d="M4.6 19.4h14.8" />
    </>
  ),
  // 닫기
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
};

export default function Icon({
  name,
  size = 16,
  className,
  title,
}: {
  name: IconName;
  /** 글자 크기에 맞춘 정사각 픽셀 크기 */
  size?: number;
  className?: string;
  /** 주면 그림 라벨이 되고, 없으면 장식으로 숨긴다 */
  title?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
