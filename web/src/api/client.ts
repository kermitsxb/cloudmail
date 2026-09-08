import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

// Ces types sont des miroirs volontaires de src/db/queries.ts (cible de build distincte
// du Worker) : toute évolution des formes de réponse côté back doit être répercutée ici
// champ par champ.
export type ThreadSummary = {
  id: number;
  subject: string;
  snippet: string;
  lastMessageAt: number;
  messageCount: number;
  unreadCount: number;
  participants: string[];
  hasAttachments: boolean;
};

export type MessageDetail = {
  id: number;
  messageId: string;
  direction: "in" | "out";
  folder: string;
  from: { address: string; name: string | null };
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  subject: string;
  text: string;
  html: string | null;
  receivedAt: number;
  isRead: boolean;
  parseError: boolean;
  attachments: { id: number; filename: string; mimeType: string; size: number }[];
};

export type ThreadDetail = { id: number; subject: string; messages: MessageDetail[] };

export type Identity = { address: string; displayName: string | null; isDefault: boolean };

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message: string } } | null;
    throw new ApiError(body?.error?.message ?? `Erreur ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export const useThreads = (folder: string, q: string) =>
  useQuery({
    queryKey: ["threads", folder, q],
    queryFn: () =>
      api<{ threads: ThreadSummary[]; cursor: string | null }>(
        `/threads?folder=${folder}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      ),
  });

export const useThread = (id: number | null) =>
  useQuery({
    queryKey: ["thread", id],
    queryFn: () => api<ThreadDetail>(`/threads/${id}`),
    enabled: id !== null,
  });

export const useIdentities = () =>
  useQuery({ queryKey: ["identities"], queryFn: () => api<Identity[]>("/identities") });

export type SendMessageRequest = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  attachments?: { filename: string; mimeType: string; contentBase64: string }[];
};

export type SendMessageResult = {
  id: number;
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
};

export const useSendMessage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: SendMessageRequest) =>
      api<SendMessageResult>("/messages", { method: "POST", body: JSON.stringify(vars) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      qc.invalidateQueries({ queryKey: ["thread"] });
    },
  });
};

export const useUpdateMessage = () => {
  const qc = useQueryClient();
  return useMutation({
    // La restauration depuis la corbeille dépend de la direction du message : le
    // dossier cible envoyé doit être "sent" pour un message direction === "out",
    // "inbox" sinon — jamais un retour figé vers "inbox". L'API accepte les trois
    // dossiers ("inbox" | "sent" | "trash").
    mutationFn: (vars: { id: number; isRead?: boolean; folder?: "inbox" | "sent" | "trash" }) =>
      api<{ ok: true }>(`/messages/${vars.id}`, { method: "PATCH", body: JSON.stringify(vars) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      qc.invalidateQueries({ queryKey: ["thread"] });
    },
  });
};
