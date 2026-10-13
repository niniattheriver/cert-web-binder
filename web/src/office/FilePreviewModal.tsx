/**
 * 지침서 빠른 보기 창 (메일 첨부 미리보기 방식)
 *
 * 지침서 라이브러리 카드의 [미리보기]로 연다. 첨부 미리보기(AttachmentPreview)와 같은 창 틀을 쓰되 본문을
 * 거의 전체 화면으로 키우고, 판본 형식에 맞는 뷰어(DocPane)를 보기 모드로 띄운다: PDF 는 pdf.js,
 * Word, Excel, PowerPoint, 한글, 텍스트는 서버가 만든 렌더 모델을 그리는 렌더러다. 새 근거 연결(매핑)은
 * [뷰어에서 열기]로 넘어가 문서 뷰어에서 한다. 보기 모드에서도 편집 권한이 있으면 하이라이트 팝오버로 기존
 * 발췌의 연결을 더하거나 풀 수 있으므로, 그때는 onLinked 로 부모(카드 목록)에 알린다.
 *
 * 키보드와 포커스는 document 의 버블 단계에서 받는다.
 * - 뷰어 안쪽 처리가 먼저 돈다. 팝오버 닫기, 선택 취소는 window 캡처 단계에서, 문항 퀵피커 입력칸의 Esc 는
 *   React onKeyDown 에서 처리하고 전파를 멈춘다. 그러면 Esc 가 여기까지 오지 않아 창은 그대로 남는다.
 * - 앱 전역 단축키('/', Ctrl+K)는 AppShell 이 window 버블 단계에서 받으므로 여기서 막는다. 막지 않으면
 *   옴니박스가 창 뒤(z-index 아래)에 열리고 입력이 그리로 간다.
 * - 창이 열린 동안 창 바깥(조상들의 형제)을 inert 로 둔다. Tab 은 브라우저 순서 그대로 창 안(문서 스크롤 영역
 *   포함)과 브라우저 주소창 사이만 돌고, 창 뒤의 링크, 단추는 포커스도 클릭도 받지 않는다. 처음과 끝을 직접 잇지
 *   않는 까닭: 브라우저가 Tab 대상으로 삼는 스크롤 영역(tabindex 없음)을 셀 방법이 없어, 직접 이으면 키보드로
 *   문서 스크롤 영역에 들어갈 수 없게 된다. 창 안에 열린 대화상자(문항 퀵피커)가 포커스를 가지면 그 안에서
 *   돌게 하고, 그래도 창 밖으로 나간 포커스는 창으로 되돌린다.
 * - 배경을 눌러 닫는 것은 누름과 뗌이 모두 배경에서 일어났을 때만이다. 문서 글자를 끌어 선택하다 배경에서
 *   놓아도 창이 닫히지 않는다.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchVersionMeta, versionDownloadUrl, type FileKind, type VersionMeta } from '../api';
import Icon from '../components/Icon';
import { errorMessage } from '../util';
import DocPane from './DocPane';
import { FILE_KIND_LABEL } from './pageLabel';
import './library.css';

export interface FilePreviewModalProps {
  versionId: number;
  /** 판본 원본 형식. 모르면 창이 판본 정보(meta)를 먼저 받아 정한다 */
  fileKind?: FileKind;
  /** 제목줄에 보일 지침서 제목 */
  title: string;
  /** 원본 파일 이름, 크기(바이트). 없으면 판본 정보에서 채운다 */
  fileName?: string;
  fileSize?: number;
  documentId: number;
  /** 창 안(하이라이트 팝오버)에서 발췌 연결을 더하거나 푼 뒤 호출한다. 부모 목록 갱신용 */
  onLinked?: () => void;
  onClose(): void;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** 글자를 입력하는 칸인가 (AppShell 의 '/' 단축키와 같은 판정) */
function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

/** Tab 으로 갈 수 있는 요소 후보. 실제로 갈 수 있는지는 isTabbable 로 다시 거른다 */
const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0 || el.matches(':disabled')) return false;
  if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
  if (el.closest('[inert]')) return false;
  // 화면에 그려지지 않는 것(display: none, 접힌 details 안, visibility: hidden)은 건너뛴다
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/** scope 안 Tab 순서의 처음과 끝. 양수 tabindex 는 쓰지 않으므로 문서 순서로 센다 */
function tabEdges(scope: HTMLElement): { first: HTMLElement | null; last: HTMLElement | null } {
  const all = scope.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR);
  let first: HTMLElement | null = null;
  let last: HTMLElement | null = null;
  for (const el of all) {
    if (isTabbable(el)) {
      first = el;
      break;
    }
  }
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i];
    if (el && isTabbable(el)) {
      last = el;
      break;
    }
  }
  return { first, last };
}

/**
 * 창 안에 열린 대화상자(문항 퀵피커 등)가 포커스를 가지면 Tab, Shift+Tab 이 그 대화상자의 처음과 끝에서
 * 돌게 한다. 창 자체는 바깥을 inert 로 막으므로 여기서 다루지 않는다
 */
