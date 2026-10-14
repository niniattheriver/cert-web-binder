/**
 * 문항 첨부·하이퍼링크 패널 (v1.5 Phase 2 — 설계서 §4 #4 보조 자료)
 * - 파일 첨부(inline은 pdf/png/jpg만)·링크(http/https) 목록.
 * - 데이터 로드/저장은 자체 수행(questionId 변경 시 재로드). 근거 카드의 [+ 파일 첨부]/[+ 링크 추가]
 *   버튼이 ref.openPicker()/openLinkForm()으로 각각 파일 선택·링크 입력을 연다.
 * - embedded: 근거 자료 카드 내부 표시용 — 자체 섹션·제목·하단 버튼 없이 목록·링크 폼만 렌더.
 * - 첨부한 파일은 근거자료 메뉴에도 올린다(문항의 연도, 파일 이름이 제목, 근거자료로 받는 형식만). 같은 이름, 같은 형식의
 *   근거자료가 이미 있으면 그 자료는 건드리지 않고 안내만 한다(다른 문항의 근거가 걸린 자료에 새 버전이 생기지 않게).
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
  attachmentDownloadUrl,
  createQuestionLink,
  deleteQuestionAttachment,
  deleteQuestionLink,
  fetchQuestionFiles,
  uploadQuestionAttachment,
  type QuestionFilesResponse,
} from '../api-phase2';
import { uploadDocAuto } from '../api';
import { DOC_UPLOAD_EXT_RE } from '../office/pageLabel';
import { errorMessage } from '../util';
import AttachmentPreview from './AttachmentPreview';
import Icon from './Icon';

interface PreviewTarget {
  id: number;
  origName: string;
}

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
  /** 첨부파일·링크 개수 통지 — 로드/추가/삭제 후 부모(근거 카드 빈 상태 문구 등)에 알림. questionId 는 그 개수가 속한 문항 */
  onCountsChange?: (files: number, links: number, questionId: number) => void;
  /** 첨부한 파일을 근거자료 메뉴에 올릴 때의 연도(문항의 연도). 없으면 서버 기본값(올해) */
  libraryYear?: number | null;
}

