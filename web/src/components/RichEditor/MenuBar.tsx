/**
 * 자유형식 문서 편집기 툴바 (설계서 §4 #8 — 제목·굵게·목록·표·이미지)
 * useEditorState 로 활성 상태를 구독해 버튼 하이라이트. 이미지는 상위에서 서버 업로드 후 URL 노드 삽입.
 * 표 삽입은 행·열·머리행을 지정하는 소형 팝오버(Enter=삽입, Esc=닫기, 바깥 클릭=닫기).
 */
import { useEditorState, type Editor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

const TABLE_ROWS_MAX = 30;
const TABLE_COLS_MAX = 10;

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

export interface MenuBarProps {
  editor: Editor;
  /** 파일 선택 시 서버 업로드 → 편집기에 URL 이미지 삽입 (상위 담당) */
  onInsertImageFile: (file: File) => void;
  disabled?: boolean;
}

export default function MenuBar({ editor, onInsertImageFile, disabled }: MenuBarProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [tablePop, setTablePop] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableCols, setTableCols] = useState(3);
  const [tableHeader, setTableHeader] = useState(true);
  const popWrapRef = useRef<HTMLDivElement | null>(null);

  // 팝오버 바깥 클릭 → 닫기 (열려 있을 때만 리스너 등록)
  useEffect(() => {
    if (!tablePop) return;
    const onDown = (e: MouseEvent) => {
      if (popWrapRef.current && !popWrapRef.current.contains(e.target as Node)) {
        setTablePop(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tablePop]);

  const insertTableNow = () => {
    const rows = clampInt(tableRows, 1, TABLE_ROWS_MAX, 3);
    const cols = clampInt(tableCols, 1, TABLE_COLS_MAX, 3);
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: tableHeader }).run();
    setTablePop(false);
  };

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      inTable: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const btn = (active: boolean) => 're-tb-btn' + (active ? ' is-active' : '');

  return (
    <div className="re-toolbar" role="toolbar" aria-label="서식 도구">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onInsertImageFile(f);
          e.target.value = ''; // 같은 파일 재선택 허용
        }}
      />

      <div className="re-tb-group">
        <button
          type="button"
          className={btn(state.h1)}
          disabled={disabled}
          title="제목 1"
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          H1
        </button>
        <button
          type="button"
          className={btn(state.h2)}
          disabled={disabled}
          title="제목 2"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </button>
        <button
          type="button"
          className={btn(state.h3)}
          disabled={disabled}
          title="제목 3"
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          H3
        </button>
      </div>

      <div className="re-tb-group">
        <button
          type="button"
          className={btn(state.bold)}
          disabled={disabled}
          title="굵게 (Ctrl+B)"
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <b>B</b>
        </button>
        <button
          type="button"
          className={btn(state.italic)}
          disabled={disabled}
          title="기울임 (Ctrl+I)"
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <i>I</i>
        </button>
        <button
          type="button"
          className={btn(state.strike)}
          disabled={disabled}
          title="취소선"
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <s>S</s>
        </button>
      </div>

      <div className="re-tb-group">
        <button
          type="button"
          className={btn(state.bullet)}
          disabled={disabled}
          title="불릿 목록"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          • 목록
        </button>
        <button
          type="button"
          className={btn(state.ordered)}
          disabled={disabled}
          title="번호 목록"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          1. 목록
        </button>
        <button
          type="button"
          className={btn(state.quote)}
          disabled={disabled}
          title="인용"
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          &ldquo; 인용
        </button>
      </div>

      <div className="re-tb-group">
        {!state.inTable ? (
          <div className="re-tb-popwrap" ref={popWrapRef}>
            <button
              type="button"
              className={'re-tb-btn' + (tablePop ? ' is-active' : '')}
              disabled={disabled}
              title="표 삽입 (행·열 지정)"
              onClick={() => setTablePop((v) => !v)}
            >
              표 삽입
            </button>
            {tablePop && (
              <form
                className="menu-table-pop"
                role="dialog"
                aria-label="표 삽입"
                onSubmit={(e) => {
                  e.preventDefault();
                  insertTableNow();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setTablePop(false);
                  }
                }}
              >
                <label className="menu-table-field">
                  행
                  <input
                    type="number"
                    min={1}
                    max={TABLE_ROWS_MAX}
                    value={Number.isFinite(tableRows) ? tableRows : ''}
                    autoFocus
                    onChange={(e) => setTableRows(e.target.valueAsNumber)}
                    aria-label="행 수"
                  />
                </label>
                <label className="menu-table-field">
                  열
                  <input
                    type="number"
                    min={1}
                    max={TABLE_COLS_MAX}
                    value={Number.isFinite(tableCols) ? tableCols : ''}
                    onChange={(e) => setTableCols(e.target.valueAsNumber)}
                    aria-label="열 수"
                  />
                </label>
                <label className="menu-table-field">
                  <input
                    type="checkbox"
                    checked={tableHeader}
                    onChange={(e) => setTableHeader(e.target.checked)}
                  />
                  머리행 포함
                </label>
                <div className="menu-table-actions">
                  <button type="submit" className="btn btn-primary btn-sm">
                    삽입
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setTablePop(false)}
                  >
                    취소
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <>
            <button
              type="button"
              className="re-tb-btn"
              disabled={disabled}
              title="아래 행 추가"
              onClick={() => editor.chain().focus().addRowAfter().run()}
            >
              행+
            </button>
            <button
              type="button"
              className="re-tb-btn"
              disabled={disabled}
              title="오른쪽 열 추가"
              onClick={() => editor.chain().focus().addColumnAfter().run()}
            >
              열+
            </button>
            <button
              type="button"
              className="re-tb-btn"
              disabled={disabled}
              title="표 삭제"
              onClick={() => editor.chain().focus().deleteTable().run()}
            >
              표 삭제
            </button>
          </>
        )}
        <button
          type="button"
          className="re-tb-btn"
          disabled={disabled}
          title="이미지 삽입 (붙여넣기·드롭도 가능)"
          onClick={() => fileRef.current?.click()}
        >
          이미지
        </button>
      </div>

      <div className="re-tb-group re-tb-right">
        <button
          type="button"
          className="re-tb-btn"
          disabled={disabled || !state.canUndo}
          title="되돌리기 (Ctrl+Z)"
          onClick={() => editor.chain().focus().undo().run()}
        >
          ↶
        </button>
        <button
          type="button"
          className="re-tb-btn"
          disabled={disabled || !state.canRedo}
          title="다시 실행 (Ctrl+Y)"
          onClick={() => editor.chain().focus().redo().run()}
        >
          ↷
        </button>
      </div>
    </div>
  );
}
