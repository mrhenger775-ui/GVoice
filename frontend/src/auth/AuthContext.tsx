import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import type { AuthUser } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "https://gvoice.online/api";
const ACCESS_TOKEN_KEY = "gvoice_access_token";
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

type AuthStatus = "loading" | "authenticated" | "anonymous";

type LoginPayload = {
  email: string;
  password: string;
};

type RegisterPayload = {
  email: string;
  username: string;
  password: string;
};

type RegisterConfirmPayload = {
  email: string;
  code: string;
};

type PasswordResetRequestPayload = {
  email: string;
};

type PasswordResetConfirmPayload = {
  email: string;
  code: string;
  newPassword: string;
};

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  login: (payload: LoginPayload) => Promise<void>;
  requestRegisterCode: (payload: RegisterPayload) => Promise<void>;
  confirmRegisterCode: (payload: RegisterConfirmPayload) => Promise<void>;
  requestPasswordResetCode: (payload: PasswordResetRequestPayload) => Promise<void>;
  confirmPasswordReset: (payload: PasswordResetConfirmPayload) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  authorizedFetch: (path: string, init?: RequestInit) => Promise<Response>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

function saveToken(token: string | null): void {
  if (!token) {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    return;
  }

  localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

function decodeTokenExpMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) {
      return null;
    }

    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    if (typeof payload.exp !== "number") {
      return null;
    }
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

function shouldRefreshAccessToken(token: string): boolean {
  const expMs = decodeTokenExpMs(token);
  if (!expMs) {
    return false;
  }
  return expMs - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const json = (await response.json().catch(() => null)) as T | { error?: string } | null;

  if (!response.ok) {
    const errorMessage = (json as { error?: string } | null)?.error ?? "Request failed";
    throw new Error(errorMessage);
  }

  return json as T;
}

type AuthPayload = {
  accessToken: string;
  user: AuthUser;
};

function normalizeAuthPayload(value: unknown): AuthPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Empty auth response");
  }

  const data = value as {
    accessToken?: unknown;
    user?: unknown;
  };

  if (typeof data.accessToken !== "string" || !data.accessToken) {
    throw new Error("Auth token missing in server response");
  }

  if (!data.user || typeof data.user !== "object") {
    throw new Error("User missing in server response");
  }

  return {
    accessToken: data.accessToken,
    user: data.user as AuthUser
  };
}

