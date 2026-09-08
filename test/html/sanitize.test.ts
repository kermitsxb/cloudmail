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
});
