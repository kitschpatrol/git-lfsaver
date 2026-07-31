/* eslint-disable ts/naming-convention -- HTTP header and LFS wire format names are not camelCase */

// eslint-disable-next-line import/no-unresolved
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
// eslint-disable-next-line import/no-unresolved
import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type {
	GitLfsBatchResponse,
	GitLfsBatchResponseErrorObject,
	GitLfsBatchResponseObject,
} from '../src/schemas'
import worker from '../src/index'
import { gitLfsBatchResponseSchema } from '../src/schemas'

const mime = 'application/vnd.git-lfs+json'
const oidA = 'a'.repeat(64)
const oidB = 'b'.repeat(64)
const repoId = 12_345_678

// Must match the fake bindings in vitest.config.ts
const bucketOrigin = 'https://test-bucket.example.r2.cloudflarestorage.com'
const readKeyId = 'test-read-key'
const readWriteKeyId = 'test-write-key'

// eslint-disable-next-line no-restricted-globals
const authHeader = { Authorization: `Basic ${btoa('user:test-token')}` }

// The worker under test runs in the same isolate as the tests, so stubbing
// global fetch intercepts its outbound GitHub and R2 subrequests. Each mock is
// consumed once, unmatched requests throw, and afterEach asserts none are left.
const pendingMocks: Array<{ method: string; response: () => Response; url: string }> = []

beforeAll(() => {
	vi.stubGlobal(
		'fetch',
		// eslint-disable-next-line ts/require-await -- Must match fetch's async signature but has nothing to await
		async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const request = new Request(input, init)
			const index = pendingMocks.findIndex(
				(mock) => mock.method === request.method && mock.url === request.url,
			)
			if (index === -1) {
				throw new Error(`Unexpected fetch: ${request.method} ${request.url}`)
			}

			const [mock] = pendingMocks.splice(index, 1)
			if (mock === undefined) {
				throw new Error('Mock disappeared')
			}

			return mock.response()
		},
	)
})

afterEach(() => {
	// Every mocked route registered by a test must have been hit
	const remaining = [...pendingMocks]
	pendingMocks.length = 0
	if (remaining.length > 0) {
		const routes = remaining.map((mock) => `${mock.method} ${mock.url}`).join(', ')
		throw new Error(`Unconsumed fetch mocks: ${routes}`)
	}
})

afterAll(() => {
	vi.unstubAllGlobals()
})

function mockGitHubRepo(permissions?: { pull: boolean; push: boolean }): void {
	pendingMocks.push({
		method: 'GET',
		response: () => Response.json({ id: repoId, permissions }),
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

function mockObjectHead(oid: string, status: number, contentLength = 0): void {
	pendingMocks.push({
		method: 'HEAD',
		response: () =>
			new Response(undefined, {
				headers: { 'content-length': String(contentLength) },
				status,
			}),
		url: `${bucketOrigin}/${repoId}/${oid}`,
	})
}

async function post(path: string, body: unknown): Promise<Response> {
	const request = new Request<unknown, IncomingRequestCfProperties>(`https://example.com${path}`, {
		body: JSON.stringify(body),
		headers: { Accept: mime, 'Content-Type': mime, ...authHeader },
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
): Promise<Response> {
	return post('/kitschpatrol/repo/objects/batch', { objects, operation })
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
		expect(url.pathname).toBe(`/${repoId}/${oidA}`)
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
		expect(url.pathname).toBe(`/${repoId}/${oidA}`)
		// Content-length is signed so the PUT cannot store more than it claims
		expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host')
		expect(url.searchParams.get('X-Amz-Credential')?.startsWith(`${readWriteKeyId}/`)).toBe(true)
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
