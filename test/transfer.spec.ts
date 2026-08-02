/* eslint-disable ts/naming-convention -- HTTP header and LFS wire format names are not camelCase */

// eslint-disable-next-line import/no-unresolved
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
// eslint-disable-next-line import/no-unresolved
import { env } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type {
	GitLfsBatchResponse,
	GitLfsBatchResponseErrorObject,
	GitLfsBatchResponseObject,
} from '../src/schemas'
import worker from '../src/index'
import { gitLfsBatchResponseSchema } from '../src/schemas'
import { selfIssuedTokenIssuer } from '../src/self-issued'

const mime = 'application/vnd.git-lfs+json'
const oidA = 'a'.repeat(64)
const oidB = 'b'.repeat(64)
const repoId = 12_345_678

// Must match the fake bindings in vitest.config.ts
const bucketOrigin = 'https://test-bucket.example.r2.cloudflarestorage.com'
const readKeyId = 'test-read-key'
const readWriteKeyId = 'test-write-key'

// Unique tokens per request by default so the worker's authorization cache
// doesn't couple tests to each other; pass an explicit token to test caching
let tokenCounter = 0

function patAuthHeader(token?: string): Record<string, string> {
	tokenCounter += 1
	// eslint-disable-next-line no-restricted-globals
	return { Authorization: `Basic ${btoa(`user:${token ?? `test-token-${tokenCounter}`}`)}` }
}

// Key pair for signing test OIDC tokens; the public half is served by the
// mocked GitHub JWKS endpoint
const githubActionsIssuer = 'https://token.actions.githubusercontent.com'
const { privateKey, publicKey } = await generateKeyPair('RS256')
const publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'test-key' }

// Test-only signing key for self-issued tokens; the public half (the "x"
// value) is bound as SELF_ISSUED_TOKEN_PUBLIC_KEY in vitest.config.ts
const selfIssuedPrivateKey = await importJWK(
	{
		crv: 'Ed25519',
		d: 'USbNlboLqsbcJbElbRsgwgYSnXEO8zthY960m02EJ9Q',
		kty: 'OKP',
		x: 'md403Y-XQZSe0jQscBC8anBx-IQlxvKmSjvV3LbAad0',
	},
	'EdDSA',
)
// Self-issued repos are addressed by a bare single-segment name that is
// deliberately absent from GITHUB_ALLOWED_OWNERS — the signed token alone authorizes
const selfIssuedRepoName = 'local-repo'
const selfIssuedStoragePrefix = `self/${selfIssuedRepoName}`

// The worker under test runs in the same isolate as the tests, so stubbing
// global fetch intercepts its outbound GitHub and R2 subrequests. Each mock is
// consumed once (unless persistent), unmatched requests throw, and afterEach
// asserts none are left.
type FetchMock = { isPersistent?: boolean; method: string; response: () => Response; url: string }

const pendingMocks: FetchMock[] = []

beforeAll(() => {
	vi.stubGlobal(
		'fetch',
		// eslint-disable-next-line ts/require-await -- Must match fetch's async signature but has nothing to await
		async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const request = new Request(input, init)
			const index = pendingMocks.findIndex(
				(mock) => mock.method === request.method && mock.url === request.url,
			)
			const mock = index === -1 ? undefined : pendingMocks[index]
			if (mock === undefined) {
				throw new Error(`Unexpected fetch: ${request.method} ${request.url}`)
			}

			if (mock.isPersistent !== true) {
				pendingMocks.splice(index, 1)
			}

			return mock.response()
		},
	)

	// The worker's remote JWK set caches keys after the first fetch, so this
	// mock persists rather than being consumed by whichever test verifies first
	pendingMocks.push({
		isPersistent: true,
		method: 'GET',
		response: () => Response.json({ keys: [publicJwk] }),
		url: `${githubActionsIssuer}/.well-known/jwks`,
	})
})

