import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../../src/html/sanitize";

const clean = (html: string, cidMap: Record<string, number> = {}) =>
  sanitizeHtml(html, { cidMap, blockRemoteImages: true });

describe("sanitizeHtml", () => {
  // --- Cas de base (brief) ---

  it("supprime les balises script", async () => {
    const { html } = await clean(`<p>ok</p><script>alert(1)</script>`);
    expect(html).not.toContain("alert");
    expect(html).not.toContain("<script");
    expect(html).toContain("<p>ok</p>");
  });

  it("supprime les balises style", async () => {
    const { html } = await clean(`<style>body{display:none}</style><p>ok</p>`);
    expect(html).not.toContain("display:none");
  });

  it("supprime les gestionnaires d'événements", async () => {
    const { html } = await clean(`<img src="https://x/y.png" onerror="alert(1)">`);
    expect(html).not.toContain("onerror");
  });

  it("neutralise les URL javascript:", async () => {
    const { html } = await clean(`<a href="javascript:alert(1)">clic</a>`);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("clic");
  });

  it("neutralise une charge XSS dans un SVG", async () => {
    const { html } = await clean(`<svg><script>alert(1)</script></svg>`);
    expect(html).not.toContain("alert");
  });

  it("supprime les iframes et objets", async () => {
    const { html } = await clean(`<iframe src="https://evil"></iframe><object data="x"></object>`);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
  });

  it("bloque les images distantes et le signale", async () => {
    const { html, hasRemoteImages } = await clean(`<img src="https://tracker/pixel.gif">`);
    expect(hasRemoteImages).toBe(true);
    // Le brief demande à la fois `not.toContain("https://tracker")` et
    // `toContain('data-blocked-src="https://tracker/pixel.gif"')` : ces deux assertions sont
    // contradictoires telles quelles (data-blocked-src contient forcément la sous-chaîne
    // "https://tracker"). L'intention réelle est qu'il n'y ait plus de `src=` actif pointant
    // vers l'URL distante (donc aucun fetch), tout en conservant l'URL dans data-blocked-src
    // pour un déblocage ultérieur côté front. On retire donc l'attribut data-blocked-src avant
    // de vérifier qu'aucun autre attribut (un `src=` actif) ne référence encore l'URL bloquée.
    expect(html.replace(/data-blocked-src="[^"]*"/g, "")).not.toContain("https://tracker");
    expect(html).toContain('data-blocked-src="https://tracker/pixel.gif"');
  });

  it("laisse passer les images distantes quand elles sont autorisées", async () => {
    const { html } = await sanitizeHtml(`<img src="https://ok/a.png">`, { cidMap: {}, blockRemoteImages: false });
    expect(html).toContain('src="https://ok/a.png"');
  });

  it("réécrit les images cid: vers l'API des pièces jointes", async () => {
    const { html, hasRemoteImages } = await clean(`<img src="cid:logo123">`, { logo123: 42 });
    expect(html).toContain('src="/api/attachments/42"');
    expect(hasRemoteImages).toBe(false);
  });

  it("force target et rel sur les liens", async () => {
    const { html } = await clean(`<a href="https://exemple.fr">lien</a>`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("supprime les balises inconnues en gardant leur texte", async () => {
    const { html } = await clean(`<blink>texte</blink>`);
    expect(html).not.toContain("<blink");
    expect(html).toContain("texte");
  });

  // --- Cas adverses supplémentaires ---

  it("supprime un cid: absent du cidMap au lieu de laisser une référence pendante", async () => {
    const { html } = await clean(`<img src="cid:inconnu">`, {});
    expect(html).not.toContain("cid:");
    expect(html).not.toContain("<img");
  });

  it("neutralise les attributs d'événement en casse mixte", async () => {
    const { html } = await clean(`<img src="https://x/y.png" OnErRoR="alert(1)">`);
    expect(html.toLowerCase()).not.toContain("onerror");
    expect(html).not.toContain("alert");
  });

  it("neutralise javascript: avec tabulation intercalée", async () => {
    const { html } = await clean(`<a href="java\tscript:alert(1)">clic</a>`);
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/href\s*=/i);
  });

  it("neutralise javascript: avec retour à la ligne intercalé", async () => {
    const { html } = await clean(`<a href="java\nscript:alert(1)">clic</a>`);
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/href\s*=/i);
  });

  it("neutralise javascript: avec espaces intercalés", async () => {
    const { html } = await clean(`<a href="java script:alert(1)">clic</a>`);
    expect(html).not.toContain("javascript:");
  });

  it("neutralise javascript: encodé en entités HTML", async () => {
    const { html } = await clean(`<a href="java&#115;cript:alert(1)">clic</a>`);
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/href\s*=/i);
  });

  it("neutralise un data: URL html/base64 dans un href", async () => {
    const payload = `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">clic</a>`;
    const { html } = await clean(payload);
    expect(html).not.toContain("data:text/html");
    expect(html).not.toMatch(/href\s*=/i);
  });

  it("supprime un svg avec animate onbegin", async () => {
    const { html } = await clean(`<svg><animate onbegin="alert(1)" attributeName="x" /></svg>`);
    expect(html).not.toContain("onbegin");
    expect(html).not.toContain("alert");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<animate");
  });

  it("supprime un math/mtext/script imbriqué", async () => {
    const { html } = await clean(`<math><mtext><script>alert(1)</script></mtext></math>`);
    expect(html).not.toContain("alert");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<math");
    expect(html).not.toContain("<mtext");
  });

  it("supprime une balise base href", async () => {
    const { html } = await clean(`<base href="https://evil.example/"><p>ok</p>`);
    expect(html).not.toContain("<base");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("<p>ok</p>");
  });

  it("supprime un form avec button formaction", async () => {
    const { html } = await clean(
      `<form action="https://evil"><button formaction="javascript:alert(1)">go</button></form>`
    );
    expect(html).not.toContain("<form");
    expect(html).not.toContain("formaction");
    expect(html).not.toContain("javascript:");
  });

  it("neutralise url(javascript:...) dans srcset", async () => {
    const { html } = await clean(`<img src="https://ok/a.png" srcset="javascript:alert(1) 1x">`);
    expect(html).not.toContain("srcset");
    expect(html).not.toContain("javascript:");
  });

  it("neutralise url(javascript:...) dans style", async () => {
    const { html } = await clean(`<p style="background:url(javascript:alert(1))">texte</p>`);
    expect(html).not.toContain("style");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("texte");
  });

  it("ignore un img sans src mais avec srcset (pas de fuite via srcset)", async () => {
    const { html, hasRemoteImages } = await clean(`<img srcset="https://tracker/pixel.gif 1x">`);
    expect(html).not.toContain("srcset");
    expect(html).not.toContain("https://tracker");
    expect(hasRemoteImages).toBe(false);
  });

  it("gère du HTML malformé (balises non fermées) sans laisser fuir de script", async () => {
    const { html } = await clean(`<p>texte<script>alert(1)</script`);
    expect(html).not.toContain("alert");
    expect(html).toContain("texte");
  });

  it("gère une imbrication invalide (script ouvert dans un attribut cassé) sans créer d'élément script réel", async () => {
    const { html } = await clean(`<img src="x" title="<script>alert(1)</script>">`);
    // Le texte "<script>...</script>" apparaît ici comme valeur (littérale, entre guillemets)
    // de l'attribut title — HTML l'interprète comme du texte inerte, jamais comme une balise
    // imbriquée, tant qu'il reste à l'intérieur des guillemets de l'attribut. Pour vérifier ça
    // sans se fier à une correspondance de chaîne (qui ne peut pas distinguer "à l'intérieur
    // d'un attribut" de "dans le flux d'éléments"), on repasse la sortie dans le même parseur
    // HTML (celui qu'utilisera aussi le navigateur) et on vérifie qu'aucun élément <script> réel
    // n'en ressort.
    let sawScript = false;
    await new HTMLRewriter()
      .on("script", { element() { sawScript = true; } })
      .transform(new Response(html))
      .text();
    expect(sawScript).toBe(false);
  });

  it("neutralise un onclick sur une balise autorisée quelconque", async () => {
    const { html } = await clean(`<p onclick="alert(1)">texte</p>`);
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert");
    expect(html).toContain("texte");
  });

  it("supprime embed", async () => {
    const { html } = await clean(`<embed src="https://evil/x.swf">`);
    expect(html).not.toContain("<embed");
  });

  it("supprime link (feuille de style / préchargement externe)", async () => {
    const { html } = await clean(`<link rel="stylesheet" href="https://evil/x.css"><p>ok</p>`);
    expect(html).not.toContain("<link");
    expect(html).toContain("<p>ok</p>");
  });

  it("supprime meta (refresh / charset trompeur)", async () => {
    const { html } = await clean(`<meta http-equiv="refresh" content="0;url=https://evil"><p>ok</p>`);
    expect(html).not.toContain("<meta");
    expect(html).toContain("<p>ok</p>");
  });

  // --- Fix round 1 : famille des éléments à contenu RAWTEXT / escapable RAWTEXT ---
  //
  // Pour ces balises, le "texte" restitué par le parseur entre l'ouverture et la fermeture
  // n'est pas réanalysé comme balisage par le parseur *source* — mais removeAndKeepContent()
  // le réémet tel quel dans le HTML de sortie, où il redevient du balisage vivant dès qu'un
  // navigateur (ou l'iframe sandbox du front) le reparse. Chaque test ci-dessous vérifie qu'il
  // ne subsiste rien d'exécutable une fois passé par sanitizeHtml, en repassant la sortie dans
  // un second HTMLRewriter pour détecter tout élément <script> ou <img onerror> réel.

  const assertNoLiveScriptOrHandler = async (html: string) => {
    let sawScript = false;
    let sawOnerror = false;
    await new HTMLRewriter()
      .on("script", { element() { sawScript = true; } })
      .on("*", {
        element(el) {
          if (el.getAttribute("onerror") !== null) sawOnerror = true;
        },
      })
      .transform(new Response(html))
      .text();
    expect(sawScript).toBe(false);
    expect(sawOnerror).toBe(false);
  };

  it("neutralise <title><script>...</script></title>", async () => {
    const { html } = await clean(`<title><script>alert(1)</script></title><p>ok</p>`);
    expect(html).not.toContain("alert");
    expect(html).toContain("<p>ok</p>");
    await assertNoLiveScriptOrHandler(html);
  });

  it("neutralise <textarea><img onerror=...></textarea>", async () => {
    const { html } = await clean(`<textarea><img src=x onerror=alert(1)></textarea><p>ok</p>`);
    expect(html).not.toContain("alert");
    expect(html).toContain("<p>ok</p>");
    await assertNoLiveScriptOrHandler(html);
  });

  it("neutralise <noscript><img onerror=...></noscript>", async () => {
    const { html } = await clean(`<noscript><img src=x onerror=alert(1)></noscript><p>ok</p>`);
    expect(html).not.toContain("alert");
    expect(html).toContain("<p>ok</p>");
    await assertNoLiveScriptOrHandler(html);
  });

  it("neutralise <xmp><script>...</script></xmp>", async () => {
    const { html } = await clean(`<xmp><script>alert(1)</script></xmp><p>ok</p>`);
    expect(html).not.toContain("alert");
    expect(html).toContain("<p>ok</p>");
    await assertNoLiveScriptOrHandler(html);
  });

  it("neutralise <noembed><img onerror=...></noembed>", async () => {
    const { html } = await clean(`<noembed><img src=x onerror=alert(1)></noembed><p>ok</p>`);
    expect(html).not.toContain("alert");
    await assertNoLiveScriptOrHandler(html);
  });

  it("neutralise <noframes><script>...</script></noframes>", async () => {
    const { html } = await clean(`<noframes><script>alert(1)</script></noframes><p>ok</p>`);
    expect(html).not.toContain("alert");
    await assertNoLiveScriptOrHandler(html);
  });

  it("neutralise <listing><script>...</script></listing>", async () => {
    const { html } = await clean(`<listing><script>alert(1)</script></listing><p>ok</p>`);
    expect(html).not.toContain("alert");
    await assertNoLiveScriptOrHandler(html);
  });

  it("neutralise <plaintext> et tout ce qui le suit", async () => {
    const { html } = await clean(`<plaintext><script>alert(1)</script>`);
    expect(html).not.toContain("alert");
  });

  it("neutralise <template><script>...</script></template>", async () => {
    const { html } = await clean(`<template><script>alert(1)</script></template><p>ok</p>`);
    expect(html).not.toContain("alert");
    await assertNoLiveScriptOrHandler(html);
  });

  it("verrouille le comportement par défaut : une balise inconnue à modèle de contenu normal garde son texte", async () => {
    // <center>, <font> et <o:p> (namespace Outlook) ont un modèle de contenu normal : leurs
    // enfants sont analysés comme du balisage à part entière par le parseur source, donc un
    // <script> à l'intérieur est déjà intercepté indépendamment par la règle générale — la
    // balise elle-même peut donc être simplement dépouillée (removeAndKeepContent) sans risque,
    // et son texte légitime doit être conservé (essentiel pour les emails Outlook réels).
    const center = await clean(`<center>texte centré<script>alert(1)</script></center>`);
    expect(center.html).not.toContain("<center");
    expect(center.html).toContain("texte centré");
    expect(center.html).not.toContain("alert");

    const font = await clean(`<font color="red">texte coloré</font>`);
    expect(font.html).not.toContain("<font");
    expect(font.html).toContain("texte coloré");

    const outlook = await clean(`<o:p>texte outlook</o:p>`);
    expect(outlook.html).not.toContain("<o:p");
    expect(outlook.html).toContain("texte outlook");
  });
});

describe("sanitizeHtml — cid: et chaîne de prototypes", () => {
  // Régression : `cidMap[cid]` sur un objet ordinaire remonte la chaîne de prototypes.
  // <img src="cid:constructor"> résolvait vers une valeur héritée non `undefined`, et l'image
  // était réécrite vers /api/attachments/<valeur héritée> au lieu d'être supprimée.
  it("supprime une image cid:constructor plutôt que de la réécrire", async () => {
    const { html } = await clean(`<img src="cid:constructor">`, { logo123: 7 });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/api/attachments/");
  });

  it("supprime une image cid:toString plutôt que de la réécrire", async () => {
    const { html } = await clean(`<img src="cid:toString">`, { logo123: 7 });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/api/attachments/");
  });

  it("réécrit toujours un cid: réellement présent dans la table", async () => {
    const { html } = await clean(`<img src="cid:logo123">`, { logo123: 7 });
    expect(html).toContain('src="/api/attachments/7"');
  });
});
