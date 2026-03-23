# AgentScan Action

GitHub action that analyzes PR authors' recent activity patterns to detect automation signals.

## Setup

Create a workflow file in your repository (e.g., `.github/workflows/agentscan.yml`):

```yaml
name: AgentScan

on:
  pull_request_target:
    types: [opened, reopened]

permissions:
  pull-requests: write
  contents: read

jobs:
  agentscan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: AgentScan
        uses: MatteoGabriele/agentscan-action@v1.0.1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The action will run automatically on new and reopened pull requests, analyzing the PR author's activity patterns to detect automation signals.

## Configuration

### Inputs

- **github-token** (required): GitHub token for API access
- **skip-members** (optional): Comma-separated list of usernames to skip from scanning
- **agent-scan-comment** (optional): Enable/disable posting comments on PRs (default: true). Set to false if you only want to use the outputs
- **cache-path** (optional): Path to cache directory for storing analysis results (e.g., `.agentscan-cache`). When provided, analysis results are cached and reused within the TTL period
- **skip-comment-on-organic** (optional): Skip posting PR comment if analysis result is "organic" (default: false)

### Skip Members

To skip specific team members from being scanned, add their usernames to the `skip-members` input:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@v1.0.1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    skip-members: "dependabot,renovate,my-trusted-bot"
```

Members in the skip list will be excluded from analysis without any PR comment or labels added.

### Caching

To enable caching and avoid redundant API calls, use `actions/cache@v4` and pass the cache path to the action:

```yaml
steps:
  - uses: actions/checkout@v4
  - name: Cache AgentScan analysis
    uses: actions/cache@v4
    with:
      path: .agentscan-cache
      key: agentscan-cache-${{ github.actor }}
      restore-keys: agentscan-cache-
  - name: AgentScan
    uses: MatteoGabriele/agentscan-action@v1.0.1
    with:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      cache-path: ".agentscan-cache"
```

**How caching works:**

1. Set up `actions/cache@v4` with a `path` and unique `key`
2. Pass the same path to the action via `cache-path` input
3. The action stores analysis results in that directory
4. `actions/cache` persists the directory between workflow runs
5. On subsequent runs, cached results are reused if they're within the TTL period

**Cache Invalidation**: Cached entries automatically expire after 2 days.

### Skip Organic Comments

To skip posting a PR comment when the analysis result is "organic" (clean, human-like activity), enable the `skip-comment-on-organic` option:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@v1.0.1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    skip-comment-on-organic: true
```

When enabled, the action will still output all analysis data (for downstream steps to use) but won't post a comment on the PR if the account is classified as organic.

### Disable Comments

To disable all PR comments and only use the action's outputs, set `agent-scan-comment` to `false`:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@v1.0.1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    agent-scan-comment: false
```

This is useful if you want to use the analysis outputs in downstream steps without posting comments.

## Testing

Run tests with vitest:

```bash
pnpm run test
```

Tests cover the following scenarios:

- **Normal Flow**: Analyzes a user without cache, saves result with timestamp
- **Cached Flow**:
  - Fresh cache (< 7 days): Uses cached data, skips API calls
  - Stale cache (≥ 7 days): Invalidates cache, makes fresh API calls
  - Corrupted cache: Falls back to API calls with warning
- **Skip-Member Flow**: Members in skip list are not analyzed
- **Label Assignment**: Correct labels added based on classification (organic, mixed, automation, community-flagged)

---

Stay safe out there, fellow human, and use AI responsibly.
