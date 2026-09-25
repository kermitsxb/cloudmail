import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchOrphans,
  reimportInBatches,
  useParseErrors,
  type Orphan,
  type ReimportResult,
} from "../api/client";
import { useI18n } from "../i18n";
import { outcomeLabel } from "../lib/reimport";
import { Button } from "./ui/button";

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} o` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

const formatDate = (value: string | number) =>
  new Date(typeof value === "number" ? value * 1000 : value).toLocaleString("fr-FR", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Messages présents dans R2 mais absents de la base : l'analyse parcourt tout le bucket page
// par page, et une page en échec peut être reprise sans perdre les orphelins déjà trouvés.
function OrphansPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [scanned, setScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Curseur de la page à redemander après un échec (null : repartir du début).
  const [resumeCursor, setResumeCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ReimportResult>>(new Map());
  const [importing, setImporting] = useState(false);

  const scan = async (from: string | null) => {
    setScanning(true);
    setError(null);
    if (from === null) {
      setOrphans([]);
      setSelected(new Set());
      setResults(new Map());
      setScanned(false);
    }
    let cursor = from;
    try {
      do {
        const page = await fetchOrphans(cursor);
        setOrphans((prev) => [...prev, ...page.orphans]);
        cursor = page.cursor;
        setResumeCursor(cursor);
      } while (cursor !== null);
      setScanned(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setScanning(false);
    }
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const allSelected = orphans.length > 0 && selected.size === orphans.length;

  const reimportSelected = async () => {
    setImporting(true);
    setError(null);
    try {
      await reimportInBatches([...selected], (batch) =>
        setResults((prev) => {
          const next = new Map(prev);
          for (const r of batch) next.set(r.key, r);
          return next;
        }),
      );
      setSelected(new Set());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
      qc.invalidateQueries({ queryKey: ["threads"] });
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Messages orphelins</h2>
      <p className="text-sm text-muted-foreground">
        Messages conservés dans le stockage mais absents de la boîte, après un échec lors de leur réception.
      </p>
      <div className="flex gap-2">
        <Button type="button" onClick={() => scan(null)} disabled={scanning || importing}>
          {scanning ? "Analyse en cours…" : "Analyser le stockage"}
        </Button>
        {error !== null && !scanning && resumeCursor !== null && (
          <Button type="button" variant="outline" onClick={() => scan(resumeCursor)}>
            Reprendre
          </Button>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      )}

      {scanned && orphans.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucun message orphelin.</p>
      )}

      {orphans.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="Tout sélectionner"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(orphans.map((o) => o.key)))}
              />
              Tout sélectionner
            </label>
            <Button type="button" onClick={reimportSelected} disabled={selected.size === 0 || importing || scanning}>
              {importing ? "Réimport en cours…" : `Réimporter la sélection (${selected.size})`}
            </Button>
          </div>
          <ul className="flex flex-col">
            {orphans.map((o) => {
              const result = results.get(o.key);
              return (
                <li key={o.key} className="flex items-center gap-3 border-b border-border py-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Sélectionner ${o.key}`}
                    checked={selected.has(o.key)}
                    onChange={() => toggle(o.key)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">{o.key}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(o.size)} — reçu le {formatDate(o.uploaded)}
                    </p>
                  </div>
                  {result && (
                    <span className={result.outcome === "error" || result.outcome === "not_found" ? "text-xs text-destructive" : "text-xs"}>
                      {outcomeLabel(result, t)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// Messages que le parseur n'a pas compris : à réimporter après une correction du parseur.
function ParseErrorsPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data, error, isLoading } = useParseErrors();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReimportResult[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const run = async () => {
    if (!data) return;
    setRunning(true);
    setRunError(null);
    const collected: ReimportResult[] = [];
    try {
      await reimportInBatches([...new Set(data.map((m) => m.rawKey))], (batch) => {
        collected.push(...batch);
        setResults([...collected]);
      });
    } catch (err) {
      setRunError(errorMessage(err));
    } finally {
      setRunning(false);
      qc.invalidateQueries({ queryKey: ["parseErrors"] });
      qc.invalidateQueries({ queryKey: ["threads"] });
    }
  };

  const failures = results?.filter((r) => r.outcome === "error" || r.outcome === "not_found") ?? [];
  const succeeded = (results?.length ?? 0) - failures.length;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Erreurs d'analyse</h2>
      <p className="text-sm text-muted-foreground">
        Messages reçus qui n'ont pas pu être analysés. Réimportez-les après une mise à jour de Cloudmail.
      </p>

      {isLoading && <p className="text-sm text-muted-foreground">Chargement…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {data && data.length === 0 && results === null && (
        <p className="text-sm text-muted-foreground">Aucun message en erreur d'analyse.</p>
      )}

      {data && data.length > 0 && (
        <>
          <div>
            <Button type="button" onClick={run} disabled={running}>
              {running ? "Réimport en cours…" : `Tout réimporter (${data.length})`}
            </Button>
          </div>
          <ul className="flex flex-col">
            {data.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-3 border-b border-border py-2 text-sm">
                <span className="truncate">{m.subject || "(sans objet)"}</span>
                <time className="shrink-0 text-xs text-muted-foreground">{formatDate(m.receivedAt)}</time>
              </li>
            ))}
          </ul>
        </>
      )}

      {runError !== null && <p role="alert" className="text-sm text-destructive">{runError}</p>}

      {results !== null && (
        <div className="flex flex-col gap-1 text-sm">
          <p>{`${succeeded} réanalysé(s), ${failures.length} échec(s)`}</p>
          <ul className="flex flex-col gap-1 text-xs text-destructive">
            {failures.map((r) => (
              <li key={r.key}>{`${r.key} — ${outcomeLabel(r, t)}`}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function MaintenanceSettings() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-lg font-semibold">Maintenance</h1>
      <OrphansPanel />
      <ParseErrorsPanel />
    </div>
  );
}
