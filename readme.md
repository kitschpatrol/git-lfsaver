## Overview

Authentication is managed through GitHub.

Inspired by `Milkey Mouse`'s [git-fs-s3-proxy](https://github.com/milkey-mouse/git-lfs-s3-proxy).

## Cloudflare Worker Setup

1.  Create a new R2 bucket to store your LFS data, e.g. `example-lfs`.

    ```sh
    wrangler r2 bucket create example-lfs
    ```

2.  Create read / write account API tokens for the bucket:

    1. Token name: e.g. `R2 Example LFS Read Write Token`
    2. Permissions: \
       Object Read & Write
    3. Specify Buckets \
       Apply to specific buckets only: \
        `example-lfs`
    4. TTL: \
       _At your discretion_
    5. Create the token and store the credentials securely

3.  Create read-only account API tokens for the bucket:

    1. Token name: e.g. `R2 Example LFS Read Token`
    2. Permissions: \
       Object Read
    3. Specify Buckets \
       Apply to specific buckets only: \
        `example-lfs`
    4. TTL: \
       _At your discretion_
    5. Create the token and store the credentials securely

## Usage

1. Generate a personal access token for the repository or account you want to use LFS with.

2. Configure Git to use a credential helper, this prevents you from having to enter your credentials every time you pull or push.

On macOS, you can use the `osxkeychain` credential helper to store your credentials.

```sh
git config --global credential.helper osxkeychain
```

---

Notes...

https://manpages.ubuntu.com/manpages/focal/man5/git-lfs-config.5.html

ssh git@github.com git-lfs-authenticate kitschpatrol/lfs-sandbox.git upload

Force redownload:

git -c http.sslVerify=false lfs push --all origin main

https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md

GIT_TRACE=1 GIT_TRANSFER_TRACE=1 GIT_CURL_VERBOSE=1 git -c http.sslVerify=false lfs push --all origin main
