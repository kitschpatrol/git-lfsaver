/* eslint-disable ts/naming-convention */
/* eslint-disable node/no-unsupported-features/node-builtins */

import type { RestEndpointMethodTypes } from '@octokit/rest'
import { Octokit } from '@octokit/rest'
import { AwsClient } from 'aws4fetch'
import { z } from 'zod'
import type {
	GitLfsBatchResponse,
	GitLfsBatchResponseErrorObject,
	GitLfsBatchResponseObject,
} from './schemas'
import { gitLfsBatchRequestSchema, gitLfsBatchResponseSchema } from './schemas'

type GitHubRepoInfo = RestEndpointMethodTypes['repos']['get']['response']['data']

const mime = 'application/vnd.git-lfs+json'

export default {
	// eslint-disable-next-line complexity
	async fetch(request, env, _context): Promise<Response> {
		const requestId = request.headers.get('cf-request-id') ?? 'unknown'
		const url = new URL(request.url)

		if (url.pathname === '/') {
			if (request.method === 'GET') {
				return new Response(
					'<!DOCTYPE html><html style="background-color:gray;"><head><meta charset="utf-8"><title>git-lfs-cf</title></head><body style="margin:0;padding:0;height:100vh;display:flex;align-items:center;justify-content:center"><h1 style="margin:0;font-size:6em">🪨</h1></body></html>',
					{
						headers: {
							'Content-Type': 'text/html; charset=utf-8',
						},
					},
				)
			}
			return Response.json(
				{
					message: 'Only GET requests are allowed at the LFS server root.',
					request_id: requestId,
				},
				{
					headers: { Allow: 'GET' },
					status: 405,
				},
			)
		}

		if (url.pathname === '/favicon.ico') {
			const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 16 16'><text x='0' y='14'>🪨</text></svg>`
			return new Response(svg, {
				headers: {
					'Cache-Control': 'public, max-age=86400',
					'Content-Type': 'image/svg+xml',
				},
				status: 200,
			})
		}

		// All LFS requests are POSTs
		if (request.method !== 'POST') {
			return Response.json(
				{ message: 'Only POST requests are allowed.', request_id: requestId },
				{
					headers: { Allow: 'POST' },
					status: 405,
				},
			)
		}

		if (
			// eslint-disable-next-line ts/no-unnecessary-condition
			env.ENFORCE_MIME &&
			(!request.headers.get('Accept')?.startsWith(mime) ||
				!request.headers.get('Content-Type')?.startsWith(mime))
		) {
			return Response.json(
				{
					message: `Invalid request headers, expect "Accept: ${mime}" and "Content-Type: ${mime}", received "${request.headers.get(
						'Accept',
					)}" and "${request.headers.get('Content-Type')}"`,
					request_id: requestId,
				},
				{ status: 406 },
			)
		}

		// Locking not yet supported
		if (url.pathname.endsWith('/locks/verify')) {
			return Response.json(
				{
					message: 'This LFS server does not support locking. (Yet...)',
					request_id: requestId,
				},
				{ headers: { Allow: 'POST' }, status: 405 },
			)
		}

		// Expect /<owner>/<repo>/objects/batch
		const pathParts = url.pathname.split('/')
		if (url.pathname.endsWith('/objects/batch') && pathParts.length >= 5) {
			const owner = decodeURIComponent(pathParts[1])
			const repo = decodeURIComponent(pathParts[2])
			if (owner.length === 0 || repo.length === 0) {
				return Response.json(
					{
						message: `Invalid request URL pathname, expect "/<owner>/<repo>/objects/batch", received "${url.pathname}" Double check your lfs.url value in your .lfsconfig file.`,
						request_id: requestId,
					},
					{ status: 422 },
				)
			}

			// Read and validate the request
			const rawClientRequest = await request.json()
			const result = gitLfsBatchRequestSchema.safeParse(rawClientRequest)
			if (!result.success) {
				return Response.json(
					{ message: z.prettifyError(result.error), request_id: requestId },
					{ status: 422 },
				)
			}
			const { hash_algo, objects, operation } = result.data

			const personalAccessToken = getPersonalAccessToken(request)

			if (personalAccessToken === undefined) {
				return Response.json(
					{
						message: 'No GitHub Personal Access Token provided.',
						request_id: requestId,
					},
					{
						status: 401,
					},
				)
			}

			const repoInfo = await getGitHubRepoInfo(owner, repo, personalAccessToken)
			if (repoInfo === undefined) {
				return Response.json(
					{
						message: `No GitHub repository found for owner "${owner}/${repo}".`,
						request_id: requestId,
					},
					{ status: 404 },
				)
			}

			const isAuthorized = checkAuthorization(repoInfo, operation)
			if (!isAuthorized) {
				return Response.json(
					{
						message: `Not authorized to ${operation} ib repository "${owner}/${repo}". Check permissions on your GitHub personal access token.`,
						request_id: requestId,
					},
					{ status: 401 },
				)
			}

			// Used as directory prefix to prevent side-channel attacks
			// while remaining robust to repo name changes
			const repoId = repoInfo.id

			const s3 = new AwsClient({
				accessKeyId: env.R2_S3_READ_WRITE_KEY_ID,
				secretAccessKey: env.R2_S3_READ_WRITE_SECRET_KEY,
			})

			const response: GitLfsBatchResponse = {
				hash_algo,
				objects: await Promise.all(
					objects.map(async ({ oid, size }) =>
						processObject(oid, size, operation, repoId, s3, env),
					),
				),
				transfer: 'basic',
			}

			const responseResult = gitLfsBatchResponseSchema.safeParse(response)
			if (!responseResult.success) {
				return Response.json(
					{
						message: `Server created bad response:\n${z.prettifyError(responseResult.error)}`,
						request_id: requestId,
					},
					{ status: 422 },
				)
			}

			return Response.json(response, {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': mime,
				},
				status: 200,
			})
		}

		return Response.json(
			{ message: 'Not found.', request_id: requestId },
			{
				status: 404,
			},
		)
	},
} satisfies ExportedHandler<Env>

