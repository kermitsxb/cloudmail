# Cloudmail

Your own webmail, running entirely on a single Cloudflare Worker.

Cloudmail receives the mail sent to your domain, stores it in your Cloudflare
account, and gives you a clean web interface to read, search, reply and send —
with no mail server to run and no third party reading your inbox. Each
installation is configured with its own domain and its own sending identities.

![Cloudmail screenshot](assets/img/screenshot.jpg)

## Features

- **Inbox, Sent and Trash**, with conversations grouped into threads
- **Full-text search** across subjects, senders and message bodies
- **Compose and reply** from any of your sending identities, each with its own
  display name
- **Attachments** — received and downloadable, stored safely
- **Safe HTML rendering** — messages are sanitized and shown in a sandboxed
  frame, with remote images blocked by default
- **Forwarding rules managed from the app** — send a copy of mail for
  `contact@` (or for every address) to an external mailbox, while still
  keeping it in Cloudmail
- **Private by default** — the whole app sits behind Cloudflare Access; only
  the addresses you allow can log in
- **Nothing is ever lost** — every received message is archived in its raw
  form before anything else happens

## How it works

```
Incoming mail ──▶ Email Routing ──▶ Worker email() ──▶ forward (optional)
                                          │
                                          ├──▶ R2  (raw message, attachments)
                                          └──▶ D1  (threads, messages, search index)

Browser ──▶ Cloudflare Access ──▶ Worker ──▶ /api/*  (Hono API)
                                         └─▶ SPA    (React, static assets)
```

A single Worker does three jobs: it receives mail from Cloudflare Email
Routing, serves a JSON API, and serves the web interface. Message metadata
lives in a D1 database and raw messages in an R2 bucket — both in your own
Cloudflare account. Sending goes through the Cloudflare Email Sending API.

## Requirements

- A domain managed on Cloudflare (active DNS zone)
- A **Workers Paid** plan — required for Email Sending (receiving via Email
  Routing is free)
- Cloudflare Access (Zero Trust) available on your account
- [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/) 10

## Try it locally

No Cloudflare account needed — D1 and R2 are simulated locally.

```bash
git clone https://github.com/kermitsxb/cloudmail.git
cd cloudmail
pnpm install
cp .dev.vars.example .dev.vars
pnpm wrangler d1 migrations apply cloudmail --local
pnpm dev
```

