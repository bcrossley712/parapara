# Parapara! backup Worker

The server side of automatic backup (step 7b). It's a small private
store in front of a Cloudflare R2 bucket. The iPad encrypts everything
before it's uploaded, so neither this Worker nor Cloudflare can see a
drawing or a project name. The design and its reasons are in
`docs/DESIGN_NOTES.md` → "Backup (7b scoping)"; how it works and its
rules are in `docs/ARCHITECTURE.md` → "Backup".

- `src/index.js`: requests (join, sign in, blobs, manifests, settings,
  status), invites, limits and the pause switch
- `src/webauthn.js`: passkey checks and challenges
- `src/cleanup.js`: the hourly cleanup (old versions, deleted
  projects, unused vaults, usage totals)
- Tests: `tests/unit/worker.test.js` (run by `npm run test:unit` and
  before every deploy)

## One-time setup

1. **R2.** Cloudflare dashboard → **R2 Object Storage** → turn it on.
   It asks for a payment method; the free tier still applies. Then
   **Create bucket** named `parapara-backup`, with the default
   location. Leave **Public access** off, with no r2.dev URL and no
   custom domain on the bucket.
2. **Address.** `parapara-backup.kmsmallengines.com` (his business
   domain, on Cloudflare), set in `wrangler.toml` and in `BACKUP_URL`
   (`js/backup/client.js`); change both together. Cloudflare creates
   the DNS record itself on the first deploy. Passkeys belong to the
   app's address, not this one, so the Worker can move later without
   anyone setting backup up again (only the app's `BACKUP_URL` changes).
3. **Deploy token.** Dashboard → your profile → **API Tokens** →
   **Create Token** → template **Edit Cloudflare Workers** → choose your
   account and your domain's zone → Create, then copy it. If the first
   deploy fails on a permission error mentioning R2, edit the token and
   add **Account → Workers R2 Storage → Read**. On GitHub:
   repo → Settings → Secrets and variables → Actions → **New repository
   secret**:
   - `CLOUDFLARE_API_TOKEN`: the token
   - `CLOUDFLARE_ACCOUNT_ID`: shown on the dashboard's Workers & Pages
     overview (right side)
4. **First deploy.** Push, or run **Deploy backup Worker** from the
   repo's Actions tab. It runs the Worker's tests, then deploys.
5. **Secrets.** Dashboard → **Workers & Pages** → `parapara-backup` →
   **Settings** → **Variables and Secrets** → **Add**, type **Secret**:
   - `INVITES`: `name:code` pairs separated by commas, e.g.
     `hers:7Kq…,maya:p2X…`. A code is any long random text (24+
     characters).
   - `SIGNING_KEY`: any long random text (40+ characters). Nobody
     ever types it.
   Secrets take effect at once and survive deploys.
6. **Budget alert.** Manage Account → Billing → **Billable Usage** →
   **Create budget alert** at $1. Alerts only email you; the Worker's
   own limits are what cap the cost.
7. **Check it.** Open `https://<your address>/v1/status` in a browser.
   `{"error":"unauthorized"}` means it's up.

## Day to day

- **A friend's family:** add `name:code` to `INVITES` and give the
  parent the code. They enter it on their iPad under gear → **Backup**.
- **Stopping a family's backups:** remove their pair from `INVITES`.
  Their uploads are refused at once. Their vault is deleted 12 months
  after its last upload, or sooner by hand in R2.
- **Pausing everything:** add a plain variable (not a secret) `PAUSED`
  with any value. The app shows "backups are paused" and keeps its
  work queued. Delete the variable to resume.
- **Usage:** R2 → `parapara-backup` → Metrics. The Worker's own count
  is the object `meta/usage.json` in the bucket, updated hourly.
- **Logs:** Workers & Pages → `parapara-backup` → Logs.

## Limits (src/index.js `LIMITS`)

- 1 GB per vault
- 8 GB in all, which keeps inside R2's free 10 GB
- 25 MB per upload

Uploads past a limit are refused (`over-limit`), and the app says the
backup space is full. The totals come from the hourly cleanup, so they
can lag by up to an hour or so.

## What's stored (all under `vaults/<vaultId>/`)

- `vault.json`: passkey public keys, the vault secret wrapped by the
  passkey, and hashes of device tokens
- `b/<name>`: encrypted blobs, named by a keyed hash of their contents
- `p/<projectId>/m/<savedAt>.json`: encrypted manifests (versions) and
  deleted markers
- `p/<projectId>/index.json`: which blobs each project last used, and
  when (for the cleanup)
- `settings.json`: encrypted app settings (tool settings, recent
  colors)
