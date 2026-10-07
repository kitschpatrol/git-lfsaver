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
import versionInfo from './version.json'

type GitHubRepositoryInfo = RestEndpointMethodTypes['repos']['get']['response']['data']

type GitHubRepositoryResult =
	| { repoInfo: GitHubRepositoryInfo; type: 'found' }
	| { type: 'not-found' }
	| { type: 'rate-limited' }
	| { type: 'unauthorized' }

type AuthorizationResult = { errorResponse: Response } | { storagePrefix: string }

// GitHub repos are addressed as /<owner>/<repo>/…, self-issued (non-GitHub)
// repos as /<repo-name>/… — the path shape selects the credential type
type RepositoryAddress =
	{ name: string; type: 'self' } | { owner: string; repo: string; type: 'github' }

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

// The batch spec caps requests at 100 objects (a few tens of KiB of JSON), so
// this generous limit only blocks abuse: Workers accept request bodies up to
// 100 MB, and the body is read before authorization because the operation
// claim inside it selects the auth policy
const maxRequestBodyBytes = 256 * 1024

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
	repository: string,
): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential))
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
	return `${hash}:${owner.toLowerCase()}/${repository.toLowerCase()}`
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
			const parsed = parseRepositoryAddress(pathParts, url.pathname, env, requestId)
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
function parseRepositoryAddress(
	pathParts: string[],
	pathname: string,
	env: Env,
	requestId: string,
): { address: RepositoryAddress } | { errorResponse: Response } {
	let repositorySegments: string[]
	try {
		repositorySegments = pathParts.slice(1, -2).map((part) => decodeURIComponent(part))
	} catch {
		// Malformed percent-encoding (e.g. "%zz") throws URIError; without this
		// it would surface as an unauthenticated 500
		return {
			errorResponse: lfsErrorResponse(
				`Invalid percent-encoding in request URL pathname "${pathname}". Double check your lfs.url value in your .lfsconfig file.`,
				requestId,
				422,
			),
		}
	}

	if (repositorySegments.some((segment) => segment.length === 0)) {
		return {
			errorResponse: lfsErrorResponse(
				`Invalid request URL pathname, expect "/<owner>/<repo>/objects/batch" (GitHub), "/<host>/<owner>/<repo>/objects/batch", or "/<repo-name>/objects/batch" (self-issued), received "${pathname}" Double check your lfs.url value in your .lfsconfig file.`,
				requestId,
				422,
			),
		}
	}

	if (repositorySegments.length === 1) {
		return { address: { name: repositorySegments[0] ?? '', type: 'self' } }
	}

	if (repositorySegments.length === 3) {
		const host = (repositorySegments.shift() ?? '').toLowerCase()
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

	const [owner = '', repository = ''] = repositorySegments

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

	return { address: { owner, repo: repository, type: 'github' } }
}

function getStaticResponse(request: Request, url: URL, requestId: string): Response | undefined {
	if (url.pathname === '/') {
		if (request.method === 'GET') {
			return new Response(
				'<!DOCTYPE html><html style="background-color:lightseagreen;"><head><meta charset="utf-8"><title>Git LFSaver</title></head><body style="margin:0;padding:0;height:100vh;display:flex;align-items:center;justify-content:center"><h1 style="margin:0;font-size:6em">🛟</h1></body></html>',
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

	if (url.pathname === '/version.json') {
		if (request.method === 'GET') {
			// Regenerated by the build script before every deploy, so this
			// reports the state of the working tree the deploy was made from
			return Response.json(versionInfo, {
				headers: { 'Cache-Control': 'no-store' },
			})
		}

		return Response.json(
			{
				message: 'Only GET requests are allowed for version info.',
				request_id: requestId,
			},
			{
				headers: { Allow: 'GET' },
				status: 405,
			},
		)
	}

	if (url.pathname === '/favicon.ico') {
		const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 16 16'><text x='0' y='14'>🛟</text></svg>`
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

/**
 * Reads and parses a JSON request body, enforcing {@link maxRequestBodyBytes} by
 * streaming rather than trusting the Content-Length header (chunked requests
 * can omit it). Bounds the memory an unauthenticated request can consume, since
 * bodies are read before authorization.
 */
async function readJsonBody(
	request: Request,
	requestId: string,
): Promise<{ errorResponse: Response } | { raw: unknown }> {
	if (request.body === null) {
		return { errorResponse: lfsErrorResponse('Request body is not valid JSON.', requestId, 422) }
	}

	const chunks: Uint8Array[] = []
	let total = 0
	for await (const chunk of request.body) {
		total += chunk.byteLength
		if (total > maxRequestBodyBytes) {
			// Breaking out of iteration cancels the underlying stream
			return {
				errorResponse: lfsErrorResponse(
					`Request body exceeds the maximum allowed size of ${maxRequestBodyBytes} bytes.`,
					requestId,
					413,
				),
			}
		}

		chunks.push(chunk)
	}

	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}

	try {
		return { raw: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
	} catch {
		return { errorResponse: lfsErrorResponse('Request body is not valid JSON.', requestId, 422) }
	}
}

async function handleBatch(
	request: Request,
	env: Env,
	address: RepositoryAddress,
	requestId: string,
): Promise<Response> {
	// Read and validate the request
	const bodyResult = await readJsonBody(request, requestId)
	if ('errorResponse' in bodyResult) {
		return bodyResult.errorResponse
	}

	const result = gitLfsBatchRequestSchema.safeParse(bodyResult.raw)
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
	address: RepositoryAddress,
	requestId: string,
): Promise<Response> {
	// Read and validate the request
	const bodyResult = await readJsonBody(request, requestId)
	if ('errorResponse' in bodyResult) {
		return bodyResult.errorResponse
	}

	const result = gitLfsVerifyRequestSchema.safeParse(bodyResult.raw)
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

	if (headResponse.status !== 200 && headResponse.status !== 404) {
		return lfsErrorResponse(
			`Storage returned HTTP ${headResponse.status} while verifying object "${oid}". Try again later.`,
			requestId,
			502,
		)
	}

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
	address: RepositoryAddress,
	operation: 'download' | 'upload',
	requestId: string,
): Promise<AuthorizationResult> {
	const credential = getCredential(request)
	if (credential === undefined) {
		// Public GitHub repos allow anonymous downloads, mirroring GitHub's own
		// LFS behavior; everything else requires a credential
		if (operation === 'download' && address.type === 'github') {
			return authorizeAnonymousDownload(address.owner, address.repo, env, requestId)
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
		// an explicit GitHub repo grant (minted with an owner-qualified --repo)
		return authorizeSelfIssuedToken(credential, audience, env, address, operation, requestId)
	}

	if (isJsonWebToken(credential)) {
		return authorizeGitHubActionsToken(credential, audience, owner, repo, operation, requestId)
	}

	const cacheKey = await getAuthorizationCacheKey(credential, owner, repo)
	const cached = getCachedAuthorization(cacheKey)
	if (cached !== undefined) {
		return hasOperationPermission(cached.permissions, operation)
			? { storagePrefix: cached.storagePrefix }
			: { errorResponse: operationForbiddenResponse(operation, owner, repo, requestId) }
	}

	const repositoryResult = await getGitHubRepositoryInfo(owner, repo, credential)
	if (repositoryResult.type === 'unauthorized') {
		return {
			errorResponse: lfsErrorResponse(
				'GitHub rejected the provided credentials.',
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	// GitHub sends 403 for rate limits and policy blocks alike, so this can't
	// claim the repo doesn't exist — distinguish it from the 404 below
	if (repositoryResult.type === 'rate-limited') {
		return {
			errorResponse: lfsErrorResponse(
				`GitHub rate-limited or refused the lookup of "${owner}/${repo}". Try again later; if this persists, check your token's access restrictions (e.g. SAML SSO authorization).`,
				requestId,
				429,
			),
		}
	}

	if (repositoryResult.type !== 'found') {
		return {
			errorResponse: lfsErrorResponse(
				`No GitHub repository found for "${owner}/${repo}".`,
				requestId,
				404,
			),
		}
	}

	const ownerResponse = resolvedOwnerForbiddenResponse(repositoryResult.repoInfo, env, requestId)
	if (ownerResponse !== undefined) {
		return { errorResponse: ownerResponse }
	}

	const permissions = {
		pull: repositoryResult.repoInfo.permissions?.pull ?? false,
		push: repositoryResult.repoInfo.permissions?.push ?? false,
	}

	// The numeric GitHub repo ID keys the storage prefix to prevent side-channel
	// attacks while remaining robust to repo name changes — GitHub's rename
	// redirects preserve authorization continuity, but only the immutable,
	// never-reused ID preserves addressing continuity
	const storagePrefix = `${githubStoragePrefix}/${repositoryResult.repoInfo.id}`
	setCachedAuthorization(cacheKey, { permissions, storagePrefix })

	return hasOperationPermission(permissions, operation)
		? { storagePrefix }
		: { errorResponse: operationForbiddenResponse(operation, owner, repo, requestId) }
}

/**
 * GitHub follows rename and transfer redirects, so the URL's owner (already
 * allowlist-checked before lookup) may not be the repo's current owner.
 * Re-checking the resolved owner keeps redirects working for renames and
 * transfers within the allowlist, but stops a repo transferred out of it from
 * using this server through its old URL — otherwise the new owner would retain
 * indefinite access to the bucket.
 */
function resolvedOwnerForbiddenResponse(
	repositoryInfo: GitHubRepositoryInfo,
	env: Env,
	requestId: string,
): Response | undefined {
	const resolvedOwner = repositoryInfo.owner.login
	return isOwnerAllowed(resolvedOwner, env.GITHUB_ALLOWED_OWNERS)
		? undefined
		: lfsErrorResponse(
				`Repository "${repositoryInfo.full_name}" is owned by "${resolvedOwner}", which is not allowed to use this LFS server.`,
				requestId,
				403,
			)
}

async function authorizeAnonymousDownload(
	owner: string,
	repository: string,
	env: Env,
	requestId: string,
): Promise<AuthorizationResult> {
	// An unauthenticated GitHub API hit can only ever see public repos, so a
	// successful lookup is proof of public visibility. Cached like credentialed
	// authorizations; the "anonymous:" prefix can't collide with the hex
	// credential hashes used as cache keys
	const cacheKey = `anonymous:${owner.toLowerCase()}/${repository.toLowerCase()}`
	const cached = getCachedAuthorization(cacheKey)
	if (cached !== undefined) {
		return { storagePrefix: cached.storagePrefix }
	}

	const repositoryResult = await getGitHubRepositoryInfo(owner, repository, undefined)
	if (repositoryResult.type === 'rate-limited') {
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

	if (repositoryResult.type !== 'found') {
		return {
			errorResponse: lfsErrorResponse(
				`No public GitHub repository found for "${owner}/${repository}". Authenticate to access private repositories.`,
				requestId,
				401,
				unauthorizedHeaders,
			),
		}
	}

	const ownerResponse = resolvedOwnerForbiddenResponse(repositoryResult.repoInfo, env, requestId)
	if (ownerResponse !== undefined) {
		return { errorResponse: ownerResponse }
	}

	const storagePrefix = `${githubStoragePrefix}/${repositoryResult.repoInfo.id}`
	setCachedAuthorization(cacheKey, { permissions: { pull: true, push: false }, storagePrefix })
	return { storagePrefix }
}

function operationForbiddenResponse(
	operation: 'download' | 'upload',
	owner: string,
	repository: string,
	requestId: string,
): Response {
	return lfsErrorResponse(
		`Not authorized to ${operation} in repository "${owner}/${repository}". Check permissions on your GitHub personal access token.`,
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
	repository: string,
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
	const claimedRepository = payload.repository
	if (
		typeof claimedRepository !== 'string' ||
		claimedRepository.toLowerCase() !== `${owner}/${repository}`.toLowerCase()
	) {
		return {
			errorResponse: lfsErrorResponse(
				`OIDC token was not issued for repository "${owner}/${repository}".`,
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
	const repositoryId = Number(payload.repository_id)
	if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
		return {
			errorResponse: lfsErrorResponse(
				'OIDC token is missing a valid repository_id claim.',
				requestId,
				403,
			),
		}
	}

	return { storagePrefix: `${githubStoragePrefix}/${repositoryId}` }
}

async function authorizeSelfIssuedToken(
	token: string,
	audience: string,
	env: Env,
	address: RepositoryAddress,
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
					`This self-issued token does not grant access to GitHub repository "${address.owner}/${address.repo}". Mint one with \`pnpm run token mint --repo ${address.owner}/${address.repo}\`.`,
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

function isOwnerAllowed(owner: string, allowedOwners: string[]): boolean {
	// GitHub owner names are case-insensitive; an empty allowlist rejects
	// everyone (fail closed)
	return allowedOwners.some((entry) => entry.toLowerCase() === owner.toLowerCase())
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

async function getGitHubRepositoryInfo(
	owner: string,
	repository: string,
	personalAccessToken: string | undefined,
): Promise<GitHubRepositoryResult> {
	try {
		const octokit = new Octokit({
			auth: personalAccessToken,
		})
		const { data } = await octokit.repos.get({ owner, repo: repository })
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
	// The aws4fetch default of 10 retries with backoff would turn a 100-object
	// batch into over a thousand subrequests during a storage outage, blowing
	// the Workers subrequest limit. Fail fast instead; the git-lfs client has
	// its own retry logic.
	return {
		readOnlyClient: new AwsClient({
			accessKeyId: env.S3_READ_KEY_ID,
			retries: 0,
			secretAccessKey: env.S3_READ_SECRET_KEY,
		}),
		readWriteClient: new AwsClient({
			accessKeyId: env.S3_READ_WRITE_KEY_ID,
			retries: 0,
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

	// Uploads only: objects already in storage must stay downloadable even if
	// MAX_UPLOAD_FILE_SIZE is later lowered beneath their size
	if (operation === 'upload' && size > env.MAX_UPLOAD_FILE_SIZE) {
		return {
			error: {
				code: 413,
				message: `File size exceeds the maximum allowed upload size of ${env.MAX_UPLOAD_FILE_SIZE} bytes.`,
			},
			oid,
			size,
		} satisfies GitLfsBatchResponseErrorObject
	}

	// One subrequest per object: existence check for downloads, dedup check for uploads
	const headResponse = await readOnlyClient.fetch(getObjectUrl(env, storagePrefix, oid), {
		method: 'HEAD',
	})

	// Anything other than "exists" or "missing" is a storage-side failure —
	// don't sign URLs against an unknown state
	if (headResponse.status !== 200 && headResponse.status !== 404) {
		return {
			error: {
				code: 502,
				message: `Storage returned HTTP ${headResponse.status} while checking the object. Try again later.`,
			},
			oid,
			size,
		} satisfies GitLfsBatchResponseErrorObject
	}

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
