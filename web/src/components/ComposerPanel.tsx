import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";

// Panneau de rédaction ancré en bas de l'écran, façon Gmail : contrairement au `Dialog`
// modal utilisé ailleurs dans l'app, il n'affiche pas de fond assombri et ne piège pas le
// focus — la page reste utilisable derrière pendant la rédaction.
export function ComposerPanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed bottom-0 right-6 z-50 flex w-[420px] max-w-[calc(100%-2rem)] flex-col rounded-t-xl border border-border bg-popover shadow-xl"
    >
      <div
        onClick={() => setMinimized((m) => !m)}
        className="flex shrink-0 cursor-pointer items-center justify-between rounded-t-xl border-b border-border bg-muted/50 px-4 py-2"
      >
        <span className="text-sm font-medium">{title}</span>
        <span className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation();
              setMinimized((m) => !m);
            }}
            aria-label={minimized ? "Agrandir" : "Réduire"}
          >
            {minimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="Fermer"
          >
            <XIcon />
          </Button>
        </span>
      </div>
      {/* `hidden` plutôt qu'un démontage conditionnel : le formulaire (Composer) doit rester
          monté pendant la réduction pour ne pas perdre la saisie en cours. */}
      <div hidden={minimized} className="max-h-[70vh] overflow-y-auto p-4">
        {children}
      </div>
    </div>
  );
}
