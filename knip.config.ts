import { knipConfig } from '@kitschpatrol/knip-config'

export default knipConfig({
	ignore: [
		// Ignore unlisted dependency in test files
		'test/*.spec.ts',
		'src/schemas.ts',
	],
	ignoreDependencies: [
		// Ignore cloudflare as unlisted dependency
		'cloudflare',
	],
})
