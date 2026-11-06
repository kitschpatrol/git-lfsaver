# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-11-01

### Maintenance

- Update runtime dependency requirements to `jose` 6.2.14 and `zod` ^4.6.7.
- Refresh development dependencies and GitHub Actions, including Vitest 5, shared-config 8.14 and pnpm 12.16.1, and set contributor Node.js support to `^24.16.0 || >=26.3.0`.
- Generate version metadata before lint, fix and release commands, and move contributor skill installation from the prepare hook to pnpm.
- Tighten release tag patterns, use the pushed tag directly, and verify that its commit is on the repository's default branch.
- Change automated dependency updates from weekly to monthly runs and standardize their pull-request title.
- Exclude loopback URLs from link checks and allow checks with no links to succeed.
- Remove stale dependency release-age exemptions and the redundant Knip exclusion for test files.

## [1.0.2] - 2026-10-07

### Maintenance

- Update runtime dependency requirements to `jose` 6.2.12 and `zod` ^4.6.5.
- Migrate Worker tests to `@cloudflare/vitest-plugin` and refresh development dependencies, pnpm, lint configuration, and corresponding source and test conventions.
- Refresh contributor scripts with install-time skill synchronization and rename the deep-clean command to `clean-deep`.
- Add a weekly and manually triggered workflow for dependency-update pull requests.
- Improve website link checks with sitemap discovery, `lychee.toml` support, and pinned discovery tools.
- Pin release and repository metadata synchronization actions to commit SHAs.

## [1.0.1] - 2026-08-12

### Maintenance

- Update Wrangler, the Cloudflare Vitest worker pool, pnpm, and the CI pnpm setup action.

## [1.0.0] - 2026-08-02

### Added

- Provide a Cloudflare Workers Git LFS batch server with persistent R2 storage, configurable S3 endpoints, and direct presigned transfers expiring after 15 minutes by default.
- Support upload deduplication, signed size and SHA-256 constraints, and post-upload verification, with a configurable upload limit just under 5 GB that leaves larger stored objects downloadable.
- Isolate repository storage by provider and immutable GitHub repository ID, preserving objects across renames and supporting both owner/repository and explicit github.com URL paths.
- Authenticate GitHub access through personal access tokens or GitHub CLI credentials, mirroring repository pull/push roles with an owner allowlist and five-minute authorization cache.
- Allow anonymous downloads from public GitHub repositories, prompting for credentials when public repository lookup is unavailable.
- Support download-only GitHub Actions OIDC authentication bound to the repository and LFS server hostname.
- Support locally verified Ed25519 tokens for non-GitHub repositories and explicit GitHub storage grants, with pull/push permissions, expiration, and revocation through key rotation.
- Provide token CLI commands to generate locally stored signing keys and mint tokens with repository, host, permission, expiry and subject options, automatically resolving GitHub grant IDs.
- Validate SHA-256 OIDs and LFS request formats, limit batches to 100 objects and request bodies to 256 KiB, and signal unsupported locking to clients.
- Return structured LFS errors for malformed repository paths, rejected credentials, GitHub rate limits, missing objects and storage failures.
- Add `pnpm run audit` with table and JSON output showing repository object counts, storage usage, and orphaned or inaccessible storage prefixes.
- Expose `/version.json` with the package version, build timestamp, Git revision, branch and commit date.

### Documentation

- Document fork-based deployment and updates, bucket credentials, Git credential helpers, `.lfsconfig` setup, and GitHub Actions checkout integration.
- Explain authentication scope and revocation caveats, storage limits and provider compatibility, repository migration and cleanup, and GitHub/R2 cost comparisons.

### Maintenance

- Establish pnpm/TypeScript development, shared linting, Worker tests, cross-platform CI, link checks, automatic version metadata generation and GitHub release automation.

[1.0.0]: https://github.com/kitschpatrol/git-lfsaver/releases/tag/v1.0.0
[1.0.1]: https://github.com/kitschpatrol/git-lfsaver/compare/v1.0.0...v1.0.1
[1.0.2]: https://github.com/kitschpatrol/git-lfsaver/compare/v1.0.1...v1.0.2
[1.0.3]: https://github.com/kitschpatrol/git-lfsaver/compare/v1.0.2...v1.0.3
