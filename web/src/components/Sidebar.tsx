import { useState } from "react";
import { useIdentities } from "../api/client";
import { Composer } from "./Composer";
import { ComposerPanel } from "./ComposerPanel";
import { Button } from "./ui/button";

const FOLDERS: { id: string; label: string }[] = [
  { id: "inbox", label: "Boîte de réception" },
  { id: "sent", label: "Envoyés" },
  { id: "trash", label: "Corbeille" },
];

export function Sidebar({
  folder,
  onSelectFolder,
}: {
  folder: string;
  onSelectFolder: (folder: string) => void;
}) {
  const { data: identities } = useIdentities();
  const [composerOpen, setComposerOpen] = useState(false);

  return (
    <nav aria-label="Dossiers" className="flex h-full flex-col gap-6 border-r border-border p-4">
      <Button type="button" onClick={() => setComposerOpen(true)}>
        Nouveau message
      </Button>

      {composerOpen && (
        <ComposerPanel title="Nouveau message" onClose={() => setComposerOpen(false)}>
          <Composer mode="new" onClose={() => setComposerOpen(false)} />
        </ComposerPanel>
      )}

      <ul className="flex flex-col gap-1">
        {FOLDERS.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              aria-current={f.id === folder ? "true" : undefined}
              onClick={() => onSelectFolder(f.id)}
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
            >
              {f.label}
            </button>
          </li>
        ))}
      </ul>

      {identities && identities.length > 0 && (
        <div className="mt-auto">
          <h2 className="px-3 text-xs font-semibold uppercase text-muted-foreground">Identités</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {identities.map((id) => (
              <li key={id.address} className="truncate px-3 py-1 text-xs text-muted-foreground">
                {id.displayName ?? id.address}
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
