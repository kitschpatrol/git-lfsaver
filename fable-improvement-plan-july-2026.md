# git-lfs-cf improvement plan (July 2026)

Assessment and hardening plan for the Cloudflare Workers + R2 Git LFS server, evaluated 2026-07-30.

## Verdict

The architecture — Worker validates a forwarded GitHub credential against the GitHub API, then hands out short-lived presigned R2 URLs — is sound and proven (same model as [Estranged.Lfs](https://alanedwardes.github.io/docs/Estranged.Lfs/)). The implementation is close to done: careful schemas, rename-proof repo-ID namespacing, mostly good validation. Worth finishing rather than paying GitHub for LFS, provided the issues below are fixed first.

### Cost comparison vs. GitHub LFS

GitHub [discontinued LFS data packs and moved to metered billing](https://github.com/orgs/community/discussions/61362): 10 GiB storage + 10 GiB/month bandwidth free, then **$0.07/GiB-month storage and $0.0875/GiB bandwidth** ([billing docs](https://docs.github.com/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage)). R2 is $0.015/GB-month with zero egress.

Example: 100 GB of assets pulled 200 GB/month (CI on fresh runners consumes bandwidth on every run) ≈ **$23/mo on GitHub vs. ~$1.35/mo on R2**, plus an optional $5/mo Workers paid plan (see subrequest limits below). If usage fits inside GitHub's free tier, paying with simplicity is defensible — but bandwidth-metered LFS plus CI is exactly the cost trap this project avoids.

## CI integration (the crux)

**Local use works today**: PAT via credential helper, worker checks `repos.get().permissions.pull/push`.

**GitHub Actions wiring**: the LFS server is a different host than github.com, so `actions/checkout`'s credential doesn't apply automatically. One extra line — no stored secrets, just the ambient `GITHUB_TOKEN`:

```yaml
- uses: actions/checkout@v7
  with: { lfs: false }
- run: |
    git config credential.https://lfs.kitschpatrol.com.helper \
      '!f() { echo username=x-access-token; echo password='"$GITHUB_TOKEN"'; };f'
    git lfs pull
```

Use a credential helper, not `http.<url>.extraheader` — extraheader has documented double-header and precedence bugs in git-lfs ([git-lfs#4031](https://github.com/git-lfs/git-lfs/issues/4031), [git-lfs#3007](https://github.com/git-lfs/git-lfs/issues/3007), [actions/checkout#162](https://github.com/actions/checkout/issues/162)).

### Unverified assumption — test before building further

> **Resolved 2026-07-31**: tested with the throwaway workflow below — `GET /repos/{owner}/{repo}` with the ambient `GITHUB_TOKEN` returns `{"admin":false,"maintain":false,"pull":false,"push":false,"triage":false}`. The worker's permission check therefore denies CI, and the OIDC path is **required**, not optional.

`GITHUB_TOKEN` is a GitHub App installation token (`ghs_`). There is no authoritative documentation that `GET /repos/{owner}/{repo}` returns a meaningful `permissions` field for installation tokens — one [community thread](https://github.com/orgs/community/discussions/163573) shows it coming back all-`false`, which would make the worker deny CI downloads. The docs only confirm installation tokens authenticate as the installation, not a user ([app auth docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).

Test empirically with a throwaway workflow:

```yaml
- run: gh api repos/$GITHUB_REPOSITORY --jq .permissions
  env:
    GH_TOKEN: ${{ github.token }}
```

### Fallback (and upgrade regardless): GitHub Actions OIDC

Add a second auth path where the worker accepts the Actions OIDC JWT (`permissions: id-token: write` — no secret anywhere), verifies the signature against GitHub's JWKS, and matches the `repository` claim against the URL path. Cryptographically verified repo identity, fork PRs can't obtain the token, and it removes the GitHub API round-trip for CI. Roughly 40 lines with `jose` (runs on Workers). Worth adding even if `GITHUB_TOKEN` turns out to work with the permissions check.

## Security findings, ranked

### 1. Critical — OID path traversal

`oid` is `z.string()` (`src/schemas.ts:14`) and goes straight into the signed URL path (`src/index.ts:340`). `new URL().pathname` normalizes dot segments (verified locally): an attacker with push access to any repo — including their own free one — can send `oid: "../<victimRepoId>/<oid>"` and receive a signed **PUT into another repo's namespace**, corrupting any object whose OID they know. Client-side hash checks catch content substitution on download, but corruption still breaks every clone (data destruction).

**Fix**: `oid: z.string().regex(/^[0-9a-f]{64}$/)` and reject `hash_algo !== 'sha256'`.

### 2. Critical — the bucket is an open storage service

Nothing restricts which repos may use the worker. Anyone with a GitHub account can create their own private repo, point `.lfsconfig` at the worker, and store 5 GB objects in the bucket indefinitely, under their repoId, on the owner's bill.

**Fix**: an `ALLOWED_OWNERS` (or explicit repo list) env var checked before the GitHub API call. Optionally also require `repoInfo.private === true` to enforce the readme's private-only claim.

### 3. Breaks production — secrets arrive as strings

`wrangler deploy --secrets-file .env` uploads everything in `.env` as string secrets, but `Env` types `EXPIRY`/`MAX_FILE_SIZE` as numbers. `expires_in: "3600"` then fails the server's own response schema → every batch returns 422. Also `ENFORCE_MIME="false"` is truthy.

**Fix**: keep only the two R2 credentials as secrets. Move `R2_S3_BUCKET`, `R2_S3_ENDPOINT`, `ENFORCE_MIME`, `EXPIRY`, `MAX_FILE_SIZE` into `vars` in `wrangler.jsonc` as typed values. Delete the placeholder credential entries currently in `vars`.

### 4. Moderate

- **Unbounded `objects` array** — cap at ~100. The Workers free plan allows 50 subrequests/request; the download path does one HEAD per object, so a default 100-object git-lfs batch already fails on the free plan (paid plan allows 1000 — another reason for the $5/mo plan).
- **Signed PUT doesn't constrain size** — sign `Content-Length` into the URL, and add the spec's `verify` action (HEAD the object, compare size) so bogus uploads are caught at push time rather than at the next clone.
- **Unused read-only R2 token** — the readme has the user create one but the code only uses the read/write credentials. Either sign GET URLs with the read-only key (least privilege) or drop the readme step.

### 5. Minor / spec compliance

- `cf-request-id` was removed by Cloudflare years ago — every `request_id` is `"unknown"`. Use `cf-ray`.
- Authenticated-but-forbidden should return 403, not 401 (401 makes git-lfs re-prompt for credentials in a loop). 401 responses should carry `LFS-Authenticate: Basic realm="Git LFS"`.
- Lock endpoints should return **404** (the spec's "locking unsupported" signal — the client auto-disables, making the `locksverify = false` line in `.lfsconfig` unnecessary) instead of 405.
- Drop `.strict()` on the _request_ schemas — future client fields shouldn't cause 422s. Keep strict validation on responses.
- Error responses should use the LFS content type (`application/vnd.git-lfs+json`).
- On upload, HEAD first and omit `actions` for objects that already exist — the spec's dedup mechanism; saves real bandwidth on re-pushes.

## Plan, in order

1. ~~**Test `GITHUB_TOKEN` + `repos.get` permissions empirically**~~ Done 2026-07-31: all-`false` permissions, so OIDC (step 5) is required.
2. **Fix the critical holes + config typing** (findings 1–3). Small diffs.
3. **Spec-compliance pass** (findings 4–5), including the `verify` action and lock 404s.
4. **Real tests** — the current suite is two hello-world snapshots. The Workers vitest pool makes this testable: mock Octokit, use fake AWS credentials (signing is deterministic, no network), and cover the attack cases directly: traversal OIDs, non-allowlisted owners, the permission matrix, oversize objects, malformed auth headers, empty batches.
5. ~~**OIDC auth path for CI**~~ Done 2026-07-31: JWTs verified against GitHub's JWKS with pinned issuer and audience, `repository` claim matched to the URL path, `repository_id` claim used as the storage namespace. Download-only.
6. **Optional polish**: short-TTL in-memory cache of auth results keyed by SHA-256(token) + repoId (cuts the ~300 ms GitHub round-trip per batch; never store the token itself), a Cloudflare rate-limiting rule on the route, and a readme rewrite covering the CI recipe.

**Out of scope for now** (no demonstrated need): locking support, multipart uploads for objects over 5 GiB, public-repo support.

## References

- [GitHub LFS metered billing FAQ](https://github.com/orgs/community/discussions/61362)
- [GitHub LFS billing docs](https://docs.github.com/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage)
- [GITHUB_TOKEN permissions discussion](https://github.com/orgs/community/discussions/163573)
- [About GITHUB_TOKEN](https://docs.github.com/en/actions/automating-your-workflow-with-github-actions/authenticating-with-the-github_token)
- [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [git-lfs authentication docs](https://github.com/git-lfs/git-lfs/blob/main/docs/api/authentication.md)
- [git-lfs batch API spec](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
- [git-lfs#4031 (extraheader double-header)](https://github.com/git-lfs/git-lfs/issues/4031), [git-lfs#3007 (extraheader precedence)](https://github.com/git-lfs/git-lfs/issues/3007), [actions/checkout#162](https://github.com/actions/checkout/issues/162)
- [Estranged.Lfs](https://alanedwardes.github.io/docs/Estranged.Lfs/)
