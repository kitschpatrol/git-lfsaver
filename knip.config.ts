import { knipConfig } from '@kitschpatrol/knip-config'

export default knipConfig({
	ignore: ['src/schemas.ts'],
	ignoreDependencies: [
		'@kitschpatrol/chagent', // Typically invoked through bumpp's --execute argument, which Knip doesn't parse
	],
})
