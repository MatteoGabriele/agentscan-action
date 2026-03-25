import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";

import {
  identifyReplicant,
  getClassificationDetails,
  type IdentifyReplicantResult,
  type IdentityClassification,
} from "voight-kampff-test";

type AutomationListItem = {
  username: string;
  reason: string;
  createdAt: string;
  issueUrl: string;
};

type CacheEntry = {
  analysis: IdentifyReplicantResult;
  hasCommunityFlag: boolean;
  isFlagged: boolean;
  timestamp: number;
};

type TriggerLevel = "all" | "flagged" | "off" | (string & {});

const CACHE_TTL_DAYS = 2;

async function run() {
  try {
    const token = core.getInput("github-token", { required: true });
    const triggerLevel = core.getInput("trigger-level", {
      required: false,
    }) as TriggerLevel;
    const cacheDir = core.getInput("cache-path", { required: false });

    const skipMembersInput = core.getInput("skip-members", { required: false });
    const skipMembers = skipMembersInput
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    const context = github.context;
    const username = context.actor;
    const prNumber = context.payload.pull_request?.number;

    if (!prNumber) {
      throw new Error("No PR number found");
    }

    if (skipMembers.includes(username)) {
      core.info(`Skipping analysis for ${username}`);
      return;
    }

    const octokit = github.getOctokit(token);

    // Check cache if cache directory is provided
    let cachedAnalysis: Record<string, unknown> | null = null;
    if (cacheDir !== "") {
      const cacheFile = path.join(cacheDir, `${username}.json`);
      if (fs.existsSync(cacheFile)) {
        try {
          const cached = JSON.parse(
            fs.readFileSync(cacheFile, "utf-8"),
          ) as CacheEntry;
          const cacheAgeMs = Date.now() - cached.timestamp;
          const cacheAgeDays = cacheAgeMs / (1000 * 60 * 60 * 24);

          if (cacheAgeDays < CACHE_TTL_DAYS) {
            cachedAnalysis = cached;
            core.info(
              `Using cached analysis for ${username} (${cacheAgeDays.toFixed(1)} days old)`,
            );
          } else {
            core.info(
              `Cache expired for ${username} (${cacheAgeDays.toFixed(1)} days old, TTL: ${CACHE_TTL_DAYS} days)`,
            );
          }
        } catch (cacheError) {
          core.warning(`Failed to read cache: ${String(cacheError)}`);
        }
      }
    }

    let hasCommunityFlag = false;
    let analysis: IdentifyReplicantResult | null = null;
    let isFlagged = false;

    // Use cached analysis if available, otherwise make API calls
    if (cachedAnalysis) {
      // Use cached analysis
      analysis = cachedAnalysis.analysis as IdentifyReplicantResult;
      hasCommunityFlag = (cachedAnalysis.hasCommunityFlag as boolean) || false;
      isFlagged = (cachedAnalysis.isFlagged as boolean) || false;
    } else {
      const { data: user } = await octokit.rest.users.getByUsername({
        username: username,
      });

      const { data: events } =
        await octokit.rest.activity.listPublicEventsForUser({
          username,
          per_page: 100,
          page: 1,
        });

      let verified: AutomationListItem[] = [];

      try {
        const { data: verifiedList } = await octokit.rest.repos.getContent({
          owner: "matteogabriele",
          repo: "agentscan",
          path: "data/verified-automations-list.json",
        });

        if ("content" in verifiedList) {
          const content = Buffer.from(verifiedList.content, "base64").toString(
            "utf-8",
          );
          verified = JSON.parse(content) as AutomationListItem[];
        }
      } catch (error) {
        core.warning("Could not fetch verified automations list");
      }

      const verifiedAutomation: AutomationListItem | undefined = verified.find(
        (account) => account.username === username,
      );

      hasCommunityFlag = !!verifiedAutomation;

      analysis = identifyReplicant({
        accountName: username,
        reposCount: user.public_repos,
        createdAt: user.created_at,
        events,
      });

      isFlagged = hasCommunityFlag || analysis.classification !== "organic";

      // Save analysis result to cache
      if (cacheDir) {
        try {
          if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
          }
          const cacheFile = path.join(cacheDir, `${username}.json`);
          fs.writeFileSync(
            cacheFile,
            JSON.stringify(
              {
                analysis,
                hasCommunityFlag,
                isFlagged,
                timestamp: Date.now(),
              } as CacheEntry,
              null,
              2,
            ),
          );
          core.info(`Cached analysis for ${username}`);
        } catch (cacheError) {
          core.warning(`Failed to save cache: ${String(cacheError)}`);
        }
      }
    }

    core.setOutput("flagged", isFlagged ? "true" : "false");
    core.setOutput("classification", analysis.classification);
    core.setOutput("score", analysis.score);
    core.setOutput("community-flagged", hasCommunityFlag ? "true" : "false");
    core.setOutput("flags", JSON.stringify(analysis.flags));
    core.setOutput("account-age", analysis.profile.age);
    core.setOutput("username", username);

    if (triggerLevel === "off" || (triggerLevel === "flagged" && !isFlagged)) {
      core.info("[trigger-level] skipping comments");
      return;
    }

    const statusIndicators: Record<IdentityClassification, string> = {
      organic: "✅",
      mixed: "⚠️",
      automation: "❌",
    };

    const indicator = hasCommunityFlag
      ? "🚩"
      : statusIndicators[analysis.classification];
    const details = hasCommunityFlag
      ? {
          label: "Flagged by community",
          description:
            "This account has been flagged as potentially automated by the community.",
        }
      : getClassificationDetails(analysis.classification);

    try {
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        body: `### ${indicator} ${details.label}

${details.description}

[View full analysis →](https://agentscan.netlify.app/user/${username})

<sub>This is an automated analysis by [AgentScan](https://agentscan.netlify.app)</sub>`,
      });

      const labelsToAdd: string[] = [];

      if (hasCommunityFlag) {
        labelsToAdd.push("agentscan:community-flagged");
      } else if (analysis.classification !== "organic") {
        const labelMap: Record<
          Exclude<IdentityClassification, "organic">,
          string
        > = {
          mixed: "agentscan:mixed-signals",
          automation: "agentscan:automated-account",
        };

        const label = labelMap[analysis.classification];
        if (label) {
          labelsToAdd.push(label);
        }
      }

      if (labelsToAdd.length > 0) {
        await octokit.rest.issues.addLabels({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          labels: labelsToAdd,
        });
      }

      core.info(`Comment posted on PR #${prNumber}`);
    } catch (commentError: unknown) {
      if (commentError instanceof Error) {
        if (commentError.message.includes("Resource not accessible")) {
          core.warning(
            "Could not post comment on this PR. Analysis completed but comment/labels skipped.",
          );
        } else {
          throw commentError;
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

export { run };

// Only run when this is the main module (not imported for testing)
if (process.env.NODE_ENV !== "test") {
  run();
}
