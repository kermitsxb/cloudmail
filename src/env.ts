export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  // Token distinct de CF_API_TOKEN, portant la seule permission « Email Routing:
  // Read ». Séparer les deux garde le moindre privilège : une fuite du token
  // d'envoi ne donne pas accès à la configuration de routage, et réciproquement.
  CF_ROUTING_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  MAIL_DOMAIN: string;
  DEV_BYPASS_AUTH?: string;
}
