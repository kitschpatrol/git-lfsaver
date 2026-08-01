/**
 * Key generation and minting for self-issued LFS tokens (repos not on GitHub).
 *
 * Usage:
 *
 * ```sh
 * pnpm run token generate-key
 * pnpm run token mint --repo <repo-name> --host lfs.example.com [--pull] [--push] [--expiry 90d] [--subject <label>]
 * pnpm run token mint --repo <owner>/<name> --github-repo-id <id> --host lfs.example.com [--pull] [--push] [--expiry 90d] [--subject <label>]
 * ```
 *
 * The second mint form is an explicit grant to a GitHub-backed repository (for
 * collaborators without GitHub accounts): the numeric ID pins the token to the
 * repo's storage prefix and bypasses GitHub's permission model entirely.
 *
 * The private key stays in `token-signing-key.json` (gitignored); the printed
 * public key goes in the `SELF_ISSUED_TOKEN_PUBLIC_KEY` variable in
 * `wrangler.jsonc`. The worker verifies minted tokens against that public key,
 * so no secrets are deployed.
 */

import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs } from 'node:util'
import {
	isValidGitHubRepoPath,
	isValidRepoName,
	selfIssuedTokenIssuer,
} from '../src/self-issued.ts'

const keyFile = 'token-signing-key.json'

function fail(message: string): never {
	console.error(`Error: ${message}`)
	// eslint-disable-next-line unicorn/no-process-exit -- This is a CLI script
	process.exit(1)
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
			'github-repo-id': { type: 'string' },
			host: { type: 'string' },
			pull: { default: false, type: 'boolean' },
			push: { default: false, type: 'boolean' },
			repo: { type: 'string' },
			subject: { type: 'string' },
		},
	})

	const { expiry, host, pull, push, repo, subject } = values
	const rawGitHubRepoId = values['github-repo-id']
	let githubRepoId: number | undefined
	if (rawGitHubRepoId === undefined) {
		if (repo === undefined || !isValidRepoName(repo)) {
			fail(
				'Pass --repo as a single-segment repository name (no owner, no slashes) using letters, numbers, ".", "_", or "-". It must match the name in the lfs.url path.',
			)
		}
	} else {
		githubRepoId = Number(rawGitHubRepoId)
		if (!Number.isInteger(githubRepoId) || githubRepoId <= 0) {
			fail(
				'Pass --github-repo-id as the numeric GitHub repository ID, e.g. from `gh api repos/<owner>/<name> --jq .id`.',
			)
		}

		if (repo === undefined || !isValidGitHubRepoPath(repo)) {
			fail('With --github-repo-id, pass --repo as the "<owner>/<name>" GitHub repository path.')
		}
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

	// eslint-disable-next-line ts/naming-convention -- JWT claim names are snake_case
	const grantClaims = githubRepoId === undefined ? {} : { github_repo_id: githubRepoId }
	let jwt = new SignJWT({ ...grantClaims, pull, push, repo })
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
		`Grants ${[pull && 'download', push && 'upload'].filter(Boolean).join(' and ')} for "${repo}" on "${host}", expires in ${expiry}.`,
	)
	if (githubRepoId !== undefined) {
		console.error(
			`This is an explicit grant to GitHub repository ID ${githubRepoId}: it bypasses GitHub's permission model, and revoking the holder's GitHub access will NOT revoke it — only expiry or key rotation will.`,
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
		'Usage: `pnpm run token generate-key` or `pnpm run token mint --repo <repo-name> --host <lfs-hostname> [--pull] [--push] [--expiry 90d] [--subject <label>] [--github-repo-id <id>]`',
	)
}
