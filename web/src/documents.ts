// Visitor documents: an anonymous session id, and the upload / list / delete
// calls. The id is a random UUID minted once per browser and stored locally;
// the server scopes every uploaded chunk to it, so nothing identifying is ever
// sent and no account exists.

const SESSION_KEY = "workrights.session";
const API = import.meta.env.VITE_API_URL ?? "";

export interface UploadedDocument {
  id: string;
  name: string;
  chunks: number;
  expiresAt: string;
}

let memorySession: string | null = null;

/** Falls back to an in-memory id when storage is blocked (private mode). */
export function sessionId(): string {
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) return stored;
  } catch {
    /* fall through */
  }
  if (!memorySession) {
    memorySession = crypto.randomUUID();
    try {
      localStorage.setItem(SESSION_KEY, memorySession);
    } catch {
      /* per-tab only */
    }
  }
  return memorySession;
}

export const sessionHeaders = (): Record<string, string> => ({ "X-Session-Id": sessionId() });

async function check(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response;
}

export const listDocuments = async (): Promise<UploadedDocument[]> =>
  (await check(await fetch(`${API}/api/documents`, { headers: sessionHeaders() }))).json();

export async function uploadDocument(file: File): Promise<UploadedDocument> {
  const body = new FormData();
  body.append("file", file);
  return (await check(await fetch(`${API}/api/documents`, { method: "POST", headers: sessionHeaders(), body }))).json();
}

export async function deleteDocument(id: string): Promise<void> {
  await check(await fetch(`${API}/api/documents/${id}`, { method: "DELETE", headers: sessionHeaders() }));
}

export async function deleteAllDocuments(): Promise<void> {
  await check(await fetch(`${API}/api/documents`, { method: "DELETE", headers: sessionHeaders() }));
}
