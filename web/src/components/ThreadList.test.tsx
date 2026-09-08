import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadList } from "./ThreadList";
import type { ThreadSummary } from "../api/client";

const threads: ThreadSummary[] = [
  { id: 1, subject: "Facture", snippet: "Voici la facture", lastMessageAt: 1757318400,
    messageCount: 2, unreadCount: 1, participants: ["zoe@example.com"], hasAttachments: true },
  { id: 2, subject: "Réunion", snippet: "Demain 14h", lastMessageAt: 1757232000,
    messageCount: 1, unreadCount: 0, participants: ["bob@example.com"], hasAttachments: false },
];

describe("ThreadList", () => {
  it("affiche le sujet et l'extrait de chaque thread", () => {
    render(<ThreadList threads={threads} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("Facture")).toBeDefined();
    expect(screen.getByText("Demain 14h")).toBeDefined();
  });

  it("marque visuellement les threads non lus", () => {
    render(<ThreadList threads={threads} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("option", { name: /Facture/ }).getAttribute("data-unread")).toBe("true");
    expect(screen.getByRole("option", { name: /Réunion/ }).getAttribute("data-unread")).toBe("false");
  });

  it("signale la présence de pièces jointes", () => {
    render(<ThreadList threads={threads} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByLabelText("Contient une pièce jointe")).toBeDefined();
  });

  it("remonte la sélection", async () => {
    const onSelect = vi.fn();
    render(<ThreadList threads={threads} selectedId={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("option", { name: /Facture/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("affiche un état vide explicite", () => {
    render(<ThreadList threads={[]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText(/Aucun message/)).toBeDefined();
  });
});

describe("ThreadList — pagination", () => {
  it("propose de charger la page suivante quand il en reste une", async () => {
    const onLoadMore = vi.fn();
    render(
      <ThreadList threads={threads} selectedId={null} onSelect={() => {}} hasMore onLoadMore={onLoadMore} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Charger plus/ }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("ne propose rien quand la dernière page est atteinte", () => {
    render(<ThreadList threads={threads} selectedId={null} onSelect={() => {}} hasMore={false} />);
    expect(screen.queryByRole("button", { name: /Charger plus/ })).toBeNull();
  });
});
