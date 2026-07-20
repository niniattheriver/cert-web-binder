/**
 * 인증 컨텍스트 + 라우트 가드 (설계서 §5)
 * - 최초 마운트 시 GET /api/me 로 세션 복원(쿠키 기반).
 * - settings(systemName/orgName)는 비로그인 상태에서도 내려오므로 함께 보관.
 * - RequireAuth: 미로그인 시 /login 으로 이동(원래 경로는 state.from 으로 보존).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { apiLogin, apiLogout, fetchMe, type AppSettings, type User } from './api';

const DEFAULT_SETTINGS: AppSettings = { orgName: '', systemName: '우수검사실 인증심사 웹 바인더' };

interface AuthContextValue {
  user: User | null;
  settings: AppSettings;
  /** 세션 복원(GET /api/me) 진행 중 여부 */
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  // 세션 복원 — 실패(서버 미기동 등)해도 로그인 화면에서 다시 시도 가능
  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((me) => {
        if (!alive) return;
        setUser(me.user);
        if (me.settings) setSettings(me.settings);
      })
      .catch(() => {
        /* 무시 — 로그인 시도 시 오류 메시지로 안내 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 시스템 표시명을 브라우저 탭 제목에 반영
  useEffect(() => {
    if (settings.systemName) document.title = settings.systemName;
  }, [settings.systemName]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiLogin(username, password);
    setUser(res.user);
    // 설정 최신화(기관명 등) — 실패해도 무해
    fetchMe()
      .then((me) => {
        if (me.settings) setSettings(me.settings);
      })
      .catch(() => {});
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, settings, loading, login, logout }),
    [user, settings, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 는 AuthProvider 내부에서만 사용할 수 있습니다.');
  return ctx;
}

/** 로그인 필수 구간 가드 — 하위 라우트는 <Outlet/> 으로 렌더 */
export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="page-status">세션 확인 중…</div>;
  }
  if (!user) {
    return (
      <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
    );
  }
  return <Outlet />;
}
