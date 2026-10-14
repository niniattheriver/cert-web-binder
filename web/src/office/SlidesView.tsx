/**
 * PowerPoint(pptx) 보기: 서버가 만든 SlidesModel 을 그린다
 *
 * 브라우저는 원본 바이트를 해석하지 않고 이 JSON 만 그린다(model.ts 머리말).
 *
 * 정합 규칙 (화면 선택 ↔ 정본 오프셋)
 * - 정본 글자 조각(run)마다 data-o={o} 를 단 <span> 을 하나 만들고, 그 자식은 글자 노드 하나다
 *   (길이 = t.length). 바꾸어 보이는 글자는 기호 글꼴의 사설영역(PUA) 글리프뿐이다(text-utils
 *   mapPuaText: 한 글자를 한 글자로, 길이 그대로). 줄바꿈 조각('\n')도 같은 <span> 안의 글자 노드이고,
 *   문단이 white-space: pre-wrap 이라 그 자리에서 줄이 바뀐다. 문단 끝의 줄바꿈 뒤 빈 줄은 CSS 가
 *   높이를 주지 않으므로(PowerPoint 는 한 줄을 더 둔다) 그 문단에 osl-p-trail 을 달아 ::after 의 폭 없는
 *   생성 글자로 줄을 세운다(DOM 글자가 아니라 선택, 오프셋과 무관하다).
 * - 글머리 기호, 슬라이드 캡션, 숨김과 '슬라이드 밖 글자' 표시, 개체 자리 이름, 잘림 안내는 표시
 *   전용이라 data-o 가 없고 선택되지 않는다(user-select: none).
 * - 한 슬라이드 안에서 DOM 순서는 오프셋 오름차순이다. 모델의 도형 순서(겹침 순서)가 오프셋 순서와
 *   다르면 DOM 은 오프셋 순으로 놓고, 겹침은 원래 순서대로 z-index 로 지킨다.
 * - 글자가 빈 조각은 그리지 않는다(글자 노드가 없고, 같은 o 가 두 요소에 붙지 않게). 추출기가 빈 문단에
 *   남기는 빈 조각(t '')은 정본 글자가 아니고 줄 높이(sz)만 알린다: 그 sz 로 빈 줄 높이를 정한다.
 * - translate="no": 브라우저 자동 번역이 글자 노드를 갈아 끼우면 오프셋 대응이 깨지므로 막는다.
 *
 * 크기
 * - 슬라이드 상자(.osl-canvas)가 CSS 크기 컨테이너(container-type: inline-size)다. EMU 길이 L 은
 *   L / slideW × 100cqw 로 바꾼다. 1pt = 12700 EMU 이므로 글자 N pt 는
 *   N × 12700 / slideW × 100cqw = N × (상자 너비 px / 슬라이드 너비 pt) px 이다. 상자 너비가 바뀌면
 *   글자도 슬라이드와 같은 비율로 따라간다(ResizeObserver 없이, 다시 그리지 않고, 인쇄에서도).
 * - 도형 위치와 크기는 슬라이드 크기에 대한 백분율이다. cqw 는 상자 안쪽 요소에만 쓴다(상자 자신에서는
 *   cqw 가 바깥 기준이 된다).
 * - 모델에 없는 값은 PowerPoint 기본값으로 그린다: 글자 18pt, 글상자 여백 0.1in/0.05in, 단계마다
 *   0.5in 들여쓰기, 글머리 자리 0.25in, 탭 1in, 윤곽선 0.75pt.
 *
 * 슬라이드 밖으로 나간 정본 글자 (넘침)
 * - 슬라이드 상자는 슬라이드 밖을 잘라 그린다(PowerPoint 슬라이드 쇼와 같다). 상자의
 *   content-visibility: auto 가 화면 밖 슬라이드의 배치를 건너뛰게 해 큰 덱에서도 빠르다(348장 덱 실측:
 *   폭을 바꿀 때 한 번에 30~60ms, 없으면 750~900ms). 이 속성은 상자 밖 그리기를 늘 자른다.
 * - 그런데 글자는 정본(page_text)에 있으니 검색, 앵커가 그 자리를 가리킬 수 있다. 그래서 슬라이드가 배치될
 *   때(contentvisibilityautostatechange, 폭 변화, 글꼴 로드) 정본 글자가 상자 밖으로 나갔는지 재고, 나갔으면
 *   그 슬라이드만 osl-slide-spill 로 바꾼다: 상자가 자르지 않고, 위아래로 나간 만큼 자리(osl-room)를 비워
 *   이웃 슬라이드와 캡션에 겹치지 않으며, 캡션에 '슬라이드 밖 글자'를 표시한다. 그림과 개체 자리는 각자
 *   슬라이드 크기의 자르개(osl-clip) 안에 있어 이때도 슬라이드 밖으로 번지지 않는다.
 */
