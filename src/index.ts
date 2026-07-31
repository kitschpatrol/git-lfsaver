/* eslint-disable ts/naming-convention */

import type { RestEndpointMethodTypes } from '@octokit/rest'
import type { JWTPayload } from 'jose'
import { Octokit } from '@octokit/rest'
import { AwsClient } from 'aws4fetch'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import type {
	GitLfsBatchResponse,
	GitLfsBatchResponseErrorObject,
	GitLfsBatchResponseObject,
} from './schemas'
import {
	gitLfsBatchRequestSchema,
	gitLfsBatchResponseSchema,
	gitLfsVerifyRequestSchema,
} from './schemas'

type GitHubRepoInfo = RestEndpointMethodTypes['repos']['get']['response']['data']

type GitHubRepoResult =
	{ repoInfo: GitHubRepoInfo; type: 'found' } | { type: 'not-found' } | { type: 'unauthorized' }

type AuthorizationResult = { errorResponse: Response } | { repoId: number }

type ObjectContext = {
	env: Env
	readOnlyClient: AwsClient
	readWriteClient: AwsClient
	repoId: number
	verifyUrl: string
}

const mime = 'application/vnd.git-lfs+json'

// Tells git-lfs to prompt for Basic credentials instead of looping on a bare 401
const unauthorizedHeaders = { 'LFS-Authenticate': 'Basic realm="Git LFS"' }

// GitHub Actions OIDC tokens are verified against this issuer's JWKS
const githubActionsIssuer = 'https://token.actions.githubusercontent.com'

let githubActionsJwks: ReturnType<typeof createRemoteJWKSet> | undefined

function getGitHubActionsJwks(): ReturnType<typeof createRemoteJWKSet> {
	// Cached at module level so fetched keys survive across requests in an isolate
	githubActionsJwks ??= createRemoteJWKSet(new URL(`${githubActionsIssuer}/.well-known/jwks`))
	return githubActionsJwks
}

// eslint-disable-next-line no-control-regex
const controlCharacterRegex = /[\u{0}-\u{1F}\u{7F}]/v

export default {
	async fetch(request, env, _context): Promise<Response> {
		const requestId = request.headers.get('cf-ray') ?? 'unknown'
		const url = new URL(request.url)

		const staticResponse = getStaticResponse(request, url, requestId)
		if (staticResponse !== undefined) {
			return staticResponse
		}

		// Locking is not supported: 404 is the spec's signal for that, and makes
		// clients disable lock verification automatically
		if (url.pathname.endsWith('/locks') || url.pathname.includes('/locks/')) {
			return lfsErrorResponse('This LFS server does not support locking.', requestId, 404)
		}

		// All LFS requests are POSTs
		if (request.method !== 'POST') {
			return lfsErrorResponse('Only POST requests are allowed.', requestId, 405, {
				Allow: 'POST',
			})
		}

		if (
			// eslint-disable-next-line ts/no-unnecessary-condition
			env.ENFORCE_MIME &&
			(!request.headers.get('Accept')?.startsWith(mime) ||
				!request.headers.get('Content-Type')?.startsWith(mime))
		) {
			return lfsErrorResponse(
				`Invalid request headers, expect "Accept: ${mime}" and "Content-Type: ${mime}", received "${request.headers.get(
					'Accept',
				)}" and "${request.headers.get('Content-Type')}"`,
				requestId,
				406,
			)
		}

		// Expect /<owner>/<repo>/objects/<batch|verify>
		const pathParts = url.pathname.split('/')
		const isBatch = url.pathname.endsWith('/objects/batch')
		const isVerify = url.pathname.endsWith('/objects/verify')
		if ((isBatch || isVerify) && pathParts.length === 5) {
			const owner = decodeURIComponent(pathParts[1] ?? '')
			const repo = decodeURIComponent(pathParts[2] ?? '')
			if (owner.length === 0 || repo.length === 0) {
				return lfsErrorResponse(
					`Invalid request URL pathname, expect "/<owner>/<repo>/objects/batch", received "${url.pathname}" Double check your lfs.url value in your .lfsconfig file.`,
					requestId,
					422,
				)
			}

			// Reject repos outside the allowlist before doing any real work,
			// otherwise anyone with a GitHub account can store objects in the bucket
			if (!isOwnerAllowed(owner, env.ALLOWED_OWNERS)) {
				return lfsErrorResponse(
					`Repository owner "${owner}" is not allowed to use this LFS server.`,
					requestId,
					403,
				)
			}

			return isBatch
				? handleBatch(request, env, owner, repo, requestId)
				: handleVerify(request, env, owner, repo, requestId)
		}

		return lfsErrorResponse('Not found.', requestId, 404)
	},
} satisfies ExportedHandler<Env>

