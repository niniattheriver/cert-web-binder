/**
 * 근거 카드 목록 (설계서 §3.3 문항→지침서, §4 #4 — 임무 D 소유)
 * - 칩 ①②③(=숫자키 1–9) + 카드: 발췌 인용문 인라인 미리보기 + 출처행("제목 v라벨, p.N")
 *   + [상세보기](C 페인 교체 + 펄스) + 메모 인라인 편집 + 드래그 재정렬 + 연결 해제.
 * - 데이터 로드/저장(PATCH evidence·링크 해제)은 부모(QuestionDetail)가 담당 — 여기는 표시·상호작용만.
 * - richdoc 항목은 Day 3 — 자리만 표시.
 */
import { useEffect, useState } from 'react';
import type { EvidenceItem, EvidencePassageItem } from '../api';

export function isPassageItem(it: EvidenceItem): it is EvidencePassageItem {
  return it.type === 'passage';
}

/** 칩 번호 표기 — 1–9는 ①…⑨ (숫자키와 대응), 10+는 숫자 그대로 */
export function chipGlyph(index: number): string {
  return index < 9 ? String.fromCharCode(0x2460 + index) : String(index + 1);
}

function snip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function statusChip(status: string | null): { label: string; cls: string } | null {
  if (status == null) return { label: '앵커 없음', cls: 'badge-recheck' };
  if (status === 'needs_review') return { label: '확인 필요', cls: 'badge-recheck' };
  if (status === 'unresolved') return { label: '미해결', cls: 'badge-recheck' };
  if (status === 'resolved_fuzzy') return { label: '확인 필요', cls: 'badge-mod' };
  return null;
}

export interface EvidenceCardsProps {
  items: EvidenceItem[];
  activeIndex: number | null;
  canEdit: boolean;
  busy?: boolean;
  statusText?: string | null;
  onOpen: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onNoteSave: (index: number, note: string) => void;
  onUnlink: (index: number) => void;
  /** H — 문서 선택 후 매핑 모드 */
  onStartMapping?: () => void;
  /** 자유형식 근거 [열기] → 편집기로 이동 (Day 3) */
  onOpenRichDoc?: (richDocId: number) => void;
  /** [자유형식 추가] — 새 자유형식 문서 생성 후 편집기로 이동 (Day 3) */
  onAddRichDoc?: () => void;
  /** [파일 첨부] — 임의 형식 파일 다중 첨부 (업로드 연결은 Phase 2 안전장치와 함께) */
  onAddFile?: () => void;
  /** [링크 추가] — 첨부 패널의 링크 입력 폼을 연다 (⑥ 카드 통합) */
  onAddLink?: () => void;
  /** 첨부파일+링크 개수 — 본문 근거가 없어도 이 값이 있으면 빈 상태 문구를 다르게 표시 */
  auxCount?: number;
}

/** 항목 안정 키 — 부모(QuestionDetail)의 활성 칩 추적에도 사용 */
export function evidenceItemKey(it: EvidenceItem): string {
  return it.type === 'passage'
    ? `p${it.passageId}`
    : `r${String((it as { richDocId?: unknown }).richDocId ?? '?')}`;
}
const itemKey = evidenceItemKey;

/** 카드가 C 페인에서 열릴 수 있는가 — passage(앵커·판본 좌표 보유) 또는 richdoc(읽기전용 페인, Phase 2) */
function openable(it: EvidenceItem): boolean {
  if (it.type === 'richdoc') return (it as { richDocId?: unknown }).richDocId != null;
  return isPassageItem(it) && it.anchorId != null && it.versionId != null;
}

