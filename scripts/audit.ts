/* eslint-disable ts/naming-convention -- HTTP header and GitHub API field names are not camelCase */

/**
 * Storage audit for the LFS bucket: lists every top-level prefix with its
 * object count, total size, and the repository it belongs to, flagging orphaned
 * prefixes whose GitHub repository no longer exists.
 *
 * Usage:
 *
 * ```sh
 * pnpm run audit [--json]
 * ```
 *
 * Reads bucket credentials from `.env` (the read-only key suffices) and
 * resolves numeric prefixes via the GitHub API, authenticated with
 * `GITHUB_TOKEN` or the `gh` CLI login when available — without a credential,
 * private repositories are indistinguishable from deleted ones.
 */

import { AwsClient } from 'aws4fetch'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const environmentKeyRegex = /^[A-Z0-9_]+$/v
const contentsBlockRegex = /<Contents>(?<block>[\s\S]*?)<\/Contents>/gv
const objectKeyRegex = /<Key>(?<key>[^<]+)<\/Key>/v
const objectSizeRegex = /<Size>(?<size>\d+)<\/Size>/v
const continuationTokenRegex = /<NextContinuationToken>(?<token>[^<]+)<\/NextContinuationToken>/v
const numericPrefixRegex = /^\d+$/v

const gitHubRepoSchema = z.object({ full_name: z.string().optional() })

type BucketConfig = {
	bucket: string
	endpoint: string
	keyId: string
	secretKey: string
}

type PrefixReport = {
	bytes: number
	objects: number
	prefix: string
	repo: string
	status: 'error' | 'ok' | 'orphaned' | 'self-issued' | 'unverified'
}

function fail(message: string): never {
	console.error(`Error: ${message}`)
	// eslint-disable-next-line unicorn/no-process-exit -- This is a CLI script
	process.exit(1)
}

async function loadBucketConfig(): Promise<BucketConfig> {
	let content: string
	try {
		content = await readFile('.env', 'utf8')
	} catch {
		fail('Could not read ".env". Run `pnpm run init` or create it as described in the readme.')
	}

	const variables: Record<string, string> = {}
	for (const line of content.split('\n')) {
		const separatorIndex = line.indexOf('=')
		if (separatorIndex === -1) {
			continue
		}

		const key = line.slice(0, separatorIndex).trim()
		if (!environmentKeyRegex.test(key)) {
			continue
		}

		let value = line.slice(separatorIndex + 1).trim()

		if (
			(value.startsWith("'") && value.endsWith("'")) ||
			(value.startsWith('"') && value.endsWith('"'))
		) {
			value = value.slice(1, -1)
		}

		variables[key] = value
	}

	const bucket = variables.R2_S3_BUCKET
	const endpoint = variables.R2_S3_ENDPOINT
	const keyId = variables.R2_S3_READ_KEY_ID
	const secretKey = variables.R2_S3_READ_SECRET_KEY
	if (
		bucket === undefined ||
		endpoint === undefined ||
		keyId === undefined ||
		secretKey === undefined
	) {
		fail(
			'.env is missing one of R2_S3_BUCKET, R2_S3_ENDPOINT, R2_S3_READ_KEY_ID, or R2_S3_READ_SECRET_KEY.',
		)
	}

	return { bucket, endpoint, keyId, secretKey }
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

async function listObjects(config_: BucketConfig): Promise<Array<{ key: string; size: number }>> {
	const client = new AwsClient({
		accessKeyId: config_.keyId,
		secretAccessKey: config_.secretKey,
	})

	const objects: Array<{ key: string; size: number }> = []
	let continuationToken: string | undefined

	do {
		const url = new URL(`https://${config_.bucket}.${config_.endpoint}/`)
		url.searchParams.set('list-type', '2')
		url.searchParams.set('max-keys', '1000')
		if (continuationToken !== undefined) {
			url.searchParams.set('continuation-token', continuationToken)
		}

		const response = await client.fetch(url.href)
		if (!response.ok) {
			fail(`Bucket listing failed with HTTP ${response.status}: ${await response.text()}`)
		}

		// The ListObjectsV2 response is server-generated XML with a fixed shape
		// and URL-safe keys, so light regex extraction beats an XML dependency

		const xml = await response.text()
		for (const contents of xml.matchAll(contentsBlockRegex)) {
			const block = contents.groups?.block ?? ''
			const key = objectKeyRegex.exec(block)?.groups?.key
			const size = objectSizeRegex.exec(block)?.groups?.size
			if (key !== undefined && size !== undefined) {
				objects.push({ key, size: Number(size) })
			}
		}

		continuationToken = continuationTokenRegex.exec(xml)?.groups?.token
	} while (continuationToken !== undefined)

	return objects
}

function getPrefix(key: string): string {
	const segments = key.split('/')
	if (segments[0] === 'self' && segments.length > 1) {
		return `self/${segments[1] ?? ''}`
	}

	return segments[0] ?? key
}

async function resolveGitHubRepo(
	id: string,
	token: string | undefined,
): Promise<{ repo: string; status: PrefixReport['status'] }> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'git-lfs-cf-storage-audit',
	}
	if (token !== undefined) {
		headers.Authorization = `Bearer ${token}`
	}

	const response = await fetch(`https://api.github.com/repositories/${id}`, { headers })
	if (response.status === 404) {
		// Without a credential, private repositories also 404 — don't report
		// them as deletable
		return token === undefined
			? { repo: '(unverified)', status: 'unverified' }
			: { repo: '(deleted repo)', status: 'orphaned' }
	}

	if (!response.ok) {
		return { repo: `(GitHub error ${response.status})`, status: 'error' }
	}

	const data = gitHubRepoSchema.safeParse(await response.json())
	return { repo: (data.success ? data.data.full_name : undefined) ?? '(unnamed)', status: 'ok' }
}

