import { useEffect, useRef, useState } from "react";
import { useReimportMessage, useThread, useUpdateMessage, type MessageDetail } from "../api/client";
import { useI18n } from "../i18n";
import { errorText } from "../lib/errors";
import { outcomeLabel } from "../lib/reimport";
import { Composer } from "./Composer";
import { MessageBody } from "./MessageBody";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

type Mailbox = { address: string; name: string | null };

// Le nom seul sur un message replié, l'adresse au survol ; déplié, l'adresse est
// aussi écrite en toutes lettres pour qui ne peut pas survoler (écran tactile).
function Address({ mailbox, showAddress }: { mailbox: Mailbox; showAddress: boolean }) {
  if (!mailbox.name) return <span>{mailbox.address}</span>;
  return (
    <>
      <span title={mailbox.address}>{mailbox.name}</span>
      {showAddress && (
        <span className="font-normal text-muted-foreground"> {`<${mailbox.address}>`}</span>
      )}
    </>
  );
}

function AddressList({ mailboxes, showAddress }: { mailboxes: Mailbox[]; showAddress: boolean }) {
  return mailboxes.map((m, i) => (
    <span key={`${i}-${m.address}`}>
      {i > 0 && ", "}
      <Address mailbox={m} showAddress={showAddress} />
    </span>
  ));
}

function MessageHeader({ message, open }: { message: MessageDetail; open: boolean }) {
  const { t, formatDate } = useI18n();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words font-semibold">
          <Address mailbox={message.from} showAddress={open} />
        </span>
        <time className="shrink-0 text-xs text-muted-foreground">
          {formatDate(new Date(message.receivedAt * 1000), {
            day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
          })}
        </time>
      </div>
      <p className={`text-xs text-muted-foreground ${open ? "break-words" : "truncate"}`}>
        {t.threadView.to} <AddressList mailboxes={message.to} showAddress={open} />
        {message.cc.length > 0 && (
          <>
            {` — ${t.threadView.cc} `}
            <AddressList mailboxes={message.cc} showAddress={open} />
          </>
        )}
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
  const { t } = useI18n();
  const updateMessage = useUpdateMessage();
  const reimport = useReimportMessage();

  return (
    <li className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-2 px-4 py-3 text-left hover:bg-accent"
      >
        <MessageHeader message={message} open={open} />
      </button>

      {open && (
        <div>
          {message.parseError && (
            <div className="flex items-center justify-between gap-4 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
              <span>{t.threadView.parseError}</span>
              <a className="underline" href={`/api/messages/${message.id}/raw`}>
                {t.threadView.viewRaw}
              </a>
            </div>
          )}

          {message.bodyTruncated && (
            <div className="flex items-center justify-between gap-4 border-b bg-muted px-4 py-2 text-sm">
              <span>{t.threadView.bodyTruncated}</span>
              <a className="underline" href={`/api/messages/${message.id}/raw`}>
                {t.threadView.viewRaw}
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
              {t.threadView.reply}
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => updateMessage.mutate({ id: message.id, isRead: false })}
            >
              {t.threadView.markUnread}
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => updateMessage.mutate({ id: message.id, folder: "trash" })}
            >
              {t.common.delete}
            </button>
            {/* Un message envoyé n'a pas de brut dans R2 (clé sent/…) : rien à réimporter. */}
            {message.direction === "in" && (
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                disabled={reimport.isPending}
                onClick={() => reimport.mutate(message.rawKey)}
              >
                {reimport.isPending ? t.threadView.reimporting : t.threadView.reimport}
              </button>
            )}
          </div>
          {reimport.isError && (
            <p role="alert" className="px-4 pb-2 text-xs text-destructive">
              {t.threadView.reimportFailed(errorText(reimport.error, t))}
            </p>
          )}
          {reimport.data && reimport.data.outcome !== "reparsed" && reimport.data.outcome !== "imported" && (
            <p role="status" className="px-4 pb-2 text-xs text-destructive">
              {outcomeLabel(reimport.data, t)}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function ThreadView({ threadId }: { threadId: number }) {
  const { t } = useI18n();
  const { data: thread, error, isLoading } = useThread(threadId);
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

  // Une requête en échec ne doit pas être indiscernable d'un chargement : sans cette
  // branche, un 500 ou un 401 laisse le panneau sur « Chargement… » indéfiniment.
  if (error) {
    return (
      <p role="alert" className="m-auto max-w-sm text-sm text-destructive">
        {t.threadView.openFailed(errorText(error, t))}
      </p>
    );
  }

  if (isLoading || !thread) {
    return <p className="m-auto text-sm text-muted-foreground">{t.common.loading}</p>;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-lg font-semibold">{thread.subject || t.common.noSubject}</h1>
        <p className="text-xs text-muted-foreground">
          {t.threadView.messageCount(thread.messages.length)}
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
        <DialogContent className="sm:max-w-lg" closeLabel={t.common.close}>
          <DialogHeader>
            <DialogTitle>{t.threadView.reply}</DialogTitle>
          </DialogHeader>
          {replyingTo && (
            <Composer mode="reply" replyTo={replyingTo} onClose={() => setReplyingTo(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
