/**
 * 의존성 없는 최소 XML 트리: Office Open XML(docx, xlsx, pptx), HWPX 전용
 *
 * 쓰임: 검사실 자료(지침서 라이브러리)에 올린 Office 파일에서 글자를 뽑고, docx 는 쪽 나눔을
 * 펼쳐 다시 쓴다(`office/docx/paginate.ts`).
 *
 * 원칙
 * - **새 의존성 없음**(설계서 §1 의존성 정책). 잘 짜인(well-formed) XML 만 다룬다.
 * - **왕복 보존**: parse → serialize 가 원문과 같은 문자열이다. 속성, 공백, 주석, 처리지시를 원문
 *   그대로 보관한다: docx 쪽 나눔 변환에서 손대지 않은 부분은 한 글자도 바뀌면 안 되기 때문.
 *   (끝 태그 안의 공백 `</a >` 만은 `</a>` 로 정리된다. Office 는 그런 XML 을 쓰지 않는다.)
 * - **엔티티를 해석하지 않는다**: DOCTYPE 이 있으면 거부한다(XXE, 엔티티 폭탄 차단).
 *   글자로 되돌릴 때 문자 참조(&#..;)와 기본 5개 엔티티만 푼다.
 */

export interface XElement {
  type: 'el';
  /** 접두사 포함 이름 (예: 'w:p') */
  name: string;
  /** 원문 속성 문자열: 앞 공백 포함, 자기닫힘 '/' 제외 (예: ' w:val="1"') */
  rawAttrs: string;
  children: XNode[];
  /** 원문이 `<x/>` 형태였는지: 자식이 없을 때만 직렬화에 쓰인다 */
  selfClosing: boolean;
  /** 속성 해석 캐시 (attr() 가 채운다) */
  _attrs?: Map<string, string>;
}

/** 원문(이스케이프된 상태) 글자 */
export interface XText {
  type: 'text';
  raw: string;
}

/** 주석, 처리지시, CDATA: 원문 그대로 보관만 한다 */
export interface XRaw {
  type: 'raw';
  raw: string;
}

export type XNode = XElement | XText | XRaw;

export interface XDocument {
  /** 루트 앞의 노드(<?xml ...?> 선언 등) */
  prolog: XNode[];
  root: XElement;
  /** 루트 뒤의 노드 */
  epilog: XNode[];
}

export class XmlParseError extends Error {
  constructor(message: string, readonly position: number) {
    super(`XML을 해석할 수 없습니다(${position}): ${message}`);
    this.name = 'XmlParseError';
  }
}

const NAME_RE = /^[^\s/>]+/;

/** XML 문자열 → 트리. 잘 짜이지 않았거나 DOCTYPE 이 있으면 XmlParseError. */
export function parseXml(src: string): XDocument {
  const n = src.length;
  const stack: XElement[] = [];
  const top: XNode[] = [];
  let rootIndex = -1;
  let i = 0;

  const push = (node: XNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else top.push(node);
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      push({ type: 'text', raw: src.slice(i) });
      break;
    }
    if (lt > i) push({ type: 'text', raw: src.slice(i, lt) });

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlParseError('닫히지 않은 주석', lt);
      push({ type: 'raw', raw: src.slice(lt, end + 3) });
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlParseError('닫히지 않은 CDATA', lt);
      push({ type: 'raw', raw: src.slice(lt, end + 3) });
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlParseError('닫히지 않은 처리지시', lt);
      push({ type: 'raw', raw: src.slice(lt, end + 2) });
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      throw new XmlParseError('DOCTYPE/엔티티 선언은 지원하지 않습니다', lt);
    }
    if (src.startsWith('</', lt)) {
      const gt = src.indexOf('>', lt + 2);
      if (gt < 0) throw new XmlParseError('닫히지 않은 끝 태그', lt);
      const name = src.slice(lt + 2, gt).trim();
      const el = stack.pop();
      if (!el || el.name !== name) {
        throw new XmlParseError(`끝 태그 불일치: </${name}> (열린 태그 ${el ? el.name : '없음'})`, lt);
      }
      if (stack.length === 0) {
        if (rootIndex >= 0 && top[rootIndex] !== el) throw new XmlParseError('루트가 둘 이상', lt);
        rootIndex = top.indexOf(el);
      }
      i = gt + 1;
      continue;
    }

    // 시작 태그: 따옴표 안의 '>' 는 건너뛴다
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const ch = src.charCodeAt(j);
      if (quote) {
        if (src[j] === quote) quote = '';
      } else if (ch === 0x22 /* " */ || ch === 0x27 /* ' */) {
        quote = src[j]!;
      } else if (ch === 0x3e /* > */) {
        break;
      }
      j += 1;
    }
    if (j >= n) throw new XmlParseError('닫히지 않은 시작 태그', lt);
    let inner = src.slice(lt + 1, j);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const m = NAME_RE.exec(inner);
    if (!m) throw new XmlParseError('태그 이름 없음', lt);
    const el: XElement = {
      type: 'el',
      name: m[0],
      rawAttrs: inner.slice(m[0].length),
      children: [],
      selfClosing,
    };
    if (stack.length === 0 && rootIndex >= 0) throw new XmlParseError('루트가 둘 이상', lt);
    push(el);
    if (selfClosing) {
      if (stack.length === 0) rootIndex = top.indexOf(el);
    } else {
      stack.push(el);
    }
    i = j + 1;
  }

  if (stack.length > 0) throw new XmlParseError(`닫히지 않은 요소 <${stack[stack.length - 1]!.name}>`, n);
  if (rootIndex < 0) throw new XmlParseError('루트 요소 없음', 0);
  return {
    prolog: top.slice(0, rootIndex),
    root: top[rootIndex] as XElement,
    epilog: top.slice(rootIndex + 1),
  };
}

