import type { IdentifyFlag, IdentityClassification } from "@unveil/identity";

const REPORT_ISSUE_URL =
	"https://github.com/matteogabriele/agentscan/issues/new";
const MAX_EVIDENCE_FLAGS = 8;
const MAX_EXAMPLE_PRS = 5;

type ReportIssueParams = {
	username: string;
	userId: number | undefined;
	classification: IdentityClassification;
	score: number;
	flags: IdentifyFlag[];
	sourceUrl: string;
};

type EvidenceParams = {
	username: string;
	flags: IdentifyFlag[];
	/** Omit when the evidence is rendered on the flagged PR/issue itself — pointing back to itself is redundant. */
	sourceUrl?: string;
};

/**
 * A github.com link to a PR/issue in the evidence body would make GitHub post an
 * unwanted "mentioned this pull request" backlink on that PR once the report issue
 * is filed. redirect.github.com is GitHub's documented escape hatch: it 302s to the
 * same page but isn't recognized by the reference parser, so no backlink is created.
 * https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
 */
function withoutBacklink(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.hostname === "github.com") {
			parsed.hostname = "redirect.github.com";
		}
		return parsed.toString();
	} catch {
		return url;
	}
}

/**
 * Flags carry the raw GitHub events that triggered them. Pull a handful of the
 * actual PRs behind a "PR volume"/"fork→PR pattern" style flag so a reviewer has
 * concrete examples to look at, instead of just the aggregate detail string.
 */
function extractExamplePrUrls(flags: IdentifyFlag[], limit: number): string[] {
	const urls = new Set<string>();

	for (const flag of flags) {
		for (const event of flag.events ?? []) {
			if (urls.size >= limit) break;
			if (event.type !== "PullRequestEvent") continue;

			const pr = event.payload?.pull_request as
				| { html_url?: string; number?: number }
				| undefined;
			const url =
				pr?.html_url ??
				(event.repo?.name && pr?.number !== undefined
					? `https://github.com/${event.repo.name}/pull/${pr.number}`
					: undefined);

			if (url) urls.add(url);
		}
	}

	return [...urls].slice(0, limit);
}

/**
 * Builds the evidence lines shared between the PR/issue comment and the pre-filled
 * report-issue link, so both surfaces always show the same facts.
 */
export function buildEvidenceLines({
	username,
	flags,
	sourceUrl,
}: EvidenceParams): string[] {
	const topFlags = [...flags]
		.sort((a, b) => b.points - a.points)
		.slice(0, MAX_EVIDENCE_FLAGS);

	const examplePrUrls = extractExamplePrUrls(flags, MAX_EXAMPLE_PRS);

	const lines: string[] = [];

	if (sourceUrl) {
		lines.push(`- Flagged in: ${withoutBacklink(sourceUrl)}`);
	}
	lines.push(`- Full analysis: https://agentscan.tools/user/${username}`);
	lines.push(...topFlags.map((flag) => `- ${flag.label}: ${flag.detail}`));

	if (flags.length > topFlags.length) {
		lines.push(
			`- (+${flags.length - topFlags.length} more signal(s), see full analysis)`,
		);
	}

	if (examplePrUrls.length > 0) {
		lines.push(
			"",
			"Example PRs:",
			...examplePrUrls.map((url) => `- ${withoutBacklink(url)}`),
		);
	}

	return lines;
}

/**
 * Builds a pre-filled "Report Automated Account" issue URL from an already-computed
 * analysis, so a maintainer only has to review and submit it instead of retyping
 * evidence AgentScan already has.
 */
export function buildReportIssueUrl({
	username,
	userId,
	classification,
	score,
	flags,
	sourceUrl,
}: ReportIssueParams): string {
	const reason = `AgentScan classified this account as "${classification}" (score ${score}/100) based on ${flags.length} possible automated signal${flags.length === 1 ? "" : "s"}.`;

	const evidenceLines = buildEvidenceLines({ username, flags, sourceUrl });

	const url = new URL(REPORT_ISSUE_URL);
	url.searchParams.set("template", "report-automated-account.yml");
	url.searchParams.set("username", username);

	if (userId !== undefined) {
		url.searchParams.set("user-id", String(userId));
	}

	url.searchParams.set("reason", reason);
	url.searchParams.set("evidence", evidenceLines.join("\n"));

	return url.toString();
}

/**
 * Parse input that can be in JSON array format or comma-separated format
 * @param input The input string to parse
 * @returns Array of strings
 */
export function parseStringArray(input: string): string[] {
	if (!input) return [];
	try {
		// Try parsing as JSON array first
		const parsed = JSON.parse(input);
		if (Array.isArray(parsed)) {
			return parsed.map((item) => String(item).trim()).filter(Boolean);
		} else {
			throw new Error("Not an array");
		}
	} catch {
		// Fall back to comma-separated format
		return input
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
}

/**
 * Parse input that can be in JSON array format or comma-separated format
 * with a type guard validator
 * @param input The input string to parse
 * @param validator A type guard function to validate each item
 * @returns Array of validated typed items
 */
export function parseTypedArray<T extends string>(
	input: string,
	validator: (item: string) => item is T,
): T[] {
	if (!input) return [];
	const result: T[] = [];
	try {
		const parsed = JSON.parse(input);
		if (Array.isArray(parsed)) {
			const items = parsed.map((item) => String(item).trim()).filter(Boolean);
			for (const item of items) {
				if (validator(item)) {
					result.push(item);
				}
			}
		} else {
			throw new Error("Not an array");
		}
	} catch {
		const items = input
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		for (const item of items) {
			if (validator(item)) {
				result.push(item);
			}
		}
	}
	return result;
}
