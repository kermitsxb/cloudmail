import PostalMime, { type Address } from "postal-mime";

export type ParsedAddress = { address: string; name: string | null };
export type ParsedAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null; // sans les chevrons
  content: ArrayBuffer;
};
export type ParsedMessage = {
  messageId: string; // avec chevrons ; UUID synthétique si absent
  inReplyTo: string | null;
  references: string[];
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  replyTo: ParsedAddress[];
  subject: string;
  text: string;
  html: string | null;
  date: number; // epoch secondes
  attachments: ParsedAttachment[];
  parseError: boolean;
};

const RE_PREFIX = /^\s*(re|ré|rép|rep|fw|fwd|tr)\s*(\[\d+\])?\s*:\s*/i;

export function normalizeSubject(subject: string): string {
  let s = (subject ?? "").trim();
  while (RE_PREFIX.test(s)) s = s.replace(RE_PREFIX, "");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function safeKey(messageId: string): string {
  const stripped = messageId.replace(/^<|>$/g, "");
  const cleaned = stripped.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "unknown").slice(0, 200);
}

export function snippetOf(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

const toAddresses = (list: Address[] | undefined): ParsedAddress[] =>
  (list ?? []).flatMap((a) =>
    "group" in a && Array.isArray((a as { group?: Address[] }).group)
      ? toAddresses((a as { group: Address[] }).group)
      : a.address
        ? [{ address: a.address.toLowerCase(), name: a.name || null }]
        : []
  );

export async function parseEmail(raw: ArrayBuffer, envelopeFrom: string): Promise<ParsedMessage> {
  const fallback = (): ParsedMessage => ({
    messageId: `<${crypto.randomUUID()}@cloudmail.local>`,
    inReplyTo: null,
    references: [],
    from: { address: envelopeFrom.toLowerCase(), name: null },
    to: [],
    cc: [],
    replyTo: [],
    subject: "(message illisible)",
    text: "",
    html: null,
    date: Math.floor(Date.now() / 1000),
    attachments: [],
    parseError: true,
  });

  let email;
  try {
    email = await PostalMime.parse(raw, { maxNestingDepth: 50 });
  } catch {
    return fallback();
  }

  // Un message sans expéditeur ni sujet ni corps n'a pas été réellement compris.
  if (!email.from?.address && !email.subject && !email.text && !email.html) {
    return fallback();
  }

  const date = email.date ? Math.floor(new Date(email.date).getTime() / 1000) : NaN;

  return {
    messageId: email.messageId ?? `<${crypto.randomUUID()}@cloudmail.local>`,
    inReplyTo: email.inReplyTo ?? null,
    references: (email.references ?? "").split(/\s+/).filter((r) => r.startsWith("<")),
    from: email.from?.address
      ? { address: email.from.address.toLowerCase(), name: email.from.name || null }
      : { address: envelopeFrom.toLowerCase(), name: null },
    to: toAddresses(email.to),
    cc: toAddresses(email.cc),
    replyTo: toAddresses(email.replyTo),
    subject: email.subject ?? "",
    text: email.text ?? "",
    html: email.html ?? null,
    date: Number.isFinite(date) ? date : Math.floor(Date.now() / 1000),
    attachments: (email.attachments ?? []).map((a) => {
      const content = a.content as ArrayBuffer;
      return {
        filename: a.filename || "sans-nom",
        mimeType: a.mimeType || "application/octet-stream",
        size: content.byteLength,
        contentId: a.contentId ? a.contentId.replace(/^<|>$/g, "") : null,
        content,
      };
    }),
    parseError: false,
  };
}