afterEach(() => {
	// Every single-use mocked route registered by a test must have been hit
	const leftover = pendingMocks.filter((mock) => mock.isPersistent !== true)
	const persistent = pendingMocks.filter((mock) => mock.isPersistent === true)
	pendingMocks.length = 0
	pendingMocks.push(...persistent)
	if (leftover.length > 0) {
		const routes = leftover.map((mock) => `${mock.method} ${mock.url}`).join(', ')
		throw new Error(`Unconsumed fetch mocks: ${routes}`)
	}
})

afterAll(() => {
	vi.unstubAllGlobals()
})

function mockGitHubRepo(
	permissions?: { pull: boolean; push: boolean },
	// The owner GitHub resolves after following redirects, which may differ
	// from the owner in the request path after a rename or transfer
	owner = 'kitschpatrol',
): void {
	pendingMocks.push({
		method: 'GET',
		response: () =>
			Response.json({
				full_name: `${owner}/repo`,
				id: repoId,
				owner: { login: owner },
				permissions,
			}),
		url: 'https://api.github.com/repos/kitschpatrol/repo',
	})
}

function mockGitHubError(status: number): void {
	pendingMocks.push({
		method: 'GET',
		response: () => Response.json({ message: 'GitHub error' }, { status }),
		url: 'https://api.github.com/repos/kitschpatrol/repo',
	})
}

function mockObjectHead(
	oid: string,
	status: number,
	contentLength = 0,
	storagePrefix = `github.com/${repoId}`,
): void {
	pendingMocks.push({
		method: 'HEAD',
		response: () =>
			new Response(undefined, {
				headers: { 'content-length': String(contentLength) },
				status,
			}),
		url: `${bucketOrigin}/${storagePrefix}/${oid}`,
	})
}

async function signOidcToken(
	claims: Record<string, unknown> = {},
	options: { audience?: string; expiresAt?: number | string; issuer?: string } = {},
): Promise<string> {
	return new SignJWT({ repository: 'kitschpatrol/repo', repository_id: String(repoId), ...claims })
		.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
		.setIssuer(options.issuer ?? githubActionsIssuer)
		.setAudience(options.audience ?? 'example.com')
		.setIssuedAt()
		.setExpirationTime(options.expiresAt ?? '5m')
		.sign(privateKey)
}

function oidcAuthHeader(token: string): Record<string, string> {
	// eslint-disable-next-line no-restricted-globals
	return { Authorization: `Basic ${btoa(`oidc:${token}`)}` }
}

async function signSelfIssuedToken(
	claims: Record<string, unknown> = {},
	options: {
		audience?: string
		expiresAt?: number | string
		key?: Awaited<ReturnType<typeof importJWK>>
		omitExpiry?: boolean
	} = {},
): Promise<string> {
	const jwt = new SignJWT({ pull: true, push: true, repo: selfIssuedRepoName, ...claims })
		.setProtectedHeader({ alg: 'EdDSA' })
		.setIssuer(selfIssuedTokenIssuer)
		.setAudience(options.audience ?? 'example.com')
		.setIssuedAt()

	if (options.omitExpiry !== true) {
		jwt.setExpirationTime(options.expiresAt ?? '5m')
	}

	return jwt.sign(options.key ?? selfIssuedPrivateKey)
}

async function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = patAuthHeader(),
): Promise<Response> {
	const request = new Request<unknown, IncomingRequestCfProperties>(`https://example.com${path}`, {
		body: JSON.stringify(body),
		headers: { Accept: mime, 'Content-Type': mime, ...headers },
		method: 'POST',
	})
	const context = createExecutionContext()
	const response = await worker.fetch(request, env, context)
	await waitOnExecutionContext(context)
	return response
}

async function postBatch(
	operation: 'download' | 'upload',
	objects: Array<{ oid: string; size: number }>,
	headers?: Record<string, string>,
): Promise<Response> {
	return post('/kitschpatrol/repo/objects/batch', { objects, operation }, headers)
}

async function postSelfBatch(
	operation: 'download' | 'upload',
	objects: Array<{ oid: string; size: number }>,
	headers?: Record<string, string>,
): Promise<Response> {
	return post(`/${selfIssuedRepoName}/objects/batch`, { objects, operation }, headers)
}