function serializeInto(node: XNode, out: string[]): void {
  if (node.type !== 'el') {
    out.push(node.raw);
    return;
  }
  if (node.children.length === 0 && node.selfClosing) {
    out.push('<', node.name, node.rawAttrs, '/>');
    return;
  }
  out.push('<', node.name, node.rawAttrs, '>');
  for (const c of node.children) serializeInto(c, out);
  out.push('</', node.name, '>');
}

/** 노드 하나를 문자열로 */
export function serializeNode(node: XNode): string {
  const out: string[] = [];
  serializeInto(node, out);
  return out.join('');
}

/** 문서 전체를 문자열로 (parseXml 의 역) */
export function serializeXml(doc: XDocument): string {
  const out: string[] = [];
  for (const nd of doc.prolog) serializeInto(nd, out);
  serializeInto(doc.root, out);
  for (const nd of doc.epilog) serializeInto(nd, out);
  return out.join('');
}

/** XML 엔티티 되돌리기: 문자 참조 + 기본 5개 (외부 엔티티는 해석하지 않는다) */
export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  // 한 번에 훑는다: 차례로 바꾸면 '&#38;lt;' 가 '<' 로 두 번 풀린다(정답은 '&lt;')
  return s.replace(ENTITY_RE, (m: string, dec?: string, hex?: string, named?: string) => {
    if (named) return NAMED_ENTITY[named] ?? m;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
    return isXmlChar(cp) ? String.fromCodePoint(cp) : REPLACEMENT_CHAR;
  });
}

