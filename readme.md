<!-- title -->

# git-lfs-cf

<!-- /title -->

<!-- badges -->

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/license/mit)
[![CI](https://github.com/kitschpatrol/git-lfs-cf/actions/workflows/ci.yml/badge.svg)](https://github.com/kitschpatrol/git-lfs-cf/actions/workflows/ci.yml)

<!-- /badges -->

<!-- short-description -->

**A serverless Git LFS server for Cloudflare Workers + R2**

<!-- /short-description -->

## Overview

This project implements the [Git LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md) as a Cloudflare Worker backed by R2 (or any S3-compatible) storage.

It's designed primarily for use with projects hosted on GitHub, and transparently adopts GitHub's authentication and repository access policies as its own.

My objective was to create something that basically _feels like_ using GitHub's built-in LFS support, without the cost and opacity that comes with it.

Since access control is delegated to GitHub, adding LFS to a repo doesn't require any additional configuration on the LFS server. You just add a `.lfsconfig` file pointing to your hosted worker, e.g. `https://lfs.example.com/<repo-owner>/<repo-name>`.

A separate keypair-based authentication model is also available as an escape hatch for repositories hosted elsewhere or to accommodate future migration off of GitHub.

For ease of integration with GitHub Actions workflows, a [`kitschpatrol/github-action-checkout-git-lfs-cf`](https://github.com/kitschpatrol/github-action-checkout-git-lfs-cf) is available as a drop-in replacement for `actions/checkout` in any workflows requiring access to smudged LFS assets.

## Getting started

### Cloudflare setup

Do this once to host LFS files for as many repositories as you'd like. We'll assume you have the [`git`](https://git-scm.com/install/), [`pnpm`](https://pnpm.io/), [`gh`](https://cli.github.com/) and [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) CLI tools on your path.

1. Create an R2 bucket to store your LFS data, e.g. `example-lfs`:

   ```sh
   wrangler r2 bucket create example-lfs
   ```

2. Create a **read/write** account API token for the bucket:

   _This token signs upload URLs._

   1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/r2/api-tokens) and create an "Account API token"
   2. Token name: e.g. `R2 Example LFS Read Write Token`
   3. Permissions: Object Read & Write
   4. Specify Buckets: apply to `example-lfs` only

3. Create a **read-only** account API token for the bucket:

   _This token signs download URLs and is used for existence checks._

   1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/r2/api-tokens) and create an "Account API token"
   2. Token name: e.g. `R2 Example LFS Read Token`
   3. Permissions: Object Read
   4. Specify Buckets: apply to `example-lfs` only

4. Clone this repo:

   ```sh
   gh repo clone kitschpatrol/git-lfs-cf
   ```

5. Configure `wrangler.jsonc` in the cloned repository root:

   - `ALLOWED_OWNERS`: comma-separated GitHub users or orgs whose repositories may use the server. An empty value rejects everyone.
   - `routes`: your custom domain, e.g. `lfs.example.com`.
   - Optionally adjust `EXPIRY` (presigned URL lifetime in seconds) and `MAX_FILE_SIZE` (bytes, capped by [R2's single-PUT limit](https://developers.cloudflare.com/r2/platform/limits/)).

6. Provide the bucket credentials as Worker secrets in a `.env`:

   ```ini
   R2_S3_BUCKET = example-lfs
   R2_S3_ENDPOINT = <account-id>.r2.cloudflarestorage.com
   R2_S3_READ_KEY_ID = <read-only key id>
   R2_S3_READ_SECRET_KEY = <read-only secret>
   R2_S3_READ_WRITE_KEY_ID = <read/write key id>
   R2_S3_READ_WRITE_SECRET_KEY = <read/write secret>
   ```

   The checked-in `.template.env` can generate this from 1Password via `pnpm run init` (`op inject`) — point its `op://` references at your own vault items. The generated `.env` file is gitignored.

7. Deploy:

   ```sh
   pnpm run deploy
   ```

8. Protect:

   Optionally add a [Cloudflare rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) to block heavy traffic on the LFS hostname to blunt credential stuffing and abuse.

### Global Git setup

Do this once on your dev machine:

1. Install the Git LFS client if you haven't already:

   ```sh
   git lfs install
   ```

2. Set up authentication:

   ```sh
   git config --global credential.https://lfs.example.com.helper '!f() { echo username=gh; echo password=$(gh auth token); };f'
   ```

   Pulling your GitHub token from the `gh` CLI tool is recommended as the easiest "set and forget" credential configuration, but there are [other ways to authenticate](#authentication-strategies).

   Nothing is stored for the LFS host itself: Git runs this helper each time the server asks for credentials (typically once per pull or push), fetching the token from `gh` on demand. The token lives wherever `gh` already keeps your login — the system keychain on macOS — so rotating or revoking it through `gh auth` takes effect immediately. You can also set this config locally per-repo if you prefer.

### Git repository setup

Do this once for each repo you'd like to use your new LFS server in on your development machine:

1. Create a `.lfsconfig` file in the root of your repo:

   ```ini
   [lfs]
   url = https://lfs.example.com/<repo-owner>/<repo-name>
   ```

   No `locksverify` setting is needed — the server signals that locking is unsupported and clients disable it automatically.

2. Make sure Git has a credential for the LFS host, as configured in [Global Git setup](#global-git-setup) — or any of the [other authentication strategies](#authentication-strategies). To scope the helper to a single repo instead of every clone on the machine, drop the `--global` flag. It can't go in the committed `.lfsconfig`: Git's credential machinery doesn't read that file, deliberately, since a committed shell helper would let any cloned repo execute code.

3. Track some files and push:

   ```sh
   git lfs track "*.bin"
   git add .
   git commit -m "Add Git LFS"
   git push
   ```

4. Verify that large files are being tracked:

   ```sh
   git lfs ls-files
   ```

### CI setup (GitHub Actions)

If your actions don't need access to smudged LFS assets, then the typical `actions/checkout` action will continue to work just fine in your workflows. (Just don't set the `lfs: true` option.)

If you _do_ need access to the LFS assets, then you'll want to use [`kitschpatrol/github-action-checkout-git-lfs-cf`](https://github.com/kitschpatrol/github-action-checkout-git-lfs-cf) as a drop-in replacement for `actions/checkout`.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: kitschpatrol/github-action-checkout-git-lfs-cf@v1

  # Any other steps you'd like that need access to LFS assets...
```

By default, authentication is handled via an OIDC token. No secrets are stored, and fork PRs can't obtain the token. See the [action's readme](https://github.com/kitschpatrol/github-action-checkout-git-lfs-cf) for more details on configuration and authentication.

## Authentication strategies

The worker accepts four kinds of credential, all sent through Git's standard Basic auth machinery (except OIDC in CI, which is wired up for you by the checkout action). Pick per person and per context — they coexist on the same server. Public GitHub repos additionally allow [anonymous downloads](#what-if-my-repo-is-public) with no credential at all.

### GitHub `gh` token

The recommended strategy for people working on GitHub-hosted repos. The credential helper from [Global Git setup](#global-git-setup) forwards your existing [GitHub CLI](https://cli.github.com/) login on demand — nothing new to create, store, or rotate, and revoking the login through `gh auth` takes effect immediately. Download and upload permission mirror your pull and push permission on the GitHub repository named in the URL. One caveat: the `gh` OAuth token is scope-based, so it carries access to _all_ your repositories — it can't be narrowed to just one. If that bothers you, use a fine-grained access token instead.

### GitHub access tokens

A [personal access token](https://github.com/settings/tokens) works anywhere the `gh` token does, without requiring the CLI: configure a stored credential helper (`git config --global credential.helper osxkeychain` on macOS), then enter your GitHub username and the token when prompted on first transfer. Fine-grained tokens are the only GitHub credential that can be scoped to a single repository.

Token caveats: a classic token needs the `repo` scope to see private repositories at all — without it the server responds 404, not 403. Fine-grained tokens grant more than they appear to: GitHub reports your _role_ on the repository rather than the token's restricted permissions, so any fine-grained token that can read a repo's metadata carries your full LFS access — scoping a token to read-only does not make LFS read-only.

### GitHub Actions OIDC

For CI only, and download-only by design. The workflow requests a short-lived OIDC token from GitHub Actions, which the worker verifies against GitHub's public keys — no stored secrets, and fork PRs can't obtain the token. The token's audience must equal the LFS server's hostname, and its cryptographically verified `repository` claim must match the repo in the URL. The [checkout action](https://github.com/kitschpatrol/github-action-checkout-git-lfs-cf) handles all of this; see [`sample-workflows/`](./sample-workflows/) for manual wiring.

### Self-issued tokens

The escape hatch when GitHub isn't in the picture: signed Ed25519 JWTs minted by the server operator and verified against a public key you configure, with no external calls at all. They serve two purposes — access to [repositories not hosted on GitHub](#repos-not-on-github-self-issued-tokens), and [explicit grants](#sharing-a-github-backed-repo-without-a-github-account) into a GitHub-backed repo's storage for collaborators without GitHub accounts. The token is used exactly like an access token (the Basic auth password); revocation is by expiry or key rotation only.

## Advanced configuration

### Repos not on GitHub (self-issued tokens)

If a repository isn't hosted on GitHub — a bare repo on your own server, a mirror, a local-only project — there's no forge API to delegate authorization to. Instead, whoever operates the LFS server mints signed tokens and hands them out. The worker verifies them against a public key with no external calls and no user database; the private key never leaves the operator's machine.

The `pnpm run token` commands below run in your clone of this repository (the same one you deploy the worker from), not in the repo that uses LFS.

Self-issued repos are addressed by a bare single-segment name — `https://lfs.example.com/<repo-name>` — with no owner. The path shape selects the credential type: single-segment URLs accept only self-issued tokens, while owner-qualified `/<owner>/<repo>` URLs accept GitHub credentials — or a self-issued token carrying an [explicit grant](#sharing-a-github-backed-repo-without-a-github-account) minted with `--github-repo-id`. Because the token itself is the authorization, `ALLOWED_OWNERS` plays no part for single-segment repos.

**One-time server setup:**

1. Generate a signing key pair:

   ```sh
   pnpm run token generate-key
   ```

   The private key is written to `token-signing-key.json` (gitignored). Copy the printed public key into `SELF_ISSUED_TOKEN_PUBLIC_KEY` in `wrangler.jsonc` and redeploy with `pnpm run deploy`. Leaving the variable empty keeps self-issued tokens disabled.

**Per person (or machine), by the operator:**

2. Mint a token — no redeploy needed, the deployed worker accepts it immediately:

   ```sh
   pnpm run token mint --repo example-repo --host lfs.example.com --pull --push --expiry 90d --subject alice
   ```

   The `--host` value becomes the token's audience and must match the LFS server's hostname exactly. Grant `--pull`, `--push`, or both; `--subject` is an optional label recorded in the token. Send the printed token to its holder over a reasonable channel — it's a bearer credential.

**In the repo that uses LFS, by the token holder:**

3. Point the repo's `.lfsconfig` at the server, using the single-segment URL whose name matches the token's `--repo` value:

   ```ini
   [lfs]
   url = https://lfs.example.com/example-repo
   ```

4. Give Git the token as the Basic auth password for the LFS host, exactly like a personal access token — for example with the keychain helper (`git config --global credential.helper osxkeychain`), entering any username and the token when prompted.

### Sharing a GitHub-backed repo without a GitHub account

Normally a GitHub-hosted repo's LFS objects require GitHub credentials. To hand access to someone outside GitHub entirely, mint an explicit grant by adding `--github-repo-id` with the repo's numeric ID (from `gh api repos/<owner>/<name> --jq .id`) and the owner-qualified `--repo` path:

```sh
pnpm run token mint --repo example-owner/example-repo --github-repo-id 12345678 --host lfs.example.com --pull --expiry 30d --subject contractor
```

The holder uses the repo's normal `.lfsconfig` (the same owner-qualified URL as everyone else) with the token as their password. Understand what this trades away: the grant bypasses GitHub's permission model, so removing someone from the GitHub repo does **not** revoke their token — only expiry or key rotation does. Keep these expiries short.

### Self-issued token caveats

- **Revocation is by expiry or key rotation.** There's no per-token revocation list — keep expiries short-ish, and rerun `generate-key` (after moving the old key file aside) to invalidate every outstanding token at once.
- **Renames move storage.** Objects are stored under a prefix derived from the repo name (`self/<repo-name>`), so renaming a repo orphans its objects until they're re-uploaded or copied to the new prefix in the bucket. GitHub-backed repos don't have this caveat because they're keyed by GitHub's immutable repo ID.
- **The public key is not a secret**, but `token-signing-key.json` is — anyone holding it can mint tokens for any self-issued repo, and explicit grants into any GitHub-backed repo's storage. Guard it accordingly.

### Alternate storage providers

Storage speaks plain SigV4, so any S3-compatible provider that supports presigned URLs and virtual-hosted-style addressing (`https://<bucket>.<endpoint>/…`) should work by pointing `R2_S3_ENDPOINT` at it — though only R2 is tested. Providers that require path-style addressing or an explicit signing region would need small changes. Note that upload integrity enforcement depends on the provider validating the signed `x-amz-content-sha256` header, as R2 does — on providers that ignore it, uploads are still size-capped but not hash-pinned.

## Limits

- Objects up to `MAX_FILE_SIZE` (default just under 5 GB, R2's single-PUT ceiling). Multipart uploads for larger objects are not supported.
- Batches up to 100 objects (the git-lfs client default). Each object costs one R2 subrequest, so the Workers paid plan's subrequest limit is recommended over the free plan's 50.
- File locking is not supported.

## Price Comparison

The table below compares monthly costs across different storage requirements. Figures are metered LFS charges only — GitHub plan seat prices are shown as the parenthetical, and both free allowances (10 GiB storage + 10 GiB/month bandwidth on Free/Pro, 250 GiB each on Team/Enterprise) are already deducted.

With the $5 Workers paid plan factored in, savings kick in around the 50 GiB mark on the free plan — earlier if the free Workers plan suffices, later if your GitHub plan's allowance covers you. The gap then grows with download volume, which R2 doesn't meter at all.

| Stored  | Downloaded / month | GitHub Free | GitHub Team       | R2     | R2 + Workers Plan |
| ------- | ------------------ | ----------- | ----------------- | ------ | ----------------- |
| 10 GiB  | 10 GiB             | $0          | $0 (+$4/user)     | $0     | $5                |
| 20 GiB  | 30 GiB             | $2.45       | $0 (+$4/user)     | $0.17  | $5.17             |
| 50 GiB  | 150 GiB            | $15.05      | $0 (+$4/user)     | $0.66  | $5.66             |
| 100 GiB | 500 GiB            | $49.18      | $21.88 (+$4/user) | $1.46  | $6.46             |
| 500 GiB | 1 TiB              | $123.03     | $85.23 (+$4/user) | $7.90  | $12.90            |
| 2 TiB   | 5 TiB              | $589.79     | $552 (+$4/user)   | $32.84 | $37.84            |

Based on August 2026 [GitHub](https://docs.github.com/en/billing/concepts/product-billing/git-lfs) and [Cloudflare](https://developers.cloudflare.com/r2/pricing/) (standard storage) prices.

## FAQ

### What if my repo is private?

Private repos are the primary use case: the worker mirrors your GitHub permissions, so collaborators use their existing credentials and outsiders get a 404 — the same "this repo doesn't exist for you" behavior GitHub itself gives. Note that a classic personal access token needs the `repo` scope to see private repositories at all.

### What if my repo is public?

Anonymous downloads just work, mirroring GitHub's own LFS behavior: the worker confirms the repo is public via an unauthenticated GitHub API lookup (which by construction can't see private repos), then serves download URLs with no credential required — so `git clone` works for anyone. Uploads always require a credential with push permission. Two caveats: a repo flipped from public to private stays anonymously downloadable for up to the five-minute authorization cache, and if the unauthenticated GitHub API rate limit is hit the server falls back to prompting for credentials, where any GitHub account works.

### Why not use GitHub's built-in LFS support?

You should probably just stick with GitHub unless you're storing a lot of stuff or using a lot of bandwidth. The GitHub free plan provides 10 GiB of storage and bandwidth per month, and Team / Enterprise plans provide 250 GiB; past those allowances the [price comparison](#price-comparison) tips quickly in R2's favor, since GitHub meters every download and R2's egress is free.

Hosting your own LFS also provides more flexibility for moving your repo elsewhere, and sovereignty over your stored data. (For example, deleting data from GitHub LFS requires opening a support ticket.)

### What if I put the wrong path in the `.lfsconfig` url?

Almost always a clear error: unknown repos get a 404, owners outside `ALLOWED_OWNERS` get a 403, and token-bound credentials (OIDC, self-issued) refuse any URL that doesn't match their signed claims. The one silent case is a personal access token with a wrong-but-real repo path you can push to — uploads would land in _that_ repo's storage namespace, and downloads failing with per-object 404s are usually the tell.

### What if I have a file larger than 5 GB?

It won't work: uploads go directly to R2 as a single presigned PUT, which caps out at [R2's \~5 GB limit](https://developers.cloudflare.com/r2/platform/limits/), and the server rejects larger objects with a per-object 413. Keep such files out of LFS tracking or split them — multipart upload support would be required to lift this.

### What if I rename my GitHub repo?

Nothing breaks: objects are stored under GitHub's immutable numeric repo ID, and the GitHub API follows renames, so even stale `.lfsconfig` URLs keep resolving. Update the URL at your convenience — mainly to guard against the old name later being reused by a different repo.

### What if I transfer ownership of my GitHub repo?

The numeric repo ID survives ownership transfers, so stored objects remain accessible. Add the new owner to `ALLOWED_OWNERS`, redeploy, and update the `.lfsconfig` URL to the new path.

### What if I delete my repo?

TODO

### What if my repo's not hosted on GitHub?

Use [self-issued tokens](#repos-not-on-github-self-issued-tokens): the repo gets a single-segment URL (`https://lfs.example.com/<repo-name>`) and you mint signed tokens for each person — no GitHub involvement at any step.

### What if I want to migrate my repo off GitHub in the future?

No history rewriting needed: LFS objects are content-addressed, so you copy them bucket-side from the numeric GitHub prefix to `self/<repo-name>`, commit a `.lfsconfig` pointing at the single-segment URL, and switch collaborators to self-issued tokens. Existing clones that check out pre-migration history need a one-line `git config lfs.url` override, which takes precedence over the committed `.lfsconfig` everywhere.

### What if I'm not on GitHub now, but move there later?

The same move in reverse: once the repo exists on GitHub, look up its numeric ID (`gh api repos/<owner>/<name> --jq .id`), copy objects from `self/<repo-name>` to that ID's prefix in the bucket, and point `.lfsconfig` at the owner-qualified URL — GitHub credentials take over from there.

## Maintainers

[kitschpatrol](https://github.com/kitschpatrol)

## Acknowledgments

Cloudflare workers approach inspired by [git-fs-s3-proxy](https://github.com/twilligon/git-lfs-s3-proxy).

GitHub authentication strategy inspired by [Alan Edwardes'](https://alanedwardes.com/) [Estranged.Lfs](https://github.com/alanedwardes/Estranged.Lfs)

<!-- contributing -->

## Contributing

[Issues](https://github.com/kitschpatrol/git-lfs-cf/issues) are welcome and appreciated.

Please open an issue to discuss changes before submitting a pull request. Unsolicited PRs (especially AI-generated ones) are unlikely to be merged.

This repository uses [@kitschpatrol/shared-config](https://github.com/kitschpatrol/shared-config) (via its `ksc` CLI) for linting and formatting, plus [MDAT](https://github.com/kitschpatrol/mdat) for readme placeholder expansion.

<!-- /contributing -->

<!-- license -->

## License

[MIT](license.txt) © [Eric Mika](https://ericmika.com)

<!-- /license -->
