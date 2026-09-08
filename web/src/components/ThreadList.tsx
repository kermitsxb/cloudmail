import type { ThreadSummary } from "../api/client";

const formatDate = (epoch: number) => {
  const d = new Date(epoch * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};

export function ThreadList({
  threads,
  selectedId,
  onSelect,
}: {
  threads: ThreadSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  if (threads.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">Aucun message ici.</p>;
  }

  return (
    <ul role="listbox" aria-label="Conversations" className="divide-y">
      {threads.map((t) => (
        <li
          key={t.id}
          role="option"
          aria-selected={t.id === selectedId}
          data-unread={t.unreadCount > 0 ? "true" : "false"}
          tabIndex={0}
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(t.id);
            }
          }}
          className="cursor-pointer px-4 py-3 hover:bg-accent data-[unread=true]:font-semibold aria-selected:bg-accent"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm">{t.participants.join(", ")}</span>
            <time className="shrink-0 text-xs text-muted-foreground">{formatDate(t.lastMessageAt)}</time>
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm">{t.subject}</span>
            {t.messageCount > 1 && <span className="text-xs text-muted-foreground">{t.messageCount}</span>}
            {t.hasAttachments && <span aria-label="Contient une pièce jointe">📎</span>}
          </div>
          <p className="truncate text-xs font-normal text-muted-foreground">{t.snippet}</p>
        </li>
      ))}
    </ul>
  );
}
