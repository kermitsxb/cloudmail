import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MessageBody } from "./MessageBody";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    Response.json({
      html: url.includes("images=allowed") ? '<img src="https://x/a.png">' : '<img data-blocked-src="https://x/a.png">',
      text: "version texte",
      hasRemoteImages: true,
    })
  ));
});

describe("MessageBody", () => {
  it("rend le HTML dans une iframe sandboxée sans scripts", async () => {
    render(<MessageBody messageId={1} />);
    const frame = await screen.findByTitle("Contenu du message");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("data-blocked-src");
  });

  it("propose d'afficher les images distantes puis les recharge", async () => {
    render(<MessageBody messageId={1} />);
    const bouton = await screen.findByRole("button", { name: /Afficher les images/ });
    await userEvent.click(bouton);
    const frame = await screen.findByTitle("Contenu du message");
    expect(frame.getAttribute("srcdoc")).toContain("https://x/a.png");
  });

  it("affiche le texte brut quand il n'y a pas de HTML", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ html: null, text: "juste du texte", hasRemoteImages: false })
    ));
    render(<MessageBody messageId={1} />);
    expect(await screen.findByText("juste du texte")).toBeDefined();
  });
});
