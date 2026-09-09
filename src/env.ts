export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  MAIL_DOMAIN: string;
  DEV_BYPASS_AUTH?: string;
}
