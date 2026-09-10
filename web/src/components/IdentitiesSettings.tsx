import { useState } from "react";
import {
  useConfig,
  useCreateIdentity,
  useDeleteIdentity,
  useIdentities,
  useUpdateIdentity,
  type Identity,
} from "../api/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function IdentityRow({ identity }: { identity: Identity }) {
  const update = useUpdateIdentity();
  const remove = useDeleteIdentity();

  return (
    <li className="flex items-center gap-3 border-b border-border py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate">
          <span className="font-medium">{identity.displayName ?? identity.address}</span>
          {identity.displayName && (
            <span className="ml-2 text-muted-foreground">{identity.address}</span>
          )}
        </p>
        {/* Les deux mutations invalident la liste dans onSettled, donc un refus repeint
            l'état d'avant sans rien dire : ces messages sont la seule trace de l'échec. */}
        {update.isError && (
          <p className="mt-1 text-xs text-destructive">
            Modification impossible : {update.error.message}
          </p>
        )}
        {remove.isError && (
          <p className="mt-1 text-xs text-destructive">
            Suppression impossible : {remove.error.message}
          </p>
        )}
      </div>

      {identity.isDefault ? (
        <span className="rounded border border-border px-2 py-1 text-xs text-muted-foreground">
          Par défaut
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Définir ${identity.address} comme identité par défaut`}
          onClick={() => update.mutate({ address: identity.address, isDefault: true })}
          className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
        >
          Définir par défaut
        </button>
      )}

      <button
        type="button"
        aria-label={`Supprimer l'identité ${identity.address}`}
        onClick={() => remove.mutate(identity.address)}
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Supprimer
      </button>
    </li>
  );
}

function NewIdentityForm({ mailDomain, onDone }: { mailDomain: string; onDone: () => void }) {
  const create = useCreateIdentity();
  const [localPart, setLocalPart] = useState("");
  const [displayName, setDisplayName] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { localPart: localPart.trim(), displayName: displayName.trim() || undefined },
      { onSuccess: onDone },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 border border-border p-4 text-sm">
      <label className="flex flex-col gap-1">
        Adresse
        <div className="flex items-center gap-1">
          <Input
            aria-label="Partie locale"
            value={localPart}
            onChange={(e) => setLocalPart(e.target.value)}
            className="w-40"
          />
          <span className="text-muted-foreground">@{mailDomain}</span>
        </div>
      </label>

      <label className="flex flex-col gap-1">
        Nom affiché
        <Input
          aria-label="Nom affiché"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Your Name"
        />
      </label>

      {create.isError && <p className="text-xs text-destructive">{create.error.message}</p>}

      <div className="flex gap-2">
        {/* create.isPending dans la condition : sans lui, un double-clic envoie deux POST et
            le second répond 409 sur un formulaire déjà fermé. */}
        <Button type="submit" disabled={create.isPending || !localPart.trim()}>
          Enregistrer
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

export function IdentitiesSettings() {
  const config = useConfig();
  const identities = useIdentities();
  const [adding, setAdding] = useState(false);
  // Pas de repli sur "" : voir la même remarque dans ForwardingSettings — un domaine
  // inconnu afficherait une fausse adresse plutôt que de ne rien montrer.
  const mailDomain = config.data?.mailDomain;

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Identités</h1>
        {!adding && mailDomain !== undefined && (
          <Button type="button" onClick={() => setAdding(true)}>
            Ajouter une identité
          </Button>
        )}
      </header>

      <p className="text-sm text-muted-foreground">
        Les identités disponibles apparaissent dans le sélecteur « De » du formulaire d'envoi.
        Le nom affiché est celui que verra le destinataire dans son client de messagerie.
      </p>

      {identities.isError && (
        <p className="text-sm text-destructive">
          Impossible de lire les identités : {identities.error.message}.
        </p>
      )}

      {config.isError && (
        <p className="text-sm text-destructive">
          Le domaine de messagerie n'a pas pu être lu : les adresses seraient incomplètes, les
          identités ne sont donc pas affichées. Rechargez la page.
        </p>
      )}

      {mailDomain !== undefined && (
        <>
          {adding && <NewIdentityForm mailDomain={mailDomain} onDone={() => setAdding(false)} />}

          {identities.isSuccess && identities.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Aucune identité.</p>
          )}

          <ul>
            {identities.data?.map((identity) => (
              <IdentityRow key={identity.address} identity={identity} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