import {
  memo,
  useEffect,
  useId,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type {
  SlidePage,
  SlidePara,
  SlidePicShape,
  SlideRun,
  SlideShape,
  SlideTableCell,
  SlideTableShape,
  SlideTextShape,
  SlidesModel,
} from './model';
import { pageRefLabel } from './pageLabel';
import {
  cropOf,
  cropPlacement,
  cssColor,
  cssFontStack,
  isSymbolFont,
  mapPuaText,
  num,
  sanitizeFont,
} from './text-utils';
import './slidesview.css';

type PageRefCallback = (el: HTMLElement | null) => void;
/** 인라인 style 에 CSS 사용자 속성(--이름)도 싣는다 */
type StyleWithVars = CSSProperties & { [name: `--${string}`]: string };

/** 1pt = 12700 EMU */
const EMU_PER_PT = 12700;
/** 글자 크기를 모를 때 (PowerPoint 기본값) */
const DEFAULT_PT = 18;
/** 글상자 안쪽 여백 기본값 [l, t, r, b] EMU */
const DEFAULT_INSET: readonly [number, number, number, number] = [91440, 45720, 91440, 45720];
/** 표 칸 안쪽 여백 [l, t, r, b] EMU */
const CELL_INSET: readonly [number, number, number, number] = [91440, 45720, 91440, 45720];
/** 목록 단계마다 들여쓰기, 글머리 자리 (Office 기본 테마 값) */
const LEVEL_INDENT_EMU = 457200;
const BULLET_HANG_EMU = 228600;
const MAX_LEVEL = 8;
const TAB_EMU = 914400;
const LINE_EMU = 9525;
/** 슬라이드 크기를 모를 때: 16:9 (13.333in × 7.5in) */
const FALLBACK_W = 12192000;
const FALLBACK_H = 6858000;
/** 넘침 판정 허용 오차 px (반올림, 줄 상자의 반 행간) */
const SPILL_TOLERANCE_PX = 1;

/**
 * 이 브라우저가 슬라이드의 배치 시점을 알려 주는가(content-visibility: auto 와 그 상태 변화 이벤트).
 * 아니면 모든 슬라이드가 늘 배치되어 있다고 보고 붙을 때 한 번 잰다.
 */
const CV_EVENTS = typeof window !== 'undefined' && 'ContentVisibilityAutoStateChangeEvent' in window;

const ALIGN: Readonly<Record<NonNullable<SlidePara['align']>, CSSProperties['textAlign']>> = {
  l: 'left',
  ctr: 'center',
  r: 'right',
  just: 'justify',
};

const ANCHOR: Readonly<Record<NonNullable<SlideTextShape['anchor']>, CSSProperties['justifyContent']>> = {
  t: 'flex-start',
  ctr: 'center',
  b: 'flex-end',
};

/** 슬라이드 좌표계 (EMU) */
interface Geo {
  w: number;
  h: number;
}

function finite(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 소수 넷째 자리까지, 뒤 0 없이 */
function fmt(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

/** EMU 길이 → 슬라이드 너비 기준 cqw (슬라이드 상자 안쪽 요소에서만 쓴다) */
function len(geo: Geo, emu: number): string {
  return `${fmt((emu / geo.w) * 100)}cqw`;
}

/** pt → cqw */
function ptLen(geo: Geo, pt: number): string {
  return len(geo, pt * EMU_PER_PT);
}

// 모델 배열 읽기: 서버가 만든 JSON 이지만 한 곳이 어긋나도 보기 전체가 죽지 않게 빈 배열로 읽는다
function runsOf(p: SlidePara): readonly SlideRun[] {
  return Array.isArray(p.runs) ? p.runs : [];
}
function parasOf(x: { paras?: SlidePara[] }): readonly SlidePara[] {
  return Array.isArray(x.paras) ? x.paras : [];
}
function cellsOf(row: { cells?: SlideTableCell[] }): readonly SlideTableCell[] {
  return Array.isArray(row.cells) ? row.cells : [];
}

function hasText(r: SlideRun): boolean {
  return typeof r.t === 'string' && r.t.length > 0;
}

/** 조각의 글자 크기 pt (모르면 fallbackPt) */
function runPt(r: SlideRun, fallbackPt: number): number {
  return num(r.sz, 0.5, 4000) ?? fallbackPt;
}

/** 문단 목록에서 글자 크기가 적힌 첫 조각의 크기 */
function firstSizedPt(paras: readonly SlidePara[]): number | null {
  for (const p of paras) {
    for (const r of runsOf(p)) {
      const sz = hasText(r) ? num(r.sz, 0.5, 4000) : undefined;
      if (sz !== undefined) return sz;
    }
  }
  return null;
}

/** 글자 조각 하나: <span data-o> 의 유일한 자식이 글자 노드 하나 */
function RunSpan(props: { run: SlideRun; geo: Geo; fallbackPt: number }): JSX.Element {
  const { run, geo, fallbackPt } = props;
  const font = sanitizeFont(run.font);
  const text = mapPuaText(run.t, font);
  const s: CSSProperties = { fontSize: ptLen(geo, runPt(run, fallbackPt)) };
  if (run.b) s.fontWeight = 700;
  if (run.i) s.fontStyle = 'italic';
  const deco = `${run.u ? 'underline ' : ''}${run.strike ? 'line-through' : ''}`.trim();
  if (deco) s.textDecorationLine = deco;
  const color = cssColor(run.color);
  if (color) s.color = color;
  // 기호 글꼴 글자를 표준 글자로 바꿨다면 그 글꼴은 빼고 공통 스택으로 그린다(FlowView 와 같다)
  if (font) s.fontFamily = cssFontStack(text !== run.t && isSymbolFont(font) ? null : font);
  return (
    <span data-o={run.o} style={s}>
      {text}
    </span>
  );
}

/**
 * 문단 하나. 빈 문단은 emptyPt 높이의 한 줄이다(CSS :empty::before 의 폭 없는 글자가 줄을 세운다.
 * 생성 내용이라 DOM 글자가 아니다). 빈 문단에는 글머리 기호도 그리지 않는다(PowerPoint 와 같다).
 * 마지막 정본 조각이 줄바꿈으로 끝나면 그 뒤 빈 줄을 같은 방식(::after)으로 세운다. 높이는 그 조각의 크기.
 */
function Paragraph(props: { para: SlidePara; geo: Geo; fallbackPt: number; emptyPt: number }): JSX.Element {
  const { para, geo, fallbackPt, emptyPt } = props;
  const runs = runsOf(para).filter(hasText);
  const first = runs[0];
  const last = runs[runs.length - 1];
  const style: StyleWithVars = {};
  const align = ALIGN[para.align ?? 'l'];
  if (align && align !== 'left') style.textAlign = align;

  if (!first || !last) {
    style.fontSize = ptLen(geo, emptyPt);
    return <p className="osl-p" style={style} />;
  }

  const sizes = runs.map((r) => runPt(r, fallbackPt));
  // 문단 자체 크기(줄 받침)는 가장 작은 조각 크기: 줄 높이는 그 줄의 가장 큰 조각이 정한다
  style.fontSize = ptLen(geo, sizes.reduce((a, b) => Math.min(a, b)));
  const lvl = Math.max(0, Math.min(MAX_LEVEL, Math.floor(finite(para.lvl, 0))));
  const bullet = typeof para.bullet === 'string' && para.bullet !== '' ? mapPuaText(para.bullet, null) : null;
  const leftEmu = lvl * LEVEL_INDENT_EMU + (bullet !== null ? BULLET_HANG_EMU : 0);
  if (leftEmu > 0) style.paddingLeft = len(geo, leftEmu);
  const trail = last.t.endsWith('\n');
  if (trail) style['--osl-trail'] = ptLen(geo, runPt(last, fallbackPt));

  let bulletEl: JSX.Element | null = null;
  if (bullet !== null) {
    // 글머리를 들여쓰기 자리에 매단다: 첫 줄만 왼쪽으로 내어 쓰고, 기호 상자의 최소 폭이 그 자리다
    style.textIndent = `-${len(geo, BULLET_HANG_EMU)}`;
    const bs: CSSProperties = { minWidth: len(geo, BULLET_HANG_EMU), fontSize: ptLen(geo, sizes[0] ?? fallbackPt) };
    const color = cssColor(first.color);
    if (color) bs.color = color;
    bulletEl = (
      <span className="osl-bullet" aria-hidden="true" style={bs}>
        {bullet}
      </span>
    );
  }

  return (
    <p className={trail ? 'osl-p osl-p-trail' : 'osl-p'} style={style}>
      {bulletEl}
      {runs.map((r) => (
        <RunSpan key={r.o} run={r} geo={geo} fallbackPt={fallbackPt} />
      ))}
    </p>
  );
}

/**
 * 문단 묶음(글상자 본문, 표 칸). 빈 문단의 높이: 추출기가 빈 문단에 남기는 빈 조각(t '')의 sz
 * (문단 끝 서식), 없으면 앞 문단 마지막 조각의 크기(Enter 를 두 번 친 빈 줄은 앞 서식을 잇는다),
 * 앞이 없으면 뒤 문단 첫 조각, 그것도 없으면 fallbackPt.
 */
function Paragraphs(props: { paras: readonly SlidePara[]; geo: Geo; fallbackPt: number }): JSX.Element {
  const { paras, geo, fallbackPt } = props;
  const edge = paras.map((p) => {
    const all = runsOf(p);
    const runs = all.filter(hasText);
    const head = runs[0];
    const tail = runs[runs.length - 1];
    let own: number | null = null;
    if (!head) for (const r of all) own ??= num(r.sz, 0.5, 4000) ?? null;
    return {
      first: head ? runPt(head, fallbackPt) : null,
      last: tail ? runPt(tail, fallbackPt) : null,
      own,
    };
  });
  const emptyPts: number[] = [];
  let prev: number | null = null;
  edge.forEach((e, i) => {
    let pt = e.own ?? prev;
    for (let j = i + 1; pt === null && j < edge.length; j += 1) pt = edge[j]?.first ?? null;
    emptyPts.push(pt ?? fallbackPt);
    if (e.last !== null) prev = e.last;
  });
  return (
    <>
      {paras.map((para, i) => (
        <Paragraph key={i} para={para} geo={geo} fallbackPt={fallbackPt} emptyPt={emptyPts[i] ?? fallbackPt} />
      ))}
    </>
  );
}

function boxStyle(geo: Geo, s: SlideShape, z: number | undefined): CSSProperties {
  const st: CSSProperties = {
    left: `${fmt((finite(s.x, 0) / geo.w) * 100)}%`,
    top: `${fmt((finite(s.y, 0) / geo.h) * 100)}%`,
    width: `${fmt((Math.max(0, finite(s.w, 0)) / geo.w) * 100)}%`,
    height: `${fmt((Math.max(0, finite(s.h, 0)) / geo.h) * 100)}%`,
  };
  const rot = finite(s.rot, 0);
  if (rot % 360 !== 0) st.transform = `rotate(${fmt(rot)}deg)`;
  if (z !== undefined) st.zIndex = z;
  return st;
}

/** 모델 순서 [l, t, r, b] → CSS padding 순서(위, 오른쪽, 아래, 왼쪽) */
function insetPadding(geo: Geo, inset: readonly number[] | undefined, fallback: readonly number[]): string {
  const at = (i: number): number => Math.max(0, finite(inset?.[i], fallback[i] ?? 0));
  return `${len(geo, at(1))} ${len(geo, at(2))} ${len(geo, at(3))} ${len(geo, at(0))}`;
}

function TextShape(props: { shape: SlideTextShape; geo: Geo; z: number | undefined }): JSX.Element {
  const { shape, geo, z } = props;
  const style = boxStyle(geo, shape, z);
  const fill = cssColor(shape.fill);
  if (fill) style.background = fill;
  const line = cssColor(shape.line);
  if (line) style.border = `max(1px, ${len(geo, LINE_EMU)}) solid ${line}`;
  const paras = parasOf(shape);
  const body: CSSProperties = {
    padding: insetPadding(geo, shape.inset, DEFAULT_INSET),
    justifyContent: ANCHOR[shape.anchor ?? 't'] ?? 'flex-start',
  };
  return (
    <div className="osl-shape osl-text" style={style}>
      {paras.length > 0 ? (
        <div className="osl-tb" style={body}>
          <div className="osl-tx" style={{ tabSize: len(geo, TAB_EMU) }}>
            <Paragraphs paras={paras} geo={geo} fallbackPt={firstSizedPt(paras) ?? DEFAULT_PT} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 슬라이드 크기의 자르개: 글자 없는 개체(그림, 개체 자리)를 슬라이드 안으로 자른다. 슬라이드가 넘침
 * 모드(상자가 자르지 않음)일 때도 이것들은 슬라이드 밖으로 번지지 않는다. 겹침 순서(z)는 여기에 단다.
 * 포인터는 통과시킨다(아래 글자의 드래그 선택을 막지 않게).
 */
function Clip(props: { z: number | undefined; children: ReactNode }): JSX.Element {
  return (
    <div className="osl-clip" style={props.z !== undefined ? { zIndex: props.z } : undefined}>
      {props.children}
    </div>
  );
}

/** 그리지 않는 개체(차트, SmartArt, OLE 등)와 받을 수 없는 그림: 점선 자리 상자에 이름만 */
function PlaceholderBox(props: { geo: Geo; shape: SlideShape; z: number | undefined; label: string }): JSX.Element {
  const { geo, shape, z, label } = props;
  return (
    <Clip z={z}>
      <div className="osl-shape osl-other" style={boxStyle(geo, shape, undefined)}>
        <span className="osl-other-label">{label}</span>
      </div>
    </Clip>
  );
}

function PicShape(props: { shape: SlidePicShape; geo: Geo; z: number | undefined; url: string | undefined }): JSX.Element {
  const { shape, geo, z, url } = props;
  if (!url) return <PlaceholderBox geo={geo} shape={shape} z={z} label="그림" />;
  const crop = cropOf(shape.crop);
  if (crop) {
    // 잘라 낸 그림: 상자(잘라 낸 뒤 크기, 회전 포함) 안에서 원본을 키워 밀어 그린다(text-utils cropPlacement)
    return (
      <Clip z={z}>
        <div className="osl-shape osl-crop" style={boxStyle(geo, shape, undefined)}>
          <img
            className="osl-pic"
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            style={cropPlacement(crop)}
          />
        </div>
      </Clip>
    );
  }
  return (
    <Clip z={z}>
      <img
        className="osl-shape osl-pic"
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        style={boxStyle(geo, shape, undefined)}
      />
    </Clip>
  );
}

/** colSpan/rowSpan 값: 2 이상일 때만 (HTML 상한 안으로) */
function spanAttr(v: number | undefined, max: number): number | undefined {
  const n = Math.floor(finite(v, 1));
  return n > 1 ? Math.min(n, max) : undefined;
}

function TableShape(props: { shape: SlideTableShape; geo: Geo; z: number | undefined }): JSX.Element {
  const { shape, geo, z } = props;
  const cols = Array.isArray(shape.cols) ? shape.cols.map((c) => Math.max(0, finite(c, 0))) : [];
  const total = cols.reduce((a, c) => a + c, 0);
  const rows = Array.isArray(shape.rows) ? shape.rows : [];
  const shown: SlidePara[] = [];
  for (const row of rows) for (const cell of cellsOf(row)) if (!cell.hidden) shown.push(...parasOf(cell));
  const fallbackPt = firstSizedPt(shown) ?? DEFAULT_PT;
  const padding = insetPadding(geo, undefined, CELL_INSET);

  const cellEl = (cell: SlideTableCell, key: number): JSX.Element | null => {
    if (cell.hidden) return null; // 병합으로 가려진 칸: 앞 칸의 colSpan/rowSpan 이 자리를 덮는다
    const cs: CSSProperties = { padding };
    const fill = cssColor(cell.fill);
    if (fill) cs.background = fill;
    return (
      <td key={key} colSpan={spanAttr(cell.gridSpan, 1000)} rowSpan={spanAttr(cell.rowSpan, 65534)} style={cs}>
        <Paragraphs paras={parasOf(cell)} geo={geo} fallbackPt={fallbackPt} />
      </td>
    );
  };

  return (
    <div className="osl-shape osl-tablebox" style={boxStyle(geo, shape, z)}>
      <table className="osl-table" style={{ tabSize: len(geo, TAB_EMU) }}>
        {total > 0 ? (
          <colgroup>
            {cols.map((c, i) => (
              <col key={i} style={{ width: `${fmt((c / total) * 100)}%` }} />
            ))}
          </colgroup>
        ) : null}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ height: len(geo, Math.max(0, finite(row.h, 0))) }}>
              {cellsOf(row).map((cell, ci) => cellEl(cell, ci))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 도형의 첫 정본 오프셋 (글자가 없으면 null) */
function firstOffset(shape: SlideShape): number | null {
  const fromParas = (paras: readonly SlidePara[]): number | null => {
    for (const p of paras) for (const r of runsOf(p)) if (hasText(r)) return r.o;
    return null;
  };
  if (shape.type === 'text') return fromParas(parasOf(shape));
  if (shape.type === 'table') {
    for (const row of Array.isArray(shape.rows) ? shape.rows : []) {
      for (const cell of cellsOf(row)) {
        if (cell.hidden) continue;
        const o = fromParas(parasOf(cell));
        if (o !== null) return o;
      }
    }
  }
  return null;
}

interface PlacedShape {
  shape: SlideShape;
  /** 모델 안 순서 (React key) */
  key: number;
  /** DOM 순서를 바꾼 경우에만: 원래 겹침 순서 */
  z?: number;
}

/**
 * DOM 에 놓을 도형 순서. 보통은 모델 순서 그대로다(글자 있는 도형의 첫 오프셋이 오름차순).
 * 아니면 글자 있는 도형을 첫 오프셋 순으로, 글자 없는 도형(그림, 개체)을 그 뒤에 놓고, 모든 도형에
 * 원래 순서의 z-index 를 준다(겹침은 그대로, DOM 은 정본 순서).
 */
function placeShapes(shapes: readonly SlideShape[]): PlacedShape[] {
  const items = shapes.map((shape, key) => ({ shape, key, first: firstOffset(shape) }));
  let last = Number.NEGATIVE_INFINITY;
  let monotonic = true;
  for (const it of items) {
    if (it.first === null) continue;
    if (it.first < last) {
      monotonic = false;
      break;
    }
    last = it.first;
  }
  if (monotonic) return items.map(({ shape, key }) => ({ shape, key }));
  return [...items]
    .sort((a, b) => {
      const fa = a.first ?? Number.POSITIVE_INFINITY;
      const fb = b.first ?? Number.POSITIVE_INFINITY;
      return fa === fb ? a.key - b.key : fa - fb;
    })
    .map(({ shape, key }) => ({ shape, key, z: key + 1 }));
}

function ShapeView(props: { placed: PlacedShape; geo: Geo; urls: readonly string[] }): JSX.Element | null {
  const { placed, geo, urls } = props;
  const { shape, z } = placed;
  switch (shape.type) {
    case 'text':
      return <TextShape shape={shape} geo={geo} z={z} />;
    case 'pic':
      return <PicShape shape={shape} geo={geo} z={z} url={urls[shape.media]} />;
    case 'table':
      return <TableShape shape={shape} geo={geo} z={z} />;
    case 'other':
      return <PlaceholderBox geo={geo} shape={shape} z={z} label={shape.label || '개체'} />;
    default:
      return null;
  }
}

/** 정본 글자가 슬라이드 상자 밖으로 나간 정도. top/bottom 은 상자 너비에 대한 백분율 (0 = 안 나감) */
interface Spill {
  top: number;
  bottom: number;
  /** 왼쪽이나 오른쪽으로 나간 글자가 있다 */
  side: boolean;
}

function sameSpill(a: Spill | null, b: Spill | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.top - b.top) < 0.05 && Math.abs(a.bottom - b.bottom) < 0.05 && a.side === b.side;
}

/**
 * 배치가 끝난 슬라이드 상자에서 정본 글자(공백 아닌 data-o 조각)의 화면 사각형이 상자 밖으로 나간
 * 정도를 잰다. 글상자 본문(.osl-tx)과 표 상자 전체가 상자 안이면 조각까지 보지 않는다.
 */
function measureSpill(canvas: HTMLElement): Spill | null {
  const cr = canvas.getBoundingClientRect();
  if (!(cr.width > 0) || !(cr.height > 0)) return null;
  const tol = SPILL_TOLERANCE_PX;
  let minTop = cr.top;
  let maxBottom = cr.bottom;
  let side = false;
  for (const box of Array.from(canvas.querySelectorAll<HTMLElement>('.osl-tx, .osl-table'))) {
    const b = box.getBoundingClientRect();
    if (b.top >= cr.top - tol && b.bottom <= cr.bottom + tol && b.left >= cr.left - tol && b.right <= cr.right + tol) {
      continue;
    }
    for (const span of Array.from(box.querySelectorAll<HTMLElement>('[data-o]'))) {
      if (!/\S/.test(span.textContent ?? '')) continue;
      for (const q of Array.from(span.getClientRects())) {
        if (!(q.width > 0) || !(q.height > 0)) continue;
        if (q.top < minTop) minTop = q.top;
        if (q.bottom > maxBottom) maxBottom = q.bottom;
        if (q.left < cr.left - tol || q.right > cr.right + tol) side = true;
      }
    }
  }
  const top = cr.top - minTop;
  const bottom = maxBottom - cr.bottom;
  if (top <= tol && bottom <= tol && !side) return null;
  return {
    top: top > tol ? (top / cr.width) * 100 : 0,
    bottom: bottom > tol ? (bottom / cr.width) * 100 : 0,
    side,
  };
}

/** 넘친 글자를 위한 빈자리: 세로 padding 백분율은 슬라이드 너비 기준이라 폭을 바꿔도 비율이 맞는다 */
function Room(props: { pct: number }): JSX.Element | null {
  if (!(props.pct > 0)) return null;
  return <div className="osl-room" aria-hidden="true" style={{ paddingTop: `${fmt(props.pct)}%` }} />;
}

/** 슬라이드 한 장. 모델은 불변이라 같은 props 면 다시 그리지 않는다 */
const SlideView = memo(function SlideView(props: {
  page: SlidePage;
  geo: Geo;
  urls: readonly string[];
  pageRef: PageRefCallback;
  capId: string;
  /** 다시 재기 신호(폭 변화, 글꼴 로드)를 받을 콜백 모음 (SlidesView 가 하나를 나눠 준다) */
  remeasure: Set<() => void>;
}): JSX.Element {
  const { page, geo, urls, pageRef, capId, remeasure } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  // 잰 결과는 잰 쪽 객체와 함께 둔다: 모델이 바뀌면 다시 잴 때까지 옛 결과를 쓰지 않는다
  const [measured, setMeasured] = useState<{ page: SlidePage; spill: Spill | null } | null>(null);
  const spill = measured !== null && measured.page === page ? measured.spill : null;
  // 배치되어 있는가: content-visibility 가 건너뛰는 동안은 재지 않는다(재면 그 슬라이드를 억지로 배치한다)
  const laidOut = useRef(!CV_EVENTS);

  // 이벤트 구독은 첫 그리기 전에(useLayoutEffect): 처음 보이는 슬라이드의 상태 변화도 놓치지 않는다
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let raf = 0;
    const run = (): void => {
      raf = 0;
      const next = measureSpill(canvas);
      setMeasured((prev) => {
        const fresh = prev === null || prev.page === page;
        // 넘침이 없으면 처음 잰 슬라이드도 상태를 바꾸지 않는다(다시 그리지 않게)
        return fresh && sameSpill(prev?.spill ?? null, next) ? prev : { page, spill: next };
      });
    };
    const schedule = (): void => {
      if (raf === 0) raf = requestAnimationFrame(run);
    };
    const onState = (e: Event): void => {
      laidOut.current = !(e as Event & { skipped?: boolean }).skipped;
      if (laidOut.current) schedule();
    };
    const again = (): void => {
      if (laidOut.current) schedule();
    };
    canvas.addEventListener('contentvisibilityautostatechange', onState);
    remeasure.add(again);
    again();
    return () => {
      canvas.removeEventListener('contentvisibilityautostatechange', onState);
      remeasure.delete(again);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [page, geo, remeasure]);

  const canvasStyle: CSSProperties = { aspectRatio: `${geo.w} / ${geo.h}` };
  const bg = cssColor(page.bg);
  if (bg) canvasStyle.background = bg;
  const placed = placeShapes(Array.isArray(page.shapes) ? page.shapes : []);
  const cls = ['osl-slide'];
  if (page.hidden) cls.push('osl-slide-hidden');
  if (spill) cls.push('osl-slide-spill');
  return (
    <section className={cls.join(' ')} data-page={page.pageNo} aria-labelledby={capId} ref={pageRef}>
      <Room pct={spill?.top ?? 0} />
      <div className="osl-canvas" style={canvasStyle} ref={canvasRef}>
        {placed.map((p) => (
          <ShapeView key={p.key} placed={p} geo={geo} urls={urls} />
        ))}
      </div>
      <Room pct={spill?.bottom ?? 0} />
      <div className="osl-cap" id={capId}>
        {page.hidden ? <span className="osl-badge">숨김</span> : null}
        {spill ? <span className="osl-badge osl-badge-spill">슬라이드 밖 글자</span> : null}
        <span>{pageRefLabel('pptx', page.pageNo, `슬라이드 ${page.no}`)}</span>
      </div>
    </section>
  );
});

export default function SlidesView(props: {
  model: SlidesModel;
  /** media 색인 → 그림 주소 (/api/docs/versions/:vid/media/:index) */
  mediaUrl: (index: number) => string;
  /** 쪽 요소가 붙으면 (pageNo, 요소), 떨어지면 (pageNo, null). 쪽 이동과 현재 쪽 판정용 */
  onPageElement?: (pageNo: number, el: HTMLElement | null) => void;
}): JSX.Element {
  const { model, mediaUrl, onPageElement } = props;
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // 쪽마다 ref 콜백을 하나로 고정하고 그 안에서 부모의 최신 콜백을 부른다(PlainView 와 같은 방식).
  // 부모가 렌더마다 새 함수를 넘겨도 (null, 요소) 호출이 되풀이되지 않는다.
  // useInsertionEffect 는 ref 가 붙기 전에 돌므로 새로 붙는 쪽도 최신 콜백을 받는다.
  const latest = useRef(onPageElement);
  useInsertionEffect(() => {
    latest.current = onPageElement;
  });
  const refFns = useRef(new Map<number, PageRefCallback>());
  const refFor = (pageNo: number): PageRefCallback => {
    let fn = refFns.current.get(pageNo);
    if (!fn) {
      fn = (el) => latest.current?.(pageNo, el);
      refFns.current.set(pageNo, fn);
    }
    return fn;
  };

  // 넘침 다시 재기: 보기 폭이 바뀌거나(줄바꿈 자리가 미세하게 달라질 수 있다) 글꼴이 늦게 오면
  // 배치되어 있는 슬라이드만 다시 잰다
  const [remeasure] = useState(() => new Set<() => void>());
  useEffect(() => {
    const all = (): void => {
      for (const f of remeasure) f();
    };
    const root = rootRef.current;
    const ro = root && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(all) : null;
    if (ro && root) ro.observe(root);
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', all);
    return () => {
      ro?.disconnect();
      fonts?.removeEventListener?.('loadingdone', all);
    };
  }, [remeasure]);

  const sw = finite(model.slideW, 0);
  const sh = finite(model.slideH, 0);
  const valid = sw > 0 && sh > 0;
  const w = valid ? sw : FALLBACK_W;
  const h = valid ? sh : FALLBACK_H;
  const geo = useMemo<Geo>(() => ({ w, h }), [w, h]);

  // 그림 주소 목록: 부모가 렌더마다 새 mediaUrl 함수를 넘겨도 주소가 같으면 같은 배열(슬라이드 memo 유지)
  const media = Array.isArray(model.media) ? model.media : [];
  const list = media.map((_, i) => mediaUrl(i));
  const signature = list.join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const urls = useMemo<readonly string[]>(() => list, [signature]);

  const pages = Array.isArray(model.pages) ? model.pages : [];
  return (
    <div className="osl-deck" translate="no" ref={rootRef}>
      {pages.map((page) => (
        <SlideView
          key={page.pageNo}
          page={page}
          geo={geo}
          urls={urls}
          pageRef={refFor(page.pageNo)}
          capId={`${uid}-cap-${page.pageNo}`}
          remeasure={remeasure}
        />
      ))}
      {pages.length === 0 ? <p className="osl-deck-note">슬라이드가 없습니다.</p> : null}
      {model.truncated ? (
        <p className="osl-deck-note osl-deck-trunc" role="note">
          {model.truncated}
        </p>
      ) : null}
    </div>
  );
}
