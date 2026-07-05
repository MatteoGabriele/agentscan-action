import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  getClassificationDetails,
  type IdentifyResult,
  type IdentityClassification,
  identify,
} from "@unveil/identity";
import { isKnownBot } from "./known-bots";
import { parseStringArray, parseTypedArray } from "./utils";

type AutomationListItem = {
  username: string;
  reason: string;
  createdAt: string;
  issueUrl: string;
};

type CacheEntry = {
  analysis: IdentifyResult;
  hasCommunityFlag: boolean;
  isFlagged: boolean;
  timestamp: number;
};

type CustomMessages = Partial<Record<IdentityClassification, string | null>> & {
  communityFlagged?: string | null;
};

type AuthorAssociation =
  | "collaborator"
  | "contributor"
  | "first_timer"
  | "first_time_contributor"
  | "member"
  | "owner";

type Mode = "full" | "labels" | "comment" | "silent";

const CACHE_TTL_DAYS = 2;
const DEFAULT_AUTO_CLOSE_CLASSIFICATION: IdentityClassification = "automation";
const MARKER = "<!-- agentscanapp-bot -->";

function getLabelInput(name: string, defaultValue: string): string {
  return core.getInput(name).trim() || defaultValue;
}

function getCustomMessage(name: string): string | null {
  const message = core.getInput(name).trim();
  return message || null;
}

function getMode(): Mode {
  const validModes: Mode[] = ["full", "labels", "comment", "silent"];
  const input = core.getInput("mode").trim().toLowerCase();
  if ((validModes as string[]).includes(input)) {
    return input as Mode;
  }
  core.warning(`Invalid mode "${input}", falling back to "full"`);
  return "full";
}

