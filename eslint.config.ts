import { eslintConfig } from '@kitschpatrol/eslint-config'

export default eslintConfig({
	ignores: ['worker-configuration.d.ts'],
	rules: {
		// Workers runtime globals like Request and Response are not Node builtins
		'node/no-unsupported-features/node-builtins': 'off',
	},
})
