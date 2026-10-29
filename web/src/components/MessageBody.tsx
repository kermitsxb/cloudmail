import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { errorText } from "../lib/errors";

type Body = { html: string | null; text: string; hasRemoteImages: boolean };

function frameCsp(remote: boolean): string {
  const extra = remote ? " https:" : "";
  return (
    `default-src 'none'; style-src 'unsafe-inline'; ` +
    `img-src ${location.origin}/api/attachments/ data:${extra}; font-src data:${extra}`
  );
}

export function MessageBody({ messageId }: { messageId: number }) {
  const { t } = useI18n();
  const [showImages, setShowImages] = useState(false);
  const [body, setBody] = useState<Body | null>(null);
  const [error, setError] = useState<unknown>(null);

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
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, showImages]);

  if (error !== null) {
    return (
      <p className="p-4 text-sm text-destructive">
        {t.messageBody.loadFailed(errorText(error, t))}
      </p>
    );
  }

  if (!body) return <p className="p-4 text-sm text-muted-foreground">{t.common.loading}</p>;

  if (!body.html) {
    return <pre className="whitespace-pre-wrap p-4 font-sans text-sm">{body.text}</pre>;
  }

  return (
    <div>
      {body.hasRemoteImages && !showImages && (
        <div className="flex items-center justify-between gap-4 border-b bg-muted px-4 py-2 text-sm">
          <span>{t.messageBody.remoteImagesBlocked}</span>
          <button type="button" className="underline" onClick={() => setShowImages(true)}>
            {t.messageBody.showImages}
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
      {/* La CSP posée dans le document de l'iframe double le filtrage des url() du CSS fait
          par l'assainisseur : tant que les images distantes ne sont pas affichées, seules les
          pièces jointes inline (cid: réécrites vers /api/attachments/) et les data: se
          chargent — y compris via background-image ou @font-face. L'origine est écrite en
          toutes lettres car 'self' ne désigne rien dans un document sandbox à origine opaque. */}
      <iframe
        title={t.messageBody.frameTitle}
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[60vh] w-full border-0"
        srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(showImages)}"><base target="_blank"><style>body{font:14px system-ui;margin:12px}img{max-width:100%}</style>${body.html}`}
      />
    </div>
  );
}
