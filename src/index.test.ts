import { describe, it, expect, vi, beforeEach } from "vitest";
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
  const mockContext = {
    actor: "test-user",
    payload: {
      pull_request: {
        number: 123,
      },
    },
    repo: {
      owner: "test-owner",
      repo: "test-repo",
    },
  };

  const mockAnalysis: IdentifyReplicantResult = {
    classification: "organic",
    score: 20,
    flags: [
      {
        label: "Test Flag",
        points: 10,
        detail: "This is a test flag",
      },
    ],
    profile: {
      age: 365,
      repos: 0,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Normal Flow - No cache, no skip", () => {
    beforeEach(() => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        if (name === "github-token") return "test-token";
        if (name === "skip-members") return "";
        if (name === "cache-dir") return "";
        return "";
      });

      Object.defineProperty(github, "context", {
        value: mockContext,
        configurable: true,
      });

      vi.mocked(fs.existsSync).mockReturnValue(false);

      const mockOctokit = {
        rest: {
          users: {
            getByUsername: vi.fn().mockResolvedValue({
              data: {
                public_repos: 10,
                created_at: "2020-01-01T00:00:00Z",
              },
            }),
          },
          activity: {
            listPublicEventsForUser: vi.fn().mockResolvedValue({
              data: [
                {
                  type: "PushEvent",
                  created_at: new Date(),
                },
              ],
            }),
          },
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from(JSON.stringify([])).toString("base64"),
              },
            }),
          },
          issues: {
            createComment: vi.fn().mockResolvedValue({}),
            addLabels: vi.fn().mockResolvedValue({}),
          },
        },
      };

      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      vi.mocked(identifyReplicant).mockReturnValue(mockAnalysis);
      vi.mocked(getClassificationDetails).mockReturnValue({
        label: "Organic Account",
        description: "This account appears to be organic.",
      });

      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      vi.mocked(fs.mkdirSync).mockImplementation(() => "");

      vi.mocked(path.join).mockImplementation((...args: any[]) =>
        args.join("/"),
      );
    });

    it("should fetch user data and analyze", async () => {
      const outputs: Record<string, string> = {};
      vi.mocked(core.setOutput).mockImplementation(
        (key: string, value: any) => {
          outputs[key] = String(value);
        },
      );

      await run();

      // Verify data was fetched
      expect(github.getOctokit).toHaveBeenCalledWith("test-token");

      // Verify analysis was performed
      expect(identifyReplicant).toHaveBeenCalled();

      // Verify outputs
      expect(core.setOutput).toHaveBeenCalledWith("classification", "organic");
      expect(core.setOutput).toHaveBeenCalledWith("community-flagged", "false");
      expect(core.setOutput).toHaveBeenCalledWith("username", "test-user");

      // Verify comment was posted
      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    });

    it("should save analysis to cache when cache-dir is provided", async () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        if (name === "github-token") return "test-token";
        if (name === "skip-members") return "";
        if (name === "cache-dir") return ".cache";
        return "";
      });

      vi.mocked(core.setOutput).mockImplementation(() => {});

      await run();

      // Verify cache was saved
      expect(fs.writeFileSync).toHaveBeenCalled();
      const cacheCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(cacheCall[0]).toContain("test-user.json");

      // Verify cache contains analysis
      const cacheData = JSON.parse(String(cacheCall[1]));
      expect(cacheData).toHaveProperty("analysis");
      expect(cacheData).toHaveProperty("hasCommunityFlag");
      expect(cacheData).toHaveProperty("isFlagged");
    });
  });

  describe("Cached Flow - Cache exists and is used", () => {
    beforeEach(() => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        if (name === "github-token") return "test-token";
        if (name === "skip-members") return "";
        if (name === "cache-dir") return ".cache";
        return "";
      });

      Object.defineProperty(github, "context", {
        value: mockContext,
        configurable: true,
      });

      // Cache file exists
      vi.mocked(fs.existsSync).mockReturnValue(true);

      // Return cached analysis
      const cachedData = {
        analysis: mockAnalysis,
        hasCommunityFlag: false,
        isFlagged: false,
      };

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cachedData));

      const mockOctokit = {
        rest: {
          users: {
            getByUsername: vi.fn(),
          },
          activity: {
            listPublicEventsForUser: vi.fn(),
          },
          repos: {
            getContent: vi.fn(),
          },
          issues: {
            createComment: vi.fn().mockResolvedValue({}),
            addLabels: vi.fn().mockResolvedValue({}),
          },
        },
      };

      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      vi.mocked(getClassificationDetails).mockReturnValue({
        label: "Organic Account",
        description: "This account appears to be organic.",
      });

      vi.mocked(path.join).mockImplementation((...args: any[]) =>
        args.join("/"),
      );
    });

    it("should use cached analysis without making API calls", async () => {
      vi.mocked(core.setOutput).mockImplementation(() => {});

      await run();

      // Verify API calls were NOT made
      const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
      expect(mockOctokit.rest.users.getByUsername).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.activity.listPublicEventsForUser,
      ).not.toHaveBeenCalled();

      // Verify cache was read
      expect(fs.readFileSync).toHaveBeenCalled();

      // Verify cache was logged
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Using cached analysis"),
      );

      // Verify outputs were set correctly
      expect(core.setOutput).toHaveBeenCalledWith("classification", "organic");

      // Verify comment was still posted with cached data
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    });

    it("should fallback to API calls if cache read fails", async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("Cache read failed");
      });

      const mockOctokit = {
        rest: {
          users: {
            getByUsername: vi.fn().mockResolvedValue({
              data: {
                public_repos: 10,
                created_at: "2020-01-01T00:00:00Z",
              },
            }),
          },
          activity: {
            listPublicEventsForUser: vi.fn().mockResolvedValue({
              data: [],
            }),
          },
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from(JSON.stringify([])).toString("base64"),
              },
            }),
          },
          issues: {
            createComment: vi.fn().mockResolvedValue({}),
            addLabels: vi.fn().mockResolvedValue({}),
          },
        },
      };

      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      vi.mocked(identifyReplicant).mockReturnValue(mockAnalysis);

      vi.mocked(core.setOutput).mockImplementation(() => {});

      await run();

      // Verify warning was logged
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to read cache"),
      );

      // Verify API calls were made as fallback
      expect(mockOctokit.rest.users.getByUsername).toHaveBeenCalled();
    });
  });

  describe("Skip-Member Flow - Username in skip list", () => {
    beforeEach(() => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        if (name === "github-token") return "test-token";
        if (name === "skip-members") return "test-user,other-user";
        if (name === "cache-dir") return "";
        return "";
      });

      Object.defineProperty(github, "context", {
        value: mockContext,
        configurable: true,
      });
    });

    it("should skip analysis for member in skip list", async () => {
      vi.mocked(core.setOutput).mockImplementation(() => {});

      await run();

      // Verify skip was logged
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipping analysis for test-user"),
      );

      // Verify no API calls were made
      expect(github.getOctokit).not.toHaveBeenCalled();

      // Verify no analysis was performed
      expect(identifyReplicant).not.toHaveBeenCalled();

      // Verify no outputs were set
      expect(core.setOutput).not.toHaveBeenCalled();
    });

    it("should analyze member not in skip list", async () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        if (name === "github-token") return "test-token";
        if (name === "skip-members") return "other-user,another-user";
        if (name === "cache-dir") return "";
        return "";
      });

      vi.mocked(fs.existsSync).mockReturnValue(false);

      const mockOctokit = {
        rest: {
          users: {
            getByUsername: vi.fn().mockResolvedValue({
              data: {
                public_repos: 10,
                created_at: "2020-01-01T00:00:00Z",
              },
            }),
          },
          activity: {
            listPublicEventsForUser: vi.fn().mockResolvedValue({
              data: [],
            }),
          },
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from(JSON.stringify([])).toString("base64"),
              },
            }),
          },
          issues: {
            createComment: vi.fn().mockResolvedValue({}),
            addLabels: vi.fn().mockResolvedValue({}),
          },
        },
      };

      vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any);

      vi.mocked(identifyReplicant).mockReturnValue(mockAnalysis);
      vi.mocked(getClassificationDetails).mockReturnValue({
        label: "Organic Account",
        description: "This account appears to be organic.",
      });

      vi.mocked(path.join).mockImplementation((...args: any[]) =>
        args.join("/"),
      );

      vi.mocked(core.setOutput).mockImplementation(() => {});

      await run();

      // Verify analysis was performed
      expect(identifyReplicant).toHaveBeenCalled();

      // Verify outputs were set
      expect(core.setOutput).toHaveBeenCalledWith("username", "test-user");
    });
  });
});