async function parseBatchResponse(response: Response): Promise<GitLfsBatchResponse> {
	return gitLfsBatchResponseSchema.parse(await response.json())
}

function getSuccessObject(response: GitLfsBatchResponse, oid: string): GitLfsBatchResponseObject {
	const object = response.objects.find((entry) => entry.oid === oid)
	if (object === undefined || 'error' in object) {
		throw new Error(`Expected success object for oid ${oid}`)
	}

	return object
}

function getErrorObject(
	response: GitLfsBatchResponse,
	oid: string,
): GitLfsBatchResponseErrorObject {
	const object = response.objects.find((entry) => entry.oid === oid)
	if (object === undefined || !('error' in object)) {
		throw new Error(`Expected error object for oid ${oid}`)
	}

	return object
}

describe('permission matrix', () => {
	it('allows download with pull permission', async () => {
		mockGitHubRepo({ pull: true, push: false })
		mockObjectHead(oidA, 200, 8)
		const response = await postBatch('download', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(200)
	})

	it('denies download without pull permission', async () => {
		mockGitHubRepo({ pull: false, push: false })
		const response = await postBatch('download', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(403)
	})

	it('allows upload with push permission', async () => {
		mockGitHubRepo({ pull: true, push: true })
		mockObjectHead(oidA, 404)
		const response = await postBatch('upload', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(200)
	})

	it('denies upload without push permission', async () => {
		mockGitHubRepo({ pull: true, push: false })
		const response = await postBatch('upload', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(403)
	})

	it('denies access when GitHub omits permissions', async () => {
		mockGitHubRepo()
		const response = await postBatch('download', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(403)
	})

	it('returns 401 with LFS-Authenticate when GitHub rejects the token', async () => {
		mockGitHubError(401)
		const response = await postBatch('download', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(401)
		expect(response.headers.get('LFS-Authenticate')).toBe('Basic realm="Git LFS"')
	})

	it('returns 404 when the repository is not found', async () => {
		mockGitHubError(404)
		const response = await postBatch('download', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(404)
	})
})

describe('resolved owner allowlist', () => {
	it('rejects a repo transferred out of the allowlist despite the redirect', async () => {
		// The path's owner passes the allowlist, but GitHub's redirect resolves
		// to an owner that doesn't — the transferred repo must not retain access
		mockGitHubRepo({ pull: true, push: true }, 'new-owner')
		const response = await postBatch('download', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(403)
	})
})

describe('download batch', () => {
	it('signs a download URL for a stored object', async () => {
		mockGitHubRepo({ pull: true, push: false })
		mockObjectHead(oidA, 200, 8)
		const response = await postBatch('download', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toContain(mime)

		const body = await parseBatchResponse(response)
		expect(body.transfer).toBe('basic')
		expect(body.hash_algo).toBe('sha256')

		const object = getSuccessObject(body, oidA)
		expect(object.authenticated).toBe(true)
		const download = object.actions?.download
		if (download === undefined) {
			throw new Error('Expected download action')
		}

		expect(download.expires_in).toBe(env.EXPIRY)
		const url = new URL(download.href)
		expect(url.origin).toBe(bucketOrigin)
		expect(url.pathname).toBe(`/github.com/${repoId}/${oidA}`)
		expect(url.searchParams.get('X-Amz-Expires')).toBe(String(env.EXPIRY))
		expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
		expect(url.searchParams.get('X-Amz-Credential')?.startsWith(`${readKeyId}/`)).toBe(true)
		expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
	})

	it('returns a per-object 404 for missing objects', async () => {
		mockGitHubRepo({ pull: true, push: false })
		mockObjectHead(oidA, 404)
		const response = await postBatch('download', [{ oid: oidA, size: 8 }])
		expect(response.status).toBe(200)
		const body = await parseBatchResponse(response)
		expect(getErrorObject(body, oidA).error.code).toBe(404)
	})

	it('handles mixed batches of stored and missing objects', async () => {
		mockGitHubRepo({ pull: true, push: false })
		mockObjectHead(oidA, 200, 8)
		mockObjectHead(oidB, 404)
		const response = await postBatch('download', [
			{ oid: oidA, size: 8 },
			{ oid: oidB, size: 16 },
		])
		const body = await parseBatchResponse(response)
		expect(getSuccessObject(body, oidA).actions?.download).toBeDefined()
		expect(getErrorObject(body, oidB).error.code).toBe(404)
	})
})

describe('upload batch', () => {
	it('signs an upload URL with the size constrained and a verify action', async () => {
		mockGitHubRepo({ pull: true, push: true })
		mockObjectHead(oidA, 404)
		const response = await postBatch('upload', [{ oid: oidA, size: 8 }])
		const body = await parseBatchResponse(response)

		const object = getSuccessObject(body, oidA)
		const upload = object.actions?.upload
		if (upload === undefined) {
			throw new Error('Expected upload action')
		}

		const url = new URL(upload.href)
		expect(url.origin).toBe(bucketOrigin)
		expect(url.pathname).toBe(`/github.com/${repoId}/${oidA}`)
		// Content-length caps the PUT's size and the signed content hash pins
		// its bytes to the OID
		expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
			'content-length;host;x-amz-content-sha256',
		)
		expect(url.searchParams.get('X-Amz-Credential')?.startsWith(`${readWriteKeyId}/`)).toBe(true)
		// The client must send the signed hash header verbatim
		expect(upload.header?.['x-amz-content-sha256']).toBe(oidA)
		expect(object.actions?.verify?.href).toBe(
			'https://example.com/kitschpatrol/repo/objects/verify',
		)
	})

	it('omits actions for objects already stored with a matching size', async () => {
		mockGitHubRepo({ pull: true, push: true })
		mockObjectHead(oidA, 200, 8)
		const response = await postBatch('upload', [{ oid: oidA, size: 8 }])
		const body = await parseBatchResponse(response)
		expect(getSuccessObject(body, oidA).actions).toBeUndefined()
	})

	it('re-signs an upload when the stored size differs', async () => {
		mockGitHubRepo({ pull: true, push: true })
		mockObjectHead(oidA, 200, 4)
		const response = await postBatch('upload', [{ oid: oidA, size: 8 }])
		const body = await parseBatchResponse(response)
		expect(getSuccessObject(body, oidA).actions?.upload).toBeDefined()
	})

	it('returns a per-object 413 for oversize objects', async () => {
		mockGitHubRepo({ pull: true, push: true })
		const response = await postBatch('upload', [{ oid: oidA, size: env.MAX_FILE_SIZE + 1 }])
		const body = await parseBatchResponse(response)
		expect(getErrorObject(body, oidA).error.code).toBe(413)
	})
})

describe('verify endpoint', () => {
	it('confirms objects stored with the expected size', async () => {
		mockGitHubRepo({ pull: true, push: true })
		mockObjectHead(oidA, 200, 8)
		const response = await post('/kitschpatrol/repo/objects/verify', { oid: oidA, size: 8 })
		expect(response.status).toBe(200)
	})

	it('returns 404 when the uploaded object is missing', async () => {
		mockGitHubRepo({ pull: true, push: true })
		mockObjectHead(oidA, 404)
		const response = await post('/kitschpatrol/repo/objects/verify', { oid: oidA, size: 8 })
		expect(response.status).toBe(404)
	})

	it('returns 422 when the stored size differs', async () => {
		mockGitHubRepo({ pull: true, push: true })
		mockObjectHead(oidA, 200, 4)
		const response = await post('/kitschpatrol/repo/objects/verify', { oid: oidA, size: 8 })
		expect(response.status).toBe(422)
		const body = z.object({ message: z.string() }).parse(await response.json())
		expect(body.message).toContain('stored size 4')
	})

	it('requires push permission to verify', async () => {
		mockGitHubRepo({ pull: true, push: false })
		const response = await post('/kitschpatrol/repo/objects/verify', { oid: oidA, size: 8 })
		expect(response.status).toBe(403)
	})
})

describe('authorization cache', () => {
	it('reuses a cached authorization instead of calling GitHub again', async () => {
		const headers = patAuthHeader('reused-token')
		// A single GitHub response is mocked for two batches: a second API
		// call would throw on the unmatched fetch
		mockGitHubRepo({ pull: true, push: false })
		mockObjectHead(oidA, 200, 8)
		mockObjectHead(oidA, 200, 8)

		const first = await postBatch('download', [{ oid: oidA, size: 8 }], headers)
		expect(first.status).toBe(200)

		const second = await postBatch('download', [{ oid: oidA, size: 8 }], headers)
		expect(second.status).toBe(200)
	})

	it('applies cached permissions to later operations', async () => {
		const headers = patAuthHeader('pull-only-token')
		mockGitHubRepo({ pull: true, push: false })
		mockObjectHead(oidA, 200, 8)

		const download = await postBatch('download', [{ oid: oidA, size: 8 }], headers)
		expect(download.status).toBe(200)

		// The upload denial comes from the cached permissions, not GitHub
		const upload = await postBatch('upload', [{ oid: oidA, size: 8 }], headers)
		expect(upload.status).toBe(403)
	})
})

describe('github actions oidc authentication', () => {
	it('allows downloads with a valid token and no GitHub API call', async () => {
		// No GitHub API mock is registered: an unexpected call would throw
		mockObjectHead(oidA, 200, 8)
		const token = await signOidcToken()
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(200)
		const body = await parseBatchResponse(response)
		expect(getSuccessObject(body, oidA).actions?.download).toBeDefined()
	})

	it('rejects uploads', async () => {
		const token = await signOidcToken()
		const response = await postBatch('upload', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(403)
	})

	it('rejects tokens issued for a different repository', async () => {
		const token = await signOidcToken({ repository: 'kitschpatrol/other' })
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(403)
	})

	it('rejects tokens with the wrong audience', async () => {
		const token = await signOidcToken({}, { audience: 'https://github.com/kitschpatrol' })
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(401)
	})

	it('rejects expired tokens', async () => {
		const token = await signOidcToken({}, { expiresAt: Math.floor(Date.now() / 1000) - 3600 })
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(401)
	})

	it('rejects tokens from an unexpected issuer', async () => {
		const token = await signOidcToken({}, { issuer: 'https://evil.example.com' })
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(401)
	})

	it('rejects tokens missing a repository_id claim', async () => {
		const token = await signOidcToken({ repository_id: undefined })
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(403)
	})

	it('rejects malformed tokens that only look like JWTs', async () => {
		const response = await postBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader('eyJhbGciOiJSUzI1NiJ9.e30.bm90LWEtcmVhbC1zaWduYXR1cmU'),
		)
		expect(response.status).toBe(401)
		expect(response.headers.get('LFS-Authenticate')).toBe('Basic realm="Git LFS"')
	})
})

describe('self-issued token authentication', () => {
	it('allows downloads with a pull token and no external auth call', async () => {
		// No GitHub API or JWKS mock is registered: an unexpected call would throw
		mockObjectHead(oidA, 200, 8, selfIssuedStoragePrefix)
		const token = await signSelfIssuedToken({ push: false })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(200)

		const body = await parseBatchResponse(response)
		const download = getSuccessObject(body, oidA).actions?.download
		if (download === undefined) {
			throw new Error('Expected download action')
		}

		// Objects live under a "self/" prefix that can never collide with the
		// numeric GitHub repo IDs
		expect(new URL(download.href).pathname).toBe(`/${selfIssuedStoragePrefix}/${oidA}`)
	})

	it('allows uploads with a push token', async () => {
		mockObjectHead(oidA, 404, 0, selfIssuedStoragePrefix)
		const token = await signSelfIssuedToken({ pull: false })
		const response = await postSelfBatch('upload', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(200)

		const body = await parseBatchResponse(response)
		const object = getSuccessObject(body, oidA)
		const upload = object.actions?.upload
		if (upload === undefined) {
			throw new Error('Expected upload action')
		}

		expect(new URL(upload.href).pathname).toBe(`/${selfIssuedStoragePrefix}/${oidA}`)
		// The verify action must use the single-segment URL shape too
		expect(object.actions?.verify?.href).toBe(
			`https://example.com/${selfIssuedRepoName}/objects/verify`,
		)
	})

	it('verifies uploads with a push token', async () => {
		mockObjectHead(oidA, 200, 8, selfIssuedStoragePrefix)
		const token = await signSelfIssuedToken()
		const response = await post(
			`/${selfIssuedRepoName}/objects/verify`,
			{ oid: oidA, size: 8 },
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(200)
	})

	it('denies uploads with a pull-only token', async () => {
		const token = await signSelfIssuedToken({ push: false })
		const response = await postSelfBatch('upload', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(403)
	})

	it('denies downloads with a push-only token', async () => {
		const token = await signSelfIssuedToken({ pull: false })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(403)
	})

	it('rejects tokens issued for a different repository', async () => {
		const token = await signSelfIssuedToken({ repo: 'other-repo' })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(403)
	})

	it('matches the repo claim case-insensitively and lowercases the storage prefix', async () => {
		mockObjectHead(oidA, 200, 8, selfIssuedStoragePrefix)
		const token = await signSelfIssuedToken({ repo: 'Local-Repo' })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(200)
	})

	it('rejects tokens missing permission claims', async () => {
		const token = await signSelfIssuedToken({ pull: undefined, push: undefined })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(403)
	})

	it('rejects repo claims that are not safe storage paths', async () => {
		const token = await signSelfIssuedToken({ repo: '../12345' })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(403)
	})

	it('rejects expired tokens', async () => {
		const token = await signSelfIssuedToken({}, { expiresAt: Math.floor(Date.now() / 1000) - 3600 })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(401)
	})

	it('rejects tokens without an expiry', async () => {
		const token = await signSelfIssuedToken({}, { omitExpiry: true })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(401)
	})

	it('rejects tokens with the wrong audience', async () => {
		const token = await signSelfIssuedToken({}, { audience: 'lfs.elsewhere.com' })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(401)
	})

	it('rejects tokens signed with a different key', async () => {
		const { privateKey: otherKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
		const token = await signSelfIssuedToken({}, { key: otherKey })
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(401)
	})

	it('rejects GitHub credentials on single-segment paths', async () => {
		// A PAT can never reach the GitHub API through a self-issued path
		const response = await postSelfBatch('download', [{ oid: oidA, size: 8 }], patAuthHeader())
		expect(response.status).toBe(401)
		expect(response.headers.get('LFS-Authenticate')).toBe('Basic realm="Git LFS"')
	})

	it('rejects tokens without a GitHub grant on owner-qualified GitHub paths', async () => {
		const token = await signSelfIssuedToken()
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(403)
	})

	it('rejects tokens when no public key is configured', async () => {
		const token = await signSelfIssuedToken()
		const request = new Request<unknown, IncomingRequestCfProperties>(
			`https://example.com/${selfIssuedRepoName}/objects/batch`,
			{
				body: JSON.stringify({ objects: [{ oid: oidA, size: 8 }], operation: 'download' }),
				headers: { Accept: mime, 'Content-Type': mime, ...oidcAuthHeader(token) },
				method: 'POST',
			},
		)
		const context = createExecutionContext()
		const response = await worker.fetch(
			request,
			{ ...env, SELF_ISSUED_TOKEN_PUBLIC_KEY: '' },
			context,
		)
		await waitOnExecutionContext(context)
		expect(response.status).toBe(401)
	})
})

describe('self-issued github grant authentication', () => {
	// An explicit grant carries the GitHub repo's numeric ID and is presented
	// on the same owner-qualified URL every other collaborator uses
	const grantClaims = { github_repo_id: repoId, repo: 'kitschpatrol/repo' }

	it('allows downloads from the GitHub storage prefix with no GitHub API call', async () => {
		// No GitHub API mock is registered: an unexpected call would throw
		mockObjectHead(oidA, 200, 8)
		const token = await signSelfIssuedToken(grantClaims)
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(200)

		const body = await parseBatchResponse(response)
		const download = getSuccessObject(body, oidA).actions?.download
		if (download === undefined) {
			throw new Error('Expected download action')
		}

		// Same numeric prefix the PAT and OIDC paths resolve — shared storage
		expect(new URL(download.href).pathname).toBe(`/github.com/${repoId}/${oidA}`)
	})

	it('allows uploads with a push grant', async () => {
		mockObjectHead(oidA, 404)
		const token = await signSelfIssuedToken({ ...grantClaims, pull: false })
		const response = await postBatch('upload', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(200)

		const body = await parseBatchResponse(response)
		expect(getSuccessObject(body, oidA).actions?.upload).toBeDefined()
	})

	it('denies operations the grant does not include', async () => {
		const token = await signSelfIssuedToken({ ...grantClaims, push: false })
		const response = await postBatch('upload', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(403)
	})

	it('rejects grants presented for a different repository path', async () => {
		const token = await signSelfIssuedToken({ ...grantClaims, repo: 'kitschpatrol/other' })
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(403)
	})

	it('rejects grants with a malformed repo ID', async () => {
		const token = await signSelfIssuedToken({ ...grantClaims, github_repo_id: 'not-a-number' })
		const response = await postBatch('download', [{ oid: oidA, size: 8 }], oidcAuthHeader(token))
		expect(response.status).toBe(403)
	})

	it('rejects grants on single-segment paths', async () => {
		// A grant's owner-qualified repo claim can never match a bare name
		const token = await signSelfIssuedToken(grantClaims)
		const response = await postSelfBatch(
			'download',
			[{ oid: oidA, size: 8 }],
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(403)
	})

	it('still enforces the owner allowlist before token verification', async () => {
		const token = await signSelfIssuedToken({ ...grantClaims, repo: 'attacker/repo' })
		const response = await post(
			'/attacker/repo/objects/batch',
			{ objects: [{ oid: oidA, size: 8 }], operation: 'download' },
			oidcAuthHeader(token),
		)
		expect(response.status).toBe(403)
	})
})

describe('anonymous public repo downloads', () => {
	// Each test uses a distinct repo name: the anonymous authorization cache is
	// keyed by repo (not credential), so reuse would couple tests

	function mockPublicRepo(repoName: string, id: number, owner = 'kitschpatrol'): void {
		pendingMocks.push({
			method: 'GET',
			response: () =>
				Response.json({ full_name: `${owner}/${repoName}`, id, owner: { login: owner } }),
			url: `https://api.github.com/repos/kitschpatrol/${repoName}`,
		})
	}

	function mockPublicRepoError(repoName: string, status: number): void {
		pendingMocks.push({
			method: 'GET',
			response: () => Response.json({ message: 'GitHub error' }, { status }),
			url: `https://api.github.com/repos/kitschpatrol/${repoName}`,
		})
	}

	async function postAnonymous(
		repoName: string,
		operation: 'download' | 'upload',
	): Promise<Response> {
		// Empty headers omit the default PAT Authorization header
		return post(
			`/kitschpatrol/${repoName}/objects/batch`,
			{ objects: [{ oid: oidA, size: 8 }], operation },
			{},
		)
	}

	it('allows downloads from public repos with no credential', async () => {
		mockPublicRepo('anon-public', 111)
		mockObjectHead(oidA, 200, 8, 'github.com/111')
		const response = await postAnonymous('anon-public', 'download')
		expect(response.status).toBe(200)

		const body = await parseBatchResponse(response)
		const download = getSuccessObject(body, oidA).actions?.download
		if (download === undefined) {
			throw new Error('Expected download action')
		}

		// Anonymous downloads resolve the same numeric storage prefix as
		// credentialed GitHub access
		expect(new URL(download.href).pathname).toBe(`/github.com/111/${oidA}`)
	})

	it('caches the public visibility lookup', async () => {
		// A single GitHub response is mocked for two batches: a second API call
		// would throw on the unmatched fetch
		mockPublicRepo('anon-cached', 222)
		mockObjectHead(oidA, 200, 8, 'github.com/222')
		mockObjectHead(oidA, 200, 8, 'github.com/222')

		const first = await postAnonymous('anon-cached', 'download')
		expect(first.status).toBe(200)

		const second = await postAnonymous('anon-cached', 'download')
		expect(second.status).toBe(200)
	})

	it('prompts for credentials when the repo is private or missing', async () => {
		mockPublicRepoError('anon-private', 404)
		const response = await postAnonymous('anon-private', 'download')
		expect(response.status).toBe(401)
		expect(response.headers.get('LFS-Authenticate')).toBe('Basic realm="Git LFS"')
	})

	it('prompts for credentials when the GitHub API rate limit is hit', async () => {
		mockPublicRepoError('anon-limited', 403)
		const response = await postAnonymous('anon-limited', 'download')
		expect(response.status).toBe(401)
		expect(response.headers.get('LFS-Authenticate')).toBe('Basic realm="Git LFS"')
	})

	it('rejects anonymous downloads from a repo transferred out of the allowlist', async () => {
		mockPublicRepo('anon-transferred', 333, 'new-owner')
		const response = await postAnonymous('anon-transferred', 'download')
		expect(response.status).toBe(403)
	})

	it('rejects anonymous uploads', async () => {
		// No GitHub mock: anonymous authorization never runs for uploads
		const response = await postAnonymous('anon-upload', 'upload')
		expect(response.status).toBe(401)
	})

	it('rejects anonymous requests on single-segment paths', async () => {
		const response = await post(
			`/${selfIssuedRepoName}/objects/batch`,
			{ objects: [{ oid: oidA, size: 8 }], operation: 'download' },
			{},
		)
		expect(response.status).toBe(401)
	})
})

describe('request body limit', () => {
	it('rejects oversized request bodies with 413 before parsing or auth', async () => {
		// No GitHub or R2 mocks: the body is refused before any outbound call
		const response = await post('/kitschpatrol/repo/objects/batch', {
			objects: [{ oid: oidA, size: 8 }],
			operation: 'download',
			padding: 'x'.repeat(300_000),
		})
		expect(response.status).toBe(413)
	})
})

describe('path parsing', () => {
	it('rejects malformed percent-encoding with 422 instead of crashing', async () => {
		const response = await post('/kitschpatrol/repo%zz/objects/batch', {
			objects: [{ oid: oidA, size: 8 }],
			operation: 'download',
		})
		expect(response.status).toBe(422)
	})
})

describe('explicit provider host paths', () => {
	it('treats /github.com/<owner>/<repo> the same as the two-segment default', async () => {
		mockGitHubRepo({ pull: true, push: true })
		mockObjectHead(oidA, 404)
		const response = await post('/github.com/kitschpatrol/repo/objects/batch', {
			objects: [{ oid: oidA, size: 8 }],
			operation: 'upload',
		})
		expect(response.status).toBe(200)

		const body = await parseBatchResponse(response)
		const object = getSuccessObject(body, oidA)
		const upload = object.actions?.upload
		if (upload === undefined) {
			throw new Error('Expected upload action')
		}

		// Storage resolves to the same provider-namespaced prefix as the
		// two-segment form, and the verify URL echoes the explicit host shape
		expect(new URL(upload.href).pathname).toBe(`/github.com/${repoId}/${oidA}`)
		expect(object.actions?.verify?.href).toBe(
			'https://example.com/github.com/kitschpatrol/repo/objects/verify',
		)
	})

	it('matches the host case-insensitively', async () => {
		mockGitHubRepo({ pull: true, push: false })
		mockObjectHead(oidA, 200, 8)
		const response = await post('/GitHub.com/kitschpatrol/repo/objects/batch', {
			objects: [{ oid: oidA, size: 8 }],
			operation: 'download',
		})
		expect(response.status).toBe(200)
	})

	it('rejects unsupported provider hosts', async () => {
		const response = await post('/bitbucket.org/kitschpatrol/repo/objects/batch', {
			objects: [{ oid: oidA, size: 8 }],
			operation: 'download',
		})
		expect(response.status).toBe(404)
	})

	it('still enforces the owner allowlist on explicit host paths', async () => {
		const response = await post('/github.com/attacker/repo/objects/batch', {
			objects: [{ oid: oidA, size: 8 }],
			operation: 'download',
		})
		expect(response.status).toBe(403)
	})
})
