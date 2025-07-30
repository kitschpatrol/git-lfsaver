import { knipConfig } from '@kitschpatrol/knip-config'

export default knipConfig({
	ignore: [
		// Ignore unlisted dependency in test file
		'test/index.spec.ts',
		'src/schemas.ts',
	],
	ignoreDependencies: [
		// Ignore cloudflare as unlisted dependency
		'cloudflare',
	],
})
