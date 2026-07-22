/**
 * 문항 첨부·하이퍼링크 패널 (v1.5 Phase 2 — 설계서 §4 #4 보조 자료)
 * - 파일 첨부(inline은 pdf/png/jpg만)·링크(http/https) 목록.
 * - 데이터 로드/저장은 자체 수행(questionId 변경 시 재로드). 근거 카드의 [+ 파일 첨부]/[+ 링크 추가]
 *   버튼이 ref.openPicker()/openLinkForm()으로 각각 파일 선택·링크 입력을 연다.
 * - embedded: 근거 자료 카드 내부 표시용 — 자체 섹션·제목·하단 버튼 없이 목록·링크 폼만 렌더.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  attachmentFileUrl,
  createQuestionLink,
  deleteQuestionAttachment,
  deleteQuestionLink,
  fetchQuestionFiles,
  uploadQuestionAttachment,
  type QuestionFilesResponse,
} from '../api-phase2';
import { errorMessage } from '../util';

export interface AttachmentsPanelHandle {
  openPicker: () => void;
  openLinkForm: () => void;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

interface Props {
  questionId: number;
  canEdit: boolean;
  /** 근거 자료 카드 내부 임베드 — 섹션·제목·하단 버튼 없이 목록만 */
  embedded?: boolean;
  /** 첨부파일·링크 개수 통지 — 로드/추가/삭제 후 부모(근거 카드 빈 상태 문구 등)에 알림 */
  onCountsChange?: (files: number, links: number) => void;
}

