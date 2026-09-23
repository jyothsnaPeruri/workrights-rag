import type { Source } from "./api";

export interface Turn {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  streaming?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
  updatedAt: number;
}

const KEY = "workrights.chats.v1";

// Visitors have no account, and the questions people ask here are sensitive —
// "can I be sacked while on sick leave" is not something a demo should hold on
// a server. Keeping history in localStorage means it stays on their device,
// under their control, and nothing identifiable ever reaches the backend.
//
// The cap exists because localStorage is a few megabytes and every turn carries
// its source excerpts, which are what make the citation panel work on reload.
const MAX_CONVERSATIONS = 25;

/** Storage can throw: Safari private mode, blocked cookies, disabled site data. */
function read(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is Conversation =>
        typeof c?.id === "string" && typeof c?.title === "string" && Array.isArray(c?.turns),
    );
  } catch {
    return [];
  }
}

function write(conversations: Conversation[]): void {
  // Oldest first out of the door when we run out of room. Retrying with a
  // smaller list is what keeps a long-running browser from silently failing
  // to save anything once the quota fills.
  let toSave = conversations.slice(0, MAX_CONVERSATIONS);
  while (toSave.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(toSave));
      return;
    } catch {
      toSave = toSave.slice(0, Math.floor(toSave.length / 2));
    }
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing more we can do; history is a convenience, not a requirement */
  }
}

export const history = {
  load: () => read().sort((a, b) => b.updatedAt - a.updatedAt),

  /** Inserts or replaces a conversation, keeping the list newest-first. */
  save(conversation: Conversation): Conversation[] {
    const rest = read().filter((c) => c.id !== conversation.id);
    const next = [conversation, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
    write(next);
    return next;
  },

  remove(id: string): Conversation[] {
    const next = read()
      .filter((c) => c.id !== id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    write(next);
    return next;
  },

  clear(): Conversation[] {
    write([]);
    return [];
  },
};

/** First question, trimmed to something that fits a sidebar row. */
export function titleFrom(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > 52 ? `${clean.slice(0, 52).trimEnd()}…` : clean;
}

export const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(16).slice(2)}`;
