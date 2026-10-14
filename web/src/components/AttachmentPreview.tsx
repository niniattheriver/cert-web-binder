/**
 * 첨부파일 미리보기 창: 첨부를 누르면 바로 내려받지 않고 메일 첨부처럼 미리보기가 뜨며,
 * 내려받기는 옆의 별도 버튼으로 한다.
 *
 * 서버(`/api/questions/attachments/:aid/preview`)가 형식별로 뽑아 준 payload 를 그린다.
 * pdf·이미지만 파일 URL 을 그대로 쓰고(inline 화이트리스트), 나머지는 서버가 뽑은
 * 텍스트·표·문단만 받는다 — 원본 바이트를 브라우저에 실어 HTML 이 실행될 여지를 없애기 위함.
 * 미리보기를 만들 수 없는 형식(구형 ppt 등)은 이유를 적고 내려받기만 안내한다.
 *
 * 고충실도 미리보기
 * - docx, xlsx, pptx, hwpx, 텍스트는 서버가 지침서 라이브러리와 같은 추출기로 만든 렌더 모델(kind 'model')로
 *   온다. 지침서 뷰어와 같은 렌더러(FlowView, SheetView, SlidesView, PlainView)로 읽기 전용으로 그리고,
 *   모델 안의 그림은 첨부 그림 라우트(attachmentMediaUrl)로 받는다. 렌더 모델을 못 만든 파일은 예전 꼴
 *   (글자, 표, 문단)로 온다.
 * - 렌더러는 처음 필요할 때 받아 온다(React.lazy, DocPane 과 같은 방식: PDF, 이미지만 여는 화면은 받지 않는다).
 *   받아 오기나 그리기에 실패해도 창 본문에만 안내를 띄운다(페이지 전체가 비지 않게). 받아 오기 실패는
 *   창을 다시 열 때 한 번 더 받아 오고, 그래도 안 되면(Chrome 처럼 브라우저가 실패를 기억하는 경우 포함)
 *   안내의 [새로고침]으로 다시 연다.
 * - 잘림 안내(model.truncated)는 네 렌더러가 스스로 그리므로 이 창은 따로 적지 않는다.
 * - 창이 떠 있는 동안 아래 화면의 단축키(window 버블 단계: j/k 문항 이동, 1-9, h, Backspace, Ctrl+K 등)는
 *   반응하지 않는다. 배경은 누름이 배경에서 시작했을 때만 창을 닫는다(글자를 끌어 고르다 배경에서 놓아도
 *   닫히지 않게).
 */
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import {
  attachmentDownloadUrl,
  attachmentFileUrl,
  attachmentMediaUrl,
  fetchAttachmentPreview,
  type AttachmentPreviewResponse,
} from '../api-phase2';
import type { RenderModel } from '../office/model';
import { FILE_KIND_LABEL } from '../office/pageLabel';
import { asRenderModel } from '../office/renderCache';
import { errorMessage } from '../util';
import Icon from './Icon';

/** 렌더러 코드 조각을 받아 오지 못했다 (화면에는 브라우저의 영문 문구 대신 한국어 안내를 보인다) */
class RendererChunkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RendererChunkError';
  }
}

/**
 * 처음 그릴 때 받아 오는 렌더러. React.lazy 는 받아 오기에 실패한 결과도 그 객체에 기억해 두고 다시 받지
 * 않는다(DocPane 과 같은 문제). 실패하면 새 lazy 객체로 바꿔 두어, 다음에 창을 열 때 다시 받아 오게 한다
 * (브라우저도 실패를 기억하면 그때도 실패하고, 안내의 [새로고침]이 남는다).
 */
function retryableLazy<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): () => LazyExoticComponent<ComponentType<P>> {
  const make = (): LazyExoticComponent<ComponentType<P>> =>
    lazy(() =>
      load().catch((e: unknown) => {
        current = make();
        throw new RendererChunkError(e);
      }),
    );
  let current = make();
  return () => current;
}

const flowView = retryableLazy(() => import('../office/FlowView'));
const sheetView = retryableLazy(() => import('../office/SheetView'));
const slidesView = retryableLazy(() => import('../office/SlidesView'));
const plainView = retryableLazy(() => import('../office/PlainView'));

/** 지금 쓸 렌더러 묶음 (받아 오기에 실패한 렌더러는 이미 새 lazy 객체로 바뀌어 있다) */
function currentViews() {
  return { Flow: flowView(), Sheet: sheetView(), Slides: slidesView(), Plain: plainView() };
}
type Views = ReturnType<typeof currentViews>;

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** 렌더 모델 본문의 바깥 여백(로딩, 오류 안내용): 창 본문의 기본 여백과 같다 */
const MODEL_MSG_STYLE: CSSProperties = { padding: '14px 16px 18px' };

