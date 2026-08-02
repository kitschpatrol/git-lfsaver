import { z } from 'zod'

/**
 * Shared contract for self-issued tokens: admin-minted Ed25519 JWTs that grant
 * LFS access to repositories that aren't on GitHub. The worker verifies them
 * against the `SELF_ISSUED_TOKEN_PUBLIC_KEY` binding, and `scripts/token.ts`
 * mints them, so both sides import the issuer and claim shape from here.
 *
 * Self-issued repositories are addressed by a bare single-segment name
 * (`/<repo-name>/…`), unlike GitHub's `/<owner>/<repo>/…` — the path shape is
 * what routes a request to this credential type.
 */
export const selfIssuedTokenIssuer = 'git-lfsaver'

const safeNameRegex = /^[\w.\-]+$/v

/**
 * Accepts only single-segment repo names limited to word characters, dots, and
 * dashes — the claim becomes a storage key prefix, so this rules out path
 * traversal and URL-delimiter surprises.
 */
export function isValidRepoName(name: string): boolean {
	return safeNameRegex.test(name) && name !== '.' && name !== '..'
}

/** Accepts only `<owner>/<name>` GitHub repo paths built from safe segments. */
export function isValidGitHubRepoPath(repo: string): boolean {
	const segments = repo.split('/')
	return segments.length === 2 && segments.every((segment) => isValidRepoName(segment))
}

/** Claims a self-issued token must carry beyond the registered iss/aud/exp. */
export const selfIssuedTokenClaimsSchema = z.object({
	pull: z.boolean(),
	push: z.boolean(),
	repo: z
		.string()
		.refine(
			isValidRepoName,
			'must be a single-segment repository name using letters, numbers, ".", "_", or "-"',
		),
})

/**
 * Claims for an explicit grant to a GitHub-backed repository, minted with
 * `--github-repo-id` for collaborators without GitHub accounts. The numeric ID
 * pins the token to the same storage prefix the GitHub credential paths use,
 * and the `repo` claim must match the owner-qualified request URL.
 */
export const selfIssuedGitHubGrantClaimsSchema = z.object({
	// eslint-disable-next-line ts/naming-convention -- JWT claim names are snake_case
	github_repo_id: z.number().int().positive(),
	pull: z.boolean(),
	push: z.boolean(),
	repo: z
		.string()
		.refine(isValidGitHubRepoPath, 'must be an "<owner>/<name>" GitHub repository path'),
})
