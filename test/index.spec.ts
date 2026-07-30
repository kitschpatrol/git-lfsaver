// eslint-disable-next-line import/no-unresolved
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'

describe('Hello World worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>('https://example.com')
		// Create an empty context to pass to `worker.fetch()`.
		const context = createExecutionContext()
		const response = await worker.fetch(request, env, context)
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(context)
		expect(await response.text()).toMatchInlineSnapshot(
			`"<!DOCTYPE html><html style="background-color:gray;"><head><meta charset="utf-8"><title>git-lfs-cf</title></head><body style="margin:0;padding:0;height:100vh;display:flex;align-items:center;justify-content:center"><h1 style="margin:0;font-size:6em">🪨</h1></body></html>"`,
		)
	})

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('https://example.com')
		expect(await response.text()).toMatchInlineSnapshot(
			`"<!DOCTYPE html><html style="background-color:gray;"><head><meta charset="utf-8"><title>git-lfs-cf</title></head><body style="margin:0;padding:0;height:100vh;display:flex;align-items:center;justify-content:center"><h1 style="margin:0;font-size:6em">🪨</h1></body></html>"`,
		)
	})
})
