/**
 * 자유양식 근거문서 편집기 (설계서 §2 rich_doc, §4 #8 — 임무 A 소유)
 * - Tiptap 3: StarterKit + Table(Kit) + Image + FileHandler(붙여넣기/드롭 → 서버 업로드 → URL 노드).
 * - content_json(ProseMirror) 저장 + content_plain(editor.getText()) 투영. 자동저장(디바운스 1.2s, 409 처리).
 * - 이미지는 내용주소 첨부(POST /api/attachments)로 업로드 — base64 금지.
 * - 연결된 문항 목록 표시. viewer 는 읽기 전용.
 * 경로: /rich/:id (편집), /rich/new?question=:qid (즉시 생성 후 리다이렉트).
 */
import { FileHandler } from '@tiptap/extension-file-handler';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ConflictError } from '../api';
import {
  createRichDoc,
  deleteRichDoc,
  fetchRichDoc,
  updateRichDoc,
  uploadAttachment,
  type RichDocFull,
} from '../api-rich';
import { useAuth } from '../auth';
import MenuBar from '../components/RichEditor/MenuBar';
import { errorMessage } from '../util';

const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
const AUTOSAVE_MS = 1200;

function nowHM(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseContent(json: string): JSONContent {
  try {
    const parsed = JSON.parse(json) as JSONContent;
    if (parsed && typeof parsed === 'object' && parsed.type) return parsed;
  } catch {
    /* 손상 → 빈 문서 */
  }
  return EMPTY_DOC;
}

/** 서버 업로드 후 편집기에 URL 이미지 노드 삽입 (pos 지정 시 그 위치, 아니면 현재 선택) */
async function insertUploadedImage(
  editor: Editor,
  file: File,
  pos: number | null,
  onError: (m: string) => void,
): Promise<void> {
  if (!ALLOWED_IMAGE_MIME.includes(file.type)) {
    onError('PNG·JPEG·GIF·WebP 이미지만 첨부할 수 있습니다.');
    return;
  }
  try {
    const info = await uploadAttachment(file);
    if (pos != null) {
      editor.chain().insertContentAt(pos, { type: 'image', attrs: { src: info.url } }).focus().run();
    } else {
      editor.chain().focus().setImage({ src: info.url }).run();
    }
  } catch (e) {
    onError(errorMessage(e));
  }
}

export default function RichEditor() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user != null && user.role !== 'viewer';
  const isNew = id === 'new' || id == null;

  const [doc, setDoc] = useState<RichDocFull | null>(null);
  const [title, setTitle] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RichDocFull | null>(null);
  const [deleting, setDeleting] = useState(false);

  const rowVersionRef = useRef<number>(1);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appliedIdRef = useRef<number | null>(null); // 편집기에 내용 주입 완료한 doc id
  const creatingRef = useRef(false); // /rich/new 중복 생성 방지(StrictMode)
  const imgErrRef = useRef<(m: string) => void>(() => {});
  const titleRef = useRef('');
  const conflictRef = useRef(false);
  imgErrRef.current = setImgError;
  titleRef.current = title;

  // ── Tiptap 편집기 (1회 생성) ──────────────────────────────────────────────
  const editor = useEditor({
    editable: false, // 로드 후 canEdit 로 갱신
    extensions: [
      StarterKit,
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({ inline: false, allowBase64: false }),
      FileHandler.configure({
        allowedMimeTypes: ALLOWED_IMAGE_MIME,
        onDrop: (currentEditor, files, pos) => {
          for (const f of files) void insertUploadedImage(currentEditor as Editor, f, pos, imgErrRef.current);
        },
        onPaste: (currentEditor, files) => {
          for (const f of files) void insertUploadedImage(currentEditor as Editor, f, null, imgErrRef.current);
        },
      }),
    ],
    onUpdate: () => scheduleSave(),
  });

  // ── 자동저장 스케줄/실행 ───────────────────────────────────────────────────
  const saveNow = useCallback(async () => {
    if (!editor || !canEdit || appliedIdRef.current == null || conflictRef.current) return;
    const docId = appliedIdRef.current;
    dirtyRef.current = false;
    setSaveStatus('저장 중…');
    setSaveError(null);
    try {
      const res = await updateRichDoc(docId, {
        rowVersion: rowVersionRef.current,
        title: titleRef.current.trim() === '' ? '제목없음' : titleRef.current,
        contentJson: editor.getJSON(),
        contentPlain: editor.getText(),
      });
      rowVersionRef.current = res.rowVersion;
      setDoc(res);
      setSaveStatus(`저장됨 ${nowHM()}`);
    } catch (e) {
      if (e instanceof ConflictError) {
        conflictRef.current = true;
        setConflict(e.server as RichDocFull);
        setSaveStatus('충돌 — 확인이 필요합니다');
      } else {
        dirtyRef.current = true;
        setSaveError(errorMessage(e));
        setSaveStatus(null);
      }
    }
  }, [editor, canEdit]);

  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  const scheduleSave = useCallback(() => {
    if (!canEdit || appliedIdRef.current == null || conflictRef.current) return;
    dirtyRef.current = true;
    setSaveStatus('편집 중…');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void saveNowRef.current(), AUTOSAVE_MS);
  }, [canEdit]);

  // ── /rich/new — 즉시 생성 후 리다이렉트 ────────────────────────────────────
  useEffect(() => {
    if (!isNew) return;
    if (!canEdit) {
      setLoadError('자유형식 문서를 만들 권한이 없습니다.');
      return;
    }
    if (creatingRef.current) return;
    creatingRef.current = true;
    const qid = Number(search.get('question'));
    createRichDoc({
      title: '제목없음',
      contentJson: EMPTY_DOC,
      contentPlain: '',
      ...(Number.isInteger(qid) && qid > 0 ? { questionId: qid } : {}),
    })
      .then((res) => navigate(`/rich/${res.id}`, { replace: true }))
      .catch((e) => setLoadError(errorMessage(e)));
  }, [isNew, canEdit, search, navigate]);

  // ── 편집 문서 로드 ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (isNew) return;
    const docId = Number(id);
    if (!Number.isInteger(docId)) {
      setLoadError('문서 주소가 올바르지 않습니다.');
      return;
    }
    let alive = true;
    setLoadError(null);
    setDoc(null);
    appliedIdRef.current = null;
    conflictRef.current = false;
    setConflict(null);
    fetchRichDoc(docId)
      .then((d) => {
        if (!alive) return;
        setDoc(d);
        setTitle(d.title);
        titleRef.current = d.title;
        rowVersionRef.current = d.rowVersion;
      })
      .catch((e) => {
        if (alive) setLoadError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [id, isNew]);

  // ── 편집기에 내용 주입 (doc + editor 준비 시 1회) ───────────────────────────
  useEffect(() => {
    if (!editor || !doc) return;
    if (appliedIdRef.current === doc.id) return;
    editor.commands.setContent(parseContent(doc.contentJson), { emitUpdate: false });
    editor.setEditable(canEdit);
    appliedIdRef.current = doc.id;
    dirtyRef.current = false;
  }, [editor, doc, canEdit]);

  // 권한 변경 시 편집 가능 상태 동기화
  useEffect(() => {
    if (editor) editor.setEditable(canEdit);
  }, [editor, canEdit]);

  // 언마운트 시 미저장분 최종 저장(베스트 에포트) + 타이머 정리
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (dirtyRef.current && !conflictRef.current) void saveNowRef.current();
    };
  }, []);

  // ── 충돌 처리 ───────────────────────────────────────────────────────────────
  const conflictLoadServer = useCallback(() => {
    if (!editor || !conflict) return;
    editor.commands.setContent(parseContent(conflict.contentJson), { emitUpdate: false });
    setTitle(conflict.title);
    titleRef.current = conflict.title;
    rowVersionRef.current = conflict.rowVersion;
    setDoc(conflict);
    conflictRef.current = false;
    dirtyRef.current = false;
    setConflict(null);
    setSaveStatus('서버 최신본을 불러왔습니다');
  }, [editor, conflict]);

  const conflictOverwrite = useCallback(() => {
    if (!conflict) return;
    rowVersionRef.current = conflict.rowVersion;
    conflictRef.current = false;
    setConflict(null);
    void saveNowRef.current();
  }, [conflict]);

  // ── 제목 변경 ───────────────────────────────────────────────────────────────
  const onTitleChange = (v: string) => {
    setTitle(v);
    titleRef.current = v;
    scheduleSave();
  };

  // ── 삭제 ────────────────────────────────────────────────────────────────────
  const onDelete = useCallback(async () => {
    if (!doc) return;
    if (!window.confirm(`자유형식 문서 「${doc.title}」을(를) 삭제할까요?\n연결된 문항의 근거에서 제거됩니다.`))
      return;
    setDeleting(true);
    try {
      if (timerRef.current) clearTimeout(timerRef.current);
      dirtyRef.current = false;
      await deleteRichDoc(doc.id);
      const firstQ = doc.questions[0];
      navigate(firstQ ? `/q/${firstQ.questionId}` : '/', { replace: true });
    } catch (e) {
      setSaveError(errorMessage(e));
      setDeleting(false);
    }
  }, [doc, navigate]);

  const onManualSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void saveNowRef.current();
  }, []);

  // ── 렌더 ────────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="re-page">
        <p className="page-status is-error">{loadError}</p>
        <button type="button" className="btn" onClick={() => navigate(-1)}>
          ← 돌아가기
        </button>
      </div>
    );
  }
  if (isNew) {
    return <div className="re-page"><p className="page-status">새 자유형식 문서 만드는 중…</p></div>;
  }

  return (
    <div className="re-page">
      <div className="re-head">
        <button type="button" className="btn btn-ghost re-back" onClick={() => navigate(-1)}>
          ← 돌아가기
        </button>
        <input
          className="re-title-input"
          type="text"
          value={title}
          placeholder="문서 제목"
          disabled={!canEdit}
          onChange={(e) => onTitleChange(e.target.value)}
          aria-label="문서 제목"
        />
        <span className={'save-status' + (saveError ? ' is-error' : '')}>
          {saveError ?? saveStatus ?? (canEdit ? '자동 저장' : '읽기 전용')}
        </span>
        {canEdit && (
          <>
            <button type="button" className="btn re-save-btn" onClick={onManualSave} disabled={!!conflict}>
              저장
            </button>
            <button
              type="button"
              className="btn btn-ghost re-del-btn"
              onClick={() => void onDelete()}
              disabled={deleting || doc == null}
            >
              삭제…
            </button>
          </>
        )}
      </div>

      {imgError && (
        <div className="re-banner is-error" role="alert">
          이미지 삽입 실패: {imgError}
          <button type="button" className="btn btn-ghost re-banner-x" onClick={() => setImgError(null)}>
            닫기
          </button>
        </div>
      )}

      {conflict && (
        <div className="re-banner is-warn" role="alert">
          <span>
            다른 사용자가 먼저 저장했습니다
            {conflict.updatedByName ? ` (${conflict.updatedByName})` : ''}. 어떻게 할까요?
          </span>
          <button type="button" className="btn re-banner-btn" onClick={conflictLoadServer}>
            서버본 불러오기
          </button>
          <button type="button" className="btn re-banner-btn" onClick={conflictOverwrite}>
            내 내용으로 덮어쓰기
          </button>
        </div>
      )}

      {canEdit && editor && (
        <MenuBar
          editor={editor}
          disabled={!!conflict}
          onInsertImageFile={(f) => void insertUploadedImage(editor, f, null, setImgError)}
        />
      )}

      <div className={'re-editor-wrap' + (canEdit ? '' : ' is-readonly')}>
        <EditorContent editor={editor} className="re-editor" />
      </div>

      {doc && (
        <div className="re-linked">
          <h2 className="card-title">연결된 문항 ({doc.questions.length})</h2>
          {doc.questions.length === 0 ? (
            <p className="dim">
              아직 연결된 문항이 없습니다. 문항 상세의 근거 영역에서 이 문서를 연결할 수 있습니다.
            </p>
          ) : (
            <ul className="re-linked-list">
              {doc.questions.map((q) => (
                <li key={q.questionId}>
                  <Link to={`/q/${q.questionId}`} className="re-linked-item">
                    <span className="re-linked-no">{q.questionNo}</span>
                    <span className="dim">{q.categoryCode}</span>
                    {q.note ? <span className="re-linked-note">— {q.note}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
