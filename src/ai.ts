import type { IdentifyReplicantResult } from "voight-kampff-test";
import { compactor } from "voight-kampff-compactor";

export type AIAnalysisInput = {
  token: string;
  model: string;
  username: string;
  analysis: IdentifyReplicantResult;
  accountCreatedAt: string;
  publicRepos: number;
  events: Record<string, unknown>[];
};

export type AIAnalysisResult = {
  classification: "organic" | "mixed" | "automation";
  confidence: number;
  reasoning: string;
};

export const SYSTEM_PROMPT = [
  "You are an expert AI system designed to analyze GitHub user accounts and classify them as human-operated (\"organic\"), bot/automated (\"automation\"), or mixed behavior patterns.",
  "",
  "## Your Task",
  "Analyze a GitHub user's activity data (account metadata and event history) and return a classification with supporting evidence.",
  "",
  "## Input Data Structure",
  "- user.login: GitHub username",
  "- user.created_at: ISO 8601 date string (account creation time)",
  "- user.public_repos: number of public repositories owned",
  "- events: array of GitHub events with type, created_at, repo.name, payload",
  "  NOTE: Events are limited to the most recent 100 public events from the GitHub API. This is NOT the user's complete activity history — draw conclusions accordingly and avoid absolute statements about total activity.",
  "",
  "## Classification Categories",
  '- **organic**: Human-operated account (low bot-like signals, score >= 70)',
  '- **mixed**: Uncertain patterns (moderate bot-like signals, score 50-69)',
  '- **automation**: Likely bot-operated (strong bot-like signals, score < 50)',
  "",
  "## Analysis Framework",
  "",
  "Evaluate each pattern independently. Assign a score per flag reflecting severity of the detected behavior (low, medium, high).",
  "",
  "### 1. Account Age Context",
  "- New account (< 30 days): Apply stricter scrutiny for bot patterns",
  "- Young account (30-89 days): Moderate scrutiny, evaluate patterns carefully",
  "- Established account (>= 90 days): Higher tolerance for activity volume",
  "",
  "### 2. Repository Activity Baseline",
  "- Account has no personal repos but 20+ events: Suspicious pattern",
  "- 95%+ external activity with < 5 personal repos: No personal investment",
  "",
  "### 3. Bot-Like Pattern Detection (11 patterns to evaluate)",
  "",
  "#### A. Rapid Repository Creation",
  'Detect CreateEvent (ref_type="repository") clustering in 24 hours.',
  "Pattern: Rapid-fire repo creation suggests automation.",
  "",
  "#### B. Fork Surge",
  "Detect ForkEvent clustering in 24-hour window.",
  "Pattern: Concentrated forking activity suggests bot behavior.",
  "",
  "#### C. Commit Burst",
  "Detect PushEvent clustering in 1-hour window.",
  "Pattern: Inhuman commit velocity or ultra-tight clustering (seconds apart).",
  "",
  "#### D. 24/7 Activity Pattern",
  "Analyze each calendar day: activity spanning 21+ unique hours with minimal rest suggests no sleep.",
  "Pattern: Sustained multi-day coding without realistic sleep windows. Over 2 days indicates strong bot signals, especially if combined with other patterns.",
  "",
  "#### E. Event Type Diversity (Shannon's Entropy)",
  "Calculate normalized Shannon entropy of event types:",
  "- Entropy = sum(p * log2(p)) for each type's probability p",
  "- Normalized entropy = Entropy / log2(number_of_types)",
  "- Low entropy (< 0.5): Bot-like concentrated profile",
  "- High entropy (> 0.8): Suspicious uniform distribution across types",
  "",
  "Pattern: Either narrow rigid focus (few types) OR artificial cycling through all types, combined with no human interactions (comments, reviews, watches).",
  "",
  "#### F. Issue Comment Spam",
  "Detect IssueCommentEvent clustering across many repos within 30-minute window.",
  "Pattern: Rapid-fire commenting across unrelated repos suggests automation.",
  "",
  "#### G. Branch -> Pull Request Correlation",
  "Detect pattern: branch created -> PR opened within window, repeated consistently.",
  "Pattern: Mechanical CI/CD automation cycling (not typical human workflow).",
  "",
  "#### H. PR Volume",
  "Detect PR bursts to external repos (young accounts only, < 90 days).",
  "Pattern: High external PR volume without personal repo activity.",
  "",
  "#### I. Consecutive Days Activity",
  "Count calendar days with any activity.",
  "Pattern: 21+ consecutive days suggests either dedication or tireless bot.",
  "",
  "#### J. External Repo Spread",
  "Count unique external repos (young accounts only, < 90 days).",
  "Pattern: Contributing to many different external repos broadly suggests spray-and-pray behavior.",
  "",
  "#### K. Daily Coding Hour Distribution",
  "Analyze hour spread within each calendar day separately.",
  "Pattern: High entropy (>0.8) across 16+ hours in a day suggests automated activity cycling.",
  "",
  "## Scoring Methodology",
  "Evaluate all detected patterns independently. For each flag present, assign a severity-based score (0-100 scale per flag).",
  "Calculate final confidence score as: average of severity assessments across all flags, weighted by pattern significance.",
  "",
  "- Extreme automated signals: 0-20 (strong bot indicators)",
  "- High bot-like behavior: 20-40 (multiple suspicious patterns)",
  "- Moderate concerns: 40-60 (mixed or ambiguous signals)",
  "- Low concerns: 60-80 (mostly human-like with isolated flags)",
  "- Confident human: 80-100 (organic patterns throughout)",
  "",
  "## Time Window Analysis Rules",
  "- 24-hour rolling windows: sliding analysis for clustering patterns",
  "- Per-day analysis: evaluate each calendar day independently (not globally)",
  "- All times treated as UTC",
  "",
  "## Return JSON Format (MUST be valid JSON only)",
  '{',
  '  "classification": "organic" | "mixed" | "automation",',
  '  "confidence": number (0-100),',
  '  "reasoning": "string (2-3 sentences of concise, evidence-based assessment)"',
  '}',
  "",
  "## Output Requirements",
  "- Evaluate patterns independently without predetermined point mappings",
  "- Assign severity per flag based on strength of evidence",
  "- Provide specific evidence in the reasoning (actual counts, timeframes, observed behaviors)",
  "- Return ONLY valid JSON - no markdown, no extra text, no code fences",
  "- Be precise. Focus on evidence-based assessment, not fixed rubrics.",
].join("\n");

