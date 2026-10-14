/**
 * 필드(w:fldChar begin/separate/end + w:instrText, w:fldSimple)
 *
 * - 화면에는 결과 구간(separate 와 end 사이)의 글자만 보인다. 명령 글자(instrText)는 절대 보이지 않는다.
 * - 필드는 겹칠 수 있다(명령 안의 필드 등). 열린 필드가 모두 결과 구간일 때만 글자를 보인다.
 * - 필드는 문단을 넘어 이어질 수 있다(목차 등). 그래서 상태는 이야기(본문, 머리말 하나, 각주) 단위로 둔다.
 * - 머리말/꼬리말의 PAGE, NUMPAGES, SECTIONPAGES 는 결과 글자 대신 계산한 값으로 바꾼다(쪽마다 다르다).
 */
import { formatNumber } from './units.js';

export type PageFieldKind = 'PAGE' | 'NUMPAGES' | 'SECTIONPAGES';

export interface PageField {
  kind: PageFieldKind;
  /** \* 서식 스위치 (roman, ROMAN, alphabetic, ALPHABETIC, Arabic, ArabicDash) */
  fmt?: string;
}

const FORMAT_SWITCHES = new Set(['roman', 'ROMAN', 'alphabetic', 'ALPHABETIC', 'Arabic', 'ArabicDash']);

/** 필드 명령 → 쪽 번호 필드면 종류와 서식 */
export function parsePageField(instr: string): PageField | undefined {
  const m = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)(?![A-Za-z])/i.exec(instr);
  if (!m) return undefined;
  const out: PageField = { kind: m[1]!.toUpperCase() as PageFieldKind };
  for (const s of instr.matchAll(/\\\*\s*([A-Za-z]+)/g)) {
    if (FORMAT_SWITCHES.has(s[1]!)) {
      out.fmt = s[1]!;
      break;
    }
  }
  return out;
}

/** 쪽 번호 글자: 필드 스위치가 우선, 없으면 구역의 pgNumType 서식(PAGE 만) */
export function formatPageNumber(n: number, field: PageField, sectFmt: string | undefined): string {
  switch (field.fmt) {
    case 'roman':
      return formatNumber(n, 'lowerRoman');
    case 'ROMAN':
      return formatNumber(n, 'upperRoman');
    case 'alphabetic':
      return formatNumber(n, 'lowerLetter');
    case 'ALPHABETIC':
      return formatNumber(n, 'upperLetter');
    case 'Arabic':
      return String(n);
    case 'ArabicDash':
      return `- ${n} -`;
    default:
      break;
  }
  if (field.kind !== 'PAGE' || !sectFmt) return String(n);
  if (sectFmt === 'numberInDash') return `- ${n} -`;
  return formatNumber(n, sectFmt);
}

interface Frame {
  instr: string;
  phase: 'instr' | 'result';
  page?: PageField;
  /** 쪽 번호 자리표시를 이미 냈는가 */
  emitted: boolean;
}

export class FieldStack {
  private frames: Frame[] = [];

  /** 지금 글자를 보여도 되는가: 열린 필드가 모두 결과 구간 */
  visible(): boolean {
    for (const f of this.frames) if (f.phase !== 'result') return false;
    return true;
  }

  depth(): number {
    return this.frames.length;
  }

  begin(): void {
    // 비정상 문서 방어: 지나치게 깊으면 더 쌓지 않는다(짝이 맞지 않는 begin 이 끝없이 이어질 때)
    if (this.frames.length < 64) this.frames.push({ instr: '', phase: 'instr', emitted: false });
  }

  instr(text: string): void {
    const f = this.frames[this.frames.length - 1];
    if (f && f.phase === 'instr') f.instr += text;
  }

  separate(): void {
    const f = this.frames[this.frames.length - 1];
    if (f && f.phase === 'instr') {
      f.phase = 'result';
      const page = parsePageField(f.instr);
      if (page) f.page = page;
    }
  }

  /** 필드를 닫는다. 결과 없이 닫힌 쪽 번호 필드면 그 정보를 돌려준다(머리말에서 값을 직접 낸다) */
  end(): PageField | undefined {
    const f = this.frames.pop();
    if (!f) return undefined;
    // 결과 구간 없이 끝났거나 결과가 비어 있던 쪽 번호 필드. 바깥 필드가 모두 결과 구간일 때만 보인다
    const page = f.phase === 'instr' ? parsePageField(f.instr) : f.emitted ? undefined : f.page;
    return page && this.visible() ? page : undefined;
  }

  /**
   * 결과 구간 안의 쪽 번호 필드: 처음 부를 때만 그 필드를 돌려주고(자리표시 한 번), 이후에는
   * 'skip' 을 돌려준다(캐시된 결과 글자를 버린다). 쪽 번호 필드 안이 아니면 undefined.
   */
  pageResult(): PageField | 'skip' | undefined {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const f = this.frames[i]!;
      if (f.page) {
        if (f.emitted) return 'skip';
        f.emitted = true;
        return f.page;
      }
    }
    return undefined;
  }

  reset(): void {
    this.frames = [];
  }
}
