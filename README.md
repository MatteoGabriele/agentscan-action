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
- **cache** (optional): Enable caching of analysis results to speed up repeated scans (default: false)

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

To enable caching and avoid redundant API calls, set the `cache` input to `true`:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@v1.0.1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    cache: true
```

Cache files are stored in `.agentscan-cache` directory. To preserve cache across workflow runs, use the `actions/cache` action:

```yaml
steps:
  - uses: actions/checkout@v4
  - name: Restore analysis cache
    uses: actions/cache@v4
    with:
      path: .agentscan-cache
      key: agentscan-${{ github.actor }}
      restore-keys: agentscan-
  - name: AgentScan
    uses: MatteoGabriele/agentscan-action@v1.0.1
    with:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      cache: true
```

**Cache Invalidation**: Cached entries automatically expire after 7 days. When a cache entry is older than the TTL (Time-To-Live), it will be invalidated and the account will be re-analyzed with fresh data from GitHub's API.

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
