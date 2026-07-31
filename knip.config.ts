import { knipConfig } from '@kitschpatrol/knip-config'

export default knipConfig({
	ignore: [
		// Ignore unlisted dependency in test files
		'test/index.spec.ts',
		'test/lfs.spec.ts',
		'src/schemas.ts',
	],
	ignoreDependencies: [
		// Ignore cloudflare as unlisted dependency
		'cloudflare',
	],
})
