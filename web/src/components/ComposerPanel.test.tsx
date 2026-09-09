import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerPanel } from "./ComposerPanel";

describe("ComposerPanel", () => {
  it("affiche le titre et les enfants", () => {
    render(
      <ComposerPanel title="Nouveau message" onClose={() => {}}>
        <p>contenu</p>
      </ComposerPanel>,
    );
    expect(screen.getByText("Nouveau message")).toBeDefined();
    expect(screen.getByText("contenu")).toBeDefined();
  });

  it("expose un rôle dialog non modal", () => {
    render(
      <ComposerPanel title="Nouveau message" onClose={() => {}}>
        <p>contenu</p>
      </ComposerPanel>,
    );
    const dialog = screen.getByRole("dialog", { name: "Nouveau message" });
    expect(dialog.getAttribute("aria-modal")).toBeNull();
  });

  it("appelle onClose au clic sur le bouton fermer", async () => {
    const onClose = vi.fn();
    render(
      <ComposerPanel title="Nouveau message" onClose={onClose}>
        <p>contenu</p>
      </ComposerPanel>,
    );
    await userEvent.click(screen.getByRole("button", { name: /fermer/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("appelle onClose sur la touche Échap", async () => {
    const onClose = vi.fn();
    render(
      <ComposerPanel title="Nouveau message" onClose={onClose}>
        <p>contenu</p>
      </ComposerPanel>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("masque le contenu au clic sur réduire sans le démonter, sans appeler onClose", async () => {
    const onClose = vi.fn();
    render(
      <ComposerPanel title="Nouveau message" onClose={onClose}>
        <p>contenu</p>
      </ComposerPanel>,
    );
    await userEvent.click(screen.getByRole("button", { name: /réduire/i }));
    // Le contenu reste monté (pas retiré du DOM) pour ne pas perdre la saisie en cours,
    // simplement masqué visuellement.
    expect(screen.getByText("contenu")).not.toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("conserve la saisie du formulaire après une réduction puis un agrandissement", async () => {
    render(
      <ComposerPanel title="Nouveau message" onClose={() => {}}>
        <input aria-label="Objet" />
      </ComposerPanel>,
    );
    const input = screen.getByLabelText("Objet") as HTMLInputElement;
    await userEvent.type(input, "Bonjour");

    await userEvent.click(screen.getByRole("button", { name: /réduire/i }));
    await userEvent.click(screen.getByText("Nouveau message"));

    expect((screen.getByLabelText("Objet") as HTMLInputElement).value).toBe("Bonjour");
  });

  it("réaffiche le contenu au clic sur la barre de titre une fois réduit", async () => {
    render(
      <ComposerPanel title="Nouveau message" onClose={() => {}}>
        <p>contenu</p>
      </ComposerPanel>,
    );
    await userEvent.click(screen.getByRole("button", { name: /réduire/i }));
    await userEvent.click(screen.getByText("Nouveau message"));
    expect(screen.getByText("contenu")).toBeDefined();
  });

  it("ferme complètement au clic sur fermer même quand réduit", async () => {
    const onClose = vi.fn();
    render(
      <ComposerPanel title="Nouveau message" onClose={onClose}>
        <p>contenu</p>
      </ComposerPanel>,
    );
    await userEvent.click(screen.getByRole("button", { name: /réduire/i }));
    await userEvent.click(screen.getByRole("button", { name: /fermer/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
