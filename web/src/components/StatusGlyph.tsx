/**
 * 진행 상태 글리프 — 인라인 SVG (검토 반영: ●◐○ 텍스트 글리프는 내부망 Windows
 * 폰트에서 두부 렌더링·12px 크기에서 구분 불가 → 벡터로 교체).
 * 색은 기존 st-* 클래스의 color를 currentColor로 그대로 사용한다.
 */
export type StatusKind = 'full' | 'partial' | 'none';

export const STATUS_LABEL: Record<StatusKind, string> = {
  full: '답변+채점 완료',
  partial: '일부 작성',
  none: '미작성',
};

export default function StatusGlyph({ kind, title }: { kind: StatusKind; title?: string }) {
  const label = title ?? STATUS_LABEL[kind];
  return (
    <svg
      className={`status-glyph st-${kind}`}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle
        cx="6"
        cy="6"
        r="4.6"
        fill={kind === 'full' ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
      />
      {kind === 'partial' && <path d="M6 1.4 A4.6 4.6 0 0 0 6 10.6 Z" fill="currentColor" />}
    </svg>
  );
}