Then open the URL printed by Vite (usually <http://localhost:5173>).
`.dev.vars` sets `DEV_BYPASS_AUTH=1`, which turns off the Cloudflare Access
login for local development — **never set it on a deployed Worker**, or the app
becomes reachable without authentication.

The inbox starts empty. Sending doesn't work locally unless you put real
Cloudflare credentials in `.dev.vars`.

## Deploying to Cloudflare

These steps touch your paid Cloudflare account and make the service public,
so they're done by hand, **in this order**. The order matters: the database
must be ready before any mail can arrive, or that mail won't be indexed.

The examples use `example.com` and `mail.example.com` — replace them with your
own domain and subdomain.

> **Keep your values out of git.** Cloudmail is designed to be cloned by
> others, so the versioned `wrangler.jsonc` only holds placeholders. Your
> domain and database ID go in `wrangler.overrides.json` (gitignored), and
> everything else is a Wrangler secret. If a placeholder is left, the deploy
> command refuses and tells you which value is missing.

### 1. Create the database and the bucket

```bash
pnpm wrangler d1 create cloudmail
pnpm wrangler r2 bucket create cloudmail
```

Create `wrangler.overrides.json` at the repository root with the
`database_id` printed by the first command:

```json
{
  "routes": [{ "pattern": "mail.example.com", "custom_domain": true }],
  "d1_databases": [{ "database_id": "REPLACE_WITH_YOUR_ID" }],
  "vars": { "MAIL_DOMAIN": "example.com" }
}
```

You can check it at any time with `pnpm run config:check`.

### 2. Create the tables

```bash
pnpm run migrate:remote
```

**When upgrading an existing installation, run this again before deploying.**
It's harmless when there's nothing new, and a missing migration fails
silently (for example, forwarding just stops working).

### 3. Add your sending identity

```bash
pnpm run config
pnpm wrangler d1 execute cloudmail --remote -c .wrangler/generated.jsonc --command \
  "INSERT INTO identities (address, display_name, is_default) VALUES ('you@example.com', 'Your Name', 1)"
```

Recipients will see mail from `Your Name <you@example.com>`. More identities
can be added later from the **Identities** tab.

### 4. First deployment

```bash
pnpm run deploy
```

This makes the Worker exist so Email Routing can target it in step 6. It's
safe to have it online already: until Access is configured, it refuses every
request.

### 5. Verify your domain for sending

Cloudflare dashboard → **Email → Email Service → Sending** → add your domain
and publish the DNS records it asks for (SPF/DKIM). Wait for the **verified**
status.

### 6. Route incoming mail to Cloudmail

Cloudflare dashboard → **Email → Email Routing** → enable it, then create a
**catch-all** rule "Send to a Worker" pointing to `cloudmail`.

> **Already forwarding some addresses** (e.g. `contact@` to Gmail)? Leave those
> rules alone for now. A rule on a specific address takes priority over the
> catch-all, so that mail keeps reaching Gmail but not Cloudmail. You'll move
> them into Cloudmail at the very end.

### 7. Protect the app with Cloudflare Access

**Zero Trust → Access → Applications → Self-hosted**, on `mail.example.com`,
with a policy allowing only your own email address. Then store the
application's details as secrets:

```bash
pnpm wrangler secret put ACCESS_TEAM_DOMAIN   # <team>.cloudflareaccess.com
pnpm wrangler secret put ACCESS_AUD           # Application Audience (AUD) tag
pnpm wrangler secret put ALLOWED_EMAILS       # you@example.com (comma-separated)
```

### 8. Create two API tokens

In **My Profile → API Tokens**, create two tokens, each with a single
permission:

- **Email Sending: Send** — used to send mail
- **Email Routing: Read** — used to list the forwarding destinations you've
  verified

Keeping them separate means a leaked token can only do one thing.

### 9. Store the tokens

```bash
pnpm wrangler secret put CF_ACCOUNT_ID
pnpm wrangler secret put CF_API_TOKEN       # the "Email Sending" token
pnpm wrangler secret put CF_ROUTING_TOKEN   # the "Email Routing" token
```

### 10. Final deployment

```bash
pnpm run deploy
```

Open `https://mail.example.com`, log in through Access, and you're done.

**Moving existing forwards into Cloudmail.** For each address you left
forwarding in step 6: first create the same rule in Cloudmail's
**Forwarding** tab, *then* delete the old rule from the Email Routing
dashboard. In that order, no mail is ever left unforwarded. Send yourself a
test message afterwards — it should arrive both in Cloudmail and in the
external mailbox.

## Configuration reference

| Variable | Where | Purpose |
| --- | --- | --- |
| `MAIL_DOMAIN` | `wrangler.overrides.json` → `vars` | Your domain, used in the `Message-ID` of sent mail |
| `ACCESS_TEAM_DOMAIN` | secret | Your Cloudflare Access team domain |
| `ACCESS_AUD` | secret | The Access application's Audience tag |
| `ALLOWED_EMAILS` | secret | Address(es) allowed to log in, comma-separated |
| `CF_ACCOUNT_ID` | secret | Your Cloudflare account ID |
| `CF_API_TOKEN` | secret | Token with **Email Sending: Send** |
| `CF_ROUTING_TOKEN` | secret | Token with **Email Routing: Read** |
| `DEV_BYPASS_AUTH` | `.dev.vars` only | `1` disables login locally — never in production |

Secrets are set with `pnpm wrangler secret put NAME` and can't be read back;
run the command again to change one. For local development, put the same names
in `.dev.vars` (see `.dev.vars.example`).

## Development

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the Worker and the web interface locally |
| `pnpm test` | Runs the Worker tests, then the web interface tests |
| `pnpm typecheck` | Type-checks the Worker |
| `pnpm build` | Builds the web interface (and type-checks it) |
| `pnpm run deploy` | Builds and deploys to Cloudflare |
| `pnpm run migrate:remote` | Applies database migrations to your Cloudflare database |
| `pnpm run config:check` | Checks your `wrangler.overrides.json` without deploying |

Use `pnpm run deploy`, not `pnpm deploy` — the latter is a built-in pnpm
command and does nothing here.

Database changes always go in a **new** file in `migrations/`: a migration
that has already been applied is never replayed, even if you edit it.

## Operations

### Checking that no mail was lost

Every incoming message is saved to R2 before anything else. If a later step
fails, the message is still in R2 but won't show up in the app. To find such
messages, compare the keys known to the database with the objects in the
bucket:

```bash
# 1. Keys known to D1
pnpm wrangler d1 execute cloudmail --remote -c .wrangler/generated.jsonc --json \
  --command "SELECT raw_key FROM messages ORDER BY raw_key" \
  | jq -r '.[0].results[].raw_key' | sort > d1-raw-keys.txt

# 2. Objects in R2 — Wrangler can't list a bucket, so use R2's S3-compatible
#    API with an "Object Read" R2 token (R2 → Manage API tokens)
export AWS_ACCESS_KEY_ID=<R2 access key id>
export AWS_SECRET_ACCESS_KEY=<R2 secret access key>
export AWS_DEFAULT_REGION=auto
aws s3api list-objects-v2 \
  --endpoint-url "https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com" \
  --bucket cloudmail --prefix "raw/" \
  --query 'Contents[].Key' --output text \
  | tr '\t' '\n' | sort > r2-raw-keys.txt

# 3. In R2 but not in D1: messages that never made it into the app
comm -23 r2-raw-keys.txt d1-raw-keys.txt

#    In D1 but not in R2: interrupted deletions (the raw download returns 404)
comm -13 r2-raw-keys.txt d1-raw-keys.txt
```

To look at one of them:

```bash
pnpm wrangler r2 object get cloudmail/raw/<sha256>.eml --remote --file orphan.eml
head -40 orphan.eml
```

`rclone lsf` works as well as `aws` for step 2, and on a small volume the R2
dashboard's object browser is enough.

### Re-importing a message

`src/email.ts` exports a `reparse()` function that re-imports a stored message
— useful after a parsing fix, or to recover a message found above. It doesn't
forward the message again. There's no button or route for it yet: you need to
add a temporary route and run it against your remote data with
`pnpm wrangler dev --remote`. Remove that route afterwards and never deploy
it.

## Roadmap

- An admin entry point for re-importing messages, instead of a temporary route
- Automatic cleanup of the empty thread left behind when a message that was
  alone in its thread is re-imported
- Continuous integration running `pnpm test` and `pnpm build` on every pull
  request, and an English translation of the interface (it is currently
  French-only)
- Scheduled maintenance: automatic emptying of the trash after a set number of
  days, and a periodic check that counts messages stored in R2 but missing from
  the app, so lost mail is detected without the manual procedure above
- SPF/DKIM/DMARC results shown on each message, with a warning on likely
  spoofing, and a Spam folder

## Contributing

Issues and pull requests are welcome. Before opening one:

- run `pnpm test` and `pnpm build` (the build is what type-checks the web
  interface);
- never commit a value that belongs to a specific installation — a real
  domain, an email address, an account or database ID. Use `example.com` and
  `you@example.com` in tests and docs.

Contributor and agent guidelines, with the reasoning behind the project's
invariants, are in [`AGENTS.md`](AGENTS.md).

## Support

Found a bug or have a question? [Open an issue](https://github.com/kermitsxb/cloudmail/issues).

## Project status

Actively developed and used as a personal mailbox.

## License

Cloudmail is licensed under the [GNU Affero General Public License v3.0](LICENSE).
You're free to use, modify and self-host it; if you run a modified version as a
service others can reach over a network, you must make your modified source
code available to them under the same license.
