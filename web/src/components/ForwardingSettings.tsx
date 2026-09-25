import { useState } from "react";
import {
  useConfig,
  useCreateForwardRule,
  useDeleteForwardRule,
  useForwardDestinations,
  useForwardRules,
  useUpdateForwardRule,
  type ForwardRule,
} from "../api/client";
import { useI18n } from "../i18n";
import type { Catalog } from "../i18n/fr";
import { errorText } from "../lib/errors";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const CATCH_ALL = "*";
const DASHBOARD_URL = "https://dash.cloudflare.com/?to=/:account/email/routing/destination-addresses";

const sourceLabel = (rule: ForwardRule, mailDomain: string, t: Catalog) =>
  rule.matchLocal === CATCH_ALL ? t.forwarding.allAddresses : `${rule.matchLocal}@${mailDomain}`;

function RuleRow({ rule, mailDomain }: { rule: ForwardRule; mailDomain: string }) {
  const { t } = useI18n();
  const update = useUpdateForwardRule();
  const remove = useDeleteForwardRule();
  const label = sourceLabel(rule, mailDomain, t);

  return (
    <li className="flex items-center gap-3 border-b border-border py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate">
          <span className="font-medium">{label}</span>
          <span className="mx-2 text-muted-foreground">→</span>
          <span>{rule.destination}</span>
        </p>
        {rule.lastStatus === "error" && (
          <p className="mt-1 text-xs text-destructive">
            {t.forwarding.lastFailure(rule.lastError ?? "")}
          </p>
        )}
        {/* Les deux mutations invalident la liste dans onSettled, donc un refus
            repeint l'état d'avant sans rien dire : l'interrupteur revient à sa
            place, la ligne reste, et l'utilisateur croit avoir agi. Ces deux
            messages sont la seule trace de l'échec. */}
        {update.isError && (
          <p className="mt-1 text-xs text-destructive">
            {t.forwarding.toggleFailed(errorText(update.error, t))}
          </p>
        )}
        {remove.isError && (
          <p className="mt-1 text-xs text-destructive">
            {t.common.deleteFailed(errorText(remove.error, t))}
          </p>
        )}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={rule.enabled}
        // Le nom accessible annonce l'action offerte, pas l'état courant : sur
        // une règle déjà active, cliquer la désactive.
        aria-label={t.forwarding.toggleLabel(rule.enabled, label)}
        onClick={() => update.mutate({ id: rule.id, enabled: !rule.enabled })}
        className="rounded border border-border px-2 py-1 text-xs aria-[checked=true]:bg-accent"
      >
        {rule.enabled ? t.forwarding.active : t.forwarding.inactive}
      </button>

      <button
        type="button"
        aria-label={t.forwarding.deleteLabel(label)}
        onClick={() => remove.mutate(rule.id)}
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {t.common.delete}
      </button>
    </li>
  );
}

function NewRuleForm({ mailDomain, onDone }: { mailDomain: string; onDone: () => void }) {
  const { t } = useI18n();
  const destinations = useForwardDestinations();
  const create = useCreateForwardRule();
  const [catchAll, setCatchAll] = useState(false);
  const [local, setLocal] = useState("");
  const [destination, setDestination] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { matchLocal: catchAll ? CATCH_ALL : local.trim(), destination },
      { onSuccess: onDone },
    );
  };

  // Trois états distincts, volontairement non fusionnés : « je ne sais pas »
  // (503, configuration manquante) ne doit pas se lire comme « aucune
  // destination » (compte vide), qui ne se lit pas comme « en cours ».
  const unavailable = destinations.isError;
  const empty = destinations.isSuccess && destinations.data.destinations.length === 0;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 border border-border p-4 text-sm">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t.forwarding.sourceLegend}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!catchAll} onChange={() => setCatchAll(false)} />
          {t.forwarding.oneAddress}
        </label>
        <div className="flex items-center gap-1 pl-6">
          <Input
            aria-label={t.common.localPart}
            value={local}
            disabled={catchAll}
            onChange={(e) => setLocal(e.target.value)}
            className="w-40"
          />
          <span className="text-muted-foreground">@{mailDomain}</span>
        </div>
        <label className="flex items-center gap-2">
          <input type="radio" checked={catchAll} onChange={() => setCatchAll(true)} />
          {t.forwarding.wholeDomain}
        </label>
      </fieldset>

      {unavailable && (
        <p className="text-xs text-destructive">{t.forwarding.destinationsUnavailable}</p>
      )}

      {empty && (
        <p className="text-xs text-muted-foreground">
          {t.forwarding.noDestinationBefore}{" "}
          <a href={DASHBOARD_URL} target="_blank" rel="noreferrer" className="underline">
            {t.forwarding.noDestinationLink}
          </a>
          {t.forwarding.noDestinationAfter}
        </p>
      )}

      {!unavailable && !empty && (
        <label className="flex flex-col gap-1">
          {t.forwarding.to}
          <select
            aria-label={t.forwarding.to}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            className="rounded border border-border bg-transparent px-3 py-2"
          >
            <option value="">{t.forwarding.choose}</option>
            {destinations.data?.destinations.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}

      {create.isError && <p className="text-xs text-destructive">{errorText(create.error, t)}</p>}

      <div className="flex gap-2">
        {/* create.isPending dans la condition : sans lui, un double-clic envoie
            deux POST et le second répond 409 sur un formulaire déjà fermé. */}
        <Button
          type="submit"
          disabled={create.isPending || !destination || (!catchAll && !local.trim())}
        >
          {t.common.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}

export function ForwardingSettings() {
  const { t } = useI18n();
  const config = useConfig();
  const rules = useForwardRules();
  const [adding, setAdding] = useState(false);
  // Pas de repli sur "" : le domaine est la moitié droite de chaque adresse
  // source affichée. Tant qu'il est inconnu — /api/config en cours, ou en échec
  // définitif — un repli afficherait « contact@ » et un « @ » nu dans le
  // formulaire, soit une adresse fausse présentée comme vraie. On préfère ne
  // rien montrer et le dire.
  const mailDomain = config.data?.mailDomain;

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t.forwarding.title}</h1>
        {!adding && mailDomain !== undefined && (
          <Button type="button" onClick={() => setAdding(true)}>
            {t.forwarding.add}
          </Button>
        )}
      </header>

      <p className="text-sm text-muted-foreground">{t.forwarding.intro}</p>

      {/* Distinct de l'état vide, et non silencieux : une installation dont la
          migration 0002 n'a pas été appliquée reçoit un 500 sur cette route, et
          lire « aucune redirection » lui ferait croire la fonctionnalité en
          ordre de marche. */}
      {rules.isError && (
        <p className="text-sm text-destructive">
          {t.forwarding.readFailed(errorText(rules.error, t))} {t.forwarding.migrationHintBefore}{" "}
          <code>0002_forward_rules.sql</code> {t.forwarding.migrationHintAfter}
        </p>
      )}

      {config.isError && (
        <p className="text-sm text-destructive">{t.forwarding.configFailed}</p>
      )}

      {mailDomain !== undefined && (
        <>
          {adding && <NewRuleForm mailDomain={mailDomain} onDone={() => setAdding(false)} />}

          {rules.isSuccess && rules.data.length === 0 && (
            <p className="text-sm text-muted-foreground">{t.forwarding.empty}</p>
          )}

          <ul>
            {rules.data?.map((rule) => (
              <RuleRow key={rule.id} rule={rule} mailDomain={mailDomain} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
