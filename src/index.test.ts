import type { IdentifyReplicantResult } from "voight-kampff-test";

// Mock modules before importing the main module
vi.mock("@actions/core");
vi.mock("@actions/github");
vi.mock("fs");
vi.mock("path");
vi.mock("voight-kampff-test");

import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
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
      "cache-dir": "",
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

  const setupCommonMocks = () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");
    vi.mocked(path.join).mockImplementation((...args: any[]) => args.join("/"));
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

    it("should save analysis to cache when cache-dir is provided", async () => {
      setupInputs({ "cache-dir": ".cache" });

      await run();

      expect(fs.writeFileSync).toHaveBeenCalled();
      const cacheCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(cacheCall[0]).toContain("test-user.json");

      const cacheData = JSON.parse(String(cacheCall[1]));
      expect(cacheData).toHaveProperty("analysis");
      expect(cacheData).toHaveProperty("hasCommunityFlag");
      expect(cacheData).toHaveProperty("isFlagged");
    });
  });

  describe("Cached Flow - Cache exists and is used", () => {
    beforeEach(() => {
      setupInputs({ "cache-dir": ".cache" });
      setupContext();
      setupCommonMocks();

      vi.mocked(fs.existsSync).mockReturnValue(true);
      const cachedData = {
        analysis: mockAnalysis,
        hasCommunityFlag: false,
        isFlagged: false,
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cachedData));
      vi.mocked(github.getOctokit).mockReturnValue(createMockOctokit() as any);
    });

    it("should use cached analysis without making API calls", async () => {
      await run();

      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.users.getByUsername).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.listPublicEventsForUser,
      ).not.toHaveBeenCalled();

      expect(fs.readFileSync).toHaveBeenCalled();
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Using cached analysis"),
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    });

    it("should fallback to API calls if cache read fails", async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("Cache read failed");
      });

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
});
