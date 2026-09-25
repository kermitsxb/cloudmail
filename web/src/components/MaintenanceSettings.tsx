import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchOrphans,
  reimportInBatches,
  useMaintenance,
  useOrphanCheck,
  useParseErrors,
  type MaintenanceRun,
  type Orphan,
  type ReimportResult,
} from "../api/client";
import { useI18n } from "../i18n";
import type { Catalog } from "../i18n/fr";
import { errorText } from "../lib/errors";
import { outcomeLabel } from "../lib/reimport";
import { Button } from "./ui/button";

const formatSize = (bytes: number, u: Catalog["maintenance"]["size"]) =>
  bytes < 1024
    ? `${bytes} ${u.bytes}`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} ${u.kilobytes}`
      : `${(bytes / 1024 / 1024).toFixed(1)} ${u.megabytes}`;

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
};
const toDate = (value: string | number) => new Date(typeof value === "number" ? value * 1000 : value);

const orphansLine = (run: MaintenanceRun, s: Catalog["maintenance"]["scheduled"]) => {
  const count = run.orphansCount ?? 0;
  if (run.orphansComplete === false) return s.orphansPartial(count);
  return count === 0 ? s.orphansNone : s.orphansFound(count);
};

// Résultat du passage nocturne (purge de la corbeille) et de la dernière vérification des
// orphelins, planifiée ou relancée ici. La purge n'est jamais déclenchable depuis l'interface.
function ScheduledPanel() {
  const { t, formatDate } = useI18n();
  const s = t.maintenance.scheduled;
  const { data, error, isLoading } = useMaintenance();
  const check = useOrphanCheck();
  const lastRun = data?.lastRun ?? null;
  const lastCheck = data?.lastCheck ?? null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{s.title}</h2>
      <p className="text-sm text-muted-foreground">{s.intro}</p>

      {isLoading && <p className="text-sm text-muted-foreground">{t.common.loading}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{errorText(error, t)}</p>}

      {data && (
        <>
          <p className="text-sm">{data.retentionDays ? s.retention(data.retentionDays) : s.retentionDisabled}</p>

          {lastRun === null ? (
            <p className="text-sm text-muted-foreground">{s.neverRun}</p>
          ) : (
            <div className="flex flex-col gap-1 text-sm">
              <p>{s.lastRun(formatDate(toDate(lastRun.ranAt), DATE_OPTIONS))}</p>
              {lastRun.trashPurged !== null && <p>{s.purged(lastRun.trashPurged)}</p>}
              {!!lastRun.trashFailed && <p className="text-destructive">{s.purgeFailed(lastRun.trashFailed)}</p>}
              {!!lastRun.trashRemaining && <p>{s.purgeRemaining(lastRun.trashRemaining)}</p>}
              {lastRun.error && <p className="text-destructive">{s.runFailed(lastRun.error)}</p>}
            </div>
          )}

          {lastCheck === null ? (
            <p className="text-sm text-muted-foreground">{s.neverChecked}</p>
          ) : (
            <p className="text-sm">
              {`${orphansLine(lastCheck, s)} — ${s.checkedAt(formatDate(toDate(lastCheck.ranAt), DATE_OPTIONS))}`}
            </p>
          )}

          <div>
            <Button type="button" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? s.rechecking : s.recheck}
            </Button>
          </div>
          {check.error && <p role="alert" className="text-sm text-destructive">{errorText(check.error, t)}</p>}
        </>
      )}
    </section>
  );
}

// Messages présents dans R2 mais absents de la base : l'analyse parcourt tout le bucket page
// par page, et une page en échec peut être reprise sans perdre les orphelins déjà trouvés.
function OrphansPanel() {
  const { t, formatDate } = useI18n();
  const qc = useQueryClient();
  const recheck = useOrphanCheck();
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [scanned, setScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Curseur de la page à redemander après un échec (null : repartir du début).
  const [resumeCursor, setResumeCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
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
      setError(err);
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
    let imported = false;
    try {
      await reimportInBatches([...selected], (batch) => {
        if (batch.some((r) => r.outcome === "imported")) imported = true;
        setResults((prev) => {
          const next = new Map(prev);
          for (const r of batch) next.set(r.key, r);
          return next;
        });
      });
      setSelected(new Set());
    } catch (err) {
      setError(err);
    } finally {
      setImporting(false);
      qc.invalidateQueries({ queryKey: ["threads"] });
      // Le compte d'orphelins affiché (et le badge) serait sinon périmé jusqu'à la nuit suivante.
      if (imported) recheck.mutate();
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t.maintenance.orphans.title}</h2>
      <p className="text-sm text-muted-foreground">{t.maintenance.orphans.intro}</p>
      <div className="flex gap-2">
        <Button type="button" onClick={() => scan(null)} disabled={scanning || importing}>
          {scanning ? t.maintenance.orphans.scanning : t.maintenance.orphans.scan}
        </Button>
        {error !== null && !scanning && resumeCursor !== null && (
          <Button type="button" variant="outline" onClick={() => scan(resumeCursor)}>
            {t.maintenance.orphans.resume}
          </Button>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">{errorText(error, t)}</p>
      )}

      {scanned && orphans.length === 0 && (
        <p className="text-sm text-muted-foreground">{t.maintenance.orphans.empty}</p>
      )}

      {orphans.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={t.maintenance.orphans.selectAll}
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(orphans.map((o) => o.key)))}
              />
              {t.maintenance.orphans.selectAll}
            </label>
            <Button type="button" onClick={reimportSelected} disabled={selected.size === 0 || importing || scanning}>
              {importing ? t.maintenance.reimporting : t.maintenance.orphans.reimportSelection(selected.size)}
            </Button>
          </div>
          <ul className="flex flex-col">
            {orphans.map((o) => {
              const result = results.get(o.key);
              return (
                <li key={o.key} className="flex items-center gap-3 border-b border-border py-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={t.maintenance.orphans.select(o.key)}
                    checked={selected.has(o.key)}
                    onChange={() => toggle(o.key)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">{o.key}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.maintenance.orphans.meta(formatSize(o.size, t.maintenance.size), formatDate(toDate(o.uploaded), DATE_OPTIONS))}
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
  const { t, formatDate } = useI18n();
  const qc = useQueryClient();
  const { data, error, isLoading } = useParseErrors();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReimportResult[] | null>(null);
  const [runError, setRunError] = useState<unknown>(null);

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
      setRunError(err);
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
      <h2 className="text-base font-semibold">{t.maintenance.parseErrors.title}</h2>
      <p className="text-sm text-muted-foreground">{t.maintenance.parseErrors.intro}</p>

      {isLoading && <p className="text-sm text-muted-foreground">{t.common.loading}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{errorText(error, t)}</p>}
      {data && data.length === 0 && results === null && (
        <p className="text-sm text-muted-foreground">{t.maintenance.parseErrors.empty}</p>
      )}

      {data && data.length > 0 && (
        <>
          <div>
            <Button type="button" onClick={run} disabled={running}>
              {running ? t.maintenance.reimporting : t.maintenance.parseErrors.reimportAll(data.length)}
            </Button>
          </div>
          <ul className="flex flex-col">
            {data.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-3 border-b border-border py-2 text-sm">
                <span className="truncate">{m.subject || t.common.noSubject}</span>
                <time className="shrink-0 text-xs text-muted-foreground">{formatDate(toDate(m.receivedAt), DATE_OPTIONS)}</time>
              </li>
            ))}
          </ul>
        </>
      )}

      {runError !== null && <p role="alert" className="text-sm text-destructive">{errorText(runError, t)}</p>}

      {results !== null && (
        <div className="flex flex-col gap-1 text-sm">
          <p>{t.maintenance.parseErrors.summary(succeeded, failures.length)}</p>
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
  const { t } = useI18n();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-lg font-semibold">{t.maintenance.title}</h1>
      <ScheduledPanel />
      <OrphansPanel />
      <ParseErrorsPanel />
    </div>
  );
}
