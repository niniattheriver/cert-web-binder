/**
 * 떼어 낸 근거자료 창 /pane-window?owner=… (듀얼 모니터용, office/paneChannel.ts)
 *
 * 문항 상세의 오른쪽 근거자료 칸을 이 창에 그대로 띄운다. 무엇을 보일지는 문항 상세 창이 정해 보내고(state), 이 창은 그 상태로
 * 뷰어(DocPane, 자유형식은 RichDocPane)를 그린다. 근거를 잇거나 풀면, 배지에서 문항을 열면, [자료 닫기]를 누르면 문항 상세 창에 알린다.
 * 연결 중의 Esc 는 뷰어가 고른 부분만 지우고 연결은 끝내지 않는다(문항 상세와 같다).
 * 창을 닫거나 [문항 창으로 합치기]를 누르면 문항 상세가 오른쪽 칸을 다시 보인다.
 * 로그인은 같은 쿠키를 쓰므로 따로 하지 않는다(App.tsx 에서 상단 메뉴 없이 단독으로 그린다).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { versionDownloadUrl, versionFileUrl } from '../api';
import Icon from '../components/Icon';
import RichDocPane from '../components/RichDocPane';
import DocPane from '../office/DocPane';
import { FILE_KIND_LABEL } from '../office/pageLabel';
import {
  isPaneMessage,
  PANE_CHANNEL_NAME,
  PANE_MAP_HINT,
  paneChannelSupported,
  type PaneMessage,
  type PaneSnapshot,
} from '../office/paneChannel';
import './panewindow.css';

export default function PaneWindow() {
  const [params] = useSearchParams();
  const owner = params.get('owner') ?? '';
  const [snap, setSnap] = useState<PaneSnapshot | null>(null);
  /** 문항 상세 창이 닫혔다 */
  const [mainGone, setMainGone] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const supported = paneChannelSupported() && owner !== '';

  const post = useCallback((m: PaneMessage) => channelRef.current?.postMessage(m), []);

  useEffect(() => {
    if (!supported) return;
    const ch = new BroadcastChannel(PANE_CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (ev: MessageEvent<unknown>) => {
      const m = ev.data;
      if (!isPaneMessage(m) || m.owner !== owner) return;
      if (m.type === 'state') {
        setSnap(m.snap);
        setMainGone(false);
      } else if (m.type === 'main-hello') {
        ch.postMessage({ type: 'alive', owner } satisfies PaneMessage);
      } else if (m.type === 'dock') {
        window.close();
      }
    };
    ch.postMessage({ type: 'hello', owner } satisfies PaneMessage);
    // 창이 닫히거나 새로 고쳐지면 문항 상세가 칸을 되찾는다(새로 고친 창은 다시 hello 를 보낸다)
    const onHide = () => ch.postMessage({ type: 'closing', owner } satisfies PaneMessage);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      ch.close();
      channelRef.current = null;
    };
  }, [supported, owner]);

  // 문항 상세 창이 닫히면 안내만 남긴다 (다시 열면 그 창이 main-hello 로 다시 찾는다)
  useEffect(() => {
    const t = window.setInterval(() => {
      const op = window.opener as Window | null;
      if (!op || op.closed) setMainGone(true);
    }, 2000);
    return () => window.clearInterval(t);
  }, []);

  const pane = snap?.pane ?? { kind: 'none' as const };
  const isMap = pane.kind === 'doc' && pane.mode === 'map';

  const title = pane.kind === 'doc' ? pane.docTitle : pane.kind === 'rich' ? pane.title : null;
  useEffect(() => {
    document.title = title ? `근거자료: ${title}` : '근거자료 창';
  }, [title]);

  const chipOrdinals = useMemo(() => new Map(snap?.chipOrdinals ?? []), [snap?.chipOrdinals]);
  const dock = useCallback(() => {
    post({ type: 'closing', owner });
    window.close();
  }, [post, owner]);
  /** [자료 닫기]: 문항 상세가 오른쪽 칸을 비우고 이 창에 빈 안내를 보낸다(창은 그대로 둔다) */
  const closeButton = (
    <button
      type="button"
      className="btn qd3-btn-sm qd3-close-btn"
      onClick={() => post({ type: 'close-pane', owner })}
      title="이 근거자료를 닫습니다. 다른 자료를 연결하려면 닫은 뒤 문항 화면에서 [+ 근거자료 연결]을 누르세요."
    >
      자료 닫기
    </button>
  );

  if (!supported) {
    return (
      <div className="pw-page">
        <div className="pw-msg">
          이 브라우저에서는 근거자료 창을 따로 띄울 수 없습니다. 문항 화면에서 오른쪽 칸으로 보세요.
        </div>
      </div>
    );
  }

  return (
    <div className="pw-page">
      <header className={'pw-head' + (isMap ? ' is-map' : '')}>
        {pane.kind === 'doc' ? (
          isMap ? (
            <>
              <span className="pw-title">
                연결 중: {pane.docTitle} → 「{snap?.mapTarget?.questionNo ?? ''}」
              </span>
              {closeButton}
            </>
          ) : (
            <>
              <span className="pw-title">
                {pane.docTitle}
                {pane.versionLabel && <span className="qd3-pane-ver">{pane.versionLabel}</span>}
              </span>
              {pane.fileKind == null || pane.fileKind === 'pdf' ? (
                <a
                  className="qd3-pane-link"
                  href={versionFileUrl(pane.versionId)}
                  target="_blank"
                  rel="noreferrer"
                  title="근거자료 원본 PDF를 새 탭에서 엽니다(인쇄, 저장 가능)"
                >
                  원본 보기 ↗
                </a>
              ) : (
                <a
                  className="qd3-pane-link"
                  href={versionDownloadUrl(pane.versionId)}
                  title={`원본 ${FILE_KIND_LABEL[pane.fileKind]} 파일을 내려받습니다.`}
                >
                  원본 내려받기
                </a>
              )}
              {closeButton}
            </>
          )
        ) : pane.kind === 'rich' ? (
          <>
            <span className="pw-title">
              <Icon name="note" size={14} /> {pane.title}
            </span>
            {closeButton}
          </>
        ) : (
          <span className="pw-title dim">근거자료 창</span>
        )}
        <span className="pw-spacer" />
        {snap?.questionNo && <span className="pw-q dim">문항 {snap.questionNo}</span>}
        <button
          type="button"
          className="btn qd3-btn-sm"
          onClick={dock}
          title="이 창을 닫고 문항 화면 오른쪽 칸에 다시 붙입니다"
        >
          문항 창으로 합치기
        </button>
      </header>
      <main className="pw-body">
        {mainGone ? (
          <div className="pw-msg">문항 화면 창이 닫혔습니다. 이 창을 닫고 문항 화면에서 다시 떼어 내세요.</div>
        ) : !snap ? (
          <div className="pw-msg">문항 화면과 연결하는 중…</div>
        ) : pane.kind === 'none' ? (
          <div className="pw-msg">문항 화면에서 근거를 고르거나 [+ 근거자료 연결]을 누르면 여기에 열립니다.</div>
        ) : pane.kind === 'rich' ? (
          <div className="pw-pane">
            <RichDocPane key={snap.paneKey} richDocId={pane.richDocId} />
          </div>
        ) : (
          <div className="pw-pane">
            <DocPane
              key={snap.paneKey}
              versionId={pane.versionId}
              fileKind={pane.fileKind}
              mode={pane.mode}
              mapTargetQuestion={pane.mode === 'map' ? (snap.mapTarget ?? undefined) : undefined}
              focusAnchorId={pane.focusAnchorId}
              onLinked={() => post({ type: 'linked', owner })}
              onBadgeOpenQuestion={(questionId) => post({ type: 'open-question', owner, questionId })}
              chipOrdinals={chipOrdinals}
              initialPage={pane.mode === 'map' ? pane.page : undefined}
              initialQuery={pane.mode === 'map' ? pane.query : undefined}
              mapHint={PANE_MAP_HINT}
            />
          </div>
        )}
      </main>
    </div>
  );
}
