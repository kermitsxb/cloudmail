import type { ThreadSummary } from "../api/client";
import { useI18n } from "../i18n";

export function ThreadList({
  threads,
  selectedId,
  onSelect,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
}: {
  threads: ThreadSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const { t, formatDate } = useI18n();

  const formatWhen = (epoch: number) => {
    const d = new Date(epoch * 1000);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? formatDate(d, { hour: "2-digit", minute: "2-digit" })
      : formatDate(d, { day: "numeric", month: "short" });
  };

  if (threads.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">{t.threadList.empty}</p>;
  }

  return (
    <>
    <ul role="listbox" aria-label={t.threadList.label} className="divide-y">
      {threads.map((thread) => (
        <li
          key={thread.id}
          role="option"
          aria-selected={thread.id === selectedId}
          data-unread={thread.unreadCount > 0 ? "true" : "false"}
          tabIndex={0}
          onClick={() => onSelect(thread.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(thread.id);
            }
          }}
          className="cursor-pointer px-4 py-3 hover:bg-accent data-[unread=true]:font-semibold aria-selected:bg-accent"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm">{thread.participants.join(", ")}</span>
            <time className="shrink-0 text-xs text-muted-foreground">{formatWhen(thread.lastMessageAt)}</time>
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm">{thread.subject}</span>
            {thread.messageCount > 1 && <span className="text-xs text-muted-foreground">{thread.messageCount}</span>}
            {thread.hasAttachments && <span aria-label={t.threadList.hasAttachment}>📎</span>}
          </div>
          <p className="truncate text-xs font-normal text-muted-foreground">{thread.snippet}</p>
        </li>
      ))}
    </ul>
    {hasMore && (
      <div className="p-3 text-center">
        <button
          type="button"
          disabled={isLoadingMore}
          onClick={() => onLoadMore?.()}
          className="rounded border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          {isLoadingMore ? t.common.loading : t.threadList.loadMore}
        </button>
      </div>
    )}
    </>
  );
}