const AttachmentsPanel = forwardRef<AttachmentsPanelHandle, Props>(function AttachmentsPanel(
  { questionId, canEdit, embedded, onCountsChange },
  ref,
) {
  const [data, setData] = useState<QuestionFilesResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const linkUrlRef = useRef<HTMLInputElement | null>(null);
  // 문항 전환 후 도착한 응답이 다른 문항 목록에 붙는 오귀속 방지 — 요청 시점 id와 대조 (검토 반영)
  const qidRef = useRef(questionId);

  useImperativeHandle(
    ref,
    () => ({
      openPicker: () => fileRef.current?.click(),
      openLinkForm: () => {
        setLinkOpen(true);
        // 폼이 렌더된 다음 프레임에 주소 입력칸 포커스
        window.requestAnimationFrame(() => linkUrlRef.current?.focus());
      },
    }),
    [],
  );

  useEffect(() => {
    qidRef.current = questionId;
    let alive = true;
    setData(null);
    setStatus(null);
    setBusy(false);
    setLinkOpen(false);
    setLinkUrl('');
    setLinkLabel('');
    fetchQuestionFiles(questionId)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch((e) => {
        if (alive) setStatus(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [questionId]);

  // 개수 통지 — data 는 로드·업로드·링크 추가·삭제 모두에서 갱신되므로 여기 한 곳이면 충분
  useEffect(() => {
    if (data) onCountsChange?.(data.attachments.length, data.links.length);
  }, [data, onCountsChange]);

  const onFilePicked = useCallback(
    async (list: FileList | null) => {
      const files = Array.from(list ?? []);
      if (files.length === 0) return;
      const qid = questionId;
      setBusy(true);
      // 여러 파일 순차 업로드 — 하나가 실패해도 나머지는 계속, 실패 목록만 알림.
      // 업로드 중 문항을 이동해도 배치는 원래 문항(qid)으로 끝까지 전송한다 —
      // qid 확인은 화면 표시(setStatus/setData) 오염 방지 용도일 뿐, 중단 사유가 아니다.
      const failed: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        if (qidRef.current === qid) {
          setStatus(
            files.length > 1
              ? `업로드 중… (${i + 1}/${files.length}) '${file.name}'`
              : `'${file.name}' 업로드 중…`,
          );
        }
        try {
          const a = await uploadQuestionAttachment(qid, file);
          if (qidRef.current === qid) {
            setData((d) => (d ? { ...d, attachments: [...d.attachments, a] } : d));
          }
        } catch (e) {
          failed.push(`${file.name}: ${errorMessage(e)}`);
        }
      }
      if (qidRef.current === qid) {
        setStatus(failed.length > 0 ? `업로드 실패 ${failed.length}건 — ${failed.join(' · ')}` : null);
        setBusy(false);
      } else if (failed.length > 0) {
        // 다른 문항으로 이동한 뒤라 상태줄이 안 보임 — 실패는 반드시 알린다
        window.alert(`파일 첨부 실패 ${failed.length}건\n${failed.join('\n')}`);
      }
      if (fileRef.current) fileRef.current.value = '';
    },
    [questionId],
  );

  const removeAttachment = useCallback((id: number, name: string) => {
    if (!window.confirm(`첨부 '${name}'을(를) 삭제할까요? (기록은 보존됩니다)`)) return;
    deleteQuestionAttachment(id)
      .then(() =>
        setData((d) =>
          d ? { ...d, attachments: d.attachments.filter((a) => a.id !== id) } : d,
        ),
      )
      .catch((e) => setStatus(errorMessage(e)));
  }, []);

  const addLink = useCallback(() => {
    const url = linkUrl.trim();
    if (url === '') return;
    const qid = questionId;
    setBusy(true);
    createQuestionLink(qid, {
      url,
      label: linkLabel.trim() === '' ? null : linkLabel.trim(),
    })
      .then((l) => {
        if (qidRef.current !== qid) return; // 생성 중 문항 이동 — 표시 오염 방지
        setData((d) => (d ? { ...d, links: [...d.links, l] } : d));
        setLinkOpen(false);
        setLinkUrl('');
        setLinkLabel('');
        setStatus(null);
      })
      .catch((e) => {
        if (qidRef.current === qid) setStatus(errorMessage(e));
      })
      .finally(() => {
        if (qidRef.current === qid) setBusy(false);
      });
  }, [questionId, linkUrl, linkLabel]);

  const removeLink = useCallback((id: number) => {
    deleteQuestionLink(id)
      .then(() => setData((d) => (d ? { ...d, links: d.links.filter((l) => l.id !== id) } : d)))
      .catch((e) => setStatus(errorMessage(e)));
  }, []);

  const empty = data != null && data.attachments.length === 0 && data.links.length === 0;

  const hiddenInput = (
    <input
      ref={fileRef}
      type="file"
      multiple
      style={{ display: 'none' }}
      onChange={(e) => void onFilePicked(e.target.files)}
    />
  );

  const lists =
    data == null ? null : (
      <>
        {data.attachments.length > 0 && (
          <ul className="attach-list">
            {data.attachments.map((a) => (
              <li key={`a${a.id}`} className="attach-row">
                <a
                  className="attach-name"
                  href={attachmentFileUrl(a.id)}
                  target={a.inlinePreview ? '_blank' : undefined}
                  rel="noreferrer"
                  title={a.inlinePreview ? '새 탭에서 열기' : '내려받기'}
                >
                  📄 {a.origName}
                </a>
                <span className="dim attach-meta">
                  {fmtSize(a.size)}
                  {a.uploadedByName ? ` · ${a.uploadedByName}` : ''}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeAttachment(a.id, a.origName)}
                  >
                    삭제
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {data.links.length > 0 && (
          <ul className="attach-list">
            {data.links.map((l) => (
              <li key={`l${l.id}`} className="attach-row">
                <a className="attach-name" href={l.url} target="_blank" rel="noreferrer">
                  🔗 {l.label || l.url}
                </a>
                {l.label && (
                  <span className="dim attach-meta cell-ellipsis" title={l.url}>
                    {l.url}
                  </span>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeLink(l.id)}
                  >
                    삭제
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </>
    );

  const linkForm = (
    <div className="attach-link-form">
      <input
        ref={linkUrlRef}
        className="attach-input"
        value={linkUrl}
        onChange={(e) => setLinkUrl(e.target.value)}
        placeholder="http://…"
        aria-label="링크 주소"
      />
      <input
        className="attach-input"
        value={linkLabel}
        onChange={(e) => setLinkLabel(e.target.value)}
        placeholder="표시명 (선택)"
        aria-label="링크 표시명"
      />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={addLink}
        disabled={busy || linkUrl.trim() === ''}
      >
        추가
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLinkOpen(false)}>
        취소
      </button>
    </div>
  );

  // 임베드 — 근거 자료 카드 내부: 목록·링크 폼·오류만. 내용이 없으면 숨은 파일 입력만 렌더
  if (embedded) {
    const showBody = (data != null && !empty) || linkOpen || status != null;
    return (
      <>
        {hiddenInput}
        {showBody && (
          <div className="attach-embed">
            {status && <span className="save-status is-error">{status}</span>}
            {lists}
            {canEdit && linkOpen && linkForm}
          </div>
        )}
      </>
    );
  }

  return (
    <section className="card qd3-card attach-panel">
      <div className="qd3-card-head">
        <h2 className="card-title">첨부·링크</h2>
        {status && <span className="save-status is-error">{status}</span>}
      </div>
      {hiddenInput}
      {data == null ? (
        <p className="dim">불러오는 중…</p>
      ) : (
        <>
          {empty && <p className="dim">첨부된 파일이나 링크가 없습니다.</p>}
          {lists}
          {canEdit && (
            <div className="attach-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              >
                + 파일 첨부
              </button>
              {!linkOpen ? (
                <button type="button" className="btn btn-sm" onClick={() => setLinkOpen(true)}>
                  + 링크 추가
                </button>
              ) : (
                linkForm
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
});

export default AttachmentsPanel;
