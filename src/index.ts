/* eslint-disable ts/naming-convention */

import type { RestEndpointMethodTypes } from '@octokit/rest'
import type { JWTPayload } from 'jose'
import { Octokit } from '@octokit/rest'
import { AwsClient } from 'aws4fetch'
import { createRemoteJWKSet, decodeJwt, importJWK, jwtVerify } from 'jose'
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
import {
	selfIssuedGitHubGrantClaimsSchema,
	selfIssuedTokenClaimsSchema,
	selfIssuedTokenIssuer,
} from './self-issued'

type GitHubRepoInfo = RestEndpointMethodTypes['repos']['get']['response']['data']

type GitHubRepoResult =
	| { repoInfo: GitHubRepoInfo; type: 'found' }
	| { type: 'not-found' }
	| { type: 'rate-limited' }
	| { type: 'unauthorized' }

type AuthorizationResult = { errorResponse: Response } | { storagePrefix: string }

// GitHub repos are addressed as /<owner>/<repo>/…, self-issued (non-GitHub)
// repos as /<repo-name>/… — the path shape selects the credential type
type RepoAddress = { name: string; type: 'self' } | { owner: string; repo: string; type: 'github' }

type ObjectContext = {
	env: Env
	readOnlyClient: AwsClient
	readWriteClient: AwsClient
	storagePrefix: string
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

let selfIssuedKeyCache: undefined | { key: CryptoKey | Uint8Array; publicKey: string }

async function getSelfIssuedPublicKey(publicKey: string): Promise<CryptoKey | Uint8Array> {
	// Cached at module level like the JWKS; keyed by the binding value so a
	// rotated key takes effect without an isolate restart
	if (selfIssuedKeyCache?.publicKey !== publicKey) {
		selfIssuedKeyCache = {
			key: await importJWK({ crv: 'Ed25519', kty: 'OKP', x: publicKey }, 'EdDSA'),
			publicKey,
		}
	}

	return selfIssuedKeyCache.key
}

// eslint-disable-next-line no-control-regex
const controlCharacterRegex = /[\u{0}-\u{1F}\u{7F}]/v

const batchPathSuffixRegex = /\/objects\/batch$/v

// Storage keys are namespaced per provider (`github.com/<id>/…`,
// `self/<name>/…`) so future forges can never collide with existing prefixes
const githubStoragePrefix = 'github.com'

type CachedAuthorization = {
	expiresAt: number
	permissions: { pull: boolean; push: boolean }
	storagePrefix: string
}

// Short-lived per-isolate cache of GitHub authorization results, keyed by a
// hash of the credential (the credential itself is never stored). Cuts the
// GitHub API round-trip on repeated batches and per-object verify calls. The
// tradeoff: a revoked token or changed permission can linger for up to the TTL.
const authorizationCache = new Map<string, CachedAuthorization>()
const authorizationCacheTtl = 5 * 60 * 1000
const authorizationCacheMaxEntries = 1000

async function getAuthorizationCacheKey(
	credential: string,
	owner: string,
	repo: string,
): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential))
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
	return `${hash}:${owner.toLowerCase()}/${repo.toLowerCase()}`
}

function getCachedAuthorization(key: string): CachedAuthorization | undefined {
	const cached = authorizationCache.get(key)
	if (cached === undefined) {
		return undefined
	}

	if (cached.expiresAt <= Date.now()) {
		authorizationCache.delete(key)
		return undefined
	}

	return cached
}

