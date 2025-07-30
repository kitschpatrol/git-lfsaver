import * as z from 'zod';

const gitLfsRefSchema = z
	.object({
		name: z.string(), // Fully-qualified server refspec
	})
	.strict();

const gitLfsObjectSchema = z
	.object({
		oid: z.string(), // String OID of the LFS object
		size: z.number().min(0), // Integer byte size, must be at least zero
		authenticated: z.boolean().optional(),
	})
	.strict();

/**
 * HTTP Batch Request
 * https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md#requests
 * https://github.com/git-lfs/git-lfs/blob/main/tq/schemas/http-batch-request-schema.json
 */
const gitLfsBatchRequestSchema = z
	.object({
		operation: z.enum(['download', 'upload']), // Must be 'download' or 'upload'
		transfers: z.array(z.string()).optional(), // Optional array of transfer adapter identifiers (defaults to 'basic' if omitted)
		ref: gitLfsRefSchema.optional(), // Optional object describing the server ref (added in v2.4)
		objects: z.array(gitLfsObjectSchema), // Array of objects to download/upload
		hash_algo: z.string().default('sha256'), // Hash algorithm used to name Git LFS objects (defaults to 'sha256')
	})
	.strict();

export type GitLfsRef = z.infer<typeof gitLfsRefSchema>;
export type GitLfsObject = z.infer<typeof gitLfsObjectSchema>;
export type GitLfsBatchRequest = z.infer<typeof gitLfsBatchRequestSchema>;

export { gitLfsRefSchema, gitLfsObjectSchema, gitLfsBatchRequestSchema };

/**
 * HTTP Batch Response
 * https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md#successful-responses
 * https://github.com/git-lfs/git-lfs/blob/main/tq/schemas/http-batch-response-schema.json
 */

// RFC 3339 timestamp regex pattern
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Action definition schema
const actionSchema = z
	.object({
		href: z.url(), // URL validation
		header: z.record(z.string(), z.string()).optional(), // Hash of string key/value pairs
		expires_in: z.number().int().min(-2147483647).max(2147483647).optional(), // Whole number
		expires_at: z.string().regex(rfc3339Pattern, 'Must be RFC 3339 formatted timestamp').optional(), // RFC 3339 format
	})
	.strict();

// Error object schema
const errorSchema = z
	.object({
		code: z.number().int(), // HTTP status code as integer
		message: z.string(),
	})
	.strict();

// Error object schema
const errorObjectSchema = z
	.object({
		oid: z.string().min(1), // OID must not be empty
		size: z.number().int().min(0), // Integer byte size, at least zero
		error: errorSchema,
	})
	.strict();

// Regular object schema
const objectSchema = z
	.object({
		oid: z.string().min(1), // OID must not be empty
		size: z.number().int().min(0), // Integer byte size, at least zero
		authenticated: z.boolean().optional(),
		actions: z
			.object({
				download: actionSchema.optional(),
				upload: actionSchema.optional(),
				verify: actionSchema.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

// Union of object types
const objectUnionSchema = z.union([objectSchema, errorObjectSchema]);

// Main Git LFS HTTPS Batch API Response schema
export const gitLfsBatchResponseSchema = z
	.object({
		transfer: z.string().optional(), // String identifier of transfer adapter
		objects: z.array(objectUnionSchema).min(1), // Must have at least one object
		message: z.string().optional(),
		request_id: z.string().optional(),
		documentation_url: z.url().optional(), // URL validation
		hash_algo: z.string().default('sha256').optional(), // Defaults to sha256
	})
	.strict();

// Type inference
export type GitLfsBatchResponseObject = z.infer<typeof objectSchema>;
export type GitLfsBatchResponseErrorObject = z.infer<typeof errorObjectSchema>;
export type GitLfsBatchResponse = z.infer<typeof gitLfsBatchResponseSchema>;
export type Action = z.infer<typeof actionSchema>;