function getStaticResponse(request: Request, url: URL, requestId: string): Response | undefined {
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

	return undefined
}

async function handleBatch(
	request: Request,
	env: Env,
	owner: string,
	repo: string,
	requestId: string,
): Promise<Response> {
	// Read and validate the request
	let rawClientRequest: unknown
	try {
		rawClientRequest = await request.json()
	} catch {
		return lfsErrorResponse('Request body is not valid JSON.', requestId, 422)
	}

	const result = gitLfsBatchRequestSchema.safeParse(rawClientRequest)
	if (!result.success) {
		return lfsErrorResponse(z.prettifyError(result.error), requestId, 422)
	}

	const { hash_algo, objects, operation } = result.data

	const authorization = await authorizeRequest(request, owner, repo, operation, requestId)
	if ('errorResponse' in authorization) {
		return authorization.errorResponse
	}

	const context: ObjectContext = {
		env,
		...createR2Clients(env),
		repoId: authorization.repoId,
		verifyUrl: new URL(
			`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/objects/verify`,
			request.url,
		).href,
	}

	const response: GitLfsBatchResponse = {
		hash_algo,
		objects: await Promise.all(
			objects.map(async ({ oid, size }) => processObject(oid, size, operation, context)),
		),
		transfer: 'basic',
	}

	const responseResult = gitLfsBatchResponseSchema.safeParse(response)
	if (!responseResult.success) {
		return lfsErrorResponse(
			`Server created bad response:\n${z.prettifyError(responseResult.error)}`,
			requestId,
			500,
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

async function handleVerify(
	request: Request,
	env: Env,
	owner: string,
	repo: string,
	requestId: string,
): Promise<Response> {
	// Read and validate the request
	let rawClientRequest: unknown
	try {
		rawClientRequest = await request.json()
	} catch {
		return lfsErrorResponse('Request body is not valid JSON.', requestId, 422)
	}

	const result = gitLfsVerifyRequestSchema.safeParse(rawClientRequest)
	if (!result.success) {
		return lfsErrorResponse(z.prettifyError(result.error), requestId, 422)
	}

	// Verification happens right after upload, so require the same permission
	const authorization = await authorizeRequest(request, owner, repo, 'upload', requestId)
	if ('errorResponse' in authorization) {
		return authorization.errorResponse
	}

	const { oid, size } = result.data
	const { readOnlyClient } = createR2Clients(env)
	const headResponse = await readOnlyClient.fetch(getObjectUrl(env, authorization.repoId, oid), {
		method: 'HEAD',
	})

	if (headResponse.status !== 200) {
		return lfsErrorResponse(
			`Object "${oid}" was not found in storage. The upload may have failed, try pushing again.`,
			requestId,
			404,
		)
	}

	const storedSize = Number(headResponse.headers.get('content-length'))
	if (storedSize !== size) {
		return lfsErrorResponse(
			`Object "${oid}" has stored size ${storedSize}, expected ${size}. Try pushing again.`,
			requestId,
			422,
		)
	}

	return Response.json(
		{ message: 'Object verified.', request_id: requestId },
		{
			headers: { 'Content-Type': mime },
			status: 200,
		},
	)
}

async function authorizeRequest(
	request: Request,
	owner: string,
	repo: string,
	operation: 'download' | 'upload',
	requestId: string,
): Promise<AuthorizationResult> {
	const credential = getCredential(request)
	if (credential === undefined) {
		return {
			errorResponse: lfsErrorResponse(
				'No GitHub credential provided. Send a personal access token or a GitHub Actions OIDC token as the Basic auth password.',
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	if (isJsonWebToken(credential)) {
		return authorizeGitHubActionsToken(
			credential,
			new URL(request.url).host,
			owner,
			repo,
			operation,
			requestId,
		)
	}

	const repoResult = await getGitHubRepoInfo(owner, repo, credential)
	if (repoResult.type === 'unauthorized') {
		return {
			errorResponse: lfsErrorResponse(
				'GitHub rejected the provided credentials.',
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	if (repoResult.type === 'not-found') {
		return {
			errorResponse: lfsErrorResponse(
				`No GitHub repository found for "${owner}/${repo}".`,
				requestId,
				404,
			),
		}
	}

	const isAuthorized = checkAuthorization(repoResult.repoInfo, operation)
	if (!isAuthorized) {
		return {
			errorResponse: lfsErrorResponse(
				`Not authorized to ${operation} in repository "${owner}/${repo}". Check permissions on your GitHub personal access token.`,
				requestId,
				403,
			),
		}
	}

	// Used as directory prefix to prevent side-channel attacks
	// while remaining robust to repo name changes
	return { repoId: repoResult.repoInfo.id }
}

async function authorizeGitHubActionsToken(
	token: string,
	audience: string,
	owner: string,
	repo: string,
	operation: 'download' | 'upload',
	requestId: string,
): Promise<AuthorizationResult> {
	let payload: JWTPayload
	try {
		const result = await jwtVerify(token, getGitHubActionsJwks(), {
			algorithms: ['RS256'],
			audience,
			issuer: githubActionsIssuer,
		})
		payload = result.payload
	} catch {
		return {
			errorResponse: lfsErrorResponse(
				`GitHub Actions OIDC token verification failed. Request the token with audience "${audience}".`,
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	// The cryptographically verified repo identity must match the request path
	const claimedRepo = payload.repository
	if (
		typeof claimedRepo !== 'string' ||
		claimedRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
	) {
		return {
			errorResponse: lfsErrorResponse(
				`OIDC token was not issued for repository "${owner}/${repo}".`,
				requestId,
				403,
			),
		}
	}

	// CI has no need to push LFS objects, so OIDC access stays read-only
	if (operation !== 'download') {
		return {
			errorResponse: lfsErrorResponse(
				'GitHub Actions OIDC tokens are only authorized to download. Upload with a personal access token instead.',
				requestId,
				403,
			),
		}
	}

	// The same numeric repo ID the GitHub API reports, so both auth paths
	// address the same storage namespace
	const repoId = Number(payload.repository_id)
	if (!Number.isInteger(repoId) || repoId <= 0) {
		return {
			errorResponse: lfsErrorResponse(
				'OIDC token is missing a valid repository_id claim.',
				requestId,
				403,
			),
		}
	}

	return { repoId }
}

function isJsonWebToken(credential: string): boolean {
	// GitHub PATs never contain dots; JWTs are three dot-separated base64url
	// segments starting with the encoded {"alg"... header
	return credential.startsWith('eyJ') && credential.split('.').length === 3
}

function lfsErrorResponse(
	message: string,
	requestId: string,
	status: number,
	headers: Record<string, string> = {},
): Response {
	return Response.json(
		{ message, request_id: requestId },
		{ headers: { 'Content-Type': mime, ...headers }, status },
	)
}

function isOwnerAllowed(owner: string, allowedOwners: string): boolean {
	// GitHub owner names are case-insensitive
	const allowed = allowedOwners
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0)

	// An empty allowlist rejects everyone (fail closed)
	return allowed.includes(owner.toLowerCase())
}

function getCredential(request: Request): string | undefined {
	const authHeader = request.headers.get('Authorization')
	if (authHeader === null || authHeader === '') {
		return undefined
	}

	const [scheme, encoded] = authHeader.split(' ', 2)
	if (scheme !== 'Basic' || encoded === undefined || encoded === '') {
		return undefined
	}

	try {
		// eslint-disable-next-line no-restricted-globals
		const decoded = atob(encoded)

		// Check for control characters before normalization
		if (controlCharacterRegex.test(decoded)) {
			return undefined
		}

		const normalized = decoded.normalize()
		const colonIndex = normalized.indexOf(':')

		if (colonIndex === -1) {
			return undefined
		}

		// Extract and return the credential (part after the colon)
		return normalized.slice(colonIndex + 1)
	} catch {
		// The atob call throws on invalid base64
		return undefined
	}
}

async function getGitHubRepoInfo(
	owner: string,
	repo: string,
	personalAccessToken: string,
): Promise<GitHubRepoResult> {
	try {
		const octokit = new Octokit({
			auth: personalAccessToken,
		})
		const { data } = await octokit.repos.get({ owner, repo })
		return { repoInfo: data, type: 'found' }
	} catch (error) {
		// Distinguish bad credentials from missing/inaccessible repos so clients
		// get a credential prompt rather than a misleading 404
		if (typeof error === 'object' && error !== null && 'status' in error && error.status === 401) {
			return { type: 'unauthorized' }
		}

		return { type: 'not-found' }
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

function createR2Clients(env: Env): { readOnlyClient: AwsClient; readWriteClient: AwsClient } {
	return {
		readOnlyClient: new AwsClient({
			accessKeyId: env.R2_S3_READ_KEY_ID,
			secretAccessKey: env.R2_S3_READ_SECRET_KEY,
		}),
		readWriteClient: new AwsClient({
			accessKeyId: env.R2_S3_READ_WRITE_KEY_ID,
			secretAccessKey: env.R2_S3_READ_WRITE_SECRET_KEY,
		}),
	}
}

function getObjectUrl(env: Env, repoId: number, oid: string): string {
	return `https://${env.R2_S3_BUCKET}.${env.R2_S3_ENDPOINT}/${repoId}/${oid}`
}

async function sign(
	s3: AwsClient,
	env: Env,
	path: string,
	method: 'GET' | 'PUT',
	contentLength?: number,
): Promise<string> {
	const url = new URL(`https://${env.R2_S3_BUCKET}.${env.R2_S3_ENDPOINT}`)
	url.pathname = path
	url.searchParams.set('X-Amz-Expires', String(env.EXPIRY))

	// Signing content-length caps how many bytes the client can PUT with this
	// URL; aws4fetch only signs it when allHeaders is set
	const headers: Record<string, string> =
		contentLength === undefined ? {} : { 'content-length': String(contentLength) }

	const signed = await s3.sign(url.href, {
		aws: { allHeaders: true, signQuery: true },
		headers,
		method,
	})

	return signed.url
}

async function processObject(
	oid: string,
	size: number,
	operation: 'download' | 'upload',
	context: ObjectContext,
): Promise<GitLfsBatchResponseErrorObject | GitLfsBatchResponseObject> {
	const { env, readOnlyClient, readWriteClient, repoId, verifyUrl } = context

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

	// One subrequest per object: existence check for downloads, dedup check for uploads
	const headResponse = await readOnlyClient.fetch(getObjectUrl(env, repoId, oid), {
		method: 'HEAD',
	})

	if (operation === 'download') {
		if (headResponse.status === 404) {
			return {
				error: {
					code: 404,
					message: `File not found.`,
				},
				oid,
				size,
			} satisfies GitLfsBatchResponseErrorObject
		}

		const signedUrl = await sign(readOnlyClient, env, `${repoId}/${oid}`, 'GET')
		return {
			actions: {
				download: {
					expires_in: env.EXPIRY,
					href: signedUrl,
				},
			},
			authenticated: true,
			oid,
			size,
		} satisfies GitLfsBatchResponseObject
	}

	// Omitting actions tells the client the object is already stored and the
	// upload can be skipped (the spec's dedup mechanism)
	if (headResponse.status === 200 && Number(headResponse.headers.get('content-length')) === size) {
		return {
			authenticated: true,
			oid,
			size,
		} satisfies GitLfsBatchResponseObject
	}

	const signedUrl = await sign(readWriteClient, env, `${repoId}/${oid}`, 'PUT', size)
	return {
		actions: {
			upload: {
				expires_in: env.EXPIRY,
				href: signedUrl,
			},
			verify: {
				href: verifyUrl,
			},
		},
		authenticated: true,
		oid,
		size,
	} satisfies GitLfsBatchResponseObject
}
