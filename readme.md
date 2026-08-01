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

It's designed primarily for use with projects hosted on GitHub, and is designed to transparently adopt GitHub's authentication and repository access policies as its own.

The idea is to create something that basically _feels like_ using GitHub's built-in LFS support, without the cost and opacity that comes with it. Since access control is delegated to GitHub,







Three credential types are accepted:

- **GitHub tokens**, for people — a personal access token or the GitHub CLI's OAuth token. Download and upload permission mirror your pull and push permission on the GitHub repository named in the URL.
- **GitHub Actions OIDC tokens**, for CI. Cryptographically verified against GitHub's keys with no stored secrets. Download only.
- **Self-issued tokens**, for repositories that aren't on GitHub, addressed by a bare repo name instead of `<owner>/<repo>`. Signed Ed25519 JWTs you mint yourself with `pnpm run token mint`; the worker verifies them against a public key you configure, with no external calls. See [Repos not on GitHub](#repos-not-on-github-self-issued-tokens).

GitHub-addressed repositories are only served when their owner is listed in the `ALLOWED_OWNERS` variable — without this, anyone with a GitHub account could store data in your bucket. Self-issued repositories don't consult the allowlist; the admin-signed token is the authorization.

Uploads are constrained to the byte size the client declares and to the object's SHA-256 — both are signed into the presigned URL, so on providers that validate `x-amz-content-sha256` (such as R2) only the correct bytes can land at an object's address. Uploads are also deduplicated against existing objects and confirmed post-upload via the LFS `verify` action.

Storage speaks plain SigV4, so any S3-compatible provider that supports presigned URLs and virtual-hosted-style addressing (`https://<bucket>.<endpoint>/…`) should work by pointing `R2_S3_ENDPOINT` at it — though only R2 is tested. Providers that require path-style addressing or an explicit signing region would need small changes.

### Why not GitHub LFS?