const AttachmentsPanel = forwardRef<AttachmentsPanelHandle, Props>(function AttachmentsPanel(
  { questionId, canEdit, embedded, onCountsChange, libraryYear },
  ref,
) {
  // 목록은 그 목록이 속한 문항 id 와 함께 둔다: 문항을 옮긴 직후 이전 문항의 응답이 도착해도 화면과 개수 통지가
  // 새 문항 것으로 섞이지 않게(화면은 지금 문항의 목록만 보고, 개수는 목록 주인 id 로 알린다)
  const [owned, setOwned] = useState<{ qid: number; data: QuestionFilesResponse } | null>(null);
  const data = owned != null && owned.qid === questionId ? owned.data : null;
  const [status, setStatus] = useState<string | null>(null);
  /** 진행 표시와 안내(회색 글자). 실패는 status(빨간 글자) */
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  /** 열려 있는 미리보기 창(첨부 클릭). null 이면 닫힘 */
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const linkUrlRef = useRef<HTMLInputElement | null>(null);
  // 문항 전환 후 도착한 응답이 다른 문항 목록에 붙는 오귀속 방지 — 요청 시점 id와 대조
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
    setOwned(null);
    setStatus(null);
    setNote(null);
    setBusy(false);
    setLinkOpen(false);
    setLinkUrl('');
    setLinkLabel('');
    fetchQuestionFiles(questionId)
      .then((r) => {
        if (alive) setOwned({ qid: questionId, data: r });
      })
      .catch((e) => {
        if (alive) setStatus(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [questionId]);

  // 개수 통지 — 목록은 로드·업로드·링크 추가·삭제 모두에서 갱신되므로 여기 한 곳이면 충분. 목록 주인 id 로 알린다
  useEffect(() => {
    if (owned) onCountsChange?.(owned.data.attachments.length, owned.data.links.length, owned.qid);
  }, [owned, onCountsChange]);

  const onFilePicked = useCallback(
    async (list: FileList | null) => {
      const files = Array.from(list ?? []);
      if (files.length === 0) return;
      const qid = questionId;
      setBusy(true);
      setStatus(null);
      // 여러 파일 순차 업로드 — 하나가 실패해도 나머지는 계속, 실패 목록만 알림.
      // 업로드 중 문항을 이동해도 배치는 원래 문항(qid)으로 끝까지 전송한다 —
      // qid 확인은 화면 표시(setStatus/setData) 오염 방지 용도일 뿐, 중단 사유가 아니다.
      // 첨부가 된 파일은 근거자료 메뉴에도 올린다(ifExists 'skip': 같은 이름, 같은 형식의 자료는 건드리지 않는다).
      const failed: string[] = [];
      const lib = { added: 0, already: 0, sameName: [] as string[], notAccepted: [] as string[], failed: [] as string[] };
      const progress = (i: number, name: string, what: string): void => {
        if (qidRef.current !== qid) return;
        setNote(files.length > 1 ? `${what}… (${i + 1}/${files.length}) '${name}'` : `'${name}' ${what}…`);
      };
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        progress(i, file.name, '업로드 중');
        try {
          const a = await uploadQuestionAttachment(qid, file);
          if (qidRef.current === qid) {
            setOwned((o) => (o && o.qid === qid ? { qid, data: { ...o.data, attachments: [...o.data.attachments, a] } } : o));
          }
        } catch (e) {
          failed.push(`${file.name}: ${errorMessage(e)}`);
          continue;
        }
        if (!DOC_UPLOAD_EXT_RE.test(file.name)) {
          lib.notAccepted.push(file.name);
          continue;
        }
        progress(i, file.name, '근거자료 메뉴에 올리는 중');
        try {
          const r = await uploadDocAuto(file, libraryYear ?? undefined, { ifExists: 'skip' });
          if (r.skipped === 'exists') lib.sameName.push(r.title);
          else if (r.duplicate) lib.already += 1;
          else lib.added += 1;
        } catch (e) {
          lib.failed.push(`${file.name}: ${errorMessage(e)}`);
        }
      }
      const quoted = (names: string[]): string => names.map((n) => `'${n}'`).join(', ');
      const errors: string[] = [];
      if (failed.length > 0) errors.push(`업로드 실패 ${failed.length}건: ${failed.join(', ')}`);
      if (lib.failed.length > 0) errors.push(`근거자료 메뉴에 올리지 못한 파일 ${lib.failed.length}건: ${lib.failed.join(', ')}`);
      const notes: string[] = [];
      if (lib.added > 0) {
        notes.push(`근거자료 메뉴${libraryYear != null ? `(${libraryYear}년)` : ''}에도 올렸습니다: ${lib.added}건.`);
      }
      if (lib.already > 0) notes.push(`근거자료 메뉴에 이미 있는 파일: ${lib.already}건.`);
      if (lib.sameName.length > 0) {
        notes.push(
          `같은 이름의 근거자료가 있어 근거자료 메뉴에는 올리지 않았습니다: ${quoted(lib.sameName)}. ` +
            '새 버전이면 근거자료 메뉴의 [새 버전 업로드]로 올리세요.',
        );
      }
      if (lib.notAccepted.length > 0) {
        notes.push(`근거자료로 받지 않는 형식이라 첨부로만 두었습니다: ${quoted(lib.notAccepted)}.`);
      }
      if (qidRef.current === qid) {
        setStatus(errors.length > 0 ? errors.join(' ') : null);
        setNote(notes.length > 0 ? notes.join(' ') : null);
        setBusy(false);
      } else if (errors.length > 0) {
        // 다른 문항으로 이동한 뒤라 상태줄이 안 보임 — 실패는 반드시 알린다
        const lines: string[] = [];
        if (failed.length > 0) lines.push(`파일 첨부 실패 ${failed.length}건`, ...failed);
        if (lib.failed.length > 0) lines.push(`근거자료 메뉴에 올리지 못한 파일 ${lib.failed.length}건`, ...lib.failed);
        window.alert(lines.join('\n'));
      }
      if (fileRef.current) fileRef.current.value = '';
    },
    [questionId, libraryYear],
  );

  const removeAttachment = useCallback((id: number, name: string) => {
    if (!window.confirm(`첨부 '${name}'을(를) 삭제할까요? (기록은 보존됩니다)`)) return;
    deleteQuestionAttachment(id)
      .then(() =>
        setOwned((o) =>
          o ? { ...o, data: { ...o.data, attachments: o.data.attachments.filter((a) => a.id !== id) } } : o,
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
        setOwned((o) => (o && o.qid === qid ? { qid, data: { ...o.data, links: [...o.data.links, l] } } : o));
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
      .then(() => setOwned((o) => (o ? { ...o, data: { ...o.data, links: o.data.links.filter((l) => l.id !== id) } } : o)))
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
                <button
                  type="button"
                  className="attach-name"
                  onClick={() => setPreview({ id: a.id, origName: a.origName })}
                  title="미리보기(내려받지 않고 창에서 봅니다)"
                >
                  <Icon name="file" size={14} /> {a.origName}
                </button>
                <a
                  className="btn btn-ghost btn-sm attach-dl"
                  href={attachmentDownloadUrl(a.id)}
                  title="내려받기"
                >
                  <Icon name="download" size={14} title="내려받기" />
                </a>
                <span className="dim attach-meta">
                  {fmtSize(a.size)}
                  {a.uploadedByName ? `, ${a.uploadedByName}` : ''}
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
                  <Icon name="link" size={14} /> {l.label || l.url}
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
        placeholder="표시명(선택)"
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

  const previewModal = preview && (
    <AttachmentPreview
      attachmentId={preview.id}
      origName={preview.origName}
      onClose={() => setPreview(null)}
    />
  );

  // 임베드 — 근거 자료 카드 내부: 목록·링크 폼·오류만. 내용이 없으면 숨은 파일 입력만 렌더
  if (embedded) {
    const showBody = (data != null && !empty) || linkOpen || status != null || note != null;
    return (
      <>
        {hiddenInput}
        {showBody && (
          <div className="attach-embed">
            {status && <span className="save-status is-error">{status}</span>}
            {note && <span className="save-status attach-note">{note}</span>}
            {lists}
            {canEdit && linkOpen && linkForm}
          </div>
        )}
        {previewModal}
      </>
    );
  }

  return (
    <section className="card qd3-card attach-panel">
      <div className="qd3-card-head">
        <h2 className="card-title">첨부와 링크</h2>
        {status && <span className="save-status is-error">{status}</span>}
        {note && <span className="save-status attach-note">{note}</span>}
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
      {previewModal}
    </section>
  );
});

export default AttachmentsPanel;
