import type { IdentifyReplicantResult } from "voight-kampff-test";
import { rmSync } from "fs";

vi.mock("@actions/core");
vi.mock("@actions/github");
vi.mock("voight-kampff-test");

import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  identifyReplicant,
  getClassificationDetails,
} from "voight-kampff-test";
import { run } from "./index";

describe("AgentScan Action", () => {
  // Shared test data
  const mockContext = {
    actor: "test-user",
    payload: { pull_request: { number: 123 } },
    repo: { owner: "test-owner", repo: "test-repo" },
  };

  const mockAnalysis: IdentifyReplicantResult = {
    classification: "organic",
    score: 20,
    flags: [{ label: "Test Flag", points: 10, detail: "This is a test flag" }],
    profile: { age: 365, repos: 0 },
  };

  // Helper functions to reduce boilerplate
  const setupInputs = (overrides: Record<string, string> = {}) => {
    const defaults: Record<string, string> = {
      "github-token": "test-token",
      "skip-members": "",
      cache: "false",
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
        createComment: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
      },
    };

    return {
      rest: {
        ...defaultApis,
        ...Object.keys(overrides).reduce(
          (acc, key) => ({
            ...acc,
            [key]: {
              ...defaultApis[key as keyof typeof defaultApis],
              ...overrides[key],
            },
          }),
          defaultApis,
        ),
      },
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
    vi.mocked(identifyReplicant).mockReturnValue(mockAnalysis);
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
      setupInputs();
      setupContext();
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);
    });

    it("should fetch user data and analyze", async () => {
      await run();

      expect(github.getOctokit).toHaveBeenCalledWith("test-token");
      expect(identifyReplicant).toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith("classification", "organic");
      expect(core.setOutput).toHaveBeenCalledWith("username", "test-user");

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    });

    it("should save analysis to cache when cache is enabled", async () => {
      setupInputs({ cache: "true" });

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
  });

  describe("Cached Flow - Cache exists and is used", () => {
    beforeEach(() => {
      setupInputs({ cache: "true" });
      setupContext();
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);
    });

    it("should use fresh cached analysis without making API calls", async () => {
      // Create cache with 1 day old timestamp (within 7-day TTL)
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
      // Create cache with 10 days old timestamp (beyond 7-day TTL)
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

  describe("Skip-Member Flow - Username in skip list", () => {
    beforeEach(() => {
      setupContext();
    });

    it("should skip analysis for member in skip list", async () => {
      setupInputs({ "skip-members": "test-user,other-user" });

      await run();

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipping analysis for test-user"),
      );
      expect(github.getOctokit).not.toHaveBeenCalled();
      expect(identifyReplicant).not.toHaveBeenCalled();
      expect(core.setOutput).not.toHaveBeenCalled();
    });

    it("should analyze member not in skip list", async () => {
      setupInputs({ "skip-members": "other-user,another-user" });
      setupCommonMocks();
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      expect(identifyReplicant).toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith("username", "test-user");
    });
  });

  describe("Label Assignment - Based on classification", () => {
    beforeEach(() => {
      setupInputs();
      setupContext();
      setupCommonMocks();
    });

    it("should not add labels for organic classification", async () => {
      vi.mocked(identifyReplicant).mockReturnValue({
        ...mockAnalysis,
        classification: "organic",
      });
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);

      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("should add mixed-signals label for mixed classification", async () => {
      vi.mocked(identifyReplicant).mockReturnValue({
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
      vi.mocked(identifyReplicant).mockReturnValue({
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

    it("should add community-flagged label for flagged accounts", async () => {
      // Mock verified automation (community-flagged)
      const flaggedAnalysis: IdentifyReplicantResult = {
        ...mockAnalysis,
        classification: "organic",
      };

      vi.mocked(identifyReplicant).mockReturnValue(flaggedAnalysis);
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
});
