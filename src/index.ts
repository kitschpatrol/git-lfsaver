import { AwsClient } from 'aws4fetch';
import { Octokit, RestEndpointMethodTypes } from '@octokit/rest';

type GitHubRepoInfo = RestEndpointMethodTypes['repos']['get']['response']['data'];

// Some clients might not set these headers correctly...

// TODO check for this...
// https://developers.cloudflare.com/r2/platform/limits/
const MAX_FILE_SIZE = 4.995 * 1024 * 1024 * 1024; // 4.995 GiB

const ENFORCE_MIME = true;
const EXPIRY = 3600; // 1 hour
const MIME = 'application/vnd.git-lfs+json';

const METHOD_FOR = {
	upload: 'PUT',
	download: 'GET',
};

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
		const url = new URL(request.url);

		if (url.pathname == '/') {
			if (request.method === 'GET') {
				return new Response('Hello LFS!');
			} else {
				return new Response(null, { status: 405, headers: { Allow: 'GET' } });
			}
		}

		// All LFS requests are POSTs
		if (request.method !== 'POST') {
			return new Response(null, { status: 405, headers: { Allow: 'POST' } });
		}

		if (ENFORCE_MIME) {
			if (!request.headers.get('Accept')?.startsWith(MIME) || !request.headers.get('Content-Type')?.startsWith(MIME)) {
				return new Response(null, { status: 406 });
			}
		}

		// Locking not yet supported
		if (url.pathname.endsWith('/locks/verify')) {
			return new Response(null, { status: 405, headers: { Allow: 'POST' } });
		}

		// Expect /<owner>/<repo>/objects/batch
		const pathParts = url.pathname.split('/');
		if (url.pathname.endsWith('/objects/batch') && pathParts.length >= 5) {
			const owner = decodeURIComponent(pathParts[1]);
			const repo = decodeURIComponent(pathParts[2]);
			if (owner.length === 0 || repo.length === 0) {
				return new Response(null, { status: 400 });
			}

			const { operation, objects, ref } = (await request.json()) as {
				operation: string;
				transfers: string;
				objects: { oid: string; size: number }[];
				ref: { name: string } | undefined | null;
			};

			if (operation !== 'upload' && operation !== 'download') {
				return new Response(null, { status: 400 });
			}

			const personalAccessToken = await getPersonalAccessToken(request);

			if (personalAccessToken === undefined) {
				console.log('No personal access token provided');
				return new Response(null, { status: 401 });
			}

			const repoInfo = await getGitHubRepoInfo(owner, repo, personalAccessToken);
			if (repoInfo === undefined) {
				console.log('No repo info');
				return new Response(null, { status: 404 });
			}

			const isAuthorized = await checkAuthorization(repoInfo, operation);
			if (!isAuthorized) {
				console.log('Not authorized');
				return new Response(null, { status: 401 });
			}

			// Used as directory prefix to prevent side-channel attacks
			// while remaining robust to repo name changes
			const repoId = repoInfo.id;

			const s3 = new AwsClient({
				accessKeyId: env.R2_S3_READ_WRITE_KEY_ID,
				secretAccessKey: env.R2_S3_READ_WRITE_SECRET_KEY,
			});

			const method = METHOD_FOR[operation];
			const response = JSON.stringify({
				transfer: 'basic',
				objects: await Promise.all(
					objects.map(async ({ oid, size }) => ({
						oid,
						size,
						authenticated: true,
						actions: {
							[operation]: { href: await sign(s3, env.R2_S3_BUCKET, env.R2_S3_ENDPOINT, `${repoId}/${oid}`, method, EXPIRY), EXPIRY },
						},
					}))
				),
			});

			return new Response(response, {
				status: 200,
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': MIME,
				},
			});
		}

		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
