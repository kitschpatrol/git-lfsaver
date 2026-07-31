/* eslint-disable ts/naming-convention -- Worker binding names are UPPER_CASE by convention */

import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			// Deterministic fake credentials so signing assertions run offline,
			// without .env, and never touch real infrastructure
			miniflare: {
				bindings: {
					R2_S3_BUCKET: 'test-bucket',
					R2_S3_ENDPOINT: 'example.r2.cloudflarestorage.com',
					R2_S3_READ_KEY_ID: 'test-read-key',
					R2_S3_READ_SECRET_KEY: 'test-read-secret',
					R2_S3_READ_WRITE_KEY_ID: 'test-write-key',
					R2_S3_READ_WRITE_SECRET_KEY: 'test-write-secret',
				},
			},
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
})