/** 렌더 모델을 그리는 동안 창 본문 꼴: 여백은 렌더러가 맡는다. 시트는 격자가 스스로 스크롤한다 */
function modelBodyStyle(model: RenderModel): CSSProperties {
  return model.kind === 'sheet'
    ? { padding: 0, overflow: 'hidden', background: 'var(--surface)' }
    : { padding: 0, background: 'var(--panel)' };
}

interface BoundaryState {
  error: Error | null;
}

/** 오류 안내의 단추 줄: 가운데 정렬 */
const MSG_ACTIONS_STYLE: CSSProperties = { justifyContent: 'center', marginTop: 0 };

/**
 * 렌더러를 받아 오거나 그리다 실패해도 창 본문에만 안내를 띄운다.
 * 받아 오기 실패면 [새로고침]을 함께 보인다. 같은 페이지 안에서 다시 받기만 하는 단추는 두지 않는다:
 * Chrome 은 실패한 동적 import 를 기억해, 다시 import 해도 네트워크 요청 없이 곧바로 실패한다.
 */
class ModelBoundary extends Component<{ downloadUrl: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('첨부 미리보기 오류:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = error instanceof RendererChunkError;
    return (
      <div style={MODEL_MSG_STYLE}>
        <div className="attach-preview-none" role="alert">
          <p>
            {chunk
              ? '미리보기 화면을 받아 오지 못했습니다. 네트워크 연결을 확인한 뒤 새로고침해 주세요.'
              : `미리보기를 그리지 못했습니다: ${error.message}`}
          </p>
          <div className="btn-row" style={MSG_ACTIONS_STYLE}>
            {chunk && (
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                새로고침
              </button>
            )}
            <a className="btn btn-primary" href={this.props.downloadUrl}>
              <Icon name="download" size={14} /> 내려받기
            </a>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * 렌더 모델 본문: 형식에 맞는 렌더러로 읽기 전용으로 그린다 (잘림 안내는 렌더러가 그린다).
 * 렌더러 묶음(views)은 Suspense 바깥에서 받는다. 이 컴포넌트는 Suspense 안이라 받아 오기를 기다린 뒤 다시
 * 그려지는데, 여기서 렌더러를 그때그때 읽으면 실패 뒤 새 lazy 객체를 집어 또 받아 오기 시작해 안내 없이
 * 끝없이 되풀이된다.
 */
function ModelBody({ attachmentId, model, views }: { attachmentId: number; model: RenderModel; views: Views }) {
  // 시트 탭: 보이는 시트 번호는 이 창이 들고, 탭 줄은 SheetView 가 그린다
  const [activePage, setActivePage] = useState(() => model.pages[0]?.pageNo ?? 1);
  const mediaUrl = useCallback((i: number) => attachmentMediaUrl(attachmentId, i), [attachmentId]);
  const { Flow, Sheet, Slides, Plain } = views;
  switch (model.kind) {
    case 'flow':
      return <Flow model={model} mediaUrl={mediaUrl} />;
    case 'sheet':
      return <Sheet model={model} activePage={activePage} onActivePageChange={setActivePage} />;
    case 'slides':
      return <Slides model={model} mediaUrl={mediaUrl} />;
    case 'plain':
      return <Plain model={model} />;
    default:
      return null;
  }
}

export default function AttachmentPreview({
  attachmentId,
  origName,
  onClose,
}: {
  attachmentId: number;
  /** 로딩 중에도 제목줄에 파일명을 보여주기 위한 값 */
  origName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<AttachmentPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 렌더러 묶음은 창을 열 때 한 번 정해 상태로 든다(ModelBody 머리 주석 참고). 창을 다시 열면 실패한
  // 렌더러는 새 lazy 객체로 바뀌어 있어 한 번 더 받아 온다
  const [views] = useState(currentViews);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setSheetIdx(0);
    fetchAttachmentPreview(attachmentId)
      .then((d) => {
        if (!alive) return;
        // 렌더 모델은 모양을 가볍게 확인한다(형식, 쪽 목록). 화면 코드와 서버가 어긋나면 안내로 보인다
        if (d.preview.kind === 'model') asRenderModel(d.preview.model);
        setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [attachmentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // 창이 떠 있는 동안 아래 화면의 단축키(window 버블 단계에 붙는 useShortcuts, AppShell)가 반응하지 않게
    // document 버블 단계에서 전파를 멈춘다. 창 안쪽의 React 키 처리(시트 탭 화살표 등)는 그보다 먼저 끝난다.
    // 글자 입력, 스크롤 같은 기본 동작은 그대로다(preventDefault 는 하지 않는다)
    const isolate = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('keydown', isolate);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keydown', isolate);
    };
  }, [onClose]);

  // 배경 누름이 배경에서 시작했는지: 창 안에서 글자를 끌어 고르다 배경에서 놓으면 click 이 배경에 떨어지므로
  // 누름 위치까지 확인해 닫는다
  const pressOnBackdrop = useRef(false);

  // 열릴 때 창으로 포커스를 옮기고, 닫히면 연 단추로 돌려준다 (지침서 빠른 보기 창과 같다)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const p = data?.preview ?? null;
  const model = p?.kind === 'model' ? p.model : null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        pressOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const fromBackdrop = pressOnBackdrop.current && e.target === e.currentTarget;
        pressOnBackdrop.current = false;
        if (fromBackdrop) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="modal-card attach-preview"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`첨부파일 미리보기: ${origName}`}
        tabIndex={-1}
      >
        <div className="attach-preview-head">
          <Icon name="file" size={16} />
          <span className="attach-preview-name" title={origName}>
            {data?.origName ?? origName}
          </span>
          {p?.kind === 'model' && <span className="attach-preview-meta">{FILE_KIND_LABEL[p.fileKind]}</span>}
          {data && <span className="attach-preview-meta">{fmtSize(data.size)}</span>}
          <a
            className="btn btn-sm attach-preview-dl"
            href={attachmentDownloadUrl(attachmentId)}
            title="이 파일을 내 PC로 내려받습니다"
          >
            <Icon name="download" size={14} /> 내려받기
          </a>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} title="닫기(Esc)">
            <Icon name="close" size={14} title="닫기" />
          </button>
        </div>

        <div className="attach-preview-body" style={model ? modelBodyStyle(model) : undefined}>
          {error && <div className="alert-card alert-danger">{error}</div>}
          {!error && data == null && <div className="dim">미리보기를 준비하는 중…</div>}

          {model && (
            <ModelBoundary key={attachmentId} downloadUrl={attachmentDownloadUrl(attachmentId)}>
              <Suspense fallback={<div className="dim" style={MODEL_MSG_STYLE}>미리보기를 준비하는 중…</div>}>
                <ModelBody attachmentId={attachmentId} model={model} views={views} />
              </Suspense>
            </ModelBoundary>
          )}

          {p?.kind === 'pdf' && (
            <iframe
              className="attach-preview-frame"
              src={attachmentFileUrl(attachmentId)}
              title={`${origName} 미리보기`}
            />
          )}

          {p?.kind === 'image' && (
            <div className="attach-preview-imgwrap">
              <img src={attachmentFileUrl(attachmentId)} alt={origName} />
            </div>
          )}

          {p?.kind === 'text' && (
            <>
              <pre className="attach-preview-text">{p.text}</pre>
              {p.truncated && (
                <p className="attach-preview-note">
                  긴 파일이라 앞부분만 보여줍니다. 전체는 내려받아 확인하세요.
                </p>
              )}
            </>
          )}

          {p?.kind === 'sheet' && (
            <>
              {p.sheets.length > 1 && (
                <div className="chip-row attach-preview-tabs">
                  {p.sheets.map((s, i) => (
                    <button
                      key={s.name + i}
                      type="button"
                      className={'chip' + (i === sheetIdx ? ' is-on' : '')}
                      onClick={() => setSheetIdx(i)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="attach-preview-sheet">
                <table className="simple-table">
                  <tbody>
                    {(p.sheets[sheetIdx]?.rows ?? []).map((row, ri) => (
                      <tr key={ri}>
                        <td className="attach-preview-rowno">{ri + 1}</td>
                        {row.map((cell, ci) => (
                          <td key={ci}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(p.truncated || p.sheets[sheetIdx]?.truncated) && (
                <p className="attach-preview-note">
                  큰 표라 앞부분만 보여줍니다. 전체는 내려받아 확인하세요.
                </p>
              )}
            </>
          )}

          {p?.kind === 'doc' && (
            <>
              <div className="attach-preview-doc">
                {p.paragraphs.map((t, i) => (
                  <p key={i}>{t}</p>
                ))}
              </div>
              {p.truncated && (
                <p className="attach-preview-note">
                  긴 문서라 앞부분만 보여줍니다. 서식과 그림은 미리보기에 나오지 않습니다.
                </p>
              )}
              <p className="attach-preview-note">
                글자만 뽑아 보여주는 미리보기입니다. 원래 서식은 내려받아 확인하세요.
              </p>
            </>
          )}

          {p?.kind === 'slides' && (
            <>
              <div className="attach-preview-doc">
                {p.slides.map((s) => (
                  <div key={s.no} className="attach-preview-slide">
                    <div className="attach-preview-slide-no">슬라이드 {s.no}</div>
                    {s.lines.length === 0 ? (
                      <p className="dim">(그림만 있는 슬라이드)</p>
                    ) : (
                      s.lines.map((l, i) => <p key={i}>{l}</p>)
                    )}
                  </div>
                ))}
              </div>
              <p className="attach-preview-note">
                글자만 뽑아 보여주는 미리보기입니다. 배치와 그림은 내려받아 확인하세요.
              </p>
            </>
          )}

          {p?.kind === 'none' && (
            <div className="attach-preview-none">
              <p>{p.reason}</p>
              <a className="btn btn-primary" href={attachmentDownloadUrl(attachmentId)}>
                <Icon name="download" size={14} /> 내려받기
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