function formatBytes(bytes: number): string {
	let value = bytes
	let unit = 'B'
	for (const nextUnit of ['KiB', 'MiB', 'GiB', 'TiB']) {
		if (value < 1024) {
			break
		}

		value /= 1024
		unit = nextUnit
	}

	return unit === 'B' ? `${value} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`
}

function printTable(reports: PrefixReport[], totals: { bytes: number; objects: number }): void {
	const header = ['Prefix', 'Repo', 'Objects', 'Size', 'Status']
	const rows = reports.map((report) => [
		report.prefix,
		report.repo,
		String(report.objects),
		formatBytes(report.bytes),
		report.status,
	])
	const totalsRow = ['Total', '', String(totals.objects), formatBytes(totals.bytes), '']

	const table = [header, ...rows, totalsRow]
	const widths = header.map((_, column) =>
		Math.max(...table.map((row) => (row[column] ?? '').length)),
	)

	// Right-align the numeric columns
	const rightAligned = new Set([2, 3])
	for (const row of table) {
		const line = row
			.map((cell, column) => {
				const width = widths[column] ?? 0
				return rightAligned.has(column) ? cell.padStart(width) : cell.padEnd(width)
			})
			.join('  ')
		console.log(line.trimEnd())
	}
}

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		json: { default: false, type: 'boolean' },
	},
})

const config = await loadBucketConfig()
const token = getGitHubToken()
if (token === undefined && !values.json) {
	console.error(
		'Warning: no GitHub credential found (GITHUB_TOKEN or `gh auth login`) — private repositories will be reported as "unverified" rather than "orphaned".\n',
	)
}

const objects = await listObjects(config)
if (objects.length === 0) {
	if (values.json) {
		console.log(JSON.stringify({ prefixes: [], totals: { bytes: 0, objects: 0 } }, undefined, 2))
	} else {
		console.log(`Bucket "${config.bucket}" is empty.`)
	}
} else {
	const groups = new Map<string, { bytes: number; objects: number }>()
	for (const object of objects) {
		const prefix = getPrefix(object.key)
		const group = groups.get(prefix) ?? { bytes: 0, objects: 0 }
		group.bytes += object.size
		group.objects += 1
		groups.set(prefix, group)
	}

	const reports: PrefixReport[] = await Promise.all(
		Array.from(groups, async ([prefix, stats]) => {
			if (prefix.startsWith('self/')) {
				return {
					...stats,
					prefix,
					repo: prefix.slice('self/'.length),
					status: 'self-issued' as const,
				}
			}

			if (!numericPrefixRegex.test(prefix)) {
				return { ...stats, prefix, repo: '(unrecognized prefix)', status: 'error' as const }
			}

			const resolved = await resolveGitHubRepo(prefix, token)
			return { ...stats, prefix, ...resolved }
		}),
	)

	reports.sort((a, b) => b.bytes - a.bytes)
	const totals = {
		bytes: reports.reduce((sum, report) => sum + report.bytes, 0),
		objects: reports.reduce((sum, report) => sum + report.objects, 0),
	}

	if (values.json) {
		console.log(JSON.stringify({ prefixes: reports, totals }, undefined, 2))
	} else {
		printTable(reports, totals)
	}
}
