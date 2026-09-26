// Catalogue de référence : sa forme définit le type `Catalog` que doivent
// respecter toutes les autres langues. Une entrée paramétrée est une fonction
// typée plutôt qu'un gabarit à interpoler : les paramètres sont vérifiés par tsc.
const plural = new Intl.PluralRules("fr-FR");

export const fr = {
  localeName: "Français",
  common: {
    loading: "Chargement…",
    cancel: "Annuler",
    save: "Enregistrer",
    delete: "Supprimer",
    close: "Fermer",
    noSubject: "(sans objet)",
    localPart: "Partie locale",
    deleteFailed: (detail: string) => `Suppression impossible : ${detail}`,
  },
  app: {
    searchPlaceholder: "Rechercher…",
    searchLabel: "Rechercher dans les conversations",
    refreshLabel: "Rafraîchir la liste des conversations",
    refreshTitle: "Rafraîchir",
    selectConversation: "Sélectionnez une conversation.",
  },
  sidebar: {
    nav: "Dossiers",
    compose: "Nouveau message",
    inbox: "Boîte de réception",
    sent: "Envoyés",
    trash: "Corbeille",
    identities: "Identités",
    forwarding: "Redirections",
    maintenance: "Maintenance",
    language: "Langue",
  },
  threadList: {
    empty: "Aucun message ici.",
    label: "Conversations",
    hasAttachment: "Contient une pièce jointe",
    loadMore: "Charger plus",
    trashNotice: (days: number) =>
      `Les messages de la corbeille sont supprimés définitivement après ${days} ${plural.select(days) === "one" ? "jour" : "jours"}.`,
  },
  threadView: {
    to: "À :",
    cc: "Cc :",
    parseError: "Ce message n'a pas pu être analysé correctement.",
    viewRaw: "Voir le message brut",
    bodyTruncated: "Corps trop volumineux : seul le début a été conservé en base.",
    reply: "Répondre",
    markUnread: "Marquer comme non lu",
    reimport: "Réimporter",
    reimporting: "Réimport…",
    reimportFailed: (detail: string) => `Réimport impossible : ${detail}`,
    openFailed: (detail: string) => `Impossible d'ouvrir cette conversation : ${detail}`,
    messageCount: (n: number) => `${n} ${plural.select(n) === "one" ? "message" : "messages"}`,
  },
  messageBody: {
    loadFailed: (detail: string) => `Impossible de charger le message : ${detail}`,
    remoteImagesBlocked: "Les images distantes sont bloquées pour protéger ta vie privée.",
    showImages: "Afficher les images",
    frameTitle: "Contenu du message",
  },
  composerPanel: {
    expand: "Agrandir",
    minimize: "Réduire",
  },
  composer: {
    from: "De",
    to: "Destinataires",
    toPlaceholder: "zoe@example.com, bob@example.com",
    subject: "Objet",
    message: "Message",
    attachments: "Pièces jointes",
    removeAttachment: (filename: string) => `Retirer ${filename}`,
    send: "Envoyer",
    attachmentsTooLarge: "L'ensemble dépasse la limite de 5 MiB",
    messageTooLarge: "Le message dépasse la limite de 5 MiB",
    noRecipient: "Indique au moins un destinataire",
    bounces: (list: string) => `Rejets définitifs : ${list}`,
    fileReadFailed: "Impossible de lire le fichier",
  },
  identities: {
    title: "Identités",
    add: "Ajouter une identité",
    intro:
      "Les identités disponibles apparaissent dans le sélecteur « De » du formulaire d'envoi. Le nom affiché est celui que verra le destinataire dans son client de messagerie.",
    readFailed: (detail: string) => `Impossible de lire les identités : ${detail}`,
    configFailed:
      "Le domaine de messagerie n'a pas pu être lu : les adresses seraient incomplètes, les identités ne sont donc pas affichées. Rechargez la page.",
    empty: "Aucune identité.",
    updateFailed: (detail: string) => `Modification impossible : ${detail}`,
    isDefault: "Par défaut",
    makeDefault: "Définir par défaut",
    makeDefaultLabel: (address: string) => `Définir ${address} comme identité par défaut`,
    deleteLabel: (address: string) => `Supprimer l'identité ${address}`,
    address: "Adresse",
    displayName: "Nom affiché",
    displayNamePlaceholder: "Votre nom",
  },
  forwarding: {
    title: "Redirections",
    add: "Ajouter une redirection",
    intro:
      "Toutes les règles qui correspondent à une adresse s'appliquent : un message reçu peut partir vers plusieurs destinations. Il reste dans tous les cas archivé dans Cloudmail.",
    allAddresses: "Toutes les adresses",
    lastFailure: (detail: string) => `Dernière tentative en échec : ${detail}`,
    toggleFailed: (detail: string) => `Activation inchangée : ${detail}`,
    toggleLabel: (enabled: boolean, source: string) =>
      `${enabled ? "Désactiver" : "Activer"} la redirection ${source}`,
    active: "Active",
    inactive: "Inactive",
    deleteLabel: (source: string) => `Supprimer la redirection ${source}`,
    sourceLegend: "Adresse source",
    oneAddress: "Une adresse",
    wholeDomain: "Toutes les adresses du domaine",
    destinationsUnavailable:
      "Impossible de lire les destinations vérifiées du compte Cloudflare. Vérifiez que le secret CF_ROUTING_TOKEN est posé sur le Worker.",
    noDestinationBefore: "Aucune destination vérifiée. Ajoutez-en une depuis le",
    noDestinationLink: "dashboard Cloudflare",
    noDestinationAfter: ", puis cliquez le lien de confirmation reçu par mail.",
    to: "Vers",
    choose: "── choisir ──",
    readFailed: (detail: string) => `Impossible de lire les redirections : ${detail}`,
    migrationHintBefore: "Si la fonctionnalité vient d'être déployée, la migration",
    migrationHintAfter:
      "n'a peut-être pas été appliquée sur la base D1 (voir l'étape 2 de la mise en service, dans le README).",
    configFailed:
      "Le domaine de messagerie n'a pas pu être lu : les adresses sources seraient incomplètes, les redirections ne sont donc pas affichées. Rechargez la page.",
    empty: "Aucune redirection.",
  },
  maintenance: {
    title: "Maintenance",
    size: { bytes: "o", kilobytes: "Ko", megabytes: "Mo" },
    reimporting: "Réimport en cours…",
    scheduled: {
      title: "Maintenance planifiée",
      intro:
        "Chaque nuit, Cloudmail vide la corbeille des anciens messages et vérifie qu'aucun message reçu ne manque à la boîte.",
      retention: (days: number) =>
        `La corbeille est vidée des messages de plus de ${days} ${plural.select(days) === "one" ? "jour" : "jours"}.`,
      retentionDisabled: "Purge automatique de la corbeille désactivée.",
      neverRun: "Aucun passage planifié pour l'instant.",
      lastRun: (date: string) => `Dernier passage : ${date}`,
      purged: (n: number) =>
        plural.select(n) === "one" ? `${n} message supprimé de la corbeille` : `${n} messages supprimés de la corbeille`,
      purgeFailed: (n: number) =>
        `${n} ${plural.select(n) === "one" ? "suppression en échec" : "suppressions en échec"}`,
      purgeRemaining: (n: number) =>
        plural.select(n) === "one"
          ? `${n} message reste à supprimer au prochain passage`
          : `${n} messages restent à supprimer au prochain passage`,
      runFailed: (detail: string) => `Erreur lors du passage : ${detail}`,
      neverChecked: "Stockage jamais vérifié.",
      orphansNone: "Aucun message orphelin.",
      orphansFound: (n: number) =>
        plural.select(n) === "one" ? `${n} message orphelin détecté` : `${n} messages orphelins détectés`,
      orphansPartial: (n: number) =>
        `Vérification partielle : ${n} ${plural.select(n) === "one" ? "orphelin" : "orphelins"} parmi les 10 000 premiers objets`,
      checkedAt: (date: string) => `vérifié le ${date}`,
      recheck: "Relancer la vérification",
      rechecking: "Vérification…",
    },
    orphans: {
      title: "Messages orphelins",
      intro:
        "Messages conservés dans le stockage mais absents de la boîte, après un échec lors de leur réception.",
      scan: "Analyser le stockage",
      scanning: "Analyse en cours…",
      resume: "Reprendre",
      empty: "Aucun message orphelin.",
      selectAll: "Tout sélectionner",
      reimportSelection: (n: number) => `Réimporter la sélection (${n})`,
      select: (key: string) => `Sélectionner ${key}`,
      meta: (size: string, date: string) => `${size} — reçu le ${date}`,
    },
    parseErrors: {
      title: "Erreurs d'analyse",
      intro:
        "Messages reçus qui n'ont pas pu être analysés. Réimportez-les après une mise à jour de Cloudmail.",
      empty: "Aucun message en erreur d'analyse.",
      reimportAll: (n: number) => `Tout réimporter (${n})`,
      summary: (succeeded: number, failed: number) => `${succeeded} réanalysé(s), ${failed} échec(s)`,
    },
  },
  reimportOutcome: {
    imported: "Importé",
    reparsed: "Réanalysé",
    duplicate: (id: number) => `Déjà présent (message #${id})`,
    notFound: "Introuvable dans le stockage",
    error: (detail: string) => `Échec : ${detail}`,
  },
  errors: {
    // Clés = codes stables renvoyés par l'API (src/api/routes.ts, src/auth/access.ts,
    // src/index.ts). Une fonction reçoit le `message` du serveur quand il porte un
    // détail utile qu'on n'a pas les moyens de traduire (erreur de l'API Cloudflare).
    codes: {
      invalid_id: "Identifiant invalide.",
      invalid_body: "Requête invalide.",
      invalid_query: "Requête invalide.",
      not_found: "Élément introuvable : il a peut-être déjà été supprimé.",
      purge_in_progress: "La suppression de ce message est en cours. Réessayez dans un instant.",
      duplicate_identity: "Cette identité existe déjà.",
      last_identity: "Impossible de supprimer la dernière identité restante.",
      duplicate_rule: "Cette redirection existe déjà.",
      unverified_destination: "Cette destination n'est pas vérifiée sur le compte Cloudflare.",
      routing_unavailable: "Impossible de lire les destinations vérifiées du compte Cloudflare.",
      storage_unavailable: "Stockage indisponible : réessayez dans un instant.",
      unknown_sender: "Expéditeur inconnu.",
      too_large: "Le message dépasse la limite de 5 MiB.",
      send_failed: (detail: string) => `Échec de l'envoi : ${detail}`,
      unauthenticated: (detail: string) => `Accès refusé : ${detail}`,
      internal_error: "Erreur interne du serveur.",
    },
    reasons: {
      invalid_local_part: "Partie locale invalide.",
    },
    http: (status: number) => `Erreur ${status}`,
    unknown: "Erreur inconnue",
  },
};

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : { [K in keyof T]: Widen<T[K]> };

export type Catalog = Widen<typeof fr>;
