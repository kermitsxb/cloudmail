import { useEffect, useRef, useState } from "react";
import { useThread, useUpdateMessage, type MessageDetail } from "../api/client";
import { Composer } from "./Composer";
import { MessageBody } from "./MessageBody";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

const formatDate = (epoch: number) =>
  new Date(epoch * 1000).toLocaleString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const formatRecipient = (r: { address: string; name: string | null }) => r.name ?? r.address;

function MessageHeader({ message }: { message: MessageDetail }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{formatRecipient(message.from)}</span>
        <time className="shrink-0 text-xs text-muted-foreground">{formatDate(message.receivedAt)}</time>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        À : {message.to.map(formatRecipient).join(", ")}
        {message.cc.length > 0 && <> — Cc : {message.cc.map(formatRecipient).join(", ")}</>}
      </p>
    </div>
  );
}

function MessageItem({
  message,
  open,
  onToggle,
  onReply,
}: {
  message: MessageDetail;
  open: boolean;
  onToggle: () => void;
  onReply: () => void;
}) {
  const updateMessage = useUpdateMessage();

  return (
    <li className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-2 px-4 py-3 text-left hover:bg-accent"
      >
        <MessageHeader message={message} />
      </button>

      {open && (
        <div>
          {message.parseError && (
            <div className="flex items-center justify-between gap-4 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
              <span>Ce message n'a pas pu être analysé correctement.</span>
              <a className="underline" href={`/api/messages/${message.id}/raw`}>
                Voir le message brut
              </a>
            </div>
          )}

          <MessageBody messageId={message.id} />

          {message.attachments.length > 0 && (
            <ul className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
              {message.attachments.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/api/attachments/${a.id}`}
                    download
                    className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                  >
                    📎 {a.filename}
                  </a>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2 border-t border-border px-4 py-2">
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={onReply}
            >
              Répondre
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => updateMessage.mutate({ id: message.id, isRead: false })}
            >
              Marquer comme non lu
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => updateMessage.mutate({ id: message.id, folder: "trash" })}
            >
              Supprimer
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function ThreadView({ threadId }: { threadId: number }) {
  const { data: thread } = useThread(threadId);
  const [openId, setOpenId] = useState<number | null>(null);
  const [replyingTo, setReplyingTo] = useState<MessageDetail | null>(null);
  const updateMessage = useUpdateMessage();
  const markedThreadId = useRef<number | null>(null);

  useEffect(() => {
    if (!thread || markedThreadId.current === thread.id) return;
    markedThreadId.current = thread.id;
    const unread = thread.messages.filter((m) => !m.isRead);
    for (const m of unread) {
      updateMessage.mutate({ id: m.id, isRead: true });
    }
    // Ne dépend que du thread chargé : on marque une seule fois par ouverture de
    // conversation, sans réagir aux mutations qu'on déclenche nous-mêmes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread]);

  useEffect(() => {
    if (thread && thread.messages.length > 0) {
      setOpenId(thread.messages[thread.messages.length - 1].id);
    }
    // Ne dépend que de l'identifiant du thread : on ne veut réinitialiser le message
    // déplié qu'à l'ouverture d'une nouvelle conversation, pas à chaque refetch (ex.
    // après le marquage "lu" ci-dessus) qui recréerait le même thread.messages.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  if (!thread) {
    return <p className="m-auto text-sm text-muted-foreground">Chargement…</p>;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-lg font-semibold">{thread.subject || "(sans objet)"}</h1>
        <p className="text-xs text-muted-foreground">
          {thread.messages.length} message{thread.messages.length > 1 ? "s" : ""}
        </p>
      </div>
      <ul>
        {thread.messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            open={openId === m.id}
            onToggle={() => setOpenId(openId === m.id ? null : m.id)}
            onReply={() => setReplyingTo(m)}
          />
        ))}
      </ul>

      <Dialog open={replyingTo !== null} onOpenChange={(open) => !open && setReplyingTo(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Répondre</DialogTitle>
          </DialogHeader>
          {replyingTo && (
            <Composer mode="reply" replyTo={replyingTo} onClose={() => setReplyingTo(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
