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
- **cache-dir** (optional): Directory to store analysis cache for faster repeated scans

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

To cache analysis results and avoid redundant API calls, use the `actions/cache` action with the `cache-dir` input:

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
      cache-dir: .agentscan-cache
```

This will cache analysis results by username. Subsequent scans of the same account will use the cached data, reducing API calls and improving performance.

## Testing

Run tests with vitest:

```bash
pnpm run test
```

Tests cover three main flows:

- **Normal Flow**: Action analyzes a user without cache
- **Cached Flow**: Action uses cached analysis and skips API calls
- **Skip-Member Flow**: Action skips members in the skip list

---

Stay safe out there, fellow human, and use AI responsibly.
