import { knipConfig } from '@kitschpatrol/knip-config'

export default knipConfig({
	ignore: [
		// Knip reports the spec files as unused rather than as Vitest entries
		'test/*.spec.ts',
		'src/schemas.ts',
	],
})