async function run() {
  try {
    const token = core.getInput("github-token", { required: true });
    const allowedUsersInput = core.getInput("allowed-users");
    const trustedAuthorAssociationsInput = core.getInput(
      "trusted-author-associations",
    );
    const scanPullRequests =
      core.getInput("scan-pull-requests").toLowerCase() !== "false";
    const scanIssues = core.getInput("scan-issues").toLowerCase() === "true";
    const mode = getMode();
    const commentOnOrganic =
      core.getInput("comment-on-organic").toLowerCase() === "true";
    const cacheDir = core.getInput("cache-path");
    const autoClose = core.getInput("auto-close").toLowerCase() === "true";
    const autoCloseClassificationsInput = core.getInput(
      "auto-close-classifications",
    );

    const allowedUsers = parseStringArray(allowedUsersInput);

    const trustedAuthorAssociations = parseTypedArray<AuthorAssociation>(
      trustedAuthorAssociationsInput,
      (item): item is AuthorAssociation =>
        [
          "collaborator",
          "contributor",
          "first_timer",
          "first_time_contributor",
          "member",
          "owner",
        ].includes(item),
    );

    const autoCloseClassifications = parseTypedArray<IdentityClassification>(
      autoCloseClassificationsInput || DEFAULT_AUTO_CLOSE_CLASSIFICATION,
      (item): item is IdentityClassification =>
        ["mixed", "automation"].includes(item),
    );

    const labels = {
      communityFlagged: getLabelInput(
        "label-community-flagged",
        "agentscan:community-flagged",
      ),
      mixed: getLabelInput("label-mixed", "agentscan:mixed-signals"),
      automation: getLabelInput(
        "label-automation",
        "agentscan:automated-account",
      ),
    };

    const customMessages: CustomMessages = {
      organic: getCustomMessage("message-organic"),
      mixed: getCustomMessage("message-mixed"),
      automation: getCustomMessage("message-automation"),
      communityFlagged: getCustomMessage("message-community-flagged"),
    };

    const context = github.context;
    const username = context.actor;
    const isPR = context.payload.pull_request !== undefined;
    const isIssue = context.payload.issue !== undefined;
    const prNumber = context.payload.pull_request?.number;
    const issueNumber = context.payload.issue?.number;
    const targetNumber = prNumber ?? issueNumber;
    const rawAuthorAssociation =
      context.payload.pull_request?.author_association ??
      context.payload.issue?.author_association;
    const authorAssociation = rawAuthorAssociation?.toLowerCase() as
      | AuthorAssociation
      | undefined;

    if (!targetNumber) {
      throw new Error("No PR or issue number found");
    }

    if (isPR && !scanPullRequests) {
      core.info("Skipping analysis: pull request scanning is disabled");
      return;
    }

    if (!isPR && isIssue && !scanIssues) {
      core.info("Skipping analysis: issue scanning is disabled");
      return;
    }

    if (allowedUsers.includes(username)) {
      core.info(`Skipping analysis for ${username}`);
      return;
    }

    if (isKnownBot(username)) {
      core.info(`Skipping analysis for ${username} (known automation)`);
      return;
    }

    if (
      authorAssociation &&
      trustedAuthorAssociations.includes(authorAssociation)
    ) {
      core.info(
        `Skipping analysis for ${username} (trusted author association: ${authorAssociation})`,
      );
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
    let analysis: IdentifyResult | null = null;
    let isFlagged = false;

    // Use cached analysis if available, otherwise make API calls
    if (cachedAnalysis) {
      // Use cached analysis
      analysis = cachedAnalysis.analysis as IdentifyResult;
      hasCommunityFlag = (cachedAnalysis.hasCommunityFlag as boolean) || false;
      isFlagged = (cachedAnalysis.isFlagged as boolean) || false;
    } else {
      const { data: user } = await octokit.rest.users.getByUsername({
        username: username,
      });

      const pageRequests = Array.from({ length: 2 }, (_, index) => {
        return octokit.rest.activity.listPublicEventsForUser({
          username,
          per_page: 100,
          page: index + 1,
        });
      });

      const responses = await Promise.all(pageRequests);
      const events = responses.flatMap((response) => response.data);

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
      } catch {
        core.warning("Could not fetch verified automations list");
      }

      const verifiedAutomation: AutomationListItem | undefined = verified.find(
        (account) => account.username === username,
      );

      hasCommunityFlag = !!verifiedAutomation;

      analysis = identify({
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

    // Skip commenting if analysis is organic and comment-on-organic is disabled
    if (
      !commentOnOrganic &&
      !hasCommunityFlag &&
      analysis.classification === "organic"
    ) {
      const skipEventType = prNumber ? "PR" : "issue";
      core.info(
        `Skipping comment on ${skipEventType} as analysis returned 'organic' and comment-on-organic is disabled`,
      );
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

    const customClassificationMessage = customMessages[analysis.classification];

    let description = details.description;
    if (customMessages.communityFlagged && hasCommunityFlag) {
      description = customMessages.communityFlagged;
    } else if (customClassificationMessage && !hasCommunityFlag) {
      description = customClassificationMessage;
    }

    const body = [
      MARKER,
      `### ${indicator} ${details.label}`,
      "",
      description,
      "",
      `[View full analysis →](https://agentscan.tools/user/${username})`,
      "",
      "<sub>This is an automated analysis by [AgentScan](https://agentscan.tools)</sub>",
    ].join("\n");

    try {
      if (mode === "full" || mode === "comment") {
        const { data: existingComments } = await octokit.rest.issues.listComments({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: targetNumber,
          per_page: 100,
        });

        const existing = existingComments.find((comment) =>
          comment.body?.includes(MARKER),
        );

        if (existing) {
          await octokit.rest.issues.updateComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            comment_id: existing.id,
            body,
          });
        } else {
          await octokit.rest.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: targetNumber,
            body,
          });
        }
      }

      if (mode === "full" || mode === "labels") {
        const labelsToAdd: string[] = [];

        if (hasCommunityFlag) {
          labelsToAdd.push(labels.communityFlagged);
        } else if (analysis.classification !== "organic") {
          const labelMap: Record<
            Exclude<IdentityClassification, "organic">,
            string
          > = {
            mixed: labels.mixed,
            automation: labels.automation,
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
            issue_number: targetNumber,
            labels: labelsToAdd,
          });
        }
      }

      const postEventType = prNumber ? "PR" : "issue";
      core.info(`Analysis posted on ${postEventType} #${targetNumber}`);
    } catch (commentError: unknown) {
      if (commentError instanceof Error) {
        if (commentError.message.includes("Resource not accessible")) {
          const warnEventType = prNumber ? "PR" : "issue";
          core.warning(
            `Could not post comment on this ${warnEventType}. Analysis completed but comment/labels skipped.`,
          );
        } else {
          throw commentError;
        }
      }
    }

    // Auto-close if enabled and classification matches
    if (autoClose) {
      const shouldClose =
        hasCommunityFlag ||
        autoCloseClassifications.includes(analysis.classification);

      if (shouldClose) {
        try {
          await octokit.rest.issues.update({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: targetNumber,
            state: "closed",
            state_reason: "not_planned",
          });

          const closeEventType = prNumber ? "PR" : "issue";
          const closeReason = hasCommunityFlag
            ? "community-flagged account"
            : `${analysis.classification} classification`;
          core.info(
            `Closed ${closeEventType} #${targetNumber} (${closeReason})`,
          );
        } catch (closeError: unknown) {
          if (closeError instanceof Error) {
            if (closeError.message.includes("Resource not accessible")) {
              const closeEventType = prNumber ? "PR" : "issue";
              core.warning(
                `Could not close ${closeEventType}. Analysis completed but close action skipped.`,
              );
            } else {
              throw closeError;
            }
          }
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
