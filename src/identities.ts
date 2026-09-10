// Identités d'envoi : les couples (adresse, nom affiché) que l'utilisateur peut
// choisir comme expéditeur dans le formulaire de composition (voir Composer.tsx
// côté web). Le nom affiché est ce qui fait apparaître « Your Name »
// plutôt que l'adresse brute chez le destinataire — voir src/send/client.ts.

export type Identity = {
  address: string;
  displayName: string | null;
  isDefault: boolean;
};

type IdentityRow = { address: string; display_name: string | null; is_default: number };

const toIdentity = (row: IdentityRow): Identity => ({
  address: row.address,
  displayName: row.display_name,
  isDefault: row.is_default === 1,
});

export async function listIdentities(db: D1Database): Promise<Identity[]> {
  const { results } = await db
    .prepare("SELECT address, display_name, is_default FROM identities ORDER BY is_default DESC, address ASC")
    .all<IdentityRow>();
  return results.map(toIdentity);
}

export async function createIdentity(
  db: D1Database,
  input: { address: string; displayName: string | null },
): Promise<Identity | null> {
  // ON CONFLICT plutôt qu'un SELECT préalable : deux requêtes concurrentes sur la
  // même adresse passeraient toutes les deux une vérification préalable, seule la
  // contrainte UNIQUE de la table garantit l'absence de doublon.
  const row = await db
    .prepare(
      `INSERT INTO identities (address, display_name, is_default) VALUES (?, ?, 0)
       ON CONFLICT (address) DO NOTHING
       RETURNING address, display_name, is_default`
    )
    .bind(input.address, input.displayName)
    .first<IdentityRow>();
  return row ? toIdentity(row) : null;
}

export async function updateIdentity(
  db: D1Database,
  address: string,
  input: { displayName?: string | null; isDefault?: boolean },
): Promise<boolean> {
  const found = await db.prepare("SELECT 1 FROM identities WHERE address = ?").bind(address).first();
  if (!found) return false;

  const statements: D1PreparedStatement[] = [];
  if (input.displayName !== undefined) {
    statements.push(
      db.prepare("UPDATE identities SET display_name = ? WHERE address = ?").bind(input.displayName, address)
    );
  }
  if (input.isDefault !== undefined) {
    // Une seule identité par défaut : la mettre à jour retire le défaut de toutes
    // les autres, dans le même batch pour éviter un état intermédiaire à deux
    // défauts si une lecture survient entre les deux requêtes.
    statements.push(db.prepare("UPDATE identities SET is_default = 0"));
    if (input.isDefault) {
      statements.push(db.prepare("UPDATE identities SET is_default = 1 WHERE address = ?").bind(address));
    }
  }
  if (statements.length > 0) await db.batch(statements);
  return true;
}

export async function deleteIdentity(
  db: D1Database,
  address: string,
): Promise<"ok" | "not_found" | "last"> {
  // La dernière identité restante ne peut pas être supprimée : le formulaire
  // d'envoi se retrouverait sans expéditeur possible, et toute tentative d'envoi
  // échouerait ensuite avec "Expéditeur inconnu" — un refus explicite ici est plus
  // clair qu'un formulaire cassé découvert plus tard.
  const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM identities").first<{ n: number }>())!;
  if (n <= 1) {
    const found = await db.prepare("SELECT 1 FROM identities WHERE address = ?").bind(address).first();
    return found ? "last" : "not_found";
  }
  const { meta } = await db.prepare("DELETE FROM identities WHERE address = ?").bind(address).run();
  return meta.changes > 0 ? "ok" : "not_found";
}
