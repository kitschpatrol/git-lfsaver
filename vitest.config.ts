/* eslint-disable ts/naming-convention -- Worker binding names are UPPER_CASE by convention */

import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			// Deterministic fake credentials so signing assertions run offline,
			// without .env, and never touch real infrastructure
			miniflare: {
				bindings: {
					// Pinned here so tests don't depend on the deployment's
					// allowlist in wrangler.jsonc
					GITHUB_ALLOWED_OWNERS: ['kitschpatrol'],
					S3_BUCKET: 'test-bucket',
					S3_ENDPOINT: 'example.r2.cloudflarestorage.com',
					S3_READ_KEY_ID: 'test-read-key',
					S3_READ_SECRET_KEY: 'test-read-secret',
					S3_READ_WRITE_KEY_ID: 'test-write-key',
					S3_READ_WRITE_SECRET_KEY: 'test-write-secret',
					// Public half of the test-only signing key in transfer.spec.ts
					SELF_ISSUED_TOKEN_PUBLIC_KEY: 'md403Y-XQZSe0jQscBC8anBx-IQlxvKmSjvV3LbAad0',
				},
			},
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
})
