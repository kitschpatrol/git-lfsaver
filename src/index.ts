import { AwsClient } from 'aws4fetch';
import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';
import {
	gitLfsBatchRequestSchema,
	type GitLfsBatchResponseObject,
	type GitLfsBatchResponseErrorObject,
	GitLfsBatchResponse,
	gitLfsBatchResponseSchema,
} from './schemas';
import { z } from 'zod';

type GitHubRepoInfo = RestEndpointMethodTypes['repos']['get']['response']['data'];

// TODO check for this...
// https://developers.cloudflare.com/r2/platform/limits/
const MAX_FILE_SIZE = 4.995 * 1024 * 1024 * 1024; // 4.995 GiB

const VALIDATE_RESPONSE = true;
const ENFORCE_MIME = true; // Some clients might not set these headers correctly...
const EXPIRY = 3600; // 1 hour
const MIME = 'application/vnd.git-lfs+json';

async function sign(s3: AwsClient, bucket: string, endpoint: string, path: string, method: string, expiry: number = 3600): Promise<string> {
	const url = new URL(`https://${bucket}.${endpoint}`);
	url.pathname = path;
	url.searchParams.set('X-Amz-Expires', String(expiry));

	const signed = await s3.sign(new Request(url, { method: method }), { aws: { signQuery: true } });

	return signed.url;
}

async function getGitHubRepoInfo(owner: string, repo: string, personalAccessToken: string): Promise<GitHubRepoInfo | undefined> {
	try {
		const octokit = new Octokit({
			auth: personalAccessToken,
		});
		const { data } = await octokit.repos.get({ owner, repo });
		return data;
	} catch (error) {
		return undefined;
	}
}

async function processObject(
	oid: string,
	size: number,
	operation: 'upload' | 'download',
	repoId: number,
	s3: AwsClient,
	env: Env
): Promise<GitLfsBatchResponseObject | GitLfsBatchResponseErrorObject> {
	// Check for max size...
	if (size > MAX_FILE_SIZE) {
		return {
			oid: oid,
			size: size,
			error: {
				code: 413,
				message: `File size exceeds the maximum allowed size of ${MAX_FILE_SIZE} bytes.`,
			},
		} satisfies GitLfsBatchResponseErrorObject;
	}

	// Check for missing object...
	if (operation === 'download') {
		const response = await s3.fetch(`https://${env.R2_S3_BUCKET}.${env.R2_S3_ENDPOINT}/${repoId}/${oid}`, {
			method: 'HEAD',
		});
		if (response.status === 404) {
			return {
				oid: oid,
				size: size,
				error: {
					code: 404,
					message: `File not found.`,
				},
			} satisfies GitLfsBatchResponseErrorObject;
		}
	}

	const signedUrl = await sign(
		s3,
		env.R2_S3_BUCKET,
		env.R2_S3_ENDPOINT,
		`${repoId}/${oid}`,
		operation === 'upload' ? 'PUT' : 'GET',
		EXPIRY
	);

	return {
		oid,
		size,
		authenticated: true,
		actions: {
			[operation]: {
				href: signedUrl,
				expires_in: EXPIRY,
			},
		},
	} satisfies GitLfsBatchResponseObject;
}

async function getPersonalAccessToken(request: Request): Promise<string | undefined> {
	const authorizationHeader = request.headers.get('Authorization');

	if (authorizationHeader === null) {
		return undefined;
	}

	const [scheme, encoded] = authorizationHeader.split(' ');
	if (scheme !== 'Basic' || !encoded) {
		return undefined;
	}

	const buffer = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
	const decoded = new TextDecoder().decode(buffer).normalize();
	const index = decoded.indexOf(':');
	if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
		return undefined;
	}
	const user = decoded.slice(0, index);
	const personalAccessToken = decoded.slice(index + 1);

	return personalAccessToken;
}

