<!-- title -->

# git-lfs-cf

<!-- /title -->

<!-- badges -->

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/license/mit)
[![CI](https://github.com/kitschpatrol/git-lfs-cf/actions/workflows/ci.yml/badge.svg)](https://github.com/kitschpatrol/git-lfs-cf/actions/workflows/ci.yml)

<!-- /badges -->

<!-- short-description -->

**A serverless Git LFS server for Cloudflare Workers + R2**

<!-- /short-description -->

## Overview

Currently supports private repositories only.

Designed to share authentication and access control with GitHub via a Personal Access Token.

## Getting started

### Cloudflare setup

1. Create a new R2 bucket to store your LFS data, e.g. `example-lfs`.

   ```sh
   wrangler r2 bucket create example-lfs
   ```

2. Create read / write account API tokens for the bucket:
   1. Token name: e.g. `R2 Example LFS Read Write Token`
   2. Permissions: \
      Object Read & Write
   3. Specify Buckets \
      Apply to specific buckets only: \
      `example-lfs`
   4. TTL: \
      _At your discretion_
   5. Create the token and store the credentials securely

3. Create read-only account API tokens for the bucket:
   1. Token name: e.g. `R2 Example LFS Read Token`
   2. Permissions: \
      Object Read
   3. Specify Buckets \
      Apply to specific buckets only: \
      `example-lfs`
   4. TTL: \
      _At your discretion_
   5. Create the token and store the credentials securely

### Git repo setup

1. Generate a GitHub personal access token for the repository or account you want to use LFS with.

2. Configure Git to use a credential helper, this prevents you from having to enter your credentials every time you pull or push.

   On macOS, you can use the `osxkeychain` credential helper to store your credentials.

   ```sh
   git config --global credential.helper osxkeychain
   ```

3. Configure Git LFS

   If you haven't already, run `git lfs install` to install the Git LFS client.

   Create a `.lfsconfig` file in the root of your repo with the following content:

   ```sh
   [lfs]
   url = https://your-worker-url.com/<repo-owner>/<repo-name>
   locksverify = false
   ```

4. Track some files:

   ```sh
   git lfs track "*.bin"
   ```

5. Push the changes to the repo:

   ```sh
   git add .
   git commit -m "Add Git LFS"
   git push
   ```

   When prompted, enter your GitHub username and the personal access token you created earlier.

6. Verify that the large files are being tracked:

   ```sh
   git lfs ls-files
   ```

## Maintainers

[kitschpatrol](https://github.com/kitschpatrol)

## Acknowledgments

Cloudflare workers approach inspired by [Milkey Mouse's](https://meme.institute/) [git-fs-s3-proxy](https://github.com/milkey-mouse/git-lfs-s3-proxy).

GitHub authentication strategy inspired by [Alan Edwardes'](https://alanedwardes.com/) [Estranged.Lfs](https://github.com/alanedwardes/Estranged.Lfs)

<!-- contributing -->

## Contributing

[Issues](https://github.com/kitschpatrol/git-lfs-cf/issues) are welcome and appreciated.

Please open an issue to discuss changes before submitting a pull request. Unsolicited PRs (especially AI-generated ones) are unlikely to be merged.

This repository uses [@kitschpatrol/shared-config](https://github.com/kitschpatrol/shared-config) (via its `ksc` CLI) for linting and formatting, plus [MDAT](https://github.com/kitschpatrol/mdat) for readme placeholder expansion.

<!-- /contributing -->

<!-- license -->

## License

[MIT](license.txt) © [Eric Mika](https://ericmika.com)

<!-- /license -->
