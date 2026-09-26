import { useConfig } from "../api/client";
import { useI18n } from "../i18n";

// Rappel en tête de la corbeille et du dossier Spam : leur contenu est purgé par la
// maintenance planifiée. Masqué quand la purge est désactivée (trashRetentionDays null).
export function TrashNotice({ folder }: { folder: "trash" | "spam" }) {
  const { t } = useI18n();
  const { data } = useConfig();
  const days = data?.trashRetentionDays;
  if (!days) return null;
  const text = folder === "spam" ? t.threadList.spamNotice(days) : t.threadList.trashNotice(days);
  return <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{text}</p>;
}