function setCachedAuthorization(key: string, value: Omit<CachedAuthorization, 'expiresAt'>): void {
	// Bound memory by dropping the oldest entry once full (Maps preserve
	// insertion order)
	if (authorizationCache.size >= authorizationCacheMaxEntries) {
		const oldestKey = authorizationCache.keys().next().value
		if (oldestKey !== undefined) {
			authorizationCache.delete(oldestKey)
		}
	}

	authorizationCache.set(key, { ...value, expiresAt: Date.now() + authorizationCacheTtl })
}

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

		const mimeResponse = getInvalidMimeResponse(request, env, requestId)
		if (mimeResponse !== undefined) {
			return mimeResponse
		}

		const pathParts = url.pathname.split('/')
		const isBatch = url.pathname.endsWith('/objects/batch')
		const isVerify = url.pathname.endsWith('/objects/verify')
		if ((isBatch || isVerify) && pathParts.length >= 4 && pathParts.length <= 6) {
			const parsed = parseRepoAddress(pathParts, url.pathname, env, requestId)
			if ('errorResponse' in parsed) {
				return parsed.errorResponse
			}

			return isBatch
				? handleBatch(request, env, parsed.address, requestId)
				: handleVerify(request, env, parsed.address, requestId)
		}

		return lfsErrorResponse('Not found.', requestId, 404)
	},
} satisfies ExportedHandler<Env>

/**
 * Repos are addressed by the path segments before `/objects/<batch|verify>`,
 * and the segment count selects the provider:
 *
 * - `/<repo-name>` — self-issued (non-GitHub) repos
 * - `/<owner>/<repo>` — GitHub (the default provider)
 * - `/<host>/<owner>/<repo>` — explicit provider host; only github.com today,
 *   other forges reserved for later
 */
function parseRepoAddress(
	pathParts: string[],
	pathname: string,
	env: Env,
	requestId: string,
): { address: RepoAddress } | { errorResponse: Response } {
	const repoSegments = pathParts.slice(1, -2).map((part) => decodeURIComponent(part))
	if (repoSegments.some((segment) => segment.length === 0)) {
		return {
			errorResponse: lfsErrorResponse(
				`Invalid request URL pathname, expect "/<owner>/<repo>/objects/batch" (GitHub), "/<host>/<owner>/<repo>/objects/batch", or "/<repo-name>/objects/batch" (self-issued), received "${pathname}" Double check your lfs.url value in your .lfsconfig file.`,
				requestId,
				422,
			),
		}
	}

	if (repoSegments.length === 1) {
		return { address: { name: repoSegments[0] ?? '', type: 'self' } }
	}

	if (repoSegments.length === 3) {
		const host = (repoSegments.shift() ?? '').toLowerCase()
		if (host !== 'github.com') {
			return {
				errorResponse: lfsErrorResponse(
					`Unsupported provider host "${host}". Only "github.com" repositories are supported on explicit three-segment paths.`,
					requestId,
					404,
				),
			}
		}
	}

	const [owner = '', repo = ''] = repoSegments

	// Reject repos outside the allowlist before doing any real work, otherwise
	// anyone with a GitHub account can store objects in the bucket. Self-issued
	// (single-segment) paths skip this: their authorization is the admin-signed
	// token itself.
	if (!isOwnerAllowed(owner, env.GITHUB_ALLOWED_OWNERS)) {
		return {
			errorResponse: lfsErrorResponse(
				`Repository owner "${owner}" is not allowed to use this LFS server.`,
				requestId,
				403,
			),
		}
	}

	return { address: { owner, repo, type: 'github' } }
}

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

function getInvalidMimeResponse(
	request: Request,
	env: Env,
	requestId: string,
): Response | undefined {
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

	return undefined
}

