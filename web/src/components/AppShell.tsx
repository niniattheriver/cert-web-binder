/**
 * 앱 셸 — 상단바(시스템 표시명 · 네비 5메뉴 · 옴니박스 트리거 · 사용자/로그아웃) + 콘텐츠 영역.
 * 네비 (v1.5 Phase 1 — 설계서 §4): 인증심사 / 결과 요약 / 기준문서 / 기관 정보 / 검수 큐(미처리 배지).
 * viewer 역할에는 편집성 메뉴(검수 큐) 숨김.
 * 전역 단축키: Ctrl+K(또는 ⌘K), 입력창 밖에서의 / → 옴니박스 열기.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { fetchReviewSummary } from '../api-phase1';
import { useAuth } from '../auth';
import type { Role } from '../api';
import ChangePasswordModal from './ChangePasswordModal';
import Omnibox from './Omnibox';

function roleLabel(role: Role | undefined): string {
  switch (role) {
    case 'admin':
      return '관리자';
    case 'editor':
      return '편집';
    case 'viewer':
      return '열람';
    default:
      return '';
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

/** 메뉴별 활성 판정 — 연도 대시보드/문항 목록/상세/자유문서/가져오기는 '인증심사' 소속 */
function navActive(menu: string, pathname: string): boolean {
  switch (menu) {
    case '/':
      return (
        pathname === '/' ||
        pathname.startsWith('/y/') ||
        pathname.startsWith('/c/') ||
        pathname.startsWith('/q/') ||
        pathname.startsWith('/rich/') ||
        pathname.startsWith('/import')
      );
    default:
      return pathname === menu || pathname.startsWith(`${menu}/`);
  }
}

export default function AppShell() {
  const { user, settings, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [omniOpen, setOmniOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [reviewCount, setReviewCount] = useState(0);
  // 사용자 메뉴(사람 아이콘) 드롭다운 — 외부 클릭/Esc 로 닫힘
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  const canEdit = user?.role === 'editor' || user?.role === 'admin';

  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [userMenuOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOmniOpen(true);
        return;
      }
      // 입력창 밖에서만 / 반응
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setOmniOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 검수 큐 미처리 배지 — 경로 이동 시 + 검수 화면에서 항목 해소 시(review:changed) 갱신.
  // pathname만 의존하면 /review에 머무는 동안 해소해도 배지가 stale하게 남는다(⑩).
  useEffect(() => {
    if (!canEdit) return;
    let alive = true;
    const refresh = (): void => {
      fetchReviewSummary()
        .then((r) => {
          if (alive) setReviewCount(r.total);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('review:changed', refresh);
    return () => {
      alive = false;
      window.removeEventListener('review:changed', refresh);
    };
  }, [canEdit, pathname]);

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  };

  const menus: { to: string; label: string; badge?: number }[] = [
    { to: '/', label: '인증심사' },
    { to: '/summary', label: '결과 요약' },
    { to: '/docs', label: '지침서 업로드' },
    { to: '/org', label: '기관 정보' },
  ];
  if (canEdit) menus.push({ to: '/review', label: '확인 필요', badge: reviewCount });
  menus.push({ to: '/guide', label: '사용 안내' });

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="topbar-brand">
          {settings.systemName || '우수검사실 인증심사 웹 바인더'}
        </Link>
        <nav className="topbar-nav" aria-label="주 메뉴">
          {menus.map((m) => (
            <Link
              key={m.to}
              to={m.to}
              className={'topbar-nav-link' + (navActive(m.to, pathname) ? ' is-active' : '')}
            >
              {m.label}
              {m.badge != null && m.badge > 0 && (
                <span className="nav-badge" title={`미처리 ${m.badge}건`}>
                  {m.badge > 99 ? '99+' : m.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <button
          type="button"
          className="omni-trigger"
          onClick={() => setOmniOpen(true)}
          title="검색 (Ctrl+K 또는 /)"
        >
          <span aria-hidden="true">🔍</span>
          <span className="omni-trigger-text">번호 또는 검색어 · Ctrl+K</span>
        </button>
        {/* 사용자 메뉴 — 사람 아이콘 하나로 통합 (계정 관리·비밀번호 변경·로그아웃) */}
        <div className="user-menu" ref={userMenuRef}>
          <button
            type="button"
            className={'user-menu-btn' + (userMenuOpen ? ' is-open' : '')}
            onClick={() => setUserMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            aria-label="사용자 메뉴"
            title={`${user?.displayName ?? ''} (${roleLabel(user?.role)})`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="8" r="4" fill="currentColor" />
              <path d="M4 20c0-3.6 3.6-6 8-6s8 2.4 8 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            </svg>
          </button>
          {userMenuOpen && (
            <div className="user-menu-pop" role="menu">
              <div className="user-menu-head">
                <span className="topbar-username">{user?.displayName}</span>
                <span className="role-chip">{roleLabel(user?.role)}</span>
              </div>
              {user?.role === 'admin' && (
                <button
                  type="button"
                  className="user-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false);
                    navigate('/admin');
                  }}
                >
                  운영 점검 (백업·점검)
                </button>
              )}
              {user?.role === 'admin' && (
                <button
                  type="button"
                  className="user-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false);
                    navigate('/users');
                  }}
                >
                  사용자 계정 관리
                </button>
              )}
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  setPwOpen(true);
                }}
              >
                비밀번호 변경
              </button>
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  void handleLogout();
                }}
              >
                로그아웃
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="app-content">
        <Outlet />
      </main>
      <Omnibox open={omniOpen} onClose={() => setOmniOpen(false)} />
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  );
}
