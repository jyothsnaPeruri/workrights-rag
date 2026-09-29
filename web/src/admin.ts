// Admin session handling.
//
// Visitors never see any of this. The only thing an admin token unlocks is the
// model-provider switch — there is deliberately no visitor sign-up, because a
// login wall on a public demo costs you almost every visitor.

const TOKEN_KEY = "workrights.admin.token";

export interface Provider {
  name: string;
  label: string;
  chatModel: string;
}

export interface ProviderState {
  default: string;
  admin: boolean;
  adminAvailable: boolean;
  providers: Provider[];
  defaultMode?: "agent" | "direct";
  modes?: Array<"agent" | "direct">;
}

const API = import.meta.env.VITE_API_URL ?? "";

/** Storage throws in private mode and with site data blocked. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* the session just won't survive a reload */
  }
}

export const authHeaders = (): Record<string, string> => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/**
 * Asks the server what this client may offer. A stored token that has expired
 * comes back as admin:false, which is how the UI knows to drop it.
 */
export async function loadProviderState(): Promise<ProviderState> {
  const response = await fetch(`${API}/api/providers`, { headers: authHeaders() });
  if (!response.ok) throw new Error("Could not read provider settings.");
  const state: ProviderState = await response.json();
  if (!state.admin && getToken()) setToken(null);
  return state;
}

export async function adminLogin(username: string, password: string): Promise<ProviderState> {
  const response = await fetch(`${API}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Sign-in failed (${response.status})`);

  setToken(body.token);
  // Login returns providers but not modes; refetch the full state so the UI has both.
  return loadProviderState();
}

export interface UsageTotals {
  visits: number;
  questions: number;
  uploads: number;
}

export interface UsageStats {
  today: UsageTotals;
  last7: UsageTotals;
  all: UsageTotals;
  days: Array<{ day: string } & UsageTotals & { questions: number }>;
}

/** Admin only; the server answers 403 without a valid token. */
export async function loadStats(): Promise<UsageStats> {
  const response = await fetch(`${API}/api/stats`, { headers: authHeaders() });
  if (!response.ok) throw new Error("Couldn't load stats.");
  return response.json();
}