function keepTabInNestedDialog(e: KeyboardEvent, dialog: HTMLElement): void {
  const active = document.activeElement;
  const inner = active instanceof HTMLElement ? active.closest<HTMLElement>('[role="dialog"]') : null;
  if (!inner || inner === dialog || !dialog.contains(inner)) return;
  const { first, last } = tabEdges(inner);
  if (!first || !last) return;
  if (e.shiftKey ? active === first : active === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

/**
 * keep 의 바깥(keep 에서 body 까지 각 조상의 형제)을 모두 inert 로 만든다. 이미 inert 인 요소는 건드리지 않고,
 * 되돌리는 함수를 돌려준다. 창(keep 안)은 그대로 쓸 수 있다
 */
function makeOutsideInert(keep: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  let node: HTMLElement = keep;
  while (node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sib of parent.children) {
      if (sib !== node && sib instanceof HTMLElement && !sib.inert) {
        sib.inert = true;
        changed.push(sib);
      }
    }
    node = parent;
  }
  return () => {
    for (const el of changed) el.inert = false;
  };
}

export default function FilePreviewModal({
  versionId,
  fileKind,
  title,
  fileName,
  fileSize,
  documentId,
  onLinked,
  onClose,
}: FilePreviewModalProps) {
  const [meta, setMeta] = useState<VersionMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  // 배경 클릭 판정: 누름과 뗌이 모두 배경 자체에서 일어났는지
  const pressOnBackdropRef = useRef(false);
  const releaseOnBackdropRef = useRef(false);

  // 형식을 모르면 판본 정보부터 받는다. 형식을 알아도 이름, 크기가 없으면 함께 받아 제목줄만 채운다
  // (이 경우 실패해도 본문은 그대로 보인다)
  const needMeta = fileKind == null || fileName == null || fileSize == null;
  useEffect(() => {
    if (!needMeta) return;
    let alive = true;
    setMeta(null);
    setMetaError(null);
    fetchVersionMeta(versionId)
      .then((m) => {
        if (alive) setMeta(m);
      })
      .catch((e: unknown) => {
        if (alive) setMetaError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [versionId, needMeta]);

  // 키보드와 포커스 (머리말 주석 참고). 열릴 때 창으로 포커스를 옮기고, 닫히면 연 단추로 돌려준다
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = backdropRef.current;
    const restoreOutside = backdrop ? makeOutsideInert(backdrop) : () => {};
    dialogRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (e.key === 'Escape') {
        // 안쪽에서 이미 쓴 Esc(기본 동작만 막은 경우 포함)와 한글 조합 중의 Esc 는 창을 닫지 않는다
        if (e.defaultPrevented || e.isComposing) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        if (!e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey) keepTabInNestedDialog(e, dialog);
        return;
      }
      const omniboxKey =
        ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') ||
        (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextEntry(e.target));
      if (omniboxKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !dialog.isConnected) return;
      if (e.target instanceof Node && dialog.contains(e.target)) return;
      dialog.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      // inert 를 먼저 풀어야 연 단추가 포커스를 받는다
      restoreOutside();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const kind: FileKind | null = fileKind ?? meta?.fileKind ?? null;
  const name = fileName ?? meta?.fileName ?? null;
  const size = fileSize ?? meta?.fileSize ?? null;
  const versionLabel = meta?.versionLabel ?? null;
  const kindLabel = kind ? FILE_KIND_LABEL[kind] : null;

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        pressOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        releaseOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const onBackdrop =
          e.target === e.currentTarget && pressOnBackdropRef.current && releaseOnBackdropRef.current;
        pressOnBackdropRef.current = false;
        releaseOnBackdropRef.current = false;
        if (onBackdrop) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal-card attach-preview filepv"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`근거자료 미리보기: ${title}`}
        tabIndex={-1}
      >
        <div className="attach-preview-head">
          <Icon name="file" size={16} />
          <span className="attach-preview-name filepv-title" title={name ?? title}>
            {title}
          </span>
          {kindLabel && <span className="kind-chip">{kindLabel}</span>}
          {versionLabel && <span className="attach-preview-meta">{versionLabel}</span>}
          {size != null && <span className="attach-preview-meta">{fmtSize(size)}</span>}
          <div className="filepv-actions">
            <Link
              className="btn btn-sm"
              to={`/docs/${documentId}?v=${versionId}`}
              onClick={onClose}
              title="문서 뷰어로 갑니다. 근거 연결은 뷰어에서 합니다."
            >
              뷰어에서 열기
            </Link>
            <a
              className="btn btn-sm"
              href={versionDownloadUrl(versionId)}
              title={name ? `원본 파일 내려받기: ${name}` : '원본 파일을 내 PC로 내려받습니다'}
            >
              <Icon name="download" size={14} /> 내려받기
            </a>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onClose}
              title="닫기(Esc)"
              aria-label="닫기"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        <div className="attach-preview-body filepv-body">
          {kind ? (
            <div className="filepv-pane">
              <DocPane
                key={versionId}
                versionId={versionId}
                fileKind={kind}
                mode="view"
                onLinked={onLinked}
              />
            </div>
          ) : metaError ? (
            <div className="filepv-msg">
              <div className="alert-card alert-danger" role="alert">
                미리보기를 열 수 없습니다: {metaError}
              </div>
            </div>
          ) : (
            <div className="filepv-msg dim">미리보기를 준비하는 중…</div>
          )}
        </div>
      </div>
    </div>
  );
}
