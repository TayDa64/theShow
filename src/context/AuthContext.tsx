import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthStatus } from '../types';

type AuthContextValue = AuthStatus & {
  isLoading: boolean;
  refreshSession: () => Promise<AuthStatus>;
  authFetch: typeof fetch;
  login: (input: { email: string; password: string }) => Promise<AuthStatus>;
  register: (input: { name: string; email: string; password: string }) => Promise<AuthStatus>;
  logout: () => Promise<void>;
  linkGeminiProvider: (input: { label?: string; apiKey: string; dailyVideoLimit?: number | null }) => Promise<AuthStatus>;
  disconnectGeminiProvider: () => Promise<AuthStatus>;
  revokeSession: (sessionId: string) => Promise<AuthStatus>;
};

const GUEST_STATUS: AuthStatus = {
  isAuthenticated: false,
  user: null,
  csrfToken: null,
  provider: {
    mode: 'sandbox',
    status: 'disconnected',
    providerType: 'sandbox',
    label: 'Sandbox fallback only',
    maskedApiKey: null,
    connectedAt: null,
    dailyVideoLimit: null,
    usedToday: 0,
    remainingToday: null,
    liveVideoEnabled: false,
    sandboxFallbackEnabled: true,
    note: 'Sign in to enable secure cloud sync and authenticated generation flows.',
  },
  sessions: [],
  auditEvents: [],
  capabilities: {
    cloudSync: false,
    aiTools: false,
    liveVideo: false,
    sandboxFallback: false,
  },
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function readApiPayload(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const text = await response.text();
  return text ? { error: text } : null;
}

function normalizeAuthStatus(input: Partial<AuthStatus> | null | undefined): AuthStatus {
  if (!input) {
    return GUEST_STATUS;
  }

  return {
    isAuthenticated: !!input.isAuthenticated,
    user: input.user || null,
    csrfToken: input.csrfToken || null,
    provider: {
      ...GUEST_STATUS.provider,
      ...(input.provider || {}),
    },
    sessions: Array.isArray(input.sessions) ? input.sessions : [],
    auditEvents: Array.isArray(input.auditEvents) ? input.auditEvents : [],
    capabilities: {
      ...GUEST_STATUS.capabilities,
      ...(input.capabilities || {}),
    },
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthStatus>(GUEST_STATUS);
  const [isLoading, setIsLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    const response = await fetch('/api/auth/session', {
      credentials: 'same-origin',
    });
    const payload = await readApiPayload(response);
    const nextState = normalizeAuthStatus(payload as Partial<AuthStatus> | null | undefined);
    setAuthState(nextState);
    setIsLoading(false);
    return nextState;
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const authFetch = useCallback<typeof fetch>(async (input, init) => {
    const method = (init?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers);

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json, text/plain, */*');
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && authState.csrfToken) {
      headers.set('x-csrf-token', authState.csrfToken);
    }

    const response = await fetch(input, {
      ...init,
      headers,
      credentials: 'same-origin',
    });

    if (response.status === 401) {
      await refreshSession();
    }

    return response;
  }, [authState.csrfToken, refreshSession]);

  const submitAuthRequest = useCallback(async (url: string, init: RequestInit) => {
    const response = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });
    const payload = await readApiPayload(response);

    if (!response.ok) {
      throw new Error((payload as any)?.error || 'The request could not be completed.');
    }

    const nextState = normalizeAuthStatus(payload as Partial<AuthStatus> | null | undefined);
    setAuthState(nextState);
    setIsLoading(false);
    return nextState;
  }, []);

  const login = useCallback(async (input: { email: string; password: string }) => {
    return submitAuthRequest('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  }, [submitAuthRequest]);

  const register = useCallback(async (input: { name: string; email: string; password: string }) => {
    return submitAuthRequest('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  }, [submitAuthRequest]);

  const logout = useCallback(async () => {
    const response = await authFetch('/api/auth/logout', {
      method: 'POST',
    });

    if (!response.ok) {
      const payload = await readApiPayload(response);
      throw new Error((payload as any)?.error || 'Sign out failed.');
    }

    setAuthState(await refreshSession());
  }, [authFetch, refreshSession]);

  const linkGeminiProvider = useCallback(async (input: { label?: string; apiKey: string; dailyVideoLimit?: number | null }) => {
    const response = await authFetch('/api/auth/provider/gemini', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    const payload = await readApiPayload(response);

    if (!response.ok) {
      throw new Error((payload as any)?.error || 'Could not connect the Gemini provider.');
    }

    const nextState = normalizeAuthStatus(payload as Partial<AuthStatus> | null | undefined);
    setAuthState(nextState);
    return nextState;
  }, [authFetch]);

  const disconnectGeminiProvider = useCallback(async () => {
    const response = await authFetch('/api/auth/provider/gemini', {
      method: 'DELETE',
    });
    const payload = await readApiPayload(response);

    if (!response.ok) {
      throw new Error((payload as any)?.error || 'Could not disconnect the Gemini provider.');
    }

    const nextState = normalizeAuthStatus(payload as Partial<AuthStatus> | null | undefined);
    setAuthState(nextState);
    return nextState;
  }, [authFetch]);

  const revokeSession = useCallback(async (sessionId: string) => {
    const response = await authFetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
    });
    const payload = await readApiPayload(response);

    if (!response.ok) {
      throw new Error((payload as any)?.error || 'Could not revoke the selected session.');
    }

    const nextState = normalizeAuthStatus(payload as Partial<AuthStatus> | null | undefined);
    setAuthState(nextState);
    return nextState;
  }, [authFetch]);

  const value = useMemo<AuthContextValue>(() => ({
    ...authState,
    isLoading,
    refreshSession,
    authFetch,
    login,
    register,
    logout,
    linkGeminiProvider,
    disconnectGeminiProvider,
    revokeSession,
  }), [authState, isLoading, refreshSession, authFetch, login, register, logout, linkGeminiProvider, disconnectGeminiProvider, revokeSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }

  return context;
}