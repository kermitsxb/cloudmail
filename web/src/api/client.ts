import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
  bodyTruncated: boolean;
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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
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

export type ThreadsPage = { threads: ThreadSummary[]; cursor: string | null };

// Pagination par curseur, câblée jusqu'au bout : le back-end renvoie 30 conversations par
// page avec un `cursor` vers la suivante, mais tant que le front ne le renvoyait pas, seules
// les 30 conversations les plus récentes (et les 30 premiers résultats d'une recherche)
// étaient atteignables. `getNextPageParam` renvoie `cursor`, que le back-end met à null sur
// la dernière page — ce qui arrête proprement la pagination côté React Query.
export const useThreads = (folder: string, q: string) =>
  useInfiniteQuery({
    queryKey: ["threads", folder, q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<ThreadsPage>(
        `/threads?folder=${folder}` +
          (q ? `&q=${encodeURIComponent(q)}` : "") +
          (pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""),
      ),
    getNextPageParam: (last) => last.cursor,
    // Rafraîchissement silencieux : ne tourne pas onglet en arrière-plan (comportement
    // par défaut de refetchIntervalInBackground) et ne perturbe pas la pagination déjà
    // chargée — un refetch d'infinite query recharge toutes les pages obtenues, dans l'ordre.
    refetchInterval: 30_000,
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

// Miroir volontaire de ForwardRule dans src/forwarding/rules.ts, comme les types
// ci-dessus : le SPA et le Worker sont deux cibles de build distinctes.
export type ForwardRule = {
  id: number;
  matchLocal: string;
  destination: string;
  enabled: boolean;
  createdAt: number;
  lastAttemptAt: number | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
};

export type AppConfig = { mailDomain: string };

export const useConfig = () =>
  useQuery({ queryKey: ["config"], queryFn: () => api<AppConfig>("/config") });

export const useForwardRules = () =>
  useQuery({ queryKey: ["forwardRules"], queryFn: () => api<ForwardRule[]>("/forwarding/rules") });

// retry: false — un 503 « routing_unavailable » traduit une configuration
// manquante, pas un incident passager : réessayer ne changerait rien et
// retarderait l'affichage du message qui explique quoi faire.
export const useForwardDestinations = () =>
  useQuery({
    queryKey: ["forwardDestinations"],
    queryFn: () => api<{ destinations: string[] }>("/forwarding/destinations"),
    retry: false,
  });

export const useCreateForwardRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { matchLocal: string; destination: string }) =>
      api<ForwardRule>("/forwarding/rules", { method: "POST", body: JSON.stringify(vars) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["forwardRules"] }),
  });
};

export const useUpdateForwardRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; enabled: boolean }) =>
      api<{ ok: true }>(`/forwarding/rules/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: vars.enabled }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["forwardRules"] }),
  });
};

export const useDeleteForwardRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<{ ok: true }>(`/forwarding/rules/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["forwardRules"] }),
  });
};