function slimEvents(events: Record<string, unknown>[]) {
  return events.map((e) => {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    return {
      type: e.type,
      created_at: e.created_at,
      repo: (e.repo as { name?: string })?.name,
      action: payload.action,
      ref: payload.ref,
      ref_type: payload.ref_type,
      size: payload.size,
      commits: Array.isArray(payload.commits) ? payload.commits.length : undefined,
    };
  });
}

export function buildUserPrompt(input: AIAnalysisInput): string {
  const compactedData = compactor(
    JSON.stringify({
      user: {
        login: input.username,
        created_at: input.accountCreatedAt,
        public_repos: input.publicRepos,
      },
      heuristic: {
        score: input.analysis.score,
        classification: input.analysis.classification,
        flags: input.analysis.flags,
      },
      events: slimEvents(input.events),
    }),
  );

  return `Here is the data to analyze: ${compactedData}`;
}

export async function getAIAnalysis({
  token,
  model,
  username,
  analysis,
  accountCreatedAt,
  publicRepos,
  events,
}: AIAnalysisInput): Promise<AIAnalysisResult | null> {
  const prompt = buildUserPrompt({ token, model, username, analysis, accountCreatedAt, publicRepos, events });

  const response = await fetch(
    "https://models.github.ai/inference/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  let content = data.choices?.[0]?.message?.content?.trim() ?? null;
  if (!content) return null;

  content = content
  // remove DeepSeek-R1 markers if present
  // This is stupid.
  .replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // todo : add validation of content structure before parsing like zod of
  return JSON.parse(content) as AIAnalysisResult;
}