function getPersonalAccessToken(request: Request): string | undefined {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader) {
		return undefined
	}

	const [scheme, encoded] = authHeader.split(' ')
	if (scheme !== 'Basic' || !encoded) {
		return undefined
	}

	try {
		// eslint-disable-next-line no-restricted-globals
		const decoded = atob(encoded)

		// Check for control characters before normalization
		// eslint-disable-next-line no-control-regex
		if (/[\u0000-\u001F\u007F]/.test(decoded)) {
			return undefined
		}

		const normalized = decoded.normalize()
		const colonIndex = normalized.indexOf(':')

		if (colonIndex === -1) {
			return undefined
		}

		// Extract and return the token (part after the colon)
		return normalized.slice(colonIndex + 1)
	} catch {
		// Buffer.from throws on invalid base64
		return undefined
	}
}

async function getGitHubRepoInfo(
	owner: string,
	repo: string,
	personalAccessToken: string,
): Promise<GitHubRepoInfo | undefined> {
	try {
		const octokit = new Octokit({
			auth: personalAccessToken,
		})
		const { data } = await octokit.repos.get({ owner, repo })
		return data
	} catch {
		return undefined
	}
}

function checkAuthorization(repoInfo: GitHubRepoInfo, operation: 'download' | 'upload'): boolean {
	if (repoInfo.permissions === undefined) {
		return false
	}

	if (operation === 'upload' && !repoInfo.permissions.push) {
		return false
	}

	if (operation === 'download' && !repoInfo.permissions.pull) {
		return false
	}

	return true
}

async function sign(
	s3: AwsClient,
	bucket: string,
	endpoint: string,
	path: string,
	method: string,
	expiry = 3600,
): Promise<string> {
	const url = new URL(`https://${bucket}.${endpoint}`)
	url.pathname = path
	url.searchParams.set('X-Amz-Expires', String(expiry))

	const signed = await s3.sign(new Request(url, { method }), { aws: { signQuery: true } })

	return signed.url
}

async function processObject(
	oid: string,
	size: number,
	operation: 'download' | 'upload',
	repoId: number,
	s3: AwsClient,
	env: Env,
): Promise<GitLfsBatchResponseErrorObject | GitLfsBatchResponseObject> {
	// Check for max size...
	if (size > env.MAX_FILE_SIZE) {
		return {
			error: {
				code: 413,
				message: `File size exceeds the maximum allowed size of ${env.MAX_FILE_SIZE} bytes.`,
			},
			oid,
			size,
		} satisfies GitLfsBatchResponseErrorObject
	}

	// Check for missing object...
	if (operation === 'download') {
		const response = await s3.fetch(
			`https://${env.R2_S3_BUCKET}.${env.R2_S3_ENDPOINT}/${repoId}/${oid}`,
			{
				method: 'HEAD',
			},
		)
		if (response.status === 404) {
			return {
				error: {
					code: 404,
					message: `File not found.`,
				},
				oid,
				size,
			} satisfies GitLfsBatchResponseErrorObject
		}
	}

	const signedUrl = await sign(
		s3,
		env.R2_S3_BUCKET,
		env.R2_S3_ENDPOINT,
		`${repoId}/${oid}`,
		operation === 'upload' ? 'PUT' : 'GET',
		env.EXPIRY,
	)

	return {
		actions: {
			[operation]: {
				expires_in: env.EXPIRY,
				href: signedUrl,
			},
		},
		authenticated: true,
		oid,
		size,
	} satisfies GitLfsBatchResponseObject
}
