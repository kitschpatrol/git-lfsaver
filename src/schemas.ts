/* eslint-disable ts/naming-convention */

import * as z from 'zod'

// Request schemas are deliberately non-strict: unknown fields from future
// clients are stripped rather than rejected. Response schemas stay strict.
const gitLfsRefSchema = z.object({
	name: z.string(), // Fully-qualified server refspec
})

// Lowercase hex SHA-256 only — anything else (e.g. "../<repoId>/<oid>") could
// escape the repo prefix when the OID is embedded in a signed URL path
const sha256OidPattern = /^[0-9a-f]{64}$/v

const gitLfsObjectSchema = z.object({
	authenticated: z.boolean().optional(),
	oid: z.string().regex(sha256OidPattern, 'Must be a lowercase hex SHA-256 OID'), // String OID of the LFS object
	size: z.number().int().min(0), // Integer byte size, must be at least zero
})

/**
 * HTTP Batch Request
 * https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md#requests
 * https://github.com/git-lfs/git-lfs/blob/main/tq/schemas/http-batch-request-schema.json
 */
const gitLfsBatchRequestSchema = z.object({
	hash_algo: z.literal('sha256').default('sha256'), // Only sha256 is supported — OID validation depends on it
	objects: z
		.array(gitLfsObjectSchema)
		.min(1) // The response schema requires at least one object, so require it here too
		.max(100, 'Batch size exceeds the maximum of 100 objects'), // Matches the git-lfs client default, and each object can cost a subrequest against Workers limits
	operation: z.enum(['download', 'upload']), // Must be 'download' or 'upload'
	ref: gitLfsRefSchema.optional(), // Optional object describing the server ref (added in v2.4)
	transfers: z.array(z.string()).optional(), // Optional array of transfer adapter identifiers (defaults to 'basic' if omitted)
})

/**
 * Verification Request
 * https://github.com/git-lfs/git-lfs/blob/main/docs/api/basic-transfers.md#verification
 */
const gitLfsVerifyRequestSchema = z.object({
	oid: z.string().regex(sha256OidPattern, 'Must be a lowercase hex SHA-256 OID'),
	size: z.number().int().min(0),
})

export type GitLfsRef = z.infer<typeof gitLfsRefSchema>
export type GitLfsObject = z.infer<typeof gitLfsObjectSchema>
export type GitLfsBatchRequest = z.infer<typeof gitLfsBatchRequestSchema>
export type GitLfsVerifyRequest = z.infer<typeof gitLfsVerifyRequestSchema>

export { gitLfsBatchRequestSchema, gitLfsObjectSchema, gitLfsRefSchema, gitLfsVerifyRequestSchema }

/**
 * HTTP Batch Response
 * https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md#successful-responses
 * https://github.com/git-lfs/git-lfs/blob/main/tq/schemas/http-batch-response-schema.json
 */

// RFC 3339 timestamp regex pattern
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/v

// Action definition schema
const actionSchema = z
	.object({
		expires_at: z.string().regex(rfc3339Pattern, 'Must be RFC 3339 formatted timestamp').optional(), // RFC 3339 format
		expires_in: z.number().int().min(-2_147_483_647).max(2_147_483_647).optional(), // Whole number
		header: z.record(z.string(), z.string()).optional(), // Hash of string key/value pairs
		href: z.url(), // URL validation
	})
	.strict()

// Error object schema
const errorSchema = z
	.object({
		code: z.number().int(), // HTTP status code as integer
		message: z.string(),
	})
	.strict()

// Error object schema
const errorObjectSchema = z
	.object({
		error: errorSchema,
		oid: z.string().min(1), // OID must not be empty
		size: z.number().int().min(0), // Integer byte size, at least zero
	})
	.strict()

// Regular object schema
const objectSchema = z
	.object({
		actions: z
			.object({
				download: actionSchema.optional(),
				upload: actionSchema.optional(),
				verify: actionSchema.optional(),
			})
			.strict()
			.optional(),
		authenticated: z.boolean().optional(),
		oid: z.string().min(1), // OID must not be empty
		size: z.number().int().min(0), // Integer byte size, at least zero
	})
	.strict()

// Union of object types
const objectUnionSchema = z.union([objectSchema, errorObjectSchema])

// Main Git LFS HTTPS Batch API Response schema
export const gitLfsBatchResponseSchema = z
	.object({
		documentation_url: z.url().optional(), // URL validation
		hash_algo: z.string().default('sha256').optional(), // Defaults to sha256
		message: z.string().optional(),
		objects: z.array(objectUnionSchema).min(1), // Must have at least one object
		request_id: z.string().optional(),
		transfer: z.string().optional(), // String identifier of transfer adapter
	})
	.strict()

// Type inference
export type GitLfsBatchResponseObject = z.infer<typeof objectSchema>
export type GitLfsBatchResponseErrorObject = z.infer<typeof errorObjectSchema>
export type GitLfsBatchResponse = z.infer<typeof gitLfsBatchResponseSchema>
export type Action = z.infer<typeof actionSchema>
