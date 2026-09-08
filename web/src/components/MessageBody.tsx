import { useEffect, useState } from "react";

type Body = { html: string | null; text: string; hasRemoteImages: boolean };

export function MessageBody({ messageId }: { messageId: number }) {
  const [showImages, setShowImages] = useState(false);
  const [body, setBody] = useState<Body | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/messages/${messageId}/body${showImages ? "?images=allowed" : ""}`)
      .then((r) => r.json())
      .then((b: Body) => {
        if (!cancelled) setBody(b);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, showImages]);

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
