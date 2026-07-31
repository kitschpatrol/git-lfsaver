/* eslint-disable ts/naming-convention -- HTTP header and LFS wire format names are not camelCase */

// eslint-disable-next-line import/no-unresolved
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
// eslint-disable-next-line import/no-unresolved
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'

const mime = 'application/vnd.git-lfs+json'
const validOid = 'a'.repeat(64)

async function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
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

function batchBody(objects: Array<{ oid: string; size: number }>): Record<string, unknown> {
	return { objects, operation: 'upload' }
}

describe('routing', () => {
	it('returns 404 for lock endpoints so clients disable locking', async () => {
		const response = await post('/kitschpatrol/repo/locks/verify', {})
		expect(response.status).toBe(404)
		expect(response.headers.get('Content-Type')).toContain(mime)
	})

	it('returns 405 for non-POST requests to LFS endpoints', async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>(
			'https://example.com/kitschpatrol/repo/objects/batch',
		)
		const context = createExecutionContext()
		const response = await worker.fetch(request, env, context)
		await waitOnExecutionContext(context)
		expect(response.status).toBe(405)
	})

	it('returns 406 when LFS media type headers are missing', async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>(
			'https://example.com/kitschpatrol/repo/objects/batch',
			{
				body: JSON.stringify(batchBody([{ oid: validOid, size: 1 }])),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
			},
		)
		const context = createExecutionContext()
		const response = await worker.fetch(request, env, context)
		await waitOnExecutionContext(context)
		expect(response.status).toBe(406)
	})

	it('returns 404 for unknown paths', async () => {
		const response = await post('/kitschpatrol/repo/objects/unknown', {})
		expect(response.status).toBe(404)
	})
})

describe('owner allowlist', () => {
	it('rejects owners outside the allowlist with 403', async () => {
		const response = await post(
			'/attacker/repo/objects/batch',
			batchBody([{ oid: validOid, size: 1 }]),
		)
		expect(response.status).toBe(403)
	})

	it('allows allowlisted owners regardless of case', async () => {
		// Passes the allowlist and fails later at authentication instead
		const response = await post(
			'/KitschPatrol/repo/objects/batch',
			batchBody([{ oid: validOid, size: 1 }]),
		)
		expect(response.status).toBe(401)
	})
})

describe('batch request validation', () => {
	it('rejects path traversal OIDs', async () => {
		const response = await post(
			'/kitschpatrol/repo/objects/batch',
			batchBody([{ oid: `../12345/${validOid}`, size: 1 }]),
		)
		expect(response.status).toBe(422)
	})

	it('rejects uppercase hex OIDs', async () => {
		const response = await post(
			'/kitschpatrol/repo/objects/batch',
			batchBody([{ oid: 'A'.repeat(64), size: 1 }]),
		)
		expect(response.status).toBe(422)
	})

	it('rejects unsupported hash algorithms', async () => {
		const response = await post('/kitschpatrol/repo/objects/batch', {
			...batchBody([{ oid: validOid, size: 1 }]),
			hash_algo: 'sha1',
		})
		expect(response.status).toBe(422)
	})

	it('rejects empty batches', async () => {
		const response = await post('/kitschpatrol/repo/objects/batch', batchBody([]))
		expect(response.status).toBe(422)
	})

	it('rejects batches over 100 objects', async () => {
		const objects = Array.from({ length: 101 }, (_, index) => ({
			oid: index.toString(16).padStart(64, '0'),
			size: 1,
		}))
		const response = await post('/kitschpatrol/repo/objects/batch', batchBody(objects))
		expect(response.status).toBe(422)
	})

	it('tolerates unknown request fields', async () => {
		// Non-strict request schemas: unknown fields are stripped, and the
		// request proceeds to authentication instead of failing validation
		const response = await post('/kitschpatrol/repo/objects/batch', {
			...batchBody([{ oid: validOid, size: 1 }]),
			future_field: true,
		})
		expect(response.status).toBe(401)
	})

	it('rejects invalid JSON bodies', async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>(
			'https://example.com/kitschpatrol/repo/objects/batch',
			{
				body: 'not json',
				headers: { Accept: mime, 'Content-Type': mime },
				method: 'POST',
			},
		)
		const context = createExecutionContext()
		const response = await worker.fetch(request, env, context)
		await waitOnExecutionContext(context)
		expect(response.status).toBe(422)
	})
})

describe('authentication', () => {
	it('returns 401 with LFS-Authenticate when no credentials are provided', async () => {
		const response = await post(
			'/kitschpatrol/repo/objects/batch',
			batchBody([{ oid: validOid, size: 1 }]),
		)
		expect(response.status).toBe(401)
		expect(response.headers.get('LFS-Authenticate')).toBe('Basic realm="Git LFS"')
	})

	it('returns 401 for malformed authorization headers', async () => {
		const response = await post(
			'/kitschpatrol/repo/objects/batch',
			batchBody([{ oid: validOid, size: 1 }]),
			{ Authorization: 'Bearer whatever' },
		)
		expect(response.status).toBe(401)
	})

	it('requires authentication on the verify endpoint', async () => {
		const response = await post('/kitschpatrol/repo/objects/verify', {
			oid: validOid,
			size: 1,
		})
		expect(response.status).toBe(401)
	})
})