GitHub [bills LFS by the metered GiB](https://docs.github.com/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage) for both storage and bandwidth, and CI on fresh runners pays the bandwidth price on every run. R2 storage costs a fraction of that and egress is free. See the [improvement plan](./fable-improvement-plan-july-2026.md) for the full assessment and a cost example.

## Getting started

### Cloudflare setup

1. Create an R2 bucket to store your LFS data, e.g. `example-lfs`:

   ```sh
   wrangler r2 bucket create example-lfs
   ```

2. Create a **read/write** account API token for the bucket (used to sign upload URLs):
   1. Token name: e.g. `R2 Example LFS Read Write Token`
   2. Permissions: Object Read & Write
   3. Specify Buckets: apply to `example-lfs` only

3. Create a **read-only** account API token for the bucket (used to sign download URLs and existence checks):
   1. Token name: e.g. `R2 Example LFS Read Token`
   2. Permissions: Object Read
   3. Specify Buckets: apply to `example-lfs` only

4. Configure `wrangler.jsonc`:
   - `ALLOWED_OWNERS`: comma-separated GitHub users or orgs whose repositories may use the server. An empty value rejects everyone.
   - `routes`: your custom domain, e.g. `lfs.example.com`.
   - Optionally adjust `EXPIRY` (presigned URL lifetime in seconds) and `MAX_FILE_SIZE` (bytes, capped by [R2's single-PUT limit](https://developers.cloudflare.com/r2/platform/limits/)).

5. Provide the bucket credentials as Worker secrets in a `.env` file (gitignored):

   ```ini
   R2_S3_BUCKET = example-lfs
   R2_S3_ENDPOINT = <account-id>.r2.cloudflarestorage.com
   R2_S3_READ_KEY_ID = <read-only key id>
   R2_S3_READ_SECRET_KEY = <read-only secret>
   R2_S3_READ_WRITE_KEY_ID = <read/write key id>
   R2_S3_READ_WRITE_SECRET_KEY = <read/write secret>
   ```

   The checked-in `.template.env` generates this from 1Password via `pnpm run init` (`op inject`) — point its `op://` references at your own vault items.

6. Deploy:

   ```sh
   pnpm run deploy
   ```

### Git repo setup

1. Install the client with `git lfs install` if you haven't already, then create a `.lfsconfig` file in the root of your repo:

   ```ini
   [lfs]
   url = https://lfs.example.com/<repo-owner>/<repo-name>
   ```

   No `locksverify` setting is needed — the server signals that locking is unsupported and clients disable it automatically.

2. Give Git a GitHub credential for the LFS host. The worker accepts any token GitHub can validate.

   **With the [GitHub CLI](https://cli.github.com/)** (recommended): forward your existing `gh` login — nothing new to create, store, or rotate:

   ```sh
   git config credential.https://lfs.example.com.helper \
     '!f() { echo username=gh; echo password=$(gh auth token); };f'
   ```

   Nothing is stored for the LFS host itself: Git runs this helper each time the server asks for credentials (typically once per pull or push), fetching the token from `gh` on demand. The token lives wherever `gh` already keeps your login — the system keychain on macOS — so rotating or revoking it through `gh auth` takes effect immediately.

   This writes to the repo's own `.git/config`; add `--global` to configure it once per machine instead — the key is scoped to the LFS URL, so it applies to every clone that uses this server and nothing else. It can't go in the committed `.lfsconfig`: Git's credential machinery doesn't read that file, deliberately, since a committed shell helper would let any cloned repo execute code.

   **Without it**: generate a personal access token with access to the repository, and configure a credential helper so you only enter it once. On macOS:

   ```sh
   git config --global credential.helper osxkeychain
   ```

   Enter your GitHub username and the token when prompted on first transfer.

   Token caveats: a classic token needs the `repo` scope to see private repositories at all — without it the server responds 404, not 403. Fine-grained tokens grant more than they appear to: GitHub reports your _role_ on the repository rather than the token's restricted permissions, so any fine-grained token that can read a repo's metadata carries your full LFS access — scoping a token to read-only does not make LFS read-only.

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

The ambient `GITHUB_TOKEN` doesn't work here — it reports no repository permissions to the API ([details](./fable-improvement-plan-july-2026.md)). Instead the workflow requests an OIDC token, which the worker verifies cryptographically. No secrets are stored, and fork PRs can't obtain the token.

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: actions/checkout@v7
    with:
      lfs: false

  - name: Configure LFS auth
    run: |
      TOKEN=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
        "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=lfs.example.com" | jq -r .value)
      git config credential.https://lfs.example.com.helper \
        '!f() { echo username=oidc; echo password='"$TOKEN"'; };f'

  - run: git lfs pull
```

The requested `audience` must equal the LFS server's hostname, and the token's `repository` claim must match the repo in the `.lfsconfig` URL. OIDC tokens can only download — uploads always require a GitHub token as described above.

### Repos not on GitHub (self-issued tokens)

If a repository isn't hosted on GitHub — a bare repo on your own server, a mirror, a local-only project — there's no forge API to delegate authorization to. Instead, whoever operates the LFS server mints signed tokens and hands them out. The worker verifies them against a public key with no external calls and no user database; the private key never leaves the operator's machine.

The `pnpm run token` commands below run in your clone of this repository (the same one you deploy the worker from), not in the repo that uses LFS.

Self-issued repos are addressed by a bare single-segment name — `https://lfs.example.com/<repo-name>` — with no owner. The path shape is what selects the credential type: owner-qualified `/<owner>/<repo>` URLs accept only GitHub credentials, single-segment URLs accept only self-issued tokens. Because the token itself is the authorization, `ALLOWED_OWNERS` plays no part here, and a repo name can never collide with a GitHub owner.

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

**Sharing a GitHub-backed repo with someone who has no GitHub account:**

Normally a GitHub-hosted repo's LFS objects require GitHub credentials. To hand access to someone outside GitHub entirely, mint an explicit grant by adding `--github-repo-id` with the repo's numeric ID (from `gh api repos/<owner>/<name> --jq .id`) and the owner-qualified `--repo` path:

```sh
pnpm run token mint --repo example-owner/example-repo --github-repo-id 12345678 --host lfs.example.com --pull --expiry 30d --subject contractor
```

The holder uses the repo's normal `.lfsconfig` (the same owner-qualified URL as everyone else) with the token as their password. Understand what this trades away: the grant bypasses GitHub's permission model, so removing someone from the GitHub repo does **not** revoke their token — only expiry or key rotation does. Keep these expiries short.

Caveats worth knowing:

- **Revocation is by expiry or key rotation.** There's no per-token revocation list — keep expiries short-ish, and rerun `generate-key` (after moving the old key file aside) to invalidate every outstanding token at once.
- **Renames move storage.** Objects are stored under a prefix derived from the repo name (`self/<repo-name>`), so renaming a repo orphans its objects until they're re-uploaded or copied to the new prefix in the bucket. GitHub-backed repos don't have this caveat because they're keyed by GitHub's immutable repo ID.
- **The public key is not a secret**, but `token-signing-key.json` is — anyone holding it can mint tokens for any self-issued repo, and explicit grants into any GitHub-backed repo's storage. Guard it accordingly.

### Optional hardening

- Add a [Cloudflare rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the LFS hostname to blunt credential stuffing and abuse — it blocks at the edge, before the worker runs. In the dashboard, open your zone, then **Security → WAF → Rate limiting rules → Create rule**, match the LFS host with the expression `http.host eq "lfs.example.com"`, and count per IP. A starting point: block above 300 requests per 10 seconds — only the small batch and verify POSTs hit this hostname (object transfers go directly to R2), but a push of many small files fires one verify per object, so don't set the threshold too low. Use the Block action rather than a challenge, which git-lfs can't solve. The worker caches authorization results for five minutes per credential, so normal use is light on the GitHub API.

## Limits

- Objects up to `MAX_FILE_SIZE` (default just under 5 GB, R2's single-PUT ceiling). Multipart uploads for larger objects are not supported.
- Batches up to 100 objects (the git-lfs client default). Each object costs one R2 subrequest, so the Workers paid plan's subrequest limit is recommended over the free plan's 50.
- File locking is not supported.

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
