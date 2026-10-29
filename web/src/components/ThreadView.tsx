import { useEffect, useRef, useState } from "react";
import { useDeleteMessage, useReimportMessage, useThread, useUpdateMessage, type MessageDetail } from "../api/client";
import { useI18n } from "../i18n";
import { errorText } from "../lib/errors";
import { outcomeLabel } from "../lib/reimport";
import { Composer } from "./Composer";
import { MessageBody } from "./MessageBody";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

type Mailbox = { address: string; name: string | null };

// Le nom suivi de l'adresse, sur chaque message : le nom seul ne dit pas à
// quelle adresse le message a été envoyé. Replié, la ligne est tronquée et
// l'adresse reste lisible au survol du nom.
function Address({ mailbox }: { mailbox: Mailbox }) {
  if (!mailbox.name) return <span>{mailbox.address}</span>;
  return (
    <>
      <span title={mailbox.address}>{mailbox.name}</span>
      <span className="font-normal text-muted-foreground"> {`<${mailbox.address}>`}</span>
    </>
  );
}

function AddressList({ mailboxes }: { mailboxes: Mailbox[] }) {
  return mailboxes.map((m, i) => (
    <span key={`${i}-${m.address}`}>
      {i > 0 && ", "}
      <Address mailbox={m} />
    </span>
  ));
}

function MessageHeader({ message, open }: { message: MessageDetail; open: boolean }) {
  const { t, formatDate } = useI18n();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words font-semibold">
          <Address mailbox={message.from} />
        </span>
        <time className="shrink-0 text-xs text-muted-foreground">
          {formatDate(new Date(message.receivedAt * 1000), {
            day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
          })}
        </time>
      </div>
      <p className={`text-xs text-muted-foreground ${open ? "break-words" : "truncate"}`}>
        {t.threadView.to} <AddressList mailboxes={message.to} />
        {message.cc.length > 0 && (
          <>
            {` — ${t.threadView.cc} `}
            <AddressList mailboxes={message.cc} />
          </>
        )}
      </p>
    </div>
  );
}

function MessageItem({
  message,
  threadId,
  open,
  inTrash,
  isLastVisible,
  onToggle,
  onReply,
  onClose,
}: {
  message: MessageDetail;
  threadId: number;
  open: boolean;
  inTrash: boolean;
  isLastVisible: boolean;
  onToggle: () => void;
  onReply: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const updateMessage = useUpdateMessage();
  // Instance distincte pour les déplacements : l'erreur d'un déplacement ne doit pas
  // se mêler à celle du marquage « non lu ».
  const moveMessage = useUpdateMessage();
  const deleteMessage = useDeleteMessage();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // La conversation ne se ferme qu'après un succès, et seulement si c'était le dernier
  // message visible : sinon elle resterait vide (ou 404 après une purge).
  const afterSuccess = () => {
    if (isLastVisible) onClose();
  };
  const move = (folder: "inbox" | "sent" | "trash") =>
    moveMessage.mutate({ id: message.id, folder }, { onSuccess: afterSuccess });
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
            {inTrash ? (
              <>
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                  onClick={() => move(message.direction === "out" ? "sent" : "inbox")}
                >
                  {t.threadView.restore}
                </button>
                {confirmingDelete ? (
                  <>
                    <span className="self-center text-xs text-destructive">
                      {t.threadView.deletePermanentlyConfirm}
                    </span>
                    <button
                      type="button"
                      className="rounded border border-destructive px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      disabled={deleteMessage.isPending}
                      onClick={() => deleteMessage.mutate(
                          { id: message.id, threadId, threadEmptied: isLastVisible },
                          { onSuccess: afterSuccess },
                        )}
                    >
                      {t.threadView.confirm}
                    </button>
                    <button
                      type="button"
                      className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      {t.common.cancel}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    {t.threadView.deletePermanently}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                onClick={() => move("trash")}
              >
                {t.common.delete}
              </button>
            )}
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
          {moveMessage.isError && (
            <p role="alert" className="px-4 pb-2 text-xs text-destructive">
              {inTrash
                ? t.threadView.restoreFailed(errorText(moveMessage.error, t))
                : t.common.deleteFailed(errorText(moveMessage.error, t))}
            </p>
          )}
          {deleteMessage.isError && (
            <p role="alert" className="px-4 pb-2 text-xs text-destructive">
              {t.common.deleteFailed(errorText(deleteMessage.error, t))}
            </p>
          )}
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

export function ThreadView({
  threadId,
  folder,
  onClose,
}: {
  threadId: number;
  folder: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { data: thread, error, isLoading } = useThread(threadId);
  const [openId, setOpenId] = useState<number | null>(null);
  const [replyingTo, setReplyingTo] = useState<MessageDetail | null>(null);
  const updateMessage = useUpdateMessage();
  const markedThreadId = useRef<number | null>(null);

  // GET /api/threads/:id renvoie aussi les messages en corbeille : la corbeille
  // n'affiche que ceux-là, les autres dossiers ne les montrent pas.
  const inTrash = folder === "trash";
  const visibleMessages = (thread?.messages ?? []).filter((m) => (m.folder === "trash") === inTrash);

  // Si le message déplié a quitté la liste visible (corbeille, restauration, purge) alors
  // qu'il en reste d'autres, on retombe sur le dernier au lieu de tout replier.
  const lastVisibleId = visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1].id : null;
  const effectiveOpenId =
    openId !== null && !visibleMessages.some((m) => m.id === openId) ? lastVisibleId : openId;

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
    if (visibleMessages.length > 0) {
      setOpenId(visibleMessages[visibleMessages.length - 1].id);
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
          {t.threadView.messageCount(visibleMessages.length)}
        </p>
      </div>
      <ul>
        {visibleMessages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            threadId={threadId}
            open={effectiveOpenId === m.id}
            inTrash={inTrash}
            isLastVisible={visibleMessages.length === 1}
            onClose={onClose}
            onToggle={() => setOpenId(effectiveOpenId === m.id ? null : m.id)}
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
