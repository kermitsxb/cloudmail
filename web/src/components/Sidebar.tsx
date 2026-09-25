import { useState } from "react";
import { useIdentities } from "../api/client";
import logo from "../assets/cloudmail-logo.png";
import { useI18n } from "../i18n";
import { Composer } from "./Composer";
import { ComposerPanel } from "./ComposerPanel";
import { LocaleSelect } from "./LocaleSelect";
import { Button } from "./ui/button";

const FOLDERS = ["inbox", "sent", "trash"] as const;

export function Sidebar({
  folder,
  onSelectFolder,
  view,
  onSelectView,
}: {
  folder: string;
  onSelectFolder: (folder: string) => void;
  view: "mail" | "forwarding" | "identities" | "maintenance";
  onSelectView: (view: "mail" | "forwarding" | "identities" | "maintenance") => void;
}) {
  const { t } = useI18n();
  const { data: identities } = useIdentities();
  const [composerOpen, setComposerOpen] = useState(false);

  return (
    <nav aria-label={t.sidebar.nav} className="flex h-full flex-col gap-6 border-r border-border p-4">
      <div className="flex items-center gap-2 px-1">
        <img src={logo} alt="" className="h-6 w-6" />
        <span className="text-sm font-semibold">Cloudmail</span>
      </div>

      <Button type="button" onClick={() => setComposerOpen(true)}>
        {t.sidebar.compose}
      </Button>

      {composerOpen && (
        <ComposerPanel title={t.sidebar.compose} onClose={() => setComposerOpen(false)}>
          <Composer mode="new" onClose={() => setComposerOpen(false)} />
        </ComposerPanel>
      )}

      <ul className="flex flex-col gap-1">
        {FOLDERS.map((id) => (
          <li key={id}>
            <button
              type="button"
              aria-current={view === "mail" && id === folder ? "true" : undefined}
              onClick={() => { onSelectView("mail"); onSelectFolder(id); }}
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
            >
              {t.sidebar[id]}
            </button>
          </li>
        ))}
      </ul>

      <ul className="flex flex-col gap-1">
        <li>
          <button
            type="button"
            aria-current={view === "identities" ? "true" : undefined}
            onClick={() => onSelectView("identities")}
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
          >
            {t.sidebar.identities}
          </button>
        </li>
        <li>
          <button
            type="button"
            aria-current={view === "forwarding" ? "true" : undefined}
            onClick={() => onSelectView("forwarding")}
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
          >
            {t.sidebar.forwarding}
          </button>
        </li>
        <li>
          <button
            type="button"
            aria-current={view === "maintenance" ? "true" : undefined}
            onClick={() => onSelectView("maintenance")}
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
          >
            {t.sidebar.maintenance}
          </button>
        </li>
      </ul>

      <div className="mt-auto flex flex-col gap-4">
        {identities && identities.length > 0 && (
          <div>
            <h2 className="px-3 text-xs font-semibold uppercase text-muted-foreground">{t.sidebar.identities}</h2>
            <ul className="mt-2 flex flex-col gap-1">
              {identities.map((id) => (
                <li key={id.address} className="truncate px-3 py-1 text-xs text-muted-foreground">
                  {id.displayName ?? id.address}
                </li>
              ))}
            </ul>
          </div>
        )}
        <LocaleSelect />
      </div>
    </nav>
  );
}
