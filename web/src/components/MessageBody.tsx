import { useEffect, useState } from "react";
import { api } from "../api/client";

type Body = { html: string | null; text: string; hasRemoteImages: boolean };

export function MessageBody({ messageId }: { messageId: number }) {
  const [showImages, setShowImages] = useState(false);
  const [body, setBody] = useState<Body | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // On passe par le helper api(), qui vérifie res.ok et lève une ApiError portant le
    // message du contrat d'erreur. Un fetch nu suivi d'un r.json() laissait le panneau
    // bloqué sur « Chargement… » en cas de 500, et affichait un corps vide sans le moindre
    // signal en cas de 401 — ce qui arrive dès qu'une session Access expire.
    api<Body>(`/messages/${messageId}/body${showImages ? "?images=allowed" : ""}`)
      .then((b) => {
        if (cancelled) return;
        setBody(b);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Erreur inconnue");
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, showImages]);

  if (error) {
    return (
      <p className="p-4 text-sm text-destructive">
        Impossible de charger le message : {error}
      </p>
    );
  }

  if (!body) return <p className="p-4 text-sm text-muted-foreground">Chargement…</p>;

  if (!body.html) {
    return <pre className="whitespace-pre-wrap p-4 font-sans text-sm">{body.text}</pre>;
  }

  return (
    <div>
      {body.hasRemoteImages && !showImages && (
        <div className="flex items-center justify-between gap-4 border-b bg-muted px-4 py-2 text-sm">
          <span>Les images distantes sont bloquées pour protéger ta vie privée.</span>
          <button type="button" className="underline" onClick={() => setShowImages(true)}>
            Afficher les images
          </button>
        </div>
      )}
      {/* sandbox="" : aucune permission accordée, donc pas de scripts, pas de formulaires, pas de navigation. */}
      {/* Assumé : le <base target="_blank"> ci-dessous, comme les target/rel posés sur chaque
          lien par l'assainisseur (src/html/sanitize.ts), sont inertes tant que l'iframe est en
          sandbox="" — allow-popups n'étant pas accordé, un clic sur un lien du message ne
          navigue ni n'ouvre d'onglet. Ce n'est pas un bug à corriger mais un compromis :
          l'isolation prime sur l'ouverture des liens, et ces attributs restent là pour que le
          jour où une permission serait accordée, le comportement soit d'emblée le bon. */}
      <iframe
        title="Contenu du message"
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[60vh] w-full border-0"
        srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:14px system-ui;margin:12px}img{max-width:100%}</style>${body.html}`}
      />
    </div>
  );
}
