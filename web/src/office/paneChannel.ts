/**
 * 문항 상세의 근거자료 칸을 다른 창으로 떼어 볼 때 두 창이 주고받는 말 (BroadcastChannel)
 *
 * 듀얼 모니터에서 왼쪽 창은 문항 상세(문항 목록, 문항, 근거 카드), 오른쪽 창은 근거자료 뷰어만 보이게 한다.
 * - 오른쪽 창(/pane-window)은 같은 앱을 따로 띄운 창이다(로그인 쿠키를 함께 쓴다). 문서를 그리는 뷰어(DocPane)는 그 창
 *   안에서 돈다. 무엇을 보일지는 늘 문항 상세(왼쪽 창)가 정해 상태(state)로 보낸다.
 * - 오른쪽 창에서 생긴 일(근거를 이음, 배지에서 문항 열기, 자료 닫기, 창 닫힘)은 왼쪽 창에 알린다.
 * - 한 브라우저에 문항 상세 탭이 여럿이어도 섞이지 않게, 창을 연 탭의 표지(owner, 탭마다 sessionStorage)를 모든 말에 붙이고
 *   표지가 같은 말만 받는다. 왼쪽 창을 새로 고쳐도 같은 탭이면 표지가 같아 다시 이어진다.
 * - 탭 복제는 sessionStorage 를 복사하므로 두 탭의 표지가 같아진다. 그래서 문항 상세는 열릴 때 같은 표지를 쓰는 탭이 이미
 *   있는지 먼저 묻고(owner-probe), 있으면(owner-taken) 자기 표지를 새로 만든다.
 */
import type { FileKind } from '../api';

export const PANE_CHANNEL_NAME = 'cwb-evidence-pane';
export const PANE_WINDOW_PATH = '/pane-window';

/** 문항 상세(오른쪽 칸, 떼어 낸 창)의 연결 안내줄 끝 문구. 연결은 Esc 로 끝내지 않고 [자료 닫기]로 닫는다 */
export const PANE_MAP_HINT = '다른 자료를 고르려면 [자료 닫기]';

/** 떼어 낸 칸에 보일 것 (문항 상세의 칸 상태를 창 사이로 보낼 수 있게 옮긴 것) */
export type DetachedPane =
  | { kind: 'none' }
  | {
      kind: 'doc';
      mode: 'view' | 'map';
      versionId: number;
      documentId: number;
      docTitle: string;
      versionLabel: string | null;
      fileKind: FileKind | null;
      focusAnchorId: number | null;
      /** 본문 검색 결과로 연결을 시작했을 때 처음 펼칠 쪽과 검색어 */
      page?: number;
      query?: string;
    }
  | { kind: 'rich'; richDocId: number; title: string };

export interface PaneSnapshot {
  pane: DetachedPane;
  /** 뷰어를 다시 붙일 열쇠(문항 상세의 칸 열쇠와 같다): 바뀌면 뷰어를 새로 연다 */
  paneKey: string;
  /** 연결 모드에서 근거를 이을 문항 */
  mapTarget: { id: number; questionNo: string } | null;
  /** 근거 칩 순번 [anchorId, 근거 배열 인덱스]. 배지에 ①②③ 를 붙인다 */
  chipOrdinals: [number, number][];
  /** 왼쪽 창에서 보고 있는 문항 번호 (안내용) */
  questionNo: string | null;
}

export type PaneMessage =
  /** 왼쪽 → 오른쪽: 지금 보일 것 */
  | { type: 'state'; owner: string; snap: PaneSnapshot }
  /** 왼쪽 → 오른쪽: 떼어 낸 창이 열려 있으면 대답해 달라(왼쪽 창을 새로 열었을 때) */
  | { type: 'main-hello'; owner: string }
  /** 왼쪽 → 오른쪽: 합치기. 창을 닫아라 */
  | { type: 'dock'; owner: string }
  /** 오른쪽 → 왼쪽: 막 열렸다. 지금 상태를 보내 달라 */
  | { type: 'hello'; owner: string }
  /** 오른쪽 → 왼쪽: main-hello 에 대한 대답 */
  | { type: 'alive'; owner: string }
  /** 오른쪽 → 왼쪽: 근거를 잇거나 풀었다(근거 목록을 다시 받아라) */
  | { type: 'linked'; owner: string }
  /** 오른쪽 → 왼쪽: 배지 팝오버의 [열기] */
  | { type: 'open-question'; owner: string; questionId: number }
  /** 오른쪽 → 왼쪽: [자료 닫기](오른쪽 칸을 비운다) */
  | { type: 'close-pane'; owner: string }
  /** 오른쪽 → 왼쪽: 창이 닫힌다(합치기, 창 닫기 단추, 새로 고침) */
  | { type: 'closing'; owner: string }
  /** 왼쪽 → 왼쪽: 이 표지를 쓰는 문항 상세가 이미 있는가 (nonce 는 묻는 쪽 표시) */
  | { type: 'owner-probe'; owner: string; nonce: string }
  /** 왼쪽 → 왼쪽: 그 표지는 이미 이 탭이 쓴다. 물은 탭은 표지를 새로 만든다 */
  | { type: 'owner-taken'; owner: string; nonce: string };

const OWNER_KEY = 'cwb-pane-owner';
/** 문항 상세가 칸을 떼어 냈다는 표시 (그 탭의 sessionStorage) */
export const DETACHED_KEY = 'cwb-pane-detached';

/** 이 탭의 표지 (탭마다 하나, 새로 고쳐도 같다). 저장소를 쓸 수 없으면 고정값 */
export function paneOwnerId(): string {
  try {
    let v = sessionStorage.getItem(OWNER_KEY);
    if (!v) {
      v = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(OWNER_KEY, v);
    }
    return v;
  } catch {
    return 'default';
  }
}

/** 다른 탭과 표지가 겹쳤을 때(탭 복제) 이 탭의 표지를 새로 만든다 */
export function renewPaneOwnerId(): string {
  const v = Math.random().toString(36).slice(2, 10);
  try {
    sessionStorage.setItem(OWNER_KEY, v);
  } catch {
    // 저장하지 못해도 이 화면에서는 새 표지를 쓴다
  }
  return v;
}

export function paneChannelSupported(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

export function isPaneMessage(v: unknown): v is PaneMessage {
  if (!v || typeof v !== 'object') return false;
  const o = v as { type?: unknown; owner?: unknown };
  return typeof o.type === 'string' && typeof o.owner === 'string';
}
