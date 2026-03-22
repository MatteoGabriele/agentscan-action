import * as core from "@actions/core";
import * as github from "@actions/github";

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

async function run() {
  try {
    const token = core.getInput("github-token", { required: true });
    const skipMembersInput = core.getInput("skip-members");
    const skipMembers = skipMembersInput
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    const octokit = github.getOctokit(token);

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

    const hasCommunityFlag: boolean = !!verifiedAutomation;

    const analysis: IdentifyReplicantResult = identifyReplicant({
      accountName: username,
      reposCount: user.public_repos,
      createdAt: user.created_at,
      events,
    });

    const isFlagged = hasCommunityFlag || analysis.classification !== "organic";
    core.setOutput("flagged", isFlagged ? "true" : "false");
    core.setOutput("classification", analysis.classification);
    core.setOutput("score", analysis.score);
    core.setOutput("community-flagged", hasCommunityFlag ? "true" : "false");
    core.setOutput("flags", JSON.stringify(analysis.flags));
    core.setOutput("account-age", analysis.profile.age);
    core.setOutput("username", username);

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
      if (core.getInput("agent-scan-comment") === "true") {
        await octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: `### ${indicator} ${details.label}

${details.description}

[View full analysis →](https://agentscan.netlify.app/user/${username})

<sub>This is an automated analysis by [AgentScan](https://agentscan.netlify.app)</sub>`,
        });
      }

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

run();
