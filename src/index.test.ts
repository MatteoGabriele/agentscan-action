import { rmSync } from "node:fs";
import type { IdentifyResult } from "@unveil/identity";

vi.mock("@actions/core");
vi.mock("@actions/github");
vi.mock("@unveil/identity");

import * as core from "@actions/core";
import * as github from "@actions/github";
import { getClassificationDetails, identify } from "@unveil/identity";
import { run } from "./index";

describe("AgentScan Action", () => {
  // Shared test data
  const mockContext = {
    actor: "test-user",
    payload: { pull_request: { number: 123 } },
    repo: { owner: "test-owner", repo: "test-repo" },
  };

  const mockAnalysis: IdentifyResult = {
    classification: "organic",
    score: 20,
    flags: [{ label: "Test Flag", points: 10, detail: "This is a test flag" }],
    profile: { age: 365, repos: 0 },
    isBountyHunter: false,
  };

  // Helper functions to reduce boilerplate
  const setupInputs = (overrides: Record<string, string> = {}) => {
    const defaults: Record<string, string> = {
      "github-token": "test-token",
      "allowed-users": "",
      "trusted-author-associations": "",
      "scan-pull-requests": "true",
      "scan-issues": "false",
      "cache-path": "",
      "comment-on-organic": "false",
      mode: "full",
      "auto-close": "false",
      "auto-close-classifications": "automation",
      "label-community-flagged": "agentscan:community-flagged",
      "label-mixed": "agentscan:mixed-signals",
      "label-automation": "agentscan:automated-account",
    };
    const config = { ...defaults, ...overrides };

    vi.mocked(core.getInput).mockImplementation(
      (name: string) => config[name] || "",
    );
  };

  const setupContext = () => {
    Object.defineProperty(github, "context", {
      value: mockContext,
      configurable: true,
    });
  };

  const createMockOctokit = (overrides: Record<string, any> = {}) => {
    const defaultApis = {
      users: {
        getByUsername: vi.fn().mockResolvedValue({
          data: { public_repos: 10, created_at: "2020-01-01T00:00:00Z" },
        }),
      },
      activity: {
        listPublicEventsForUser: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        getContent: vi.fn().mockResolvedValue({ data: { content: [] } }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const rest = {
      ...defaultApis,
      ...Object.keys(overrides).reduce(
        (acc, key) =>
          Object.assign({
            acc,
            [key]: {
              ...defaultApis[key as keyof typeof defaultApis],
              ...overrides[key],
            },
          }),
        defaultApis,
      ),
    };

    return {
      rest,
      paginate: vi
        .fn()
        .mockImplementation(
          async (
            method: (params: unknown) => Promise<{ data: unknown }>,
            params: unknown,
          ) => {
            const { data } = await method(params);
            return data;
          },
        ),
    };
  };

  const createCacheEntry = (daysOld: number = 0): Record<string, unknown> => {
    return {
      analysis: mockAnalysis,
      hasCommunityFlag: false,
      isFlagged: false,
      timestamp: Date.now() - daysOld * 24 * 60 * 60 * 1000,
    };
  };

  const setupCommonMocks = () => {
    vi.mocked(identify).mockReturnValue(mockAnalysis);
    vi.mocked(getClassificationDetails).mockReturnValue({
      label: "Organic Account",
      description: "This account appears to be organic.",
    });
    vi.mocked(core.setOutput).mockImplementation(() => {});
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up cache directory
    try {
      rmSync(".agentscan-cache", { recursive: true, force: true });
    } catch {
      // Ignore if not present
    }
  });

  describe("Normal Flow - No cache, no skip", () => {
    beforeEach(() => {
      setupInputs({ "comment-on-organic": "true" });
      setupContext();
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);
    });

    it("should fetch user data and analyze", async () => {
      await run();

      expect(github.getOctokit).toHaveBeenCalledWith("test-token");
      expect(identify).toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith("classification", "organic");
      expect(core.setOutput).toHaveBeenCalledWith("username", "test-user");

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    });

    it("should scan the PR author, not the actor, when someone else reopens the PR", async () => {
      Object.defineProperty(github, "context", {
        value: {
          ...mockContext,
          actor: "maintainer-who-reopened",
          payload: {
            pull_request: { number: 123, user: { login: "pr-author" } },
          },
        },
        configurable: true,
      });

      await run();

      expect(core.setOutput).toHaveBeenCalledWith("username", "pr-author");

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.users.getByUsername).toHaveBeenCalledWith({
        username: "pr-author",
      });
    });

    it("should save analysis to cache when cache path is provided", async () => {
      setupInputs({ "cache-path": ".agentscan-cache" });

      await run();

      const cacheFile = ".agentscan-cache/test-user.json";
      const cacheData = JSON.parse(
        require("fs").readFileSync(cacheFile, "utf-8"),
      );
      expect(cacheData).toHaveProperty("analysis");
      expect(cacheData).toHaveProperty("hasCommunityFlag");
      expect(cacheData).toHaveProperty("isFlagged");
      expect(cacheData).toHaveProperty("timestamp");
      expect(typeof cacheData.timestamp).toBe("number");
    });

    it("should fetch 2 pages with 100 items per page", async () => {
      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;

      expect(
        mockOctokit.rest.activity.listPublicEventsForUser,
      ).toHaveBeenNthCalledWith(1, {
        username: "test-user",
        per_page: 100,
        page: 1,
      });

      expect(
        mockOctokit.rest.activity.listPublicEventsForUser,
      ).toHaveBeenNthCalledWith(2, {
        username: "test-user",
        per_page: 100,
        page: 2,
      });

      expect(
        mockOctokit.rest.activity.listPublicEventsForUser,
      ).toHaveBeenCalledTimes(2);
    });
  });

  describe("Cached Flow - Cache exists and is used", () => {
    beforeEach(() => {
      setupInputs({ "cache-path": ".agentscan-cache" });
      setupContext();
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);
    });

    it("should use fresh cached analysis without making API calls", async () => {
      setupInputs({
        "cache-path": ".agentscan-cache",
        "comment-on-organic": "true",
      });
      // Create cache with 1 day old timestamp (within 2-day TTL)
      require("fs").mkdirSync(".agentscan-cache", { recursive: true });
      require("fs").writeFileSync(
        ".agentscan-cache/test-user.json",
        JSON.stringify(createCacheEntry(1)),
      );

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.users.getByUsername).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.listPublicEventsForUser,
      ).not.toHaveBeenCalled();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Using cached analysis"),
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    });

    it("should invalidate stale cache and make API calls", async () => {
      // Create cache with 10 days old timestamp (beyond 2-day TTL)
      const cacheFile = ".agentscan-cache/test-user.json";
      const oldCacheData = createCacheEntry(10);
      require("fs").mkdirSync(".agentscan-cache", { recursive: true });
      require("fs").writeFileSync(cacheFile, JSON.stringify(oldCacheData));

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Cache expired"),
      );

      // Verify new cache was created with fresh timestamp (overwrites old cache)
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Cached analysis"),
      );

      // Verify new cache has fresh timestamp
      const newCacheData = JSON.parse(
        require("fs").readFileSync(cacheFile, "utf-8"),
      );
      expect(newCacheData.timestamp).toBeGreaterThan(
        (oldCacheData as any).timestamp + 86400000, // At least 1 day newer
      );

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.users.getByUsername).toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.listPublicEventsForUser,
      ).toHaveBeenCalled();
    });

    it("should fallback to API calls if cache read fails", async () => {
      // Create a corrupted cache file (invalid JSON)
      require("fs").mkdirSync(".agentscan-cache", { recursive: true });
      require("fs").writeFileSync(
        ".agentscan-cache/test-user.json",
        "invalid json{",
      );

      await run();

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to read cache"),
      );

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.users.getByUsername).toHaveBeenCalled();
    });
  });

  describe("Allowed-Users Flow - Username in allow list", () => {
    beforeEach(() => {
      setupContext();
    });

    it("should skip analysis for member in allowed-users list", async () => {
      setupInputs({ "allowed-users": "test-user,other-user" });

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipping analysis for test-user"),
      );
      expect(github.getOctokit).not.toHaveBeenCalled();
      expect(identify).not.toHaveBeenCalled();
      expect(core.setOutput).not.toHaveBeenCalled();
    });

    it("should analyze member not in allowed-users list", async () => {
      setupInputs({ "allowed-users": "other-user,another-user" });
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      expect(identify).toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith("username", "test-user");
    });

    it("should parse and skip multiple members from JSON array", async () => {
      setupInputs({ "allowed-users": '["test-user", "skip-this"]' });

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipping analysis for test-user"),
      );
      expect(identify).not.toHaveBeenCalled();
    });
  });

  describe("Known Bots Flow - Username matches a known automation", () => {
    beforeEach(() => {
      setupContext();
    });

    it("should skip analysis when actor is a known bot", async () => {
      Object.defineProperty(github, "context", {
        value: { ...mockContext, actor: "dependabot[bot]" },
        configurable: true,
      });
      setupInputs();

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("known automation"),
      );
      expect(github.getOctokit).not.toHaveBeenCalled();
      expect(identify).not.toHaveBeenCalled();
    });
  });

  describe("Trusted Author Associations Flow", () => {
    it("should skip analysis when author association is trusted", async () => {
      Object.defineProperty(github, "context", {
        value: {
          actor: "test-user",
          payload: {
            pull_request: { number: 123, author_association: "MEMBER" },
          },
          repo: { owner: "test-owner", repo: "test-repo" },
        },
        configurable: true,
      });
      setupInputs({ "trusted-author-associations": "member,owner" });

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("trusted author association"),
      );
      expect(github.getOctokit).not.toHaveBeenCalled();
      expect(identify).not.toHaveBeenCalled();
    });

    it("should analyze when author association is not trusted", async () => {
      Object.defineProperty(github, "context", {
        value: {
          actor: "test-user",
          payload: {
            pull_request: { number: 123, author_association: "NONE" },
          },
          repo: { owner: "test-owner", repo: "test-repo" },
        },
        configurable: true,
      });
      setupInputs({ "trusted-author-associations": "member,owner" });
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      expect(identify).toHaveBeenCalled();
    });
  });

  describe("Scan Gating - Enabling/disabling PR and issue scanning", () => {
    it("should skip analysis when scan-pull-requests is disabled", async () => {
      setupContext();
      setupInputs({ "scan-pull-requests": "false" });

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("pull request scanning is disabled"),
      );
      expect(github.getOctokit).not.toHaveBeenCalled();
      expect(identify).not.toHaveBeenCalled();
    });

    it("should skip issue analysis by default (scan-issues defaults to false)", async () => {
      Object.defineProperty(github, "context", {
        value: {
          actor: "issue-user",
          payload: { issue: { number: 456 } },
          repo: { owner: "test-owner", repo: "test-repo" },
        },
        configurable: true,
      });
      setupInputs();

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("issue scanning is disabled"),
      );
      expect(github.getOctokit).not.toHaveBeenCalled();
      expect(identify).not.toHaveBeenCalled();
    });

    it("should analyze issues when scan-issues is enabled", async () => {
      Object.defineProperty(github, "context", {
        value: {
          actor: "issue-user",
          payload: { issue: { number: 456 } },
          repo: { owner: "test-owner", repo: "test-repo" },
        },
        configurable: true,
      });
      setupInputs({ "scan-issues": "true" });
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      expect(identify).toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith("username", "issue-user");
    });
  });

  describe("Issue Scanning - Triggered by issue events, no PR", () => {
    beforeEach(() => {
      setupInputs({ "scan-issues": "true", "comment-on-organic": "true" });
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);
    });

    it("should scan issue author when triggered by an issue event with no PR", async () => {
      const issueContext = {
        actor: "issue-user",
        payload: { issue: { number: 456 } },
        repo: { owner: "test-owner", repo: "test-repo" },
      };
      Object.defineProperty(github, "context", {
        value: issueContext,
        configurable: true,
      });

      await run();

      expect(github.getOctokit).toHaveBeenCalledWith("test-token");
      expect(identify).toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith("classification", "organic");
      expect(core.setOutput).toHaveBeenCalledWith("username", "issue-user");
    });

    it("should post comment on issue with analysis results", async () => {
      const issueContext = {
        actor: "issue-user",
        payload: { issue: { number: 456 } },
        repo: { owner: "test-owner", repo: "test-repo" },
      };
      Object.defineProperty(github, "context", {
        value: issueContext,
        configurable: true,
      });

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-owner",
          repo: "test-repo",
          issue_number: 456,
        }),
      );
    });

    it("should add labels to the issue when flagged", async () => {
      const issueContext = {
        actor: "flagged-user",
        payload: { issue: { number: 789 } },
        repo: { owner: "test-owner", repo: "test-repo" },
      };
      Object.defineProperty(github, "context", {
        value: issueContext,
        configurable: true,
      });

      vi.mocked(identify).mockReturnValue({
        ...mockAnalysis,
        classification: "automation",
      });

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 789,
        labels: ["agentscan:automated-account"],
      });
    });

    it("should throw error when neither PR nor issue number is found", async () => {
      const noEventContext = {
        actor: "no-number-user",
        payload: {},
        repo: { owner: "test-owner", repo: "test-repo" },
      };
      Object.defineProperty(github, "context", {
        value: noEventContext,
        configurable: true,
      });

      await run();

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("No PR or issue number found"),
      );
    });

    it("should prefer PR number when both PR and issue exist in payload", async () => {
      const bothContext = {
        actor: "both-user",
        payload: {
          pull_request: { number: 123 },
          issue: { number: 456 },
        },
        repo: { owner: "test-owner", repo: "test-repo" },
      };
      Object.defineProperty(github, "context", {
        value: bothContext,
        configurable: true,
      });

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 123,
        }),
      );
    });

    it("should handle allowed-users for issue events", async () => {
      const issueContext = {
        actor: "skip-me",
        payload: { issue: { number: 999 } },
        repo: { owner: "test-owner", repo: "test-repo" },
      };
      Object.defineProperty(github, "context", {
        value: issueContext,
        configurable: true,
      });
      setupInputs({ "scan-issues": "true", "allowed-users": "skip-me" });

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipping analysis for skip-me"),
      );
      expect(github.getOctokit).not.toHaveBeenCalled();
    });
  });

  describe("Comment Idempotency - Reuse existing marked comment", () => {
    beforeEach(() => {
      setupInputs({ "comment-on-organic": "true" });
      setupContext();
      setupCommonMocks();
    });

    it("should create a comment when no existing marked comment is found", async () => {
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 123 }),
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
    });

    it("should update the existing marked comment instead of creating a new one", async () => {
      const mockOctokit = createMockOctokit({
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [{ id: 42, body: "<!-- agentscanapp-bot -->\nold analysis" }],
          }),
        },
      });
      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      await run();

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 42 }),
      );
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  describe("Mode - Controls comment and label posting", () => {
    beforeEach(() => {
      setupContext();
      vi.mocked(identify).mockReturnValue({
        ...mockAnalysis,
        classification: "automation",
      });
      vi.mocked(getClassificationDetails).mockReturnValue({
        label: "Automated Account",
        description: "This account appears to be automated.",
      });
      vi.mocked(core.setOutput).mockImplementation(() => {});
    });

    it("should only add labels in 'labels' mode", async () => {
      setupInputs({ mode: "labels" });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("should only comment in 'comment' mode", async () => {
      setupInputs({ mode: "comment" });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("should skip comment and labels in 'silent' mode but still set outputs", async () => {
      setupInputs({ mode: "silent" });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith(
        "classification",
        "automation",
      );
    });
  });

  describe("Label Assignment - Based on classification", () => {
    beforeEach(() => {
      setupInputs();
      setupContext();
      setupCommonMocks();
    });

    it("should not add labels for organic classification", async () => {
      vi.mocked(identify).mockReturnValue({
        ...mockAnalysis,
        classification: "organic",
      });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("should add mixed-signals label for mixed classification", async () => {
      vi.mocked(identify).mockReturnValue({
        ...mockAnalysis,
        classification: "mixed",
      });
      vi.mocked(getClassificationDetails).mockReturnValue({
        label: "Mixed Signals",
        description: "This account shows mixed signals.",
      });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 123,
        labels: ["agentscan:mixed-signals"],
      });
    });

    it("should add automated-account label for automation classification", async () => {
      vi.mocked(identify).mockReturnValue({
        ...mockAnalysis,
        classification: "automation",
      });
      vi.mocked(getClassificationDetails).mockReturnValue({
        label: "Automated Account",
        description: "This account appears to be automated.",
      });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 123,
        labels: ["agentscan:automated-account"],
      });
    });

    it("should use custom labels for mixed and automation classifications", async () => {
      setupInputs({
        "label-mixed": "needs-review:automation-signals",
        "label-automation": "blocked:automated-account",
      });
      vi.mocked(identify).mockReturnValue({
        ...mockAnalysis,
        classification: "mixed",
      });
      vi.mocked(getClassificationDetails).mockReturnValue({
        label: "Mixed Signals",
        description: "This account shows mixed signals.",
      });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      let mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 123,
        labels: ["needs-review:automation-signals"],
      });

      vi.clearAllMocks();
      setupInputs({
        "label-mixed": "needs-review:automation-signals",
        "label-automation": "blocked:automated-account",
      });
      setupContext();
      setupCommonMocks();
      vi.mocked(identify).mockReturnValue({
        ...mockAnalysis,
        classification: "automation",
      });
      vi.mocked(getClassificationDetails).mockReturnValue({
        label: "Automated Account",
        description: "This account appears to be automated.",
      });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 123,
        labels: ["blocked:automated-account"],
      });
    });

    it("should use custom community-flagged label for flagged accounts", async () => {
      setupInputs({
        "label-community-flagged": "security:community-flagged",
      });
      // Mock verified automation (community-flagged)
      const flaggedAnalysis: IdentifyResult = {
        ...mockAnalysis,
        classification: "organic",
      };

      vi.mocked(identify).mockReturnValue(flaggedAnalysis);
      vi.mocked(github.getOctokit).mockReturnValue(
        createMockOctokit({
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from(
                  JSON.stringify([
                    {
                      username: "test-user",
                      reason: "Verified automation bot",
                      createdAt: "2024-01-01",
                      issueUrl: "https://example.com",
                    },
                  ]),
                ),
              },
            }),
          },
        }) as any,
      );

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 123,
        labels: ["security:community-flagged"],
      });
    });

    it("should add community-flagged label for flagged accounts", async () => {
      // Mock verified automation (community-flagged)
      const flaggedAnalysis: IdentifyResult = {
        ...mockAnalysis,
        classification: "organic",
      };

      vi.mocked(identify).mockReturnValue(flaggedAnalysis);
      vi.mocked(github.getOctokit).mockReturnValue(
        createMockOctokit({
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from(
                  JSON.stringify([
                    {
                      username: "test-user",
                      reason: "Verified automation bot",
                      createdAt: "2024-01-01",
                      issueUrl: "https://example.com",
                    },
                  ]),
                ),
              },
            }),
          },
        }) as any,
      );

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 123,
        labels: ["agentscan:community-flagged"],
      });
    });
  });

  describe("Auto-Close Feature", () => {
    beforeEach(() => {
      setupContext();
      setupCommonMocks();
    });

    it("should not close when auto-close is disabled (default)", async () => {
      setupInputs({ "auto-close": "false" });

      const automationAnalysis: IdentifyResult = {
        ...mockAnalysis,
        classification: "automation",
      };
      vi.mocked(identify).mockReturnValue(automationAnalysis);
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.update).not.toHaveBeenCalled();
    });

    it("should close when auto-close is enabled and classification is automation", async () => {
      setupInputs({
        "auto-close": "true",
        "auto-close-classifications": "automation",
      });

      const automationAnalysis: IdentifyResult = {
        ...mockAnalysis,
        classification: "automation",
      };
      vi.mocked(identify).mockReturnValue(automationAnalysis);

      const mockOctokit = createMockOctokit();
      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      await run();

      expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 123,
        state: "closed",
        state_reason: "not_planned",
      });
    });

    it("should close with comma-separated classifications", async () => {
      setupInputs({
        "auto-close": "true",
        "auto-close-classifications": "automation, mixed",
      });

      const mixedAnalysis: IdentifyResult = {
        ...mockAnalysis,
        classification: "mixed",
      };
      vi.mocked(identify).mockReturnValue(mixedAnalysis);

      const mockOctokit = createMockOctokit();
      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      await run();

      expect(mockOctokit.rest.issues.update).toHaveBeenCalled();
    });

    it("should close with JSON array classifications", async () => {
      setupInputs({
        "auto-close": "true",
        "auto-close-classifications": '["automation", "mixed"]',
      });

      const automationAnalysis: IdentifyResult = {
        ...mockAnalysis,
        classification: "automation",
      };
      vi.mocked(identify).mockReturnValue(automationAnalysis);

      const mockOctokit = createMockOctokit();
      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      await run();

      expect(mockOctokit.rest.issues.update).toHaveBeenCalled();
    });

    it("should not close when classification doesn't match auto-close list", async () => {
      setupInputs({
        "auto-close": "true",
        "auto-close-classifications": "automation",
      });

      const mixedAnalysis: IdentifyResult = {
        ...mockAnalysis,
        classification: "mixed",
      };
      vi.mocked(identify).mockReturnValue(mixedAnalysis);

      const mockOctokit = createMockOctokit();
      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      await run();

      expect(mockOctokit.rest.issues.update).not.toHaveBeenCalled();
    });

    it("should close community-flagged accounts when auto-close is enabled", async () => {
      setupInputs({
        "auto-close": "true",
        "auto-close-classifications": "automation",
      });

      const mockOctokit = createMockOctokit({
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: {
              content: Buffer.from(
                JSON.stringify([
                  {
                    username: "test-user",
                    reason: "Verified automation",
                    createdAt: "2024-01-01",
                    issueUrl: "https://example.com",
                  },
                ]),
              ),
            },
          }),
        },
      });
      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      await run();

      expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 123,
        state: "closed",
        state_reason: "not_planned",
      });
    });
  });
});
