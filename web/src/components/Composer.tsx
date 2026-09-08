import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { useIdentities, useSendMessage, type MessageDetail } from "../api/client";

// Même mesure que `payloadSize` côté Worker (src/send/client.ts) pour la partie pièces
// jointes : la longueur de la chaîne base64 telle quelle, pas les octets décodés. Un fichier
// accepté ici doit rester accepté par le Worker.
const MAX_ATTACHMENTS_BASE64 = 5 * 1024 * 1024;

type Attachment = { filename: string; mimeType: string; contentBase64: string };

function replySubject(subject: string): string {
  return /^re:\s*/i.test(subject) ? subject : `Re: ${subject}`;
}

function parseRecipients(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("Échec de lecture du fichier"));
    reader.readAsDataURL(file);
  });
}

export function Composer({
  mode,
  replyTo,
  onClose,
}: {
  mode: "new" | "reply";
  replyTo?: MessageDetail;
  onClose: () => void;
}) {
  const { data: identities } = useIdentities();
  const sendMessage = useSendMessage();

  const [fromOverride, setFromOverride] = useState<string | null>(null);
  const [to, setTo] = useState(mode === "reply" && replyTo ? replyTo.from.address : "");
  const [subject, setSubject] = useState(mode === "reply" && replyTo ? replySubject(replyTo.subject) : "");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [bounces, setBounces] = useState<string[] | null>(null);

  // Dérivé de `identities` à chaque rendu plutôt que copié dans un effect : évite un
  // second rendu déclenché après le chargement des identités, et reste synchronisé si
  // les identités changent (nouvelle identité par défaut, etc.).
  const defaultFrom = identities?.find((i) => i.isDefault)?.address ?? identities?.[0]?.address ?? "";
  const from = fromOverride ?? defaultFrom;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    const newAttachments = await Promise.all(
      files.map(async (file) => ({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64: await readFileAsBase64(file),
      })),
    );

    const total = [...attachments, ...newAttachments].reduce((sum, a) => sum + a.contentBase64.length, 0);
    if (total > MAX_ATTACHMENTS_BASE64) {
      setFileError("L'ensemble dépasse la limite de 5 MiB");
      return;
    }
    setFileError(null);
    setAttachments((prev) => [...prev, ...newAttachments]);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const recipients = parseRecipients(to);
    if (recipients.length === 0) {
      setError("Indique au moins un destinataire");
      return;
    }

    sendMessage.mutate(
      {
        from,
        to: recipients,
        subject,
        text,
        inReplyTo: mode === "reply" ? replyTo?.messageId : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      {
        onSuccess: (result) => {
          if (result.permanentBounces.length > 0) {
            setBounces(result.permanentBounces);
            return;
          }
          onClose();
        },
        onError: (err) => {
          setError(err.message);
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {(error || fileError) && (
        <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
          {error && fileError && <br />}
          {fileError}
        </div>
      )}

      {bounces && bounces.length > 0 && (
        <div role="alert" className="flex flex-col gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p>Rejets définitifs : {bounces.join(", ")}</p>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Fermer
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="composer-from" className="text-xs font-medium text-muted-foreground">
          De
        </label>
        <select
          id="composer-from"
          aria-label="De"
          value={from}
          onChange={(e) => setFromOverride(e.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none"
        >
          {(identities ?? []).map((identity) => (
            <option key={identity.address} value={identity.address}>
              {identity.displayName ?? identity.address}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="composer-to" className="text-xs font-medium text-muted-foreground">
          Destinataires
        </label>
        <Input
          id="composer-to"
          aria-label="Destinataires"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="zoe@example.com, bob@example.com"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="composer-subject" className="text-xs font-medium text-muted-foreground">
          Objet
        </label>
        <Input
          id="composer-subject"
          aria-label="Objet"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="composer-text" className="text-xs font-medium text-muted-foreground">
          Message
        </label>
        <Textarea
          id="composer-text"
          aria-label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="composer-attachments" className="text-xs font-medium text-muted-foreground">
          Pièces jointes
        </label>
        <input
          id="composer-attachments"
          aria-label="Pièces jointes"
          type="file"
          multiple
          onChange={handleFileChange}
          className="text-sm"
        />
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {attachments.map((a, i) => (
              <li key={`${a.filename}-${i}`} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs">
                {a.filename}
                <button type="button" onClick={() => removeAttachment(i)} aria-label={`Retirer ${a.filename}`}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Annuler
        </Button>
        <Button type="submit" disabled={sendMessage.isPending}>
          Envoyer
        </Button>
      </div>
    </form>
  );
}
