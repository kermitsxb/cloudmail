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
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const CATCH_ALL = "*";
const DASHBOARD_URL = "https://dash.cloudflare.com/?to=/:account/email/routing/destination-addresses";

const sourceLabel = (rule: ForwardRule, mailDomain: string) =>
  rule.matchLocal === CATCH_ALL ? "Toutes les adresses" : `${rule.matchLocal}@${mailDomain}`;

function RuleRow({ rule, mailDomain }: { rule: ForwardRule; mailDomain: string }) {
  const update = useUpdateForwardRule();
  const remove = useDeleteForwardRule();
  const label = sourceLabel(rule, mailDomain);

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
            Dernière tentative en échec : {rule.lastError}
          </p>
        )}
        {/* Les deux mutations invalident la liste dans onSettled, donc un refus
            repeint l'état d'avant sans rien dire : l'interrupteur revient à sa
            place, la ligne reste, et l'utilisateur croit avoir agi. Ces deux
            messages sont la seule trace de l'échec. */}
        {update.isError && (
          <p className="mt-1 text-xs text-destructive">
            Activation inchangée : {update.error.message}
          </p>
        )}
        {remove.isError && (
          <p className="mt-1 text-xs text-destructive">
            Suppression impossible : {remove.error.message}
          </p>
        )}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={rule.enabled}
        // Le nom accessible annonce l'action offerte, pas l'état courant : sur
        // une règle déjà active, cliquer la désactive.
        aria-label={`${rule.enabled ? "Désactiver" : "Activer"} la redirection ${label}`}
        onClick={() => update.mutate({ id: rule.id, enabled: !rule.enabled })}
        className="rounded border border-border px-2 py-1 text-xs aria-[checked=true]:bg-accent"
      >
        {rule.enabled ? "Active" : "Inactive"}
      </button>

      <button
        type="button"
        aria-label={`Supprimer la redirection ${label}`}
        onClick={() => remove.mutate(rule.id)}
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Supprimer
      </button>
    </li>
  );
}

function NewRuleForm({ mailDomain, onDone }: { mailDomain: string; onDone: () => void }) {
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
        <legend className="sr-only">Adresse source</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!catchAll} onChange={() => setCatchAll(false)} />
          Une adresse
        </label>
        <div className="flex items-center gap-1 pl-6">
          <Input
            aria-label="Partie locale"
            value={local}
            disabled={catchAll}
            onChange={(e) => setLocal(e.target.value)}
            className="w-40"
          />
          <span className="text-muted-foreground">@{mailDomain}</span>
        </div>
        <label className="flex items-center gap-2">
          <input type="radio" checked={catchAll} onChange={() => setCatchAll(true)} />
          Toutes les adresses du domaine
        </label>
      </fieldset>

      {unavailable && (
        <p className="text-xs text-destructive">
          Impossible de lire les destinations vérifiées du compte Cloudflare. Vérifiez que le
          secret CF_ROUTING_TOKEN est posé sur le Worker.
        </p>
      )}

      {empty && (
        <p className="text-xs text-muted-foreground">
          Aucune destination vérifiée. Ajoutez-en une depuis le{" "}
          <a href={DASHBOARD_URL} target="_blank" rel="noreferrer" className="underline">
            dashboard Cloudflare
          </a>
          , puis cliquez le lien de confirmation reçu par mail.
        </p>
      )}

      {!unavailable && !empty && (
        <label className="flex flex-col gap-1">
          Vers
          <select
            aria-label="Vers"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            className="rounded border border-border bg-transparent px-3 py-2"
          >
            <option value="">── choisir ──</option>
            {destinations.data?.destinations.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}

      {create.isError && <p className="text-xs text-destructive">{create.error.message}</p>}

      <div className="flex gap-2">
        {/* create.isPending dans la condition : sans lui, un double-clic envoie
            deux POST et le second répond 409 sur un formulaire déjà fermé. */}
        <Button
          type="submit"
          disabled={create.isPending || !destination || (!catchAll && !local.trim())}
        >
          Enregistrer
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

export function ForwardingSettings() {
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
        <h1 className="text-lg font-semibold">Redirections</h1>
        {!adding && mailDomain !== undefined && (
          <Button type="button" onClick={() => setAdding(true)}>
            Ajouter une redirection
          </Button>
        )}
      </header>

      <p className="text-sm text-muted-foreground">
        Toutes les règles qui correspondent à une adresse s'appliquent : un message reçu peut
        partir vers plusieurs destinations. Il reste dans tous les cas archivé dans Cloudmail.
      </p>

      {/* Distinct de l'état vide, et non silencieux : une installation dont la
          migration 0002 n'a pas été appliquée reçoit un 500 sur cette route, et
          lire « aucune redirection » lui ferait croire la fonctionnalité en
          ordre de marche. */}
      {rules.isError && (
        <p className="text-sm text-destructive">
          Impossible de lire les redirections : {rules.error.message}. Si la fonctionnalité vient
          d'être déployée, la migration <code>0002_forward_rules.sql</code> n'a peut-être pas été
          appliquée sur la base D1 (voir l'étape 2 de la mise en service, dans le README).
        </p>
      )}

      {config.isError && (
        <p className="text-sm text-destructive">
          Le domaine de messagerie n'a pas pu être lu : les adresses sources seraient incomplètes,
          les redirections ne sont donc pas affichées. Rechargez la page.
        </p>
      )}

      {mailDomain !== undefined && (
        <>
          {adding && <NewRuleForm mailDomain={mailDomain} onDone={() => setAdding(false)} />}

          {rules.isSuccess && rules.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Aucune redirection.</p>
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
