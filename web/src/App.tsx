import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { useThreads } from "./api/client";
import { Sidebar } from "./components/Sidebar";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";

const queryClient = new QueryClient();

function Mailbox() {
  const [folder, setFolder] = useState("inbox");
  const [query, setQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);

  const { data } = useThreads(folder, query);

  const handleSelectFolder = (next: string) => {
    setFolder(next);
    setSelectedThreadId(null);
  };

  return (
    <div className="grid h-screen grid-cols-1 lg:grid-cols-[220px_360px_1fr]">
      <div className={selectedThreadId !== null ? "hidden lg:block" : "block"}>
        <Sidebar folder={folder} onSelectFolder={handleSelectFolder} />
      </div>
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
          <ThreadList threads={data?.threads ?? []} selectedId={selectedThreadId} onSelect={setSelectedThreadId} />
        </div>
      </div>
      <div className={selectedThreadId === null ? "hidden lg:flex" : "flex"}>
        {selectedThreadId === null ? (
          <p className="m-auto text-sm text-muted-foreground">Sélectionnez une conversation.</p>
        ) : (
          <ThreadView threadId={selectedThreadId} />
        )}
      </div>
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
