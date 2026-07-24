/**
 * 자유형식 문서 읽기전용 페인 (v1.5 Phase 2 — 설계서 §4 #4 우측 뷰어의 richdoc 모드)
 * - 문항 상세 C 페인에서 richdoc 근거를 대형 표시. 편집은 /rich/:id 편집기에서.
 * - Tiptap editable=false 인스턴스(StarterKit+Table+Image — 편집기와 동일 스키마·스타일).
 *   이미지는 내용주소 URL(/api/attachments/…) — same-origin 세션 쿠키로 로드됨.
 */
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useState } from 'react';
import { fetchRichDoc } from '../api-rich';
import { errorMessage } from '../util';

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

function parseContent(json: string): JSONContent {
  try {
    const parsed = JSON.parse(json) as JSONContent;
    if (parsed && typeof parsed === 'object' && parsed.type) return parsed;
  } catch {
    /* 손상 → 빈 문서 */
  }
  return EMPTY_DOC;
}

export default function RichDocPane({ richDocId }: { richDocId: number }) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit,
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ inline: false, allowBase64: false }),
    ],
  });

  useEffect(() => {
    if (!editor) return;
    let alive = true;
    setLoaded(false);
    setError(null);
    fetchRichDoc(richDocId)
      .then((doc) => {
        if (!alive) return;
        editor.commands.setContent(parseContent(doc.contentJson), { emitUpdate: false });
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [editor, richDocId]);

  if (error) return <div className="page-status">{error}</div>;

  return (
    <div className="richpane-scroll">
      {!loaded && <div className="page-status">자유형식 문서 불러오는 중…</div>}
      <div
        className="re-editor-wrap is-readonly richpane-body"
        style={loaded ? undefined : { display: 'none' }}
      >
        <div className="re-editor">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
