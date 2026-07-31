/**
 * Secret bindings uploaded via `wrangler deploy --secrets-file .env` (see
 * .template.env). `wrangler types` only generates types for `vars`, so secrets
 * are declared here and merged into the generated `Env` interface.
 */
/* eslint-disable ts/consistent-type-definitions -- Declaration merging with the generated Env requires an interface */
/* eslint-disable ts/naming-convention -- Binding names are UPPER_CASE by convention */
interface Env {
	R2_S3_BUCKET: string
	R2_S3_ENDPOINT: string
	R2_S3_READ_WRITE_KEY_ID: string
	R2_S3_READ_WRITE_SECRET_KEY: string
}
