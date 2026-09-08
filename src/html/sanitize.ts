export type SanitizeOptions = {
  cidMap: Record<string, number>; // contentId → id de pièce jointe
  blockRemoteImages: boolean;
};
export type SanitizeResult = { html: string; hasRemoteImages: boolean };

// Balises dont le contenu textuel est inoffensif et vaut la peine d'être conservé même
// si la balise elle-même est retirée (ex: <blink>texte</blink> -> "texte").
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

// Balises dont le contenu doit disparaître intégralement : soit parce qu'il n'est jamais
// destiné à être affiché comme texte (script, style, link, meta, base), soit parce que leur
// contenu peut receler des vecteurs XSS impossibles à assainir attribut par attribut une fois
// dépouillé de leur balise racine (svg avec <animate onbegin>, math avec <mtext><script>,
// iframe/object/embed avec leurs propres documents, form avec formaction).
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "form", "svg", "math", "link", "meta", "base",
]);

const ALLOWED_ATTRS = new Set(["href", "src", "alt", "title", "width", "height", "colspan", "rowspan"]);

// Liste blanche de schémas d'URL. Volontairement stricte : toute valeur qui ne commence pas
// par l'un de ces schémas (après trim des espaces en tête/fin) est rejetée, quel que soit son
// contenu. C'est ce choix — liste blanche plutôt que détection de motifs interdits — qui rend
// l'assainissement robuste aux obfuscations (casse, tabulations/retours à la ligne intercalés,
// entités HTML décodées par le parseur, data: URIs, etc.) sans avoir à les énumérer.
const SAFE_URL = /^(https?:|mailto:|cid:)/i;

export async function sanitizeHtml(html: string, opts: SanitizeOptions): Promise<SanitizeResult> {
  let hasRemoteImages = false;

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();

      if (DROP_WITH_CONTENT.has(tag)) {
        el.remove();
        return;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        el.removeAndKeepContent();
        return;
      }

      for (const [name, value] of [...el.attributes]) {
        const lower = name.toLowerCase();
        if (lower.startsWith("on") || !ALLOWED_ATTRS.has(lower)) {
          el.removeAttribute(name);
          continue;
        }
        if ((lower === "href" || lower === "src") && !SAFE_URL.test(value.trim())) {
          el.removeAttribute(name);
        }
      }

      if (tag === "a") {
        if (el.getAttribute("href")) {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
      }

      if (tag === "img") {
        const src = el.getAttribute("src");
        if (!src) return;
        if (src.toLowerCase().startsWith("cid:")) {
          const id = opts.cidMap[src.slice(4)];
          if (id === undefined) el.remove();
          else el.setAttribute("src", `/api/attachments/${id}`);
          return;
        }
        hasRemoteImages = true;
        if (opts.blockRemoteImages) {
          el.removeAttribute("src");
          el.setAttribute("data-blocked-src", src);
        }
      }
    },
  });

  const out = await rewriter.transform(new Response(html)).text();
  return { html: out, hasRemoteImages };
}