const ENTITY_RE = /&(?:#(\d{1,8})|#x([0-9a-fA-F]{1,7})|(lt|gt|amp|quot|apos));/g;
const NAMED_ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * XML 1.0 이 허용하는 글자인가 (Char 생성 규칙). 짝 없는 서로게이트(D800~DFFF), NUL 같은 제어 문자는
 * 대체 문자로 바꾼다: 그대로 두면 깨진 UTF-16 이 DB 와 JSON 에 들어간다.
 */
function isXmlChar(cp: number): boolean {
  if (!Number.isFinite(cp)) return false;
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** 글자 → XML 텍스트(새로 만드는 요소용) */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isAttrSpace(c: number): boolean {
  return c === 0x20 || c === 0x9 || c === 0xa || c === 0xd;
}

/**
 * 속성 원문 → 이름별 값 (엔티티 해제). 글자를 한 번만 훑는 선형 스캐너다.
 * 예전 정규식은 '=' 없는 긴 토큰에서 되돌아가기로 시간이 제곱으로 늘었다(16만 자에 38초).
 * 같은 이름이 두 번 나오면 뒤의 값을 쓴다(예전 동작과 같다). 따옴표 없는 값은 XML 이 아니므로 건너뛴다.
 */
export function parseAttrs(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const n = raw.length;
  let i = 0;
  while (i < n) {
    while (i < n && isAttrSpace(raw.charCodeAt(i))) i += 1;
    if (i >= n) break;
    const nameStart = i;
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (isAttrSpace(c) || c === 0x3d /* = */ || c === 0x22 /* " */ || c === 0x27 /* ' */) break;
      i += 1;
    }
    const name = raw.slice(nameStart, i);
    while (i < n && isAttrSpace(raw.charCodeAt(i))) i += 1;
    if (i >= n) break;
    if (raw.charCodeAt(i) !== 0x3d) {
      if (i === nameStart) i += 1; // 따옴표 같은 글자에서 멈춘 경우에도 반드시 앞으로 간다
      continue;
    }
    i += 1; // '='
    while (i < n && isAttrSpace(raw.charCodeAt(i))) i += 1;
    const q = raw.charCodeAt(i);
    if (q !== 0x22 && q !== 0x27) continue;
    const vStart = i + 1;
    const vEnd = raw.indexOf(q === 0x22 ? '"' : "'", vStart);
    if (vEnd < 0) break;
    if (name) map.set(name, unescapeXml(raw.slice(vStart, vEnd)));
    i = vEnd + 1;
  }
  return map;
}

/** 속성 값(엔티티 해제). 없으면 undefined */
export function attr(el: XElement, name: string): string | undefined {
  if (!el._attrs) el._attrs = parseAttrs(el.rawAttrs);
  return el._attrs.get(name);
}

/** 'w:p' → 'p' */
export function localName(name: string): string {
  const k = name.indexOf(':');
  return k < 0 ? name : name.slice(k + 1);
}

export function isEl(node: XNode | undefined): node is XElement {
  return node != null && node.type === 'el';
}

/** 직계 자식 요소 (이름 지정 시 그 이름만) */
export function childEls(el: XElement, name?: string): XElement[] {
  const out: XElement[] = [];
  for (const c of el.children) {
    if (c.type === 'el' && (name === undefined || c.name === name)) out.push(c);
  }
  return out;
}

/** 이름이 같은 첫 직계 자식 요소 */
export function childEl(el: XElement, name: string): XElement | undefined {
  for (const c of el.children) {
    if (c.type === 'el' && c.name === name) return c;
  }
  return undefined;
}

/** 경로를 따라 내려간 첫 요소 (예: childPath(p, 'w:pPr', 'w:sectPr')) */
export function childPath(el: XElement, ...names: string[]): XElement | undefined {
  let cur: XElement | undefined = el;
  for (const nm of names) {
    if (!cur) return undefined;
    cur = childEl(cur, nm);
  }
  return cur;
}

/** 깊이 우선으로 이름이 같은 모든 하위 요소 (자기 자신 제외) */
export function descendants(el: XElement, name: string, out: XElement[] = []): XElement[] {
  for (const c of el.children) {
    if (c.type !== 'el') continue;
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

/** 이름이 같은 하위 요소가 하나라도 있는가 */
export function hasDescendant(el: XElement, name: string): boolean {
  for (const c of el.children) {
    if (c.type !== 'el') continue;
    if (c.name === name || hasDescendant(c, name)) return true;
  }
  return false;
}

/** 새 요소 만들기 (변환용). rawAttrs 는 앞 공백 포함 원문 형태로 넘긴다 */
export function makeEl(name: string, rawAttrs = '', children: XNode[] = []): XElement {
  return { type: 'el', name, rawAttrs, children, selfClosing: children.length === 0 };
}

/** 요소의 얕은 복제(자식 배열은 새 배열, 자식 노드는 공유) */
export function shallowClone(el: XElement, children: XNode[] = el.children.slice()): XElement {
  return { type: 'el', name: el.name, rawAttrs: el.rawAttrs, children, selfClosing: el.selfClosing };
}

/** 요소의 깊은 복제 */
export function deepClone<T extends XNode>(node: T): T {
  if (node.type !== 'el') return { ...node };
  return {
    type: 'el',
    name: node.name,
    rawAttrs: node.rawAttrs,
    children: node.children.map((c) => deepClone(c)),
    selfClosing: node.selfClosing,
  } as T;
}
