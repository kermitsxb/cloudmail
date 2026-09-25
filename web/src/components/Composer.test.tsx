import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { LocaleSelect } from "./LocaleSelect";
import { LocaleProvider } from "../i18n";
import { renderWithI18n as render } from "../test/i18n";

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const identities = [{ address: "thomas@example.com", displayName: "Thomas", isDefault: true }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/identities")) return Response.json(identities);
    return Response.json({ id: 1, delivered: ["zoe@example.com"], queued: [], permanentBounces: [] });
  }));
});

describe("Composer", () => {
  it("envoie le message saisi", async () => {
    wrap(<Composer mode="new" onClose={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Destinataires"), "zoe@example.com");
    await userEvent.type(screen.getByLabelText("Objet"), "Bonjour");
    await userEvent.type(screen.getByLabelText("Message"), "Salut");
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));

    await waitFor(() => {
      const body = JSON.parse((vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        from: "thomas@example.com", to: ["zoe@example.com"], subject: "Bonjour", text: "Salut",
      });
    });
  });

  it("refuse d'envoyer sans destinataire", async () => {
    wrap(<Composer mode="new" onClose={() => {}} />);
    await screen.findByLabelText("Destinataires");
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    expect(await screen.findByText(/au moins un destinataire/i)).toBeDefined();
  });

  it("préremplit une réponse avec le sujet et le destinataire", async () => {
    wrap(
      <Composer
        mode="reply"
        replyTo={{
          id: 1, messageId: "<p@x>", direction: "in", folder: "inbox",
          from: { address: "zoe@example.com", name: "Zoé" }, to: [], cc: [],
          subject: "Facture", text: "", html: null, receivedAt: 1, isRead: true,
          parseError: false,
    bodyTruncated: false, rawKey: "raw/c.eml", attachments: [],
        }}
        onClose={() => {}}
      />
    );
    expect((await screen.findByLabelText("Destinataires") as HTMLInputElement).value).toBe("zoe@example.com");
    expect((screen.getByLabelText("Objet") as HTMLInputElement).value).toBe("Re: Facture");
  });

  it("refuse un fichier qui ferait dépasser 5 MiB", async () => {
    wrap(<Composer mode="new" onClose={() => {}} />);
    const input = await screen.findByLabelText("Pièces jointes") as HTMLInputElement;
    const gros = new File([new Uint8Array(6 * 1024 * 1024)], "gros.bin");
    await userEvent.upload(input, gros);
    expect(await screen.findByText(/5 MiB/)).toBeDefined();
  });

  it("refuse l'envoi si le corps seul dépasse la limite, sans pièce jointe", async () => {
    wrap(<Composer mode="new" onClose={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Destinataires"), "zoe@example.com");
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "a".repeat(6 * 1024 * 1024) } });
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));

    expect(await screen.findByText(/5 MiB/)).toBeDefined();
    const sendCalls = vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).includes("/identities"));
    expect(sendCalls.length).toBe(0);
  });

  it("refuse l'envoi quand les pièces jointes seules passent mais l'ensemble dépasse", async () => {
    wrap(<Composer mode="new" onClose={() => {}} />);
    const input = await screen.findByLabelText("Pièces jointes") as HTMLInputElement;
    const fichier = new File([new Uint8Array(3.5 * 1024 * 1024)], "moyen.bin");
    await userEvent.upload(input, fichier);
    expect(screen.queryByText(/5 MiB/)).toBeNull();

    await userEvent.type(screen.getByLabelText("Destinataires"), "zoe@example.com");
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "a".repeat(2 * 1024 * 1024) } });
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));

    expect(await screen.findByText(/5 MiB/)).toBeDefined();
    const sendCalls = vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).includes("/identities"));
    expect(sendCalls.length).toBe(0);
  });

  it("affiche l'erreur renvoyée par l'API", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes("/identities")
        ? Response.json(identities)
        : Response.json({ error: { code: "send_failed", message: "Domaine non vérifié" } }, { status: 400 })
    );
    wrap(<Composer mode="new" onClose={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Destinataires"), "zoe@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    expect(await screen.findByText("Échec de l'envoi : Domaine non vérifié")).toBeDefined();
  });

  it("s'affiche en anglais", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Composer mode="new" onClose={() => {}} /></QueryClientProvider>, { locale: "en" });
    expect(await screen.findByLabelText("To")).toBeDefined();
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
  });

  it("retraduit une erreur déjà affichée après un changement de langue", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtlRender(
      <LocaleProvider initialLocale="fr">
        <LocaleSelect />
        <QueryClientProvider client={qc}>
          <Composer mode="new" onClose={() => {}} />
        </QueryClientProvider>
      </LocaleProvider>,
    );

    await screen.findByLabelText("Destinataires");
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    expect(await screen.findByText("Indique au moins un destinataire")).toBeDefined();

    await userEvent.selectOptions(screen.getByLabelText("Langue"), "en");

    expect(await screen.findByText("Enter at least one recipient")).toBeDefined();
    expect(screen.queryByText("Indique au moins un destinataire")).toBeNull();
  });

  it("signale un échec de lecture de fichier sans laisser de rejet non géré", async () => {
    class FailingFileReader {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      error = new Error("boom");
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("FileReader", FailingFileReader as unknown as typeof FileReader);

    try {
      wrap(<Composer mode="new" onClose={() => {}} />);
      const input = (await screen.findByLabelText("Pièces jointes")) as HTMLInputElement;
      const file = new File(["a"], "a.txt");
      await userEvent.upload(input, file);
      expect(await screen.findByText("Impossible de lire le fichier")).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