async function handleBatch(
	request: Request,
	env: Env,
	address: RepoAddress,
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

	const authorization = await authorizeRequest(request, env, address, operation, requestId)
	if ('errorResponse' in authorization) {
		return authorization.errorResponse
	}

	const context: ObjectContext = {
		env,
		...createS3Clients(env),
		storagePrefix: authorization.storagePrefix,
		// Echo the request's own path shape (default, explicit-host, or
		// self-issued) so the client verifies against the URL form it already uses
		verifyUrl: new URL(
			new URL(request.url).pathname.replace(batchPathSuffixRegex, '/objects/verify'),
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
	address: RepoAddress,
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
	const authorization = await authorizeRequest(request, env, address, 'upload', requestId)
	if ('errorResponse' in authorization) {
		return authorization.errorResponse
	}

	const { oid, size } = result.data
	const { readOnlyClient } = createS3Clients(env)
	const headResponse = await readOnlyClient.fetch(
		getObjectUrl(env, authorization.storagePrefix, oid),
		{ method: 'HEAD' },
	)

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
	env: Env,
	address: RepoAddress,
	operation: 'download' | 'upload',
	requestId: string,
): Promise<AuthorizationResult> {
	const credential = getCredential(request)
	if (credential === undefined) {
		// Public GitHub repos allow anonymous downloads, mirroring GitHub's own
		// LFS behavior; everything else requires a credential
		if (operation === 'download' && address.type === 'github') {
			return authorizeAnonymousDownload(address.owner, address.repo, requestId)
		}

		return {
			errorResponse: lfsErrorResponse(
				'No credential provided. Send a GitHub personal access token, a GitHub Actions OIDC token, or a self-issued token as the Basic auth password.',
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	const audience = new URL(request.url).host
	// The issuer claim only routes the token to a verifier; nothing is trusted
	// until the signature check inside that verifier passes
	const isSelfIssuedToken =
		isJsonWebToken(credential) && getUnverifiedIssuer(credential) === selfIssuedTokenIssuer

	if (address.type === 'self') {
		if (!isSelfIssuedToken) {
			return {
				errorResponse: lfsErrorResponse(
					`Repository "${address.name}" is addressed without an owner segment, so it accepts only self-issued tokens. GitHub repositories use "/<owner>/<repo>" URLs instead.`,
					requestId,
					401,
					unauthorizedHeaders,
				),
			}
		}

		return authorizeSelfIssuedToken(credential, audience, env, address, operation, requestId)
	}

	const { owner, repo } = address
	if (isSelfIssuedToken) {
		// Owner-qualified paths accept self-issued tokens only when they carry
		// an explicit GitHub repo grant (minted with --github-repo-id)
		return authorizeSelfIssuedToken(credential, audience, env, address, operation, requestId)
	}

	if (isJsonWebToken(credential)) {
		return authorizeGitHubActionsToken(credential, audience, owner, repo, operation, requestId)
	}

	const cacheKey = await getAuthorizationCacheKey(credential, owner, repo)
	const cached = getCachedAuthorization(cacheKey)
	if (cached !== undefined) {
		if (!hasOperationPermission(cached.permissions, operation)) {
			return { errorResponse: operationForbiddenResponse(operation, owner, repo, requestId) }
		}

		return { storagePrefix: cached.storagePrefix }
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

	if (repoResult.type !== 'found') {
		return {
			errorResponse: lfsErrorResponse(
				`No GitHub repository found for "${owner}/${repo}".`,
				requestId,
				404,
			),
		}
	}

	const permissions = {
		pull: repoResult.repoInfo.permissions?.pull ?? false,
		push: repoResult.repoInfo.permissions?.push ?? false,
	}

	// The numeric GitHub repo ID keys the storage prefix to prevent side-channel
	// attacks while remaining robust to repo name changes — GitHub's rename
	// redirects preserve authorization continuity, but only the immutable,
	// never-reused ID preserves addressing continuity
	const storagePrefix = `${githubStoragePrefix}/${repoResult.repoInfo.id}`
	setCachedAuthorization(cacheKey, { permissions, storagePrefix })

	if (!hasOperationPermission(permissions, operation)) {
		return { errorResponse: operationForbiddenResponse(operation, owner, repo, requestId) }
	}

	return { storagePrefix }
}

async function authorizeAnonymousDownload(
	owner: string,
	repo: string,
	requestId: string,
): Promise<AuthorizationResult> {
	// An unauthenticated GitHub API hit can only ever see public repos, so a
	// successful lookup is proof of public visibility. Cached like credentialed
	// authorizations; the "anonymous:" prefix can't collide with the hex
	// credential hashes used as cache keys
	const cacheKey = `anonymous:${owner.toLowerCase()}/${repo.toLowerCase()}`
	const cached = getCachedAuthorization(cacheKey)
	if (cached !== undefined) {
		return { storagePrefix: cached.storagePrefix }
	}

	const repoResult = await getGitHubRepoInfo(owner, repo, undefined)
	if (repoResult.type === 'rate-limited') {
		// Unauthenticated GitHub API calls share a per-IP rate limit across
		// Workers tenants, so fall back to asking for credentials
		return {
			errorResponse: lfsErrorResponse(
				'Anonymous access is temporarily unavailable (GitHub API rate limit). Authenticate to proceed.',
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	if (repoResult.type !== 'found') {
		return {
			errorResponse: lfsErrorResponse(
				`No public GitHub repository found for "${owner}/${repo}". Authenticate to access private repositories.`,
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	const storagePrefix = `${githubStoragePrefix}/${repoResult.repoInfo.id}`
	setCachedAuthorization(cacheKey, { permissions: { pull: true, push: false }, storagePrefix })
	return { storagePrefix }
}

function operationForbiddenResponse(
	operation: 'download' | 'upload',
	owner: string,
	repo: string,
	requestId: string,
): Response {
	return lfsErrorResponse(
		`Not authorized to ${operation} in repository "${owner}/${repo}". Check permissions on your GitHub personal access token.`,
		requestId,
		403,
	)
}

function hasOperationPermission(
	permissions: { pull: boolean; push: boolean },
	operation: 'download' | 'upload',
): boolean {
	return operation === 'download' ? permissions.pull : permissions.push
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

	// The same numeric repo ID the GitHub API reports, so both GitHub auth
	// paths address the same storage namespace
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

	return { storagePrefix: `${githubStoragePrefix}/${repoId}` }
}

async function authorizeSelfIssuedToken(
	token: string,
	audience: string,
	env: Env,
	address: RepoAddress,
	operation: 'download' | 'upload',
	requestId: string,
): Promise<AuthorizationResult> {
	const publicKey = env.SELF_ISSUED_TOKEN_PUBLIC_KEY
	// eslint-disable-next-line ts/no-unnecessary-condition -- The generated type narrows to the deployment's literal value
	if (publicKey === '') {
		return {
			errorResponse: lfsErrorResponse(
				'This server does not accept self-issued tokens. Set the SELF_ISSUED_TOKEN_PUBLIC_KEY variable to enable them.',
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	let key: Awaited<ReturnType<typeof getSelfIssuedPublicKey>>
	try {
		key = await getSelfIssuedPublicKey(publicKey)
	} catch {
		return {
			errorResponse: lfsErrorResponse(
				'SELF_ISSUED_TOKEN_PUBLIC_KEY is not a valid Ed25519 public key. Expect the base64url value printed by `pnpm run token generate-key`.',
				requestId,
				500,
			),
		}
	}

	let payload: JWTPayload
	try {
		const result = await jwtVerify(token, key, {
			algorithms: ['EdDSA'],
			audience,
			issuer: selfIssuedTokenIssuer,
			requiredClaims: ['exp'],
		})
		payload = result.payload
	} catch {
		return {
			errorResponse: lfsErrorResponse(
				`Self-issued token verification failed. Mint the token for host "${audience}" with \`pnpm run token mint\`.`,
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	if (address.type === 'github') {
		// Owner-qualified paths require an explicit GitHub repo grant: the
		// admin-asserted numeric ID pins the token to the same storage prefix
		// the GitHub credential paths resolve, bypassing GitHub's permission
		// model for collaborators without GitHub accounts
		const grantResult = selfIssuedGitHubGrantClaimsSchema.safeParse(payload)
		if (!grantResult.success) {
			return {
				errorResponse: lfsErrorResponse(
					`This self-issued token does not grant access to GitHub repository "${address.owner}/${address.repo}". Mint one with \`pnpm run token mint --github-repo-id\`.`,
					requestId,
					403,
				),
			}
		}

		const grant = grantResult.data
		if (grant.repo.toLowerCase() !== `${address.owner}/${address.repo}`.toLowerCase()) {
			return {
				errorResponse: lfsErrorResponse(
					`Self-issued token was not issued for repository "${address.owner}/${address.repo}".`,
					requestId,
					403,
				),
			}
		}

		if (!hasOperationPermission(grant, operation)) {
			return {
				errorResponse: lfsErrorResponse(
					`This self-issued token is not authorized to ${operation} in repository "${address.owner}/${address.repo}".`,
					requestId,
					403,
				),
			}
		}

		return { storagePrefix: `${githubStoragePrefix}/${grant.github_repo_id}` }
	}

	const claimsResult = selfIssuedTokenClaimsSchema.safeParse(payload)
	if (!claimsResult.success) {
		return {
			errorResponse: lfsErrorResponse(
				`Self-issued token has invalid claims:\n${z.prettifyError(claimsResult.error)}`,
				requestId,
				403,
			),
		}
	}

	const claims = claimsResult.data
	if (claims.repo.toLowerCase() !== address.name.toLowerCase()) {
		return {
			errorResponse: lfsErrorResponse(
				`Self-issued token was not issued for repository "${address.name}".`,
				requestId,
				403,
			),
		}
	}

	if (!hasOperationPermission(claims, operation)) {
		return {
			errorResponse: lfsErrorResponse(
				`This self-issued token is not authorized to ${operation} in repository "${address.name}".`,
				requestId,
				403,
			),
		}
	}

	// The "self/" namespace keeps admin-chosen repo names disjoint from every
	// provider namespace (github.com/…, and any future forge). Renaming a repo
	// moves its prefix, so objects must be copied or re-uploaded after a rename.
	return { storagePrefix: `self/${claims.repo.toLowerCase()}` }
}

function getUnverifiedIssuer(token: string): string | undefined {
	try {
		return decodeJwt(token).iss
	} catch {
		return undefined
	}
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
	personalAccessToken: string | undefined,
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
		if (typeof error === 'object' && error !== null && 'status' in error) {
			if (error.status === 401) {
				return { type: 'unauthorized' }
			}

			if (error.status === 403 || error.status === 429) {
				return { type: 'rate-limited' }
			}
		}

		return { type: 'not-found' }
	}
}

function createS3Clients(env: Env): { readOnlyClient: AwsClient; readWriteClient: AwsClient } {
	return {
		readOnlyClient: new AwsClient({
			accessKeyId: env.S3_READ_KEY_ID,
			secretAccessKey: env.S3_READ_SECRET_KEY,
		}),
		readWriteClient: new AwsClient({
			accessKeyId: env.S3_READ_WRITE_KEY_ID,
			secretAccessKey: env.S3_READ_WRITE_SECRET_KEY,
		}),
	}
}

function getObjectUrl(env: Env, storagePrefix: string, oid: string): string {
	return `https://${env.S3_BUCKET}.${env.S3_ENDPOINT}/${storagePrefix}/${oid}`
}

async function sign(
	s3: AwsClient,
	env: Env,
	path: string,
	method: 'GET' | 'PUT',
	uploadConstraints?: { contentLength: number; contentSha256: string },
): Promise<string> {
	const url = new URL(`https://${env.S3_BUCKET}.${env.S3_ENDPOINT}`)
	url.pathname = path
	url.searchParams.set('X-Amz-Expires', String(env.EXPIRY))

	// Signing content-length caps how many bytes the client can PUT with this
	// URL, and x-amz-content-sha256 declares the exact expected bytes, enforced
	// by providers that validate it on presigned uploads. The client must send
	// both headers verbatim; aws4fetch only signs them when allHeaders is set
	const headers: Record<string, string> =
		uploadConstraints === undefined
			? {}
			: {
					'content-length': String(uploadConstraints.contentLength),
					'x-amz-content-sha256': uploadConstraints.contentSha256,
				}

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
	const { env, readOnlyClient, readWriteClient, storagePrefix, verifyUrl } = context

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
	const headResponse = await readOnlyClient.fetch(getObjectUrl(env, storagePrefix, oid), {
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

		const signedUrl = await sign(readOnlyClient, env, `${storagePrefix}/${oid}`, 'GET')
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

	// The OID is the SHA-256 of the content, so signing it as the expected
	// payload hash makes storage content-addressed: only the correct bytes can
	// land at an object's address (on providers that enforce it)
	const signedUrl = await sign(readWriteClient, env, `${storagePrefix}/${oid}`, 'PUT', {
		contentLength: size,
		contentSha256: oid,
	})
	return {
		actions: {
			upload: {
				expires_in: env.EXPIRY,
				// Sent by the client verbatim; must match the signed value
				header: { 'x-amz-content-sha256': oid },
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
