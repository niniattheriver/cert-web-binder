/**
 * 문항 본문 렌더 — PDF 물리 줄을 "흐르는 텍스트"로 재조립(칸 너비에 맞춰 흐름).
 *
 * 저장된 body는 PDF 물리 줄을 보존한다(예: "…있고"⏎"이를…", "추적관찰하"⏎"고").
 * 줄바꿈 지점의 공백은 워드프로세서가 소비해 PDF에 남지 않아(표시·재추출 모두 복원 불가),
 * 이어붙일 때 공백 여부를 **휴리스틱**으로 추정한다. 실데이터 5,258개 조인 지점 분석 결과
 * 경계 대부분은 공백이 필요하므로 **기본 공백**, 단 명백한 단어 중간만 붙인다:
 *   - prev 마지막 음절이 '하'  → 붙임(실시하|고 → 실시하고, 평가하|면 → 평가하면)
 *   - next 첫 음절이 어/아/여/워 → 붙임(있|어오는지 → 있어오는지, 들|어 → 들어)
 *   - 그 외 한글–한글, 또는 비한글 경계 → 공백 하나
 * 한계: '시설물'이 '시'⏎'설물'로 갈린 명사 중간 등은 규칙으로 못 잡아 드물게 '시 설물' 잔여.
 *   근본 교정은 형태소 기반 띄어쓰기 모델(후속) 몫. 표시 계층 전용(저장 텍스트 무접촉).
 *
 * 불릿(•)·열거((1),(2),① …)로 시작하는 줄은 별도 항목으로 분리(원본 줄바꿈 유지),
 * 그 내부에서 이어지는 줄은 위 규칙으로 흐르게 합침 + hanging indent 렌더.
 */
import { fixBullets } from '../util';

type Kind = 'para' | 'bullet' | 'enum';
interface Block {
  kind: Kind;
  text: string;
}

const BULLET_RE = /^\s*[•●]\s*(.*)$/;
// 열거 표지: (1) · 1) · 1. · ①…⑳ 로 시작하는 줄
const ENUM_RE = /^\s*(?:\(\d+\)|\d+[.)]|[①-⑳])\s/;
// 다음 줄 첫 음절이 이것이면 어미 연결로 보고 붙임 (있|어, 들|어, 되|어…)
const SUPPRESS_NEXT = new Set(['어', '아', '여', '워']);

function isHangul(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f);
}

/** 소프트 랩으로 쪼개진 줄 합치기 — 기본 공백, 명백한 단어 중간만 공백 없이 */
function joinWrapped(prev: string, next: string): string {
  const p = prev.replace(/\s+$/, '');
  const n = next.replace(/^\s+/, '');
  if (!p) return n;
  if (!n) return p;
  const a = p[p.length - 1]!;
  const b = n[0]!;
  if (isHangul(a) && isHangul(b)) {
    if (a === '하') return p + n; // 하-어간 중간 (실시하|고)
    if (SUPPRESS_NEXT.has(b)) return p + n; // 어미 연결 (있|어)
  }
  return `${p} ${n}`;
}

function toBlocks(text: string): Block[] {
  const lines = fixBullets(text).split('\n');
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      flush(); // 빈 줄 = 경계
      continue;
    }
    const bm = BULLET_RE.exec(line);
    if (bm) {
      flush();
      cur = { kind: 'bullet', text: bm[1]!.trim() };
      continue;
    }
    if (ENUM_RE.test(line)) {
      flush();
      cur = { kind: 'enum', text: line };
      continue;
    }
    if (cur) cur.text = joinWrapped(cur.text, line); // 이어지는 줄 = 흐르게 합침
    else cur = { kind: 'para', text: line };
  }
  flush();
  return blocks;
}

export default function QuestionBody({ text }: { text: string }) {
  const blocks = toBlocks(text);
  return (
    <div className="qbody">
      {blocks.map((b, i) =>
        b.kind === 'bullet' ? (
          <div className="qbody-bullet" key={i}>
            {b.text}
          </div>
        ) : b.kind === 'enum' ? (
          <div className="qbody-enum" key={i}>
            {b.text}
          </div>
        ) : (
          <p className="qbody-para" key={i}>
            {b.text}
          </p>
        ),
      )}
    </div>
  );
}
