/**
 * 전역 단축키 훅 (설계서 §4 단축키 전도 — 임무 D 소유)
 * - window keydown "버블" 단계에 바인딩 — PdfViewerPane 이 캡처 단계에서
 *   Enter/Esc 를 소비(stopPropagation)하면 여기 도달하지 않는다(의도된 우선순위).
 * - 입력창(input/textarea/contentEditable) 포커스 중에는 무반응.
 * - Ctrl/⌘/Alt 조합은 무시(Ctrl+K 는 AppShell 이 별도 처리). Shift 는 허용('?' 등).
 * - 핸들러 맵은 ref 로 최신을 유지 — 리스너 재등록 없이 상태를 참조할 수 있다.
 */
import { useEffect, useRef } from 'react';

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.isContentEditable;
}

/**
 * 키 → 핸들러 맵. 키 표기:
 * - 한 글자 키는 소문자로 정규화해 조회('j', 'k', 'e', 'h', 'f', '1'…'9', '?')
 * - 그 외에는 KeyboardEvent.key 그대로('Backspace', 'Escape', 'ArrowLeft' …)
 * preventDefault 는 핸들러 책임(Escape 처럼 조건부로만 소비할 키가 있음).
 */
export type KeyHandlerMap = Record<string, (e: KeyboardEvent) => void>;

export function useShortcuts(handlers: KeyHandlerMap, enabled = true): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const h = ref.current[key];
      if (h) h(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