async function checkAuthorization(repoInfo: GitHubRepoInfo, operation: 'upload' | 'download'): Promise<boolean> {
	if (repoInfo.permissions === undefined) {
		return false;
	}

	if (operation === 'upload' && !repoInfo.permissions.push) {
		return false;
	}

	if (operation === 'download' && !repoInfo.permissions.pull) {
		return false;
	}

	return true;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const requestId = request.headers.get('cf-request-id') ?? 'unknown';
		const url = new URL(request.url);

		if (url.pathname == '/') {
			if (request.method === 'GET') {
				return new Response(
					'<!DOCTYPE html><html style="background-color:gray;"><head><meta charset="utf-8"><title>git-lfs-cf</title></head><body style="margin:0;padding:0;height:100vh;display:flex;align-items:center;justify-content:center"><h1 style="margin:0;font-size:6em">🪨</h1></body></html>',
					{
						headers: {
							'Content-Type': 'text/html; charset=utf-8',
						},
					}
				);
			} else {
				return new Response(JSON.stringify({ message: 'Only GET requests are allowed at the LFS server root.', request_id: requestId }), {
					status: 405,
					headers: { Allow: 'GET' },
				});
			}
		}

		if (url.pathname === '/favicon.ico') {
			const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 16 16'><text x='0' y='14'>🪨</text></svg>`;
			return new Response(svg, {
				status: 200,
				headers: {
					'Content-Type': 'image/svg+xml',
					'Cache-Control': 'public, max-age=86400',
				},
			});
		}

		// All LFS requests are POSTs
		if (request.method !== 'POST') {
			return new Response(JSON.stringify({ message: 'Only POST requests are allowed.', request_id: requestId }), {
				status: 405,
				headers: { Allow: 'POST' },
			});
		}

		if (ENFORCE_MIME) {
			if (!request.headers.get('Accept')?.startsWith(MIME) || !request.headers.get('Content-Type')?.startsWith(MIME)) {
				return new Response(
					JSON.stringify({
						message: `Invalid request headers, expect "Accept: ${MIME}" and "Content-Type: ${MIME}", received "${request.headers.get(
							'Accept'
						)}" and "${request.headers.get('Content-Type')}"`,
						request_id: requestId,
					}),
					{ status: 406 }
				);
			}
		}

		// Locking not yet supported
		if (url.pathname.endsWith('/locks/verify')) {
			return new Response(
				JSON.stringify({
					message: 'This LFS server does not support locking. (Yet...)',
					request_id: requestId,
				}),
				{ status: 405, headers: { Allow: 'POST' } }
			);
		}

		// Expect /<owner>/<repo>/objects/batch
		const pathParts = url.pathname.split('/');
		if (url.pathname.endsWith('/objects/batch') && pathParts.length >= 5) {
			const owner = decodeURIComponent(pathParts[1]);
			const repo = decodeURIComponent(pathParts[2]);
			if (owner.length === 0 || repo.length === 0) {
				return new Response(
					JSON.stringify({
						message: `Invalid request URL pathname, expect "/<owner>/<repo>/objects/batch", received "${url.pathname}" Double check your lfs.url value in your .lfsconfig file.`,
						request_id: requestId,
					}),
					{ status: 422 }
				);
			}

			// Read and validate the request
			const rawClientRequest = await request.json();
			const result = gitLfsBatchRequestSchema.safeParse(rawClientRequest);
			if (!result.success) {
				return new Response(JSON.stringify({ message: z.prettifyError(result.error), request_id: requestId }), { status: 422 });
			}
			const { operation, objects, hash_algo } = result.data;

			const personalAccessToken = await getPersonalAccessToken(request);

			if (personalAccessToken === undefined) {
				return new Response(JSON.stringify({ message: 'No GitHub Personal Access Token provided.', request_id: requestId }), {
					status: 401,
				});
			}

			const repoInfo = await getGitHubRepoInfo(owner, repo, personalAccessToken);
			if (repoInfo === undefined) {
				return new Response(
					JSON.stringify({ message: `No GitHub repository found for owner "${owner}/${repo}".`, request_id: requestId }),
					{ status: 404 }
				);
			}

			const isAuthorized = await checkAuthorization(repoInfo, operation);
			if (!isAuthorized) {
				return new Response(
					JSON.stringify({
						message: `Not authorized to ${operation} ib repository "${owner}/${repo}". Check permissions on your GitHub personal access token.`,
						request_id: requestId,
					}),
					{ status: 401 }
				);
			}

			// Used as directory prefix to prevent side-channel attacks
			// while remaining robust to repo name changes
			const repoId = repoInfo.id;

			const s3 = new AwsClient({
				accessKeyId: env.R2_S3_READ_WRITE_KEY_ID,
				secretAccessKey: env.R2_S3_READ_WRITE_SECRET_KEY,
			});

			const response: GitLfsBatchResponse = {
				transfer: 'basic',
				objects: await Promise.all(objects.map(async ({ oid, size }) => processObject(oid, size, operation, repoId, s3, env))),
				hash_algo: hash_algo,
			};

			if (VALIDATE_RESPONSE) {
				const responseResult = gitLfsBatchResponseSchema.safeParse(response);
				if (!responseResult.success) {
					return new Response(
						JSON.stringify({ message: `Server created bad response:\n${z.prettifyError(responseResult.error)}`, request_id: requestId }),
						{ status: 422 }
					);
				}
			}

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': MIME,
				},
			});
		}

		return new Response(JSON.stringify({ message: 'Not found.', request_id: requestId }), { status: 404 });
	},
} satisfies ExportedHandler<Env>;
