import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { useThreads } from "./api/client";
import { ForwardingSettings } from "./components/ForwardingSettings";
import { Sidebar } from "./components/Sidebar";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";

const queryClient = new QueryClient();

function Mailbox() {
  const [folder, setFolder] = useState("inbox");
  const [query, setQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [view, setView] = useState<"mail" | "forwarding">("mail");

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useThreads(folder, query);
  const threads = data?.pages.flatMap((p) => p.threads) ?? [];

  const handleSelectFolder = (next: string) => {
    setFolder(next);
    setSelectedThreadId(null);
  };

  return (
    <div className="grid h-screen grid-cols-1 lg:grid-cols-[220px_360px_1fr]">
      <div className={selectedThreadId !== null ? "hidden lg:block" : "block"}>
        <Sidebar folder={folder} onSelectFolder={handleSelectFolder} view={view} onSelectView={setView} />
      </div>
      {view === "forwarding" ? (
        <div className="col-span-1 overflow-y-auto lg:col-span-2">
          <ForwardingSettings />
        </div>
      ) : (
        <>
          <div className={`flex flex-col border-r border-border ${selectedThreadId !== null ? "hidden lg:flex" : "flex"}`}>
            <div className="border-b border-border p-3">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher…"
                aria-label="Rechercher dans les conversations"
                className="w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground"
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              <ThreadList
                threads={threads}
                selectedId={selectedThreadId}
                onSelect={setSelectedThreadId}
                hasMore={hasNextPage}
                isLoadingMore={isFetchingNextPage}
                onLoadMore={() => fetchNextPage()}
              />
            </div>
          </div>
          {/* flex-col : en flex-row, ThreadView se dimensionnerait sur son contenu au lieu
              d'occuper toute la colonne. min-w-0 laisse le contenu large (iframe, sujet long)
              rétrécir plutôt que d'élargir la piste de grille. */}
          <div
            className={`min-w-0 flex-col ${selectedThreadId === null ? "hidden lg:flex" : "flex"}`}
          >
            {selectedThreadId === null ? (
              <p className="m-auto text-sm text-muted-foreground">Sélectionnez une conversation.</p>
            ) : (
              <ThreadView threadId={selectedThreadId} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Mailbox />
    </QueryClientProvider>
  );
}
