# AgentScan Action

GitHub action that analyzes PR and issue authors' recent activity patterns to detect automation signals.

## Setup

Create a workflow file in your repository (e.g., `.github/workflows/agentscan.yml`):

```yaml
name: AgentScan

on:
  pull_request_target:
    types:
      - opened
      - reopened
  issues:
    types:
      - opened

jobs:
  agentscan:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      issues: write
      contents: read
    steps:
      - name: AgentScan
        uses: MatteoGabriele/agentscan-action@c7d61446e7aece6bdd3edcee4558bbfc0392615e
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The action will run automatically on new and reopened pull requests, and on newly opened issues, analyzing the author's activity patterns to detect automation signals.

## Configuration

### Inputs

- **github-token** (required): GitHub token for API access
- **allowed-users** (optional): Comma-separated list of usernames to skip from scanning
- **trusted-author-associations** (optional): Comma-separated list of author associations to skip from scanning (`collaborator`, `contributor`, `first_timer`, `first_time_contributor`, `member`, `owner`)
- **scan-pull-requests** (optional): Whether to analyze pull request authors (default: `true`)
- **scan-issues** (optional): Whether to analyze issue authors (default: `false`)
- **mode** (optional): How AgentScan should act on its findings: `full` (comment and labels), `labels` (labels only), `comment` (comment only), or `silent` (outputs only) (default: `full`)
- **comment-on-organic** (optional): Post a comment even when the analysis result is "organic" (default: `false`)
- **cache-path** (optional): Path to cache directory for storing analysis results (e.g., `.agentscan-cache`). When provided, analysis results are cached and reused within the TTL period
- **label-community-flagged** (optional): Label to add when an account is flagged by the community (default: `agentscan:community-flagged`)
- **label-mixed** (optional): Label to add when an account has mixed automation signals (default: `agentscan:mixed-signals`)
- **label-automation** (optional): Label to add when an account is classified as automated (default: `agentscan:automated-account`)
- **auto-close** (optional): Whether to automatically close issues/PRs for detected automations (default: `false`)
- **auto-close-classifications** (optional): Comma-separated list of classifications that trigger auto-close (default: `automation`)
- **message-organic** / **message-mixed** / **message-automation** / **message-community-flagged** (optional): Custom messages per classification

A machine-readable reference for these inputs (types, enums, defaults) is available at [`agentscan-action-v2.json`](https://agentscan.tools/schemas/agentscan-action-v2.json).

### Allowed Users

To skip specific team members from being scanned, add their usernames to the `allowed-users` input:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@c7d61446e7aece6bdd3edcee4558bbfc0392615e
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    allowed-users: "dependabot,renovate,my-trusted-bot"
```

Members in the allowed-users list will be excluded from analysis without any PR comment or labels added. Known CI/CD bot accounts (e.g. `dependabot`, `renovate`, `github-actions[bot]`) are always skipped automatically, regardless of this list.

### Trusted Author Associations

To skip analysis based on the author's relationship to the repository, set `trusted-author-associations`:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@c7d61446e7aece6bdd3edcee4558bbfc0392615e
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    trusted-author-associations: "member,owner,collaborator"
```

### Scanning Pull Requests and Issues

Use `scan-pull-requests` and `scan-issues` to control which event types are analyzed. `scan-issues` defaults to `false`:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@c7d61446e7aece6bdd3edcee4558bbfc0392615e
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    scan-pull-requests: true
    scan-issues: true
```

### Caching

To enable caching and avoid redundant API calls, use `actions/cache@v5` and pass the cache path to the action:

```yaml
steps:
  - name: Cache AgentScan analysis
    uses: actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae
    with:
      path: .agentscan-cache
      key: agentscan-cache-${{ github.actor }}
      restore-keys: agentscan-cache-
  - name: AgentScan
    uses: MatteoGabriele/agentscan-action@c7d61446e7aece6bdd3edcee4558bbfc0392615e
    with:
      github-token: ${{ secrets.GITHUB_TOKEN }}
      cache-path: ".agentscan-cache"
```

**How caching works:**

1. Set up `actions/cache` with a `path` and unique `key`
2. Pass the same path to the action via `cache-path` input
3. The action stores analysis results in that directory
4. `actions/cache` persists the directory between workflow runs
5. On subsequent runs, cached results are reused if they're within the TTL period

**Cache Invalidation**: Cached entries automatically expire after 2 days.

### Comment on Organic

By default, the action skips posting a PR or issue comment when the analysis result is "organic" (clean, human-like activity). To always comment, enable `comment-on-organic`:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@c7d61446e7aece6bdd3edcee4558bbfc0392615e
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    comment-on-organic: true
```

The action always outputs all analysis data (for downstream steps to use) regardless of this setting.

### Custom Labels

To customize labels added to PRs and issues, set any of the label inputs:

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@c7d61446e7aece6bdd3edcee4558bbfc0392615e
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    label-community-flagged: "security:community-flagged"
    label-mixed: "needs-review:automation-signals"
    label-automation: "blocked:automated-account"
```

### Mode

Control what AgentScan does with its findings via `mode`:

- `full` (default): post a comment and add labels
- `labels`: add labels only
- `comment`: post a comment only
- `silent`: neither — only use the action's outputs in downstream steps

```yaml
- name: AgentScan
  uses: MatteoGabriele/agentscan-action@c7d61446e7aece6bdd3edcee4558bbfc0392615e
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    mode: silent
```

---

Stay safe out there, fellow human, and use AI responsibly.
