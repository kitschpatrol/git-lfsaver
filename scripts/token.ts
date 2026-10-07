/**
 * Key generation and minting for self-issued LFS tokens (repos not on GitHub).
 *
 * Usage:
 *
 * ```sh
 * pnpm run token generate-key
 * pnpm run token mint --repo <repo-name> --host lfs.example.com [--pull] [--push] [--expiry 90d] [--subject <label>]
 * pnpm run token mint --repo <owner>/<name> --host lfs.example.com [--pull] [--push] [--expiry 90d] [--subject <label>]
 * ```
 *
 * The repo shape selects the token type, mirroring the server's URL routing: a
 * single-segment name mints a token for a self-issued (non-GitHub) repo, while
 * an owner-qualified `<owner>/<name>` path mints an explicit grant to a
 * GitHub-backed repository (for collaborators without GitHub accounts). For
 * grants, the repo's immutable numeric ID is resolved from the GitHub API at
 * mint time — authenticated with `GITHUB_TOKEN` or the `gh` CLI login when
 * available, which private repositories require — and pins the token to the
 * repo's storage prefix, bypassing GitHub's permission model entirely.
 *
 * The private key stays in `token-signing-key.json` (gitignored); the printed
 * public key goes in the `SELF_ISSUED_TOKEN_PUBLIC_KEY` variable in
 * `wrangler.jsonc`. The worker verifies minted tokens against that public key,
 * so no secrets are deployed.
 */

import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import {
	isValidGitHubRepositoryPath,
	isValidRepositoryName,
	selfIssuedTokenIssuer,
} from '../src/self-issued.ts'

const keyFile = 'token-signing-key.json'

const gitHubRepositorySchema = z.object({
	// eslint-disable-next-line ts/naming-convention -- GitHub API field names are snake_case
	full_name: z.string(),
	id: z.number().int().positive(),
})

function fail(message: string): never {
	console.error(`Error: ${message}`)
	// eslint-disable-next-line unicorn/no-process-exit -- This is a CLI script
	process.exit(1)
}

function getGitHubToken(): string | undefined {
	const environmentToken = process.env.GITHUB_TOKEN
	if (environmentToken !== undefined && environmentToken.length > 0) {
		return environmentToken
	}

	try {
		const token = execFileSync('gh', ['auth', 'token'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
		return token.length > 0 ? token : undefined
	} catch {
		return undefined
	}
}

/**
 * Resolves a GitHub repository path to its immutable numeric ID and canonical
 * name at mint time, so the operator never hand-copies the ID (a transposition
 * there would silently grant a different repo's storage).
 */
async function resolveGitHubRepository(
	repositoryPath: string,
): Promise<{ fullName: string; id: number }> {
	const token = getGitHubToken()
	const headers: Record<string, string> = {
		// eslint-disable-next-line ts/naming-convention -- HTTP header name
		Accept: 'application/vnd.github+json',
		'User-Agent': 'git-lfsaver-token-mint',
	}
	if (token !== undefined) {
		headers.Authorization = `Bearer ${token}`
	}

	let response: Response
	try {
		response = await fetch(`https://api.github.com/repos/${repositoryPath}`, { headers })
	} catch {
		fail(
			`Could not reach the GitHub API to resolve "${repositoryPath}". Check your network connection.`,
		)
	}

	if (response.status === 404) {
		fail(
			`No GitHub repository found for "${repositoryPath}".${
				token === undefined
					? ' Private repositories require a credential: run `gh auth login` or set GITHUB_TOKEN.'
					: ''
			}`,
		)
	}

	if (!response.ok) {
		fail(`GitHub API request for "${repositoryPath}" failed with HTTP ${response.status}.`)
	}

	const parsed = gitHubRepositorySchema.safeParse(await response.json())
	if (!parsed.success) {
		fail(`GitHub API returned an unexpected response for "${repositoryPath}".`)
	}

	return { fullName: parsed.data.full_name, id: parsed.data.id }
}

async function generateKey(): Promise<void> {
	let keyFileExists = true
	try {
		await readFile(keyFile)
	} catch {
		keyFileExists = false
	}

	if (keyFileExists) {
		fail(`"${keyFile}" already exists. Move or delete it first to rotate the key.`)
	}

	const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
		crv: 'Ed25519',
		extractable: true,
	})
	await writeFile(keyFile, `${JSON.stringify(await exportJWK(privateKey), undefined, '\t')}\n`, {
		mode: 0o600,
	})

	const publicJwk = await exportJWK(publicKey)
	console.log(
		`Private signing key written to "${keyFile}" (gitignored — keep it out of version control).`,
	)
	console.log('')
	console.log('Add the public key to "vars" in wrangler.jsonc and deploy:')
	console.log('')
	console.log(`  "SELF_ISSUED_TOKEN_PUBLIC_KEY": "${publicJwk.x}",`)
}

