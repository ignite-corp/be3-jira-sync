'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';

export interface AppUser {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  sourceProject: string | null; // 팀의 기준 프로젝트 키 (예: 'BE3')
  igniteAccountId: string;
  igniteJiraEmail: string;
  igniteJiraApiToken: string;
  hmgAccountId: string;
  hmgJiraEmail: string;
  hmgJiraApiToken: string;
  hmgUserId: string;
  hChatApiKey: string;
  gitlabToken: string;
}

interface UserContextValue {
  currentUser: AppUser | null;
  setCurrentUser: (user: AppUser | null) => void;
  clearUser: () => void;
  refreshUser: () => Promise<void>;
}

const UserContext = createContext<UserContextValue | null>(null);

const STORAGE_KEY = 'ignite-current-user';

export function UserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUserState] = useState<AppUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  // API에서 최신 사용자 데이터 가져와 갱신
  const refreshUser = useCallback(async () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;

    let storedUser: AppUser;
    try {
      storedUser = JSON.parse(stored);
    } catch {
      return;
    }

    try {
      const res = await fetch('/api/users');
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        const fresh = json.data.find((u: AppUser) => u.id === storedUser.id);
        if (fresh) {
          setCurrentUserState(fresh);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        }
      }
    } catch {
      // 네트워크 오류 시 캐시된 데이터 유지
    }
  }, []);

  // localStorage에서 복원 후 API에서 최신 정보로 갱신 (완료 후 렌더)
  useEffect(() => {
    const init = async () => {
      // 1. localStorage에서 즉시 복원
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          setCurrentUserState(JSON.parse(stored));
        }
      } catch {
        // ignore
      }

      // 2. API에서 최신 데이터로 갱신 (완료될 때까지 대기)
      await refreshUser();

      // 3. 모든 데이터 준비 후 렌더 허용
      setLoaded(true);
    };

    init();
  }, [refreshUser]);

  const setCurrentUser = (user: AppUser | null) => {
    setCurrentUserState(user);
    if (user) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const clearUser = () => {
    setCurrentUserState(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  if (!loaded) return null;

  return (
    <UserContext.Provider value={{ currentUser, setCurrentUser, clearUser, refreshUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useCurrentUser() {
  const ctx = useContext(UserContext);
  if (!ctx) {
    throw new Error('useCurrentUser must be used within UserProvider');
  }
  return ctx;
}
