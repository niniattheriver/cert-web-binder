/**
 * 텍스트 문서(txt, md) 보기: 서버가 만든 PlainModel 을 그린다
 *
 * - 쪽 하나 = 종이 한 장(<section class="opv-page" data-page>) 안의 <pre> 하나.
 * - PlainPage.t 는 그 쪽 page_text 전체(o = 0)라서 글자 조각은 쪽마다 하나다. 그 글자를
 *   <span data-o="0"> 의 유일한 자식 글자 노드에 담으므로, 화면에서 고른 위치(노드 안 위치)가 그대로
 *   정본 오프셋이고 정본 범위도 그대로 화면 범위가 된다.
 * - 빈 쪽(t === '')의 <span data-o="0"> 에는 자식 노드가 없다(React 는 빈 글자 노드를 만들지 않는다).
 *   렌더러 불변식의 "글자 노드 하나"는 빈 조각이면 "자식 없음"으로 읽는다. domOffsets 는 길이 0 조각을
 *   조각으로 세지 않으므로 선택과 하이라이트에 영향이 없다.
 * - 바꾸어 보이는 글자는 사설영역(PUA) 글머리 기호뿐이다: text-utils mapPuaText 를 글꼴 없이 불러
 *   흐름, 슬라이드 보기와 같은 글자로 보이고, 텍스트 파일에 흔한 U+F02D 대시 글머리만 여기서 더 바꾼다
 *   (plainDisplayText, 한 글자를 한 글자로, 길이 그대로). 워드 문서에서 옮겨 온 txt, md 에는 Wingdings
 *   글머리(U+F06C 등)가 U+F0B7 보다 흔하다(실물 집계).
 * - md 도 꾸미지 않고 원문 그대로 보인다. 꾸미면 화면 글자와 정본 글자가 1:1 로 맞지 않는다.
 * - 쪽 표시('구간 N'), 빈 쪽 안내, 잘림 안내는 표시 전용이라 data-o 가 없고 선택, 복사에서 빠진다.
 * - 화면 읽기 프로그램에는 쪽마다 '구간 N' 이름의 묶음(role="group", 랜드마크가 아니라 쪽이 많아도 랜드마크
 *   목록을 채우지 않는다)으로 알리고, 눈으로 보는 쪽 표시는 숨긴다(aria-hidden). 숨기지 않으면 쪽 표시가 다음
 *   쪽 글자와 한 덩어리로 읽힌다.
 * - 잘림 안내는 첫 쪽 위와 마지막 쪽 아래에 둔다: 긴 문서에서 끝까지 내려가지 않아도 잘린 것을 알고, 글이
 *   끊긴 자리에서도 다시 본다.
 * - translate="no": 브라우저 자동 번역이 글자 노드를 갈아 끼우면 오프셋 대응이 깨지므로 막는다.
 */
import { useInsertionEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { PlainModel } from './model';
import { pageRefLabel } from './pageLabel';
import { mapPuaText } from './text-utils';
import './plainview.css';

type PageElementCallback = (pageNo: number, el: HTMLElement | null) => void;
type PageRefCallback = (el: HTMLElement | null) => void;

const SYMBOL_DASH_RE = //g;

/**
 * 화면 글자: mapPuaText(글꼴 없음) 다음에 U+F02D 를 U+2212(빼기 기호, text-utils SYMBOL_PUA 와 같은 값)로
 * 바꾼다. U+F02D 는 Symbol 글꼴 0x2D 이고, 글꼴 정보가 없는 텍스트 파일에서는 줄머리 대시 글머리로 쓰인다
 * (실물 집계: 15개 파일 417자, 그중 204자가 줄머리, 숫자 사이 0자). 글꼴 모름 표(BULLET_PUA)에
 * 없어서 텍스트 보기에서만 더한다. 한 단위를 한 단위로 바꾸므로 길이는 그대로다.
 */
function plainDisplayText(t: string): string {
  const s = mapPuaText(t);
  return s.includes('') ? s.replace(SYMBOL_DASH_RE, '−') : s;
}

export default function PlainView(props: {
  model: PlainModel;
  /**
   * 쪽 요소가 붙으면 (pageNo, 요소), 떨어지면 (pageNo, null). 쪽 이동과 현재 쪽 판정용.
   * - 처음에 없던 함수를 나중에 넘기면 이미 붙어 있는 쪽마다 (pageNo, 요소)를 한 번 보낸다.
   * - 넘기던 함수를 거두면 그 함수에 알린 쪽마다 (pageNo, null)을 보낸다.
   * - 함수를 다른 함수로 바꾸면 다시 알리지 않는다. 렌더마다 새로 만든 함수를 넘겨도 쪽마다 (null, 요소)
   *   호출이 되풀이되지 않게 하려는 것이다(부모가 그 콜백에서 상태를 바꾸면 무한 렌더가 된다). 바꾼 뒤의 알림은
   *   새 함수로 가지만, 바꾸는 바로 그 커밋에서 떨어지는 쪽은 앞 함수로 간다. 그래서 바꿔 넘기는 함수들은 같은
   *   저장소를 고쳐야 한다(useCallback 으로 고정한 함수 하나를 권한다).
   */
  onPageElement?: PageElementCallback;
}): JSX.Element {
  const { model, onPageElement } = props;

  // 쪽마다 ref 콜백을 하나로 고정하고, 그 안에서 부모의 최신 콜백을 부른다(부모가 렌더마다 새 함수를 넘겨도
  // ref 가 다시 붙지 않는다). useInsertionEffect 는 ref 가 붙기 전에 돌므로 새로 붙는 쪽도 최신 콜백을 받는다.
  const latest = useRef(onPageElement);
  useInsertionEffect(() => {
    latest.current = onPageElement;
  });
  /** 붙어 있는 쪽 요소 */
  const mounted = useRef(new Map<number, HTMLElement>());
  /** 그중 콜백에 (pageNo, 요소)를 알린 쪽: 나중에 넘긴 함수에 같은 쪽을 두 번 알리지 않는다 */
  const told = useRef(new Set<number>());
  const refFns = useRef(new Map<number, PageRefCallback>());

  // 콜백이 생기거나 없어질 때만 지금 붙어 있는 쪽을 알리거나 거둔다. 자식 ref 가 다 붙은 뒤에 돌므로 이번
  // 커밋에 붙은 쪽까지 본다. 함수에서 함수로 바뀔 때는 아무것도 하지 않는다(위 prop 설명).
  const effective = useRef(onPageElement);
  useLayoutEffect(() => {
    const prev = effective.current;
    effective.current = onPageElement;
    if (!prev && onPageElement) {
      for (const [pageNo, el] of mounted.current) {
        if (told.current.has(pageNo)) continue;
        told.current.add(pageNo);
        onPageElement(pageNo, el);
      }
    } else if (prev && !onPageElement) {
      const pageNos = [...told.current];
      told.current.clear();
      for (const pageNo of pageNos) prev(pageNo, null);
    }
  }, [onPageElement]);

  // 모델이 같으면 쪽 요소를 다시 만들지 않는다(긴 문서에서 부모가 다시 그려도 쪽은 그대로).
  const pages = useMemo(() => {
    const refFor = (pageNo: number): PageRefCallback => {
      let fn = refFns.current.get(pageNo);
      if (!fn) {
        fn = (el) => {
          const cb = latest.current;
          if (el) {
            mounted.current.set(pageNo, el);
            if (cb) {
              told.current.add(pageNo);
              cb(pageNo, el);
            } else {
              told.current.delete(pageNo);
            }
          } else {
            mounted.current.delete(pageNo);
            if (told.current.delete(pageNo)) cb?.(pageNo, null);
          }
        };
        refFns.current.set(pageNo, fn);
      }
      return fn;
    };
    return model.pages.map((page) => {
      const label = pageRefLabel('text', page.pageNo, null);
      return (
        <section
          key={page.pageNo}
          className="opv-page"
          data-page={page.pageNo}
          role="group"
          aria-label={label}
          ref={refFor(page.pageNo)}
        >
          <pre className="opv-text" translate="no">
            <span data-o="0">{plainDisplayText(page.t)}</span>
          </pre>
          {page.t === '' ? <p className="opv-empty">내용 없음</p> : null}
          <div className="opv-cap" aria-hidden="true">
            {label}
          </div>
        </section>
      );
    });
  }, [model.pages]);

  return (
    <div className="opv-plain">
      {model.truncated ? (
        <p className="opv-trunc opv-trunc-top" role="note">
          {model.truncated}
        </p>
      ) : null}
      {pages}
      {model.truncated ? (
        <p className="opv-trunc opv-trunc-end" role="note">
          {model.truncated}
        </p>
      ) : null}
    </div>
  );
}
