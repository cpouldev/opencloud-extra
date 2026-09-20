# Downstream releases

All mutation targets are fixed to `cpouldev/opencloud-extra` and
`docker.io/cpoul/opencloud-extra`. `opencloud-eu/opencloud` supplies Git objects and
release metadata through read-only requests. No workflow opens an upstream PR,
issue or release, and upstream is never installed as a push remote.

## Setup

1. Make `extra/stable` the fork's default branch. GitHub runs scheduled workflows
   from the default branch. Keep `main` as the original upstream branch if useful.
2. Enable GitHub Actions and Issues in the fork. The workflows request only their
   required job-level `GITHUB_TOKEN` permissions; no GitHub personal token is used.
3. Add `DOCKERHUB_TOKEN` as an Actions repository secret. The token belongs to
   `cpoul` and must allow writing `cpoul/opencloud-extra` on Docker Hub. Create
   the public repository in Docker Hub once. If it is missing, publication tries
   to create it using the
   [Docker Hub API](https://docs.docker.com/reference/api/hub/latest/operations/CreateRepository/).
   A token that permits image pushes may lack repository-creation permission;
   if creation returns HTTP 403, create the repository in Docker Hub and rerun
   the failed publication job to reuse its tested image artifacts.
4. Run **OpenCloud Extra stable release** on `extra/stable`. The same workflow also
   runs on pushes to that branch and daily at 05:23 UTC.

## Release sequence

`upstream.json` records the upstream stable tag already merged into the fork.
Preparation selects the highest semantic `X.Y.Z` tag from published, non-draft,
non-prerelease GitHub releases. It merges that tag into the current `extra/stable`
head with an ordinary Git merge. A conflict aborts the merge without changing the
remote branch. Changes to our tracked files participate in normal merge conflict
detection; automation never resets to upstream or discards the extras.

Preparation uploads the exact candidate as a Git bundle. Separate native amd64
and arm64 jobs restore that commit, run the targeted Go suites, build the final
image, run runtime smoke checks, real converter tests and browser preview tests,
and save that tested image as an artifact. These jobs have read-only GitHub
permissions and no Docker Hub credentials. Pull requests use the same validation
workflow without saving release artifacts or publishing anything.

After both architectures pass, the publication job checks that `extra/stable`
still matches preparation's starting commit. It atomically fast-forwards the
branch and reserves the immutable Git tag with a lease. A concurrent change
rejects the whole update. The publisher then loads the saved images, verifies
their source and version labels, and publishes both architectures. No rebuild is
performed in the publication job. The `stable` and `latest` aliases move only
after the complete multi-architecture version exists and its digest is verified.
A GitHub release in the fork records completion.

Versions are `8.0.1-extra.1`, `8.0.1-extra.2`, and so on, with matching Git and
Docker tags. Architecture tags add `-amd64` or `-arm64`. A new upstream version
starts again at `extra.1`. Custom commits on the same upstream version increment
the extra revision. Manual `force_release` increments it even without a source
change, for example to refresh container dependencies. A completed version at
the current head makes ordinary daily runs a no-op.

All release steps are connected in one workflow. They do not rely on pushes made
with `GITHUB_TOKEN` triggering another workflow. See GitHub's
[token behavior](https://docs.github.com/en/actions/concepts/security/github_token).

## Failures and recovery

A failed job creates or updates one diagnostic issue **in the fork** with a link
to the run. Older versioned Docker images remain available. If branch/tag
reservation succeeded but publication failed, a later run retries the same
reserved version before taking another upstream update. Existing platform tags
are checked against the reserved source commit and reused. Existing version
manifests are checked against those platform digests and never overwritten.
Network or authentication errors fail the job; only a registry 404 means a tag
does not exist.

If the branch advanced since an incomplete release, the next run allocates a new
revision for the new source. A failed release can therefore leave a reserved Git
tag without a complete image; it is not advertised through a GitHub release.
Re-running a failed publication job works while its three-day artifacts remain
available. Starting a fresh workflow rebuilds and validates the reserved source;
any already-published parts of that reserved version are retained.

GitHub can reject an automatic merge that changes `.github/workflows/`, because
`GITHUB_TOKEN` cannot be granted the workflow-write permission. Branch rules may
also prohibit the direct fast-forward. In these cases a maintainer resolves or
merges the change **in this fork**, then reruns the workflow. Do not grant an
upstream-capable token to the workflow. See GitHub's
[workflow permission restriction](https://docs.github.com/en/rest/releases/releases#update-a-release)
and [Git reference permissions](https://docs.github.com/en/rest/git/refs).

The two mutable Docker aliases cannot be updated transactionally; if a registry
operation fails between them, a retry aligns both with the verified version.
The workflow serializes releases, and scripts refuse to replace version tags.
Maintainers should also avoid changing versioned tags manually.

GitHub may disable scheduled workflows in an inactive public repository after
60 days. Check that the schedule remains enabled when the fork has had no new
commits for a long period; see
[scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Local checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extras/release -p 'test_*.py' -v
actionlint .github/workflows/extra-*.yml
```

Tests use temporary local Git repositories for real merges, bundle restoration,
atomic promotion, stale-head rejection and tag collisions. Registry tests use
fixtures; they never create remote tags or releases.
