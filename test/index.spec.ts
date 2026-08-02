// eslint-disable-next-line import/no-unresolved
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
// eslint-disable-next-line import/no-unresolved
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import versionInfo from '../src/version.json'

describe('Hello World worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>('https://example.com')
		// Create an empty context to pass to `worker.fetch()`.
		const context = createExecutionContext()
		const response = await worker.fetch(request, env, context)
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(context)
		expect(await response.text()).toMatchInlineSnapshot(
			`"<!DOCTYPE html><html style="background-color:lightseagreen;"><head><meta charset="utf-8"><title>Git LFSaver</title></head><body style="margin:0;padding:0;height:100vh;display:flex;align-items:center;justify-content:center"><h1 style="margin:0;font-size:6em">🛟</h1></body></html>"`,
		)
	})

	it('responds with Hello World! (integration style)', async () => {
		const response = await exports.default.fetch('https://example.com')
		expect(await response.text()).toMatchInlineSnapshot(
			`"<!DOCTYPE html><html style="background-color:lightseagreen;"><head><meta charset="utf-8"><title>Git LFSaver</title></head><body style="margin:0;padding:0;height:100vh;display:flex;align-items:center;justify-content:center"><h1 style="margin:0;font-size:6em">🛟</h1></body></html>"`,
		)
	})
})

describe('Version info', () => {
	it('serves the committed version info at /version.json', async () => {
		const response = await exports.default.fetch('https://example.com/version.json')
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toContain('application/json')
		expect(await response.json()).toEqual(versionInfo)
	})

	it('rejects non-GET requests to /version.json', async () => {
		const response = await exports.default.fetch('https://example.com/version.json', {
			method: 'POST',
		})
		expect(response.status).toBe(405)
		expect(response.headers.get('Allow')).toBe('GET')
	})
})