async function fetchMe(accessToken: string): Promise<AuthUser> {
  const response = await fetch(`${API_URL}/users/me`, {
    method: "GET",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  return parseResponse<AuthUser>(response);
}

async function refreshAccessToken(): Promise<string | null> {
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    credentials: "include"
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json().catch(() => null)) as { accessToken?: string } | null;
  if (!data || typeof data.accessToken !== "string" || !data.accessToken) {
    return null;
  }
  return data.accessToken;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);

  const refreshAccessTokenOnce = useCallback(async (): Promise<string | null> => {
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }

    const pending = (async () => {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        saveToken(refreshed);
      }
      return refreshed;
    })();

    refreshInFlightRef.current = pending;
    try {
      return await pending;
    } finally {
      refreshInFlightRef.current = null;
    }
  }, []);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const existing = readToken();
    if (existing && !shouldRefreshAccessToken(existing)) {
      return existing;
    }

    const refreshed = await refreshAccessTokenOnce();
    if (!refreshed) {
      return null;
    }

    return refreshed;
  }, [refreshAccessTokenOnce]);

  const bootstrapAuth = useCallback(async () => {
    setStatus("loading");
    setError(null);

    const existing = readToken();
    if (!existing) {
      setUser(null);
      setStatus("anonymous");
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      setUser(null);
      setStatus("anonymous");
      return;
    }

    try {
      const profile = await fetchMe(token);
      setUser(profile);
      setStatus("authenticated");
    } catch {
      saveToken(null);
      setUser(null);
      setStatus("anonymous");
    }
  }, [getAccessToken]);

  useEffect(() => {
    void bootstrapAuth();
  }, [bootstrapAuth]);

  const login = useCallback(async (payload: LoginPayload) => {
    setError(null);

    const response = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const headerToken = response.headers.get("x-gvoice-access-token");
    const raw = await parseResponse<unknown>(response);
    try {
      const data = normalizeAuthPayload(raw);
      saveToken(data.accessToken);
      setUser(data.user);
      setStatus("authenticated");
      return;
    } catch {
      if (headerToken) {
        const profile = await fetchMe(headerToken);
        saveToken(headerToken);
        setUser(profile);
        setStatus("authenticated");
        return;
      }
      // Some Android WebView builds occasionally return an empty JSON body
      // even when login succeeded and refresh cookie was set.
      const token = await refreshAccessTokenOnce();
      if (!token) {
        throw new Error("Empty auth response");
      }
      const profile = await fetchMe(token);
      saveToken(token);
      setUser(profile);
      setStatus("authenticated");
    }
  }, []);

  const requestRegisterCode = useCallback(async (payload: RegisterPayload) => {
    setError(null);

    const response = await fetch(`${API_URL}/auth/register/request-code`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    await parseResponse<null>(response);
  }, []);

  const confirmRegisterCode = useCallback(async (payload: RegisterConfirmPayload) => {
    setError(null);

    const response = await fetch(`${API_URL}/auth/register/confirm`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const raw = await parseResponse<unknown>(response);
    const data = normalizeAuthPayload(raw);
    saveToken(data.accessToken);
    setUser(data.user);
    setStatus("authenticated");
  }, []);

  const requestPasswordResetCode = useCallback(async (payload: PasswordResetRequestPayload) => {
    setError(null);

    const response = await fetch(`${API_URL}/auth/password-reset/request-code`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    await parseResponse<null>(response);
  }, []);

  const confirmPasswordReset = useCallback(async (payload: PasswordResetConfirmPayload) => {
    setError(null);

    const response = await fetch(`${API_URL}/auth/password-reset/confirm`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    await parseResponse<null>(response);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        credentials: "include"
      });
    } finally {
      saveToken(null);
      setUser(null);
      setStatus("anonymous");
      setError(null);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    setError(null);

    const token = await getAccessToken();
    if (!token) {
      setUser(null);
      setStatus("anonymous");
      return;
    }

    try {
      const profile = await fetchMe(token);
      setUser(profile);
      setStatus("authenticated");
    } catch {
      saveToken(null);
      setUser(null);
      setStatus("anonymous");
    }
  }, [getAccessToken]);

  const authorizedFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      const doFetch = async (token: string) =>
        fetch(`${API_URL}${path}`, {
          ...init,
          credentials: "include",
          headers: {
            ...(init?.headers ?? {}),
            Authorization: `Bearer ${token}`
          }
        });

      const token = await getAccessToken();
      if (!token) {
        saveToken(null);
        setUser(null);
        setStatus("anonymous");
        throw new Error("Unauthorized");
      }

      let response = await doFetch(token);
      if (response.status !== 401) {
        return response;
      }

      const refreshed = await refreshAccessTokenOnce();
      if (!refreshed) {
        saveToken(null);
        setUser(null);
        setStatus("anonymous");
        throw new Error("Unauthorized");
      }

      response = await doFetch(refreshed);

      if (response.status === 401) {
        saveToken(null);
        setUser(null);
        setStatus("anonymous");
      }

      return response;
    },
    [getAccessToken, refreshAccessTokenOnce]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      error,
      login: async (payload) => {
        try {
          await login(payload);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Login failed";
          setError(message);
          throw err;
        }
      },
      requestRegisterCode: async (payload) => {
        try {
          await requestRegisterCode(payload);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Code request failed";
          setError(message);
          throw err;
        }
      },
      confirmRegisterCode: async (payload) => {
        try {
          await confirmRegisterCode(payload);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Registration confirmation failed";
          setError(message);
          throw err;
        }
      },
      requestPasswordResetCode: async (payload) => {
        try {
          await requestPasswordResetCode(payload);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Password reset code request failed";
          setError(message);
          throw err;
        }
      },
      confirmPasswordReset: async (payload) => {
        try {
          await confirmPasswordReset(payload);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Password reset confirmation failed";
          setError(message);
          throw err;
        }
      },
      logout,
      refreshProfile: async () => {
        try {
          await refreshProfile();
        } catch (err) {
          const message = err instanceof Error ? err.message : "Profile refresh failed";
          setError(message);
          throw err;
        }
      },
      getAccessToken,
      authorizedFetch
    }),
    [
      status,
      user,
      error,
      login,
      requestRegisterCode,
      confirmRegisterCode,
      requestPasswordResetCode,
      confirmPasswordReset,
      logout,
      refreshProfile,
      getAccessToken,
      authorizedFetch
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);

  if (!ctx) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return ctx;
}
