// 텍스트 정규화 — 설계서 §3.1-3
// 규칙: 유니코드 NFC(한글 NFC/NFD 혼입 방지), 제로폭 문자 제거, 줄끝 \n 통일.
// 저장 텍스트의 공백은 절대 붕괴시키지 않는다(오프셋 안정성 우선).
// 오프셋 맵을 가진 "정규화 그림자 문자열"은 Day 2(매핑)에서 추가 — 여기서는 단순 정규화만.
//
// 주의(검토 반영): 불릿 PUA(U+F09F 등)→● 치환은 여기(저장 계층)에서 하지 않는다.
//   canon_norm('nfc-v1') 라벨을 검증하는 코드가 없어, 정규화 집합을 바꾸면 기존 판본 page_text/quote와
//   신규 정규화가 어긋나는 "조용한 정규화 드리프트"(needs_review 가짜양성)가 생긴다.
//   글머리기호 교정은 **표시 계층**에서만 수행한다 → web `util.ts:fixBullets`.
//   정식 저장 교정이 필요하면 canon_norm v2 범프 + 전 판본 일괄 재정규화 + 전 앵커 재검증(1:1이므로 100% 통과)로.

/** 제로폭 문자: ZWSP(U+200B), ZWNJ(U+200C), ZWJ(U+200D), BOM/ZWNBSP(U+FEFF) */
const ZERO_WIDTH_RE = /[​‌‍﻿]/g;

export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\r\n?/g, '\n');
}
