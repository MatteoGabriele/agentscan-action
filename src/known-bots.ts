const knownBots = new Set([
  "agentscanapp",
  "copilot",
  "dependabot",
  "dependabot-preview",
  "renovate",
  "renovate-bot",
  "greenkeeper",
  "github-actions",
  "stale",
  "snyk-bot",
  "codecov",
  "codecov-commenter",
  "coveralls",
  "travis-ci",
  "circleci",
  "appveyor",
  "azure-pipelines",
  "netlify",
  "vercel",
  "heroku",
  "aws-amplify",
  "eslintbot",
]);

export function isKnownBot(username: string): boolean {
  const lower = username.toLowerCase();
  return lower.endsWith("[bot]") || knownBots.has(lower);
}