export default function EvidenceCards({
  items,
  activeIndex,
  canEdit,
  busy,
  statusText,
  onOpen,
  onReorder,
  onNoteSave,
  onUnlink,
  onStartMapping,
  onOpenRichDoc,
  onAddRichDoc,
  onAddFile,
  onAddLink,
  auxCount,
}: EvidenceCardsProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  /** 메모 편집 초안 — key: itemKey */
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  // 항목 목록이 갱신되면(서버 반영) 초안 중 저장된 것과 같아진 항목은 정리
  useEffect(() => {
    setNoteDrafts((prev) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const it of items) {
        const k = itemKey(it);
        const d = prev[k];
        if (d !== undefined && d !== (it.note ?? '')) {
          next[k] = d;
        } else if (d !== undefined) {
          changed = true;
        }
      }
      if (!changed && Object.keys(next).length === Object.keys(prev).length) return prev;
      return next;
    });
  }, [items]);

  const editable = canEdit;

  return (
    <div className="evd-root">
      <div className="evd-head-row">
        <h2 className="card-title">근거 자료 ({items.length})</h2>
        {statusText && <span className="save-status">{statusText}</span>}
        {editable && onStartMapping && (
          <button
            type="button"
            className="btn evd-map-btn"
            onClick={onStartMapping}
            title="지침서를 선택해 드래그로 문항에 연결합니다 (단축키 H)"
          >
            + 지침서 연결 (H)
          </button>
        )}
        {editable && onAddFile && (
          <button
            type="button"
            className="btn evd-file-btn"
            onClick={onAddFile}
            title="임의 형식 파일을 이 문항 근거로 첨부합니다 (다중 업로드·다운로드·삭제)"
          >
            + 파일 첨부
          </button>
        )}
        {editable && onAddLink && (
          <button
            type="button"
            className="btn evd-link-btn"
            onClick={onAddLink}
            title="웹 주소(URL)를 이 문항 근거로 연결합니다"
          >
            + 링크 추가
          </button>
        )}
        {editable && onAddRichDoc && (
          <button
            type="button"
            className="btn evd-rich-btn"
            onClick={onAddRichDoc}
            title="자유형식 근거문서를 새로 만들어 이 문항에 연결합니다"
          >
            + 자유형식
          </button>
        )}
      </div>

      {items.length > 0 && (
        <div className="evd-chips" role="tablist" aria-label="근거 칩">
          {items.map((it, i) => (
            <button
              key={itemKey(it)}
              type="button"
              role="tab"
              aria-selected={activeIndex === i}
              className={
                'evd-chip' +
                (activeIndex === i ? ' is-active' : '') +
                (openable(it) ? '' : ' is-dead')
              }
              disabled={!openable(it)}
              onClick={() => onOpen(i)}
              title={
                openable(it)
                  ? `근거 ${i + 1} 열기${i < 9 ? ` (숫자키 ${i + 1})` : ''}`
                  : '뷰어에서 열 수 없는 항목'
              }
            >
              {chipGlyph(i)}
            </button>
          ))}
        </div>
      )}

      {items.length === 0 &&
        ((auxCount ?? 0) > 0 ? (
          <p className="dim evd-empty">
            본문 근거(지침서 발췌·자유형식)는 없고 첨부파일·링크만 연결되어 있습니다.
          </p>
        ) : (
          <p className="dim evd-empty">
            아직 연결된 근거가 없습니다.
            {editable && ' H 를 눌러 문서를 선택하고 드래그로 연결하세요.'}
          </p>
        ))}

      <div className="evd-list">
        {items.map((it, i) => {
          const k = itemKey(it);
          const isActive = activeIndex === i;
          const canOpen = openable(it);
          const dragProps =
            editable && items.length > 1
              ? {
                  draggable: true,
                  onDragStart: (e: React.DragEvent) => {
                    setDragFrom(i);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(i));
                  },
                  onDragEnd: () => {
                    setDragFrom(null);
                    setDragOver(null);
                  },
                  onDragOver: (e: React.DragEvent) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOver !== i) setDragOver(i);
                  },
                  onDrop: (e: React.DragEvent) => {
                    e.preventDefault();
                    const from = dragFrom ?? Number(e.dataTransfer.getData('text/plain'));
                    setDragFrom(null);
                    setDragOver(null);
                    if (Number.isInteger(from) && from !== i) onReorder(from, i);
                  },
                }
              : {};

          if (!isPassageItem(it)) {
            const richDocId = Number((it as { richDocId?: unknown }).richDocId);
            const rTitle = String((it as { title?: unknown }).title ?? '자유형식');
            const rExcerptRaw = (it as { excerpt?: unknown }).excerpt;
            const rExcerpt = typeof rExcerptRaw === 'string' && rExcerptRaw !== '' ? rExcerptRaw : null;
            const rNoteDraft = noteDrafts[k];
            const rNoteValue = rNoteDraft !== undefined ? rNoteDraft : (it.note ?? '');
            return (
              <div
                key={k}
                className={
                  'evd-card evd-card-rich' +
                  (dragOver === i && dragFrom !== i ? ' is-dragover' : '')
                }
                {...dragProps}
              >
                <div className="evd-card-top">
                  <span className="evd-chip evd-chip-inline">{chipGlyph(i)}</span>
                  <span className="evd-source">
                    <span className="evd-rich-badge">자유형식</span> {rTitle}
                  </span>
                  {editable && items.length > 1 && (
                    <span className="evd-drag-handle" title="드래그로 순서 변경" aria-hidden="true">
                      ⋮⋮
                    </span>
                  )}
                </div>

                {rExcerpt && (
                  <div className="evd-rich-excerpt" title="문서 본문 앞부분입니다. [열기/편집]으로 전체를 봅니다.">
                    {rExcerpt}
                  </div>
                )}

                <div className="evd-card-actions">
                  <button
                    type="button"
                    className="btn evd-btn-sm"
                    disabled={!onOpenRichDoc || !Number.isInteger(richDocId)}
                    onClick={() => onOpenRichDoc?.(richDocId)}
                  >
                    {editable ? '열기/편집' : '열기'}
                  </button>
                  {editable && (
                    <button
                      type="button"
                      className="btn btn-ghost evd-btn-sm"
                      disabled={busy}
                      onClick={() => onUnlink(i)}
                    >
                      연결 해제…
                    </button>
                  )}
                </div>

                {(canEdit || rNoteValue) && (
                  <div className="evd-note-row">
                    {canEdit ? (
                      <input
                        className="evd-note-input"
                        type="text"
                        value={rNoteValue}
                        placeholder="메모 (이 문항 기준 참고사항)"
                        onChange={(e) =>
                          setNoteDrafts((prev) => ({ ...prev, [k]: e.target.value }))
                        }
                        onBlur={() => {
                          if (rNoteDraft !== undefined && rNoteDraft !== (it.note ?? '')) {
                            onNoteSave(i, rNoteDraft);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    ) : (
                      <span className="dim">메모: {rNoteValue}</span>
                    )}
                  </div>
                )}
              </div>
            );
          }

          const chip = statusChip(it.status);
          const noteDraft = noteDrafts[k];
          const noteValue = noteDraft !== undefined ? noteDraft : (it.note ?? '');

          return (
            <div
              key={k}
              className={
                'evd-card' +
                (isActive ? ' is-active' : '') +
                (dragOver === i && dragFrom !== i ? ' is-dragover' : '')
              }
              {...dragProps}
            >
              <div className="evd-card-top">
                <span className="evd-chip evd-chip-inline">{chipGlyph(i)}</span>
                <span className="evd-source">
                  {it.docTitle}
                  {it.versionLabel ? ` ${it.versionLabel}` : ''}
                  {it.pageStart != null ? `, p.${it.pageStart}` : ''}
                </span>
                {chip && <span className={`badge ${chip.cls}`}>{chip.label}</span>}
                {editable && items.length > 1 && (
                  <span className="evd-drag-handle" title="드래그로 순서 변경" aria-hidden="true">
                    ⋮⋮
                  </span>
                )}
              </div>

              {it.quote ? (
                <blockquote
                  className={'evd-quote' + (canOpen ? ' is-openable' : '')}
                  onClick={canOpen ? () => onOpen(i) : undefined}
                  title={canOpen ? '클릭: 뷰어에서 해당 위치 열기' : undefined}
                >
                  “{snip(it.quote, 200)}”
                </blockquote>
              ) : (
                <p className="dim">인용문 없음 (박스 앵커 또는 미해결)</p>
              )}

              <div className="evd-card-actions">
                <button
                  type="button"
                  className="btn evd-btn-sm"
                  disabled={!canOpen}
                  onClick={() => onOpen(i)}
                >
                  상세보기
                </button>
                {editable && (
                  <button
                    type="button"
                    className="btn btn-ghost evd-btn-sm"
                    disabled={busy}
                    onClick={() => onUnlink(i)}
                  >
                    연결 해제…
                  </button>
                )}
              </div>

              {(canEdit || noteValue) && (
                <div className="evd-note-row">
                  {canEdit ? (
                    <input
                      className="evd-note-input"
                      type="text"
                      value={noteValue}
                      placeholder="메모 (이 문항 기준 참고사항)"
                      onChange={(e) =>
                        setNoteDrafts((prev) => ({ ...prev, [k]: e.target.value }))
                      }
                      onBlur={() => {
                        if (noteDraft !== undefined && noteDraft !== (it.note ?? '')) {
                          onNoteSave(i, noteDraft);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                    />
                  ) : (
                    <span className="dim">메모: {noteValue}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