async function mint(mintArguments: string[]): Promise<void> {
	const { values } = parseArgs({
		args: mintArguments,
		options: {
			expiry: { default: '90d', type: 'string' },
			host: { type: 'string' },
			pull: { default: false, type: 'boolean' },
			push: { default: false, type: 'boolean' },
			repo: { type: 'string' },
			subject: { type: 'string' },
		},
	})

	const { expiry, host, pull, push, repo, subject } = values

	if (repo === undefined) {
		fail(
			'Pass --repo as a single-segment repository name (self-issued repos) or an "<owner>/<name>" GitHub repository path (explicit grant).',
		)
	}

	// The repo shape selects the token type, exactly like the server's URL
	// routing: owner-qualified paths are explicit grants to GitHub-backed
	// repos, single-segment names are self-issued repos
	const isGitHubGrant = repo.includes('/')
	if (isGitHubGrant) {
		if (!isValidGitHubRepositoryPath(repo)) {
			fail(
				'Pass --repo as the "<owner>/<name>" GitHub repository path, with each segment using letters, numbers, ".", "_", or "-".',
			)
		}
	} else if (!isValidRepositoryName(repo)) {
		fail(
			'Pass --repo as a single-segment repository name (no owner) using letters, numbers, ".", "_", or "-". It must match the name in the lfs.url path.',
		)
	}

	if (host === undefined || host.length === 0) {
		fail(
			'Pass --host as the LFS server hostname, e.g. "lfs.example.com". It becomes the token audience and must match exactly.',
		)
	}

	if (!pull && !push) {
		fail('Pass --pull and/or --push to grant at least one permission.')
	}

	let privateJwk: unknown
	try {
		privateJwk = JSON.parse(await readFile(keyFile, 'utf8'))
	} catch {
		fail(`Could not read "${keyFile}". Run \`pnpm run token generate-key\` first.`)
	}

	const privateKey = await importJWK(privateJwk as Parameters<typeof importJWK>[0], 'EdDSA')

	// Grants embed the canonical name GitHub resolves, so a token minted
	// against a stale (renamed) path still matches the URL collaborators use
	let repositoryClaim = repo
	let githubRepositoryId: number | undefined
	if (isGitHubGrant) {
		const resolved = await resolveGitHubRepository(repo)
		githubRepositoryId = resolved.id
		if (resolved.fullName.toLowerCase() !== repo.toLowerCase()) {
			console.error(
				`Note: GitHub resolves "${repo}" to "${resolved.fullName}" (renamed or transferred) — minting for "${resolved.fullName}".`,
			)
		}

		repositoryClaim = resolved.fullName
	}

	// eslint-disable-next-line ts/naming-convention -- JWT claim names are snake_case
	const grantClaims = githubRepositoryId === undefined ? {} : { github_repo_id: githubRepositoryId }
	let jwt = new SignJWT({ ...grantClaims, pull, push, repo: repositoryClaim })
		.setProtectedHeader({ alg: 'EdDSA' })
		.setIssuer(selfIssuedTokenIssuer)
		.setAudience(host)
		.setIssuedAt()
		.setExpirationTime(expiry)

	if (subject !== undefined) {
		jwt = jwt.setSubject(subject)
	}

	const token = await jwt.sign(privateKey)

	console.log(token)
	console.error('')
	console.error(
		`Grants ${[pull && 'download', push && 'upload'].filter(Boolean).join(' and ')} for "${repositoryClaim}" on "${host}", expires in ${expiry}.`,
	)
	if (githubRepositoryId !== undefined) {
		console.error(
			`This is an explicit grant to GitHub repository ID ${githubRepositoryId}: it bypasses GitHub's permission model, and revoking the holder's GitHub access will NOT revoke it — only expiry or key rotation will.`,
		)
	}

	console.error('Use it as the Basic auth password for the LFS host, e.g.:')
	console.error('')
	console.error(`  git config credential.https://${host}.helper \\`)
	console.error(`    '!f() { echo username=token; echo password=<token>; };f'`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'generate-key') {
	await generateKey()
} else if (command === 'mint') {
	await mint(rest)
} else {
	fail(
		'Usage: `pnpm run token generate-key` or `pnpm run token mint --repo <repo-name-or-owner/name> --host <lfs-hostname> [--pull] [--push] [--expiry 90d] [--subject <label>]`',
	)
}
