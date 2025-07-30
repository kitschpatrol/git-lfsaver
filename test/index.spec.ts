/* eslint-disable ts/naming-convention */
/* eslint-disable node/no-unsupported-features/node-builtins */

// eslint-disable-next-line import/no-unresolved
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>

describe('Hello World worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const request = new IncomingRequest('http://example.com')
		// Create an empty context to pass to `worker.fetch()`.
		const context = createExecutionContext()
		const response = await worker.fetch(request, env, context)
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(context)
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`)
	})

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('https://example.com')
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`)
	})
})
