/**
 * 문서 뷰어 페인 고르기
 *
 * 판본 원본 형식(fileKind)에 맞는 뷰어를 붙인다.
 * - pdf, 또는 형식을 모를 때(구 서버 응답): 기존 PdfViewerPane 그대로
 * - Word, Excel, PowerPoint, 한글(hwpx), 텍스트: OfficeViewerPane (서버가 만든 렌더 모델 JSON 을 그린다)
 *
 * OfficeViewerPane 은 처음 필요할 때 따로 받아 온다(React.lazy). PDF 만 여는 화면은 그 코드를 받지 않는다.
 * 그리다 오류가 나도 화면 전체가 비지 않도록 이 페인 자리에만 안내를 띄운다. 판본이 바뀌거나 다른 문서로
 * 옮기면 부모가 key 로 DocPane 을 새로 붙이므로 그 안내는 지워진다.
 * 뷰어 코드를 받아 오지 못한 경우는 다르다: React.lazy 도, 브라우저의 모듈 목록도 실패한 결과를 기억해
 * 페이지를 새로 읽기 전에는 다시 받지 않는다(Chrome 에서 확인). 그래서 한국어 안내와 새로고침 단추를 보인다.
 */
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import type { FileKind } from '../api';
import PdfViewerPane, { type PdfViewerPaneProps } from '../pdf/PdfViewerPane';

/** 뷰어 코드 조각을 받아 오지 못했다(화면에는 브라우저의 영문 문구 대신 한국어 안내를 보인다) */
class ViewerChunkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ViewerChunkError';
  }
}

const OfficeViewerPane = lazy(() =>
  import('./OfficeViewerPane').catch((e: unknown) => {
    throw new ViewerChunkError(e);
  }),
);

export type DocPaneProps = PdfViewerPaneProps & {
  /** 판본 원본 형식. 없으면 pdf 로 본다 */
  fileKind?: FileKind | null;
  /** 처음 열 때 찾아서 깜빡여 보일 검색어(?q=). PDF 뷰어는 쓰지 않는다 */
  initialQuery?: string;
};

interface BoundaryState {
  error: Error | null;
}

class PaneErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('문서 뷰어 오류:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="pvp-status pvp-status-error" role="alert">
        {error instanceof ViewerChunkError
          ? '문서 뷰어를 받아 오지 못했습니다. 네트워크 연결을 확인한 뒤 새로고침해 주세요.'
          : `문서를 표시하지 못했습니다: ${error.message}`}{' '}
        <button type="button" className="btn pvp-btn-sm" onClick={() => window.location.reload()}>
          새로고침
        </button>
      </div>
    );
  }
}

export default function DocPane({ fileKind, initialQuery, ...paneProps }: DocPaneProps) {
  if (fileKind == null || fileKind === 'pdf') return <PdfViewerPane {...paneProps} />;
  return (
    <PaneErrorBoundary>
      <Suspense fallback={<div className="pvp-status">문서 불러오는 중…</div>}>
        <OfficeViewerPane {...paneProps} fileKind={fileKind} initialQuery={initialQuery} />
      </Suspense>
    </PaneErrorBoundary>
  );
}
