import fs, { rmSync } from "node:fs";
import type { IdentifyResult } from "@unveil/identity";
import type { Mock } from "vitest";

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
		flags: [
			{
				label: "Test Flag",
				group: "pr-volume",
				points: 10,
				detail: "This is a test flag",
				data: [],
				events: [],
			},
		],
		profile: { age: 365, repos: 0 },
		isBountyHunter: false,
		confidence: 0.9,
		groups: [{ group: "pr-volume", flagCount: 1, rawPoints: 10, points: 10 }],
		window: {
			eventCount: 1,
			spanDays: 1,
			firstEventAt: "2024-01-01T00:00:00Z",
			lastEventAt: "2024-01-02T00:00:00Z",
			saturated: false,
		},
		timezone: { offsetHours: 0, confidence: 0.5 },
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
			honeypot: "false",
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

	type MockApis = {
		users: { getByUsername: Mock };
		activity: { listPublicEventsForUser: Mock };
		repos: { getContent: Mock };
		issues: {
			listComments: Mock;
			createComment: Mock;
			updateComment: Mock;
			addLabels: Mock;
			update: Mock;
		};
	};

	const createMockOctokit = (
		overrides: { [K in keyof MockApis]?: Partial<MockApis[K]> } = {},
	) => {
		const defaultApis: MockApis = {
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
			...Object.fromEntries(
				(Object.keys(overrides) as Array<keyof MockApis>).map((key) => [
					key,
					{ ...defaultApis[key], ...overrides[key] },
				]),
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

	const mockGetOctokit = (
		overrides?: { [K in keyof MockApis]?: Partial<MockApis[K]> },
	) => {
		const mockOctokit = createMockOctokit(overrides);
		vi.mocked(github.getOctokit).mockReturnValue(
			mockOctokit as unknown as ReturnType<typeof github.getOctokit>,
		);
		return mockOctokit;
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
			mockGetOctokit();
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
			const cacheData = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
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
			mockGetOctokit();
		});

		it("should use fresh cached analysis without making API calls", async () => {
			setupInputs({
				"cache-path": ".agentscan-cache",
				"comment-on-organic": "true",
			});
			// Create cache with 1 day old timestamp (within 2-day TTL)
			fs.mkdirSync(".agentscan-cache", { recursive: true });
			fs.writeFileSync(
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
			fs.mkdirSync(".agentscan-cache", { recursive: true });
			fs.writeFileSync(cacheFile, JSON.stringify(oldCacheData));

			await run();

			expect(core.info).toHaveBeenCalledWith(
				expect.stringContaining("Cache expired"),
			);

			// Verify new cache was created with fresh timestamp (overwrites old cache)
			expect(core.info).toHaveBeenCalledWith(
				expect.stringContaining("Cached analysis"),
			);

			// Verify new cache has fresh timestamp
			const newCacheData = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
			expect(newCacheData.timestamp).toBeGreaterThan(
				(oldCacheData as { timestamp: number }).timestamp + 86400000, // At least 1 day newer
			);

			const mockOctokit = vi.mocked(github.getOctokit).mock.results[0].value;
			expect(mockOctokit.rest.users.getByUsername).toHaveBeenCalled();
			expect(
				mockOctokit.rest.activity.listPublicEventsForUser,
			).toHaveBeenCalled();
		});

		it("should fallback to API calls if cache read fails", async () => {
			// Create a corrupted cache file (invalid JSON)
			fs.mkdirSync(".agentscan-cache", { recursive: true });
			fs.writeFileSync(".agentscan-cache/test-user.json", "invalid json{");

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
			mockGetOctokit();

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
			mockGetOctokit();

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
			mockGetOctokit();

			await run();

			expect(identify).toHaveBeenCalled();
			expect(core.setOutput).toHaveBeenCalledWith("username", "issue-user");
		});
	});

	describe("Issue Scanning - Triggered by issue events, no PR", () => {
		beforeEach(() => {
			setupInputs({ "scan-issues": "true", "comment-on-organic": "true" });
			setupCommonMocks();
			mockGetOctokit();
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
			const mockOctokit = mockGetOctokit();

			await run();

			expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith(
				expect.objectContaining({ issue_number: 123 }),
			);
			expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
			expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
		});

		it("should update the existing marked comment instead of creating a new one", async () => {
			const mockOctokit = mockGetOctokit({
				issues: {
					listComments: vi.fn().mockResolvedValue({
						data: [{ id: 42, body: "<!-- agentscanapp-bot -->\nold analysis" }],
					}),
				},
			});

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
			const mockOctokit = mockGetOctokit();

			await run();

			expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalled();
			expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
		});

		it("should only comment in 'comment' mode", async () => {
			setupInputs({ mode: "comment" });
			const mockOctokit = mockGetOctokit();

			await run();

			expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
			expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
		});

		it("should skip comment and labels in 'silent' mode but still set outputs", async () => {
			setupInputs({ mode: "silent" });
			const mockOctokit = mockGetOctokit();

			await run();

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
			const mockOctokit = mockGetOctokit();

			await run();

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
			const mockOctokit = mockGetOctokit();

			await run();

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
			const mockOctokit = mockGetOctokit();

			await run();

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
			let mockOctokit = mockGetOctokit();

			await run();

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
			mockOctokit = mockGetOctokit();

			await run();

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
			const mockOctokit = mockGetOctokit({
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
			});

			await run();

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
			const mockOctokit = mockGetOctokit({
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
			});

			await run();

			expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
				owner: "test-owner",
				repo: "test-repo",
				issue_number: 123,
				labels: ["agentscan:community-flagged"],
			});
		});
	});

	describe("Report Issue Link - Pre-filled evidence for automation classification", () => {
		beforeEach(() => {
			setupInputs();
			setupContext();
			setupCommonMocks();
		});

		const getPostedCommentBody = (
			mockOctokit: ReturnType<typeof createMockOctokit>,
		) => {
			const call =
				mockOctokit.rest.issues.createComment.mock.calls[0]?.[0] ??
				mockOctokit.rest.issues.updateComment.mock.calls[0]?.[0];
			return call.body as string;
		};

		it("includes a pre-filled report link for automation classification", async () => {
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Automated Account",
				description: "This account appears to be automated.",
			});
			const mockOctokit = mockGetOctokit();

			await run();
			const body = getPostedCommentBody(mockOctokit);

			expect(body).toContain(
				"https://github.com/matteogabriele/agentscan/issues/new",
			);
			expect(body).toContain("template=report-automated-account.yml");
			expect(body).toContain("username=test-user");
		});

		it("does not include a report link for organic classification", async () => {
			setupInputs({ "comment-on-organic": "true" });
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "organic",
			});
			const mockOctokit = mockGetOctokit();

			await run();
			const body = getPostedCommentBody(mockOctokit);

			expect(body).not.toContain("issues/new");
		});

		it("does not include a report link for mixed classification", async () => {
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "mixed",
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Mixed Signals",
				description: "This account shows mixed signals.",
			});
			const mockOctokit = mockGetOctokit();

			await run();
			const body = getPostedCommentBody(mockOctokit);

			expect(body).not.toContain("issues/new");
		});

		it("does not include a report link for already community-flagged accounts", async () => {
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Automated Account",
				description: "This account appears to be automated.",
			});
			const mockOctokit = mockGetOctokit({
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
			});

			await run();

			const body = getPostedCommentBody(mockOctokit);

			expect(body).not.toContain("issues/new");
		});

		it("includes the PR url as evidence, rewritten to avoid a github.com backlink on the flagged PR", async () => {
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Automated Account",
				description: "This account appears to be automated.",
			});
			Object.defineProperty(github, "context", {
				value: {
					...mockContext,
					payload: {
						pull_request: {
							number: 123,
							html_url: "https://github.com/test-owner/test-repo/pull/123",
						},
					},
				},
				configurable: true,
			});
			const mockOctokit = mockGetOctokit();

			await run();
			const body = getPostedCommentBody(mockOctokit);
			const [, query] =
				body.match(/\((https:\/\/github\.com\/matteogabriele[^)]+)\)/) ?? [];
			const url = new URL(query ?? "");

			const evidence = url.searchParams.get("evidence") ?? "";
			expect(evidence).not.toContain("https://github.com/");
			expect(evidence).toContain(
				"https://redirect.github.com/test-owner/test-repo/pull/123",
			);
		});
	});

	describe("Inline Evidence - Rendered directly in the comment", () => {
		beforeEach(() => {
			setupInputs();
			setupContext();
			setupCommonMocks();
		});

		const getPostedCommentBody = (
			mockOctokit: ReturnType<typeof createMockOctokit>,
		) => {
			const call =
				mockOctokit.rest.issues.createComment.mock.calls[0]?.[0] ??
				mockOctokit.rest.issues.updateComment.mock.calls[0]?.[0];
			return call.body as string;
		};

		it("renders a collapsible evidence section in the comment when flags are present", async () => {
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Automated Account",
				description: "This account appears to be automated.",
			});
			const mockOctokit = mockGetOctokit();

			await run();
			const body = getPostedCommentBody(mockOctokit);

			expect(body).toContain("<details>");
			expect(body).toContain("<summary>Evidence</summary>");
			expect(body).toContain("Test Flag: This is a test flag");
			expect(body).toContain("</details>");
		});

		it("does not point the inline evidence's source link back at itself", async () => {
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Automated Account",
				description: "This account appears to be automated.",
			});
			const mockOctokit = mockGetOctokit();

			await run();
			const body = getPostedCommentBody(mockOctokit);
			const detailsSection = body.split("<details>")[1] ?? "";

			expect(detailsSection).not.toContain("Flagged in:");
		});

		it("omits the evidence section entirely when there are no flags", async () => {
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "organic",
				flags: [],
			});
			const mockOctokit = mockGetOctokit();
			setupInputs({ "comment-on-organic": "true" });

			await run();

			const body = getPostedCommentBody(mockOctokit);

			expect(body).not.toContain("<details>");
			expect(body).not.toContain("Evidence");
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
			const mockOctokit = mockGetOctokit();

			await run();

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

			const mockOctokit = mockGetOctokit();

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

			const mockOctokit = mockGetOctokit();

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

			const mockOctokit = mockGetOctokit();

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

			const mockOctokit = mockGetOctokit();

			await run();

			expect(mockOctokit.rest.issues.update).not.toHaveBeenCalled();
		});

		it("should close community-flagged accounts when auto-close is enabled", async () => {
			setupInputs({
				"auto-close": "true",
				"auto-close-classifications": "automation",
			});

			const mockOctokit = mockGetOctokit({
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

	describe("Outputs - What downstream steps read", () => {
		beforeEach(() => {
			setupInputs();
			setupContext();
			setupCommonMocks();
			mockGetOctokit();
		});

		it("reports the full analysis result for a flagged account", async () => {
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
				score: 82,
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Automated Account",
				description: "This account appears to be automated.",
			});

			await run();

			expect(core.setOutput).toHaveBeenCalledWith("flagged", "true");
			expect(core.setOutput).toHaveBeenCalledWith(
				"classification",
				"automation",
			);
			expect(core.setOutput).toHaveBeenCalledWith("score", 82);
			expect(core.setOutput).toHaveBeenCalledWith("community-flagged", "false");
			expect(core.setOutput).toHaveBeenCalledWith("account-age", 365);
			expect(core.setOutput).toHaveBeenCalledWith(
				"flags",
				JSON.stringify(mockAnalysis.flags),
			);
		});

		it("reports flagged for a community-flagged account even when the analysis is organic", async () => {
			mockGetOctokit({
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

			await run();

			expect(core.setOutput).toHaveBeenCalledWith("flagged", "true");
			expect(core.setOutput).toHaveBeenCalledWith("community-flagged", "true");
			expect(core.setOutput).toHaveBeenCalledWith("classification", "organic");
		});

		it("reports not flagged for an organic account", async () => {
			await run();

			expect(core.setOutput).toHaveBeenCalledWith("flagged", "false");
			expect(core.setOutput).toHaveBeenCalledWith("community-flagged", "false");
		});
	});

	describe("Custom Messages - Replacing the default description", () => {
		beforeEach(() => {
			setupContext();
			setupCommonMocks();
		});

		const getPostedCommentBody = (
			mockOctokit: ReturnType<typeof createMockOctokit>,
		) => {
			const call =
				mockOctokit.rest.issues.createComment.mock.calls[0]?.[0] ??
				mockOctokit.rest.issues.updateComment.mock.calls[0]?.[0];
			return call.body as string;
		};

		it("uses the classification's custom message instead of the default", async () => {
			setupInputs({ "message-automation": "Bots are not welcome here." });
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Automated Account",
				description: "This account appears to be automated.",
			});
			const mockOctokit = mockGetOctokit();

			await run();

			const body = getPostedCommentBody(mockOctokit);
			expect(body).toContain("Bots are not welcome here.");
			expect(body).not.toContain("This account appears to be automated.");
		});

		it("prefers the community-flagged message over the classification one when both apply", async () => {
			setupInputs({
				"message-automation": "Classification message.",
				"message-community-flagged": "The community flagged this account.",
			});
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
			});
			const mockOctokit = mockGetOctokit({
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

			await run();

			const body = getPostedCommentBody(mockOctokit);
			expect(body).toContain("The community flagged this account.");
			expect(body).not.toContain("Classification message.");
		});
	});

	describe("Mode Parsing - Invalid input", () => {
		it("warns and falls back to 'full' for an unrecognised mode", async () => {
			setupInputs({ mode: "loud", "comment-on-organic": "true" });
			setupContext();
			setupCommonMocks();
			const mockOctokit = mockGetOctokit();

			await run();

			expect(core.warning).toHaveBeenCalledWith(
				expect.stringContaining('Invalid mode "loud"'),
			);
			expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
		});
	});

	describe("Missing Permissions - Degrade instead of failing the workflow", () => {
		beforeEach(() => {
			setupInputs({ "auto-close": "true" });
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
		});

		it("warns instead of failing when the comment cannot be posted", async () => {
			mockGetOctokit({
				issues: {
					createComment: vi
						.fn()
						.mockRejectedValue(
							new Error("Resource not accessible by integration"),
						),
				},
			});

			await run();

			expect(core.warning).toHaveBeenCalledWith(
				expect.stringContaining("Could not post comment"),
			);
			expect(core.setFailed).not.toHaveBeenCalled();
		});

		it("warns instead of failing when the PR cannot be closed", async () => {
			mockGetOctokit({
				issues: {
					update: vi
						.fn()
						.mockRejectedValue(
							new Error("Resource not accessible by integration"),
						),
				},
			});

			await run();

			expect(core.warning).toHaveBeenCalledWith(
				expect.stringContaining("Could not close"),
			);
			expect(core.setFailed).not.toHaveBeenCalled();
		});

		it("fails the workflow for an error that is not a permission problem", async () => {
			mockGetOctokit({
				issues: {
					createComment: vi.fn().mockRejectedValue(new Error("API is down")),
				},
			});

			await run();

			expect(core.setFailed).toHaveBeenCalledWith("API is down");
		});
	});

	describe("Insufficient Data - Not a classification to act on", () => {
		it("adds no label when there is not enough activity to classify", async () => {
			setupInputs({ "comment-on-organic": "true" });
			setupContext();
			setupCommonMocks();
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "insufficient-data",
				score: -1,
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Not enough data",
				description:
					"There is not enough public activity to classify this account.",
			});
			const mockOctokit = mockGetOctokit();

			await run();

			expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
		});
	});

	describe("Honeypot - Posting the bait", () => {
		const botComment = (body: string) => ({
			id: 1,
			body,
			user: { type: "Bot" },
		});

		const getBaitBody = (mockOctokit: ReturnType<typeof createMockOctokit>) => {
			const bodies = mockOctokit.rest.issues.createComment.mock.calls.map(
				(call) => (call[0] as { body: string }).body,
			);
			return bodies.find((body) => body.includes("agentscanapp-ref:"));
		};

		beforeEach(() => {
			setupContext();
			setupCommonMocks();
		});

		it("does not post bait when the honeypot is disabled", async () => {
			setupInputs({ honeypot: "false" });
			const mockOctokit = mockGetOctokit();

			await run();

			expect(getBaitBody(mockOctokit)).toBeUndefined();
		});

		it("posts bait on an organic PR, even though the analysis comment is skipped", async () => {
			setupInputs({ honeypot: "true", "comment-on-organic": "false" });
			const mockOctokit = mockGetOctokit();

			await run();

			const bait = getBaitBody(mockOctokit);
			expect(bait).toMatch(/<!-- agentscanapp-ref:[0-9a-f]{12} -->/);
			expect(bait).toContain("@test-user");
		});

		it("posts bait in silent mode, because the bait is not a finding", async () => {
			setupInputs({ honeypot: "true", mode: "silent" });
			const mockOctokit = mockGetOctokit();

			await run();

			expect(getBaitBody(mockOctokit)).toBeDefined();
		});

		it("does not post a second bait when the thread already has one", async () => {
			setupInputs({ honeypot: "true" });
			const mockOctokit = mockGetOctokit({
				issues: {
					listComments: vi.fn().mockResolvedValue({
						data: [
							botComment("<!-- agentscanapp-ref:a1b2c3d4e5f6 -->\nHello!"),
						],
					}),
				},
			});

			await run();

			expect(getBaitBody(mockOctokit)).toBeUndefined();
		});

		it("ignores a token marker planted by a human, and still posts its own bait", async () => {
			setupInputs({ honeypot: "true" });
			const mockOctokit = mockGetOctokit({
				issues: {
					listComments: vi.fn().mockResolvedValue({
						data: [
							{
								id: 1,
								body: "<!-- agentscanapp-ref:a1b2c3d4e5f6 -->",
								user: { type: "User" },
							},
						],
					}),
				},
			});

			await run();

			expect(getBaitBody(mockOctokit)).toBeDefined();
		});

		it("does not post bait when the PR is being auto-closed anyway", async () => {
			setupInputs({ honeypot: "true", "auto-close": "true" });
			vi.mocked(identify).mockReturnValue({
				...mockAnalysis,
				classification: "automation",
			});
			vi.mocked(getClassificationDetails).mockReturnValue({
				label: "Automated Account",
				description: "This account appears to be automated.",
			});
			const mockOctokit = mockGetOctokit();

			await run();

			expect(getBaitBody(mockOctokit)).toBeUndefined();
			expect(mockOctokit.rest.issues.update).toHaveBeenCalled();
		});

		it("uses the custom greeting and its placeholders", async () => {
			setupInputs({
				honeypot: "true",
				"message-honeypot": "Welcome {username}, nice {type}!",
			});
			const mockOctokit = mockGetOctokit();

			await run();

			expect(getBaitBody(mockOctokit)).toContain(
				"Welcome test-user, nice pull request!",
			);
		});

		it("uses the first-time greeting for a first-time contributor", async () => {
			Object.defineProperty(github, "context", {
				value: {
					...mockContext,
					payload: {
						pull_request: {
							number: 123,
							user: { login: "test-user" },
							author_association: "FIRST_TIME_CONTRIBUTOR",
						},
					},
				},
				configurable: true,
			});
			setupInputs({
				honeypot: "true",
				"message-honeypot": "Regular greeting.",
				"message-honeypot-first-time": "Welcome aboard, {username}!",
			});
			const mockOctokit = mockGetOctokit();

			await run();

			expect(getBaitBody(mockOctokit)).toContain("Welcome aboard, test-user!");
		});

		it("falls back to the regular greeting when no first-time one is set", async () => {
			Object.defineProperty(github, "context", {
				value: {
					...mockContext,
					payload: {
						pull_request: {
							number: 123,
							user: { login: "test-user" },
							author_association: "FIRST_TIMER",
						},
					},
				},
				configurable: true,
			});
			setupInputs({
				honeypot: "true",
				"message-honeypot": "Regular greeting.",
			});
			const mockOctokit = mockGetOctokit();

			await run();

			expect(getBaitBody(mockOctokit)).toContain("Regular greeting.");
		});

		it("warns instead of failing when the bait cannot be posted", async () => {
			setupInputs({ honeypot: "true", "comment-on-organic": "false" });
			mockGetOctokit({
				issues: {
					createComment: vi
						.fn()
						.mockRejectedValue(
							new Error("Resource not accessible by integration"),
						),
				},
			});

			await run();

			expect(core.warning).toHaveBeenCalledWith(
				expect.stringContaining("Could not post the honeypot comment"),
			);
			expect(core.setFailed).not.toHaveBeenCalled();
		});
	});

	describe("Honeypot - Reacting to the reply", () => {
		const BAIT_TOKEN = "a1b2c3d4e5f6";

		const commentContext = (
			overrides: {
				commentAuthor?: string;
				commentBody?: string;
				isPR?: boolean;
			} = {},
		) => {
			const {
				commentAuthor = "test-user",
				commentBody = BAIT_TOKEN,
				isPR = true,
			} = overrides;

			return {
				actor: commentAuthor,
				payload: {
					issue: {
						number: 123,
						user: { login: "test-user" },
						...(isPR
							? { pull_request: { url: "https://api.github.com" } }
							: {}),
					},
					comment: { id: 9, body: commentBody, user: { login: commentAuthor } },
				},
				repo: { owner: "test-owner", repo: "test-repo" },
			};
		};

		const setupCommentEvent = (
			overrides?: Parameters<typeof commentContext>[0],
		) => {
			Object.defineProperty(github, "context", {
				value: commentContext(overrides),
				configurable: true,
			});
		};

		const withBait = (extra: Array<Record<string, unknown>> = []) => ({
			issues: {
				listComments: vi.fn().mockResolvedValue({
					data: [
						{
							id: 1,
							body: `<!-- agentscanapp-ref:${BAIT_TOKEN} -->\nThanks for opening this!`,
							user: { type: "Bot" },
						},
						...extra,
					],
				}),
			},
		});

		beforeEach(() => {
			setupCommonMocks();
		});

		it("does nothing when the honeypot is disabled", async () => {
			setupInputs({ honeypot: "false" });
			setupCommentEvent();

			await run();

			expect(github.getOctokit).not.toHaveBeenCalled();
			expect(identify).not.toHaveBeenCalled();
		});

		it("never runs the activity analysis on a comment event", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent();
			mockGetOctokit(withBait());

			await run();

			expect(identify).not.toHaveBeenCalled();
		});

		it("comments and labels when the author replies with the code", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent();
			const mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(core.setOutput).toHaveBeenCalledWith("honeypot-triggered", "true");
			expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
				expect.objectContaining({
					issue_number: 123,
					body: expect.stringContaining("Automated contributor detected"),
				}),
			);
			expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
				owner: "test-owner",
				repo: "test-repo",
				issue_number: 123,
				labels: ["agentscan:automated-account"],
			});
		});

		it("closes the thread when auto-close is enabled", async () => {
			setupInputs({ honeypot: "true", "auto-close": "true" });
			setupCommentEvent();
			const mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith({
				owner: "test-owner",
				repo: "test-repo",
				issue_number: 123,
				state: "closed",
				state_reason: "not_planned",
			});
			expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
				expect.objectContaining({
					body: expect.stringContaining("closed automatically"),
				}),
			);
		});

		it("does not close the thread when auto-close is disabled", async () => {
			setupInputs({ honeypot: "true", "auto-close": "false" });
			setupCommentEvent();
			const mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(mockOctokit.rest.issues.update).not.toHaveBeenCalled();
		});

		it("ignores a reply from anyone other than the thread author", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent({ commentAuthor: "a-maintainer" });
			const mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(core.setOutput).toHaveBeenCalledWith(
				"honeypot-triggered",
				"false",
			);
			expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
		});

		it("ignores a reply that does not contain the code", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent({ commentBody: "Thanks for the review!" });
			const mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(core.setOutput).toHaveBeenCalledWith(
				"honeypot-triggered",
				"false",
			);
			expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
		});

		it("ignores a code the author only quoted back", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent({ commentBody: `> ${BAIT_TOKEN}\n\nWhat is this?` });
			const mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
		});

		it("ignores a code that came from a marker a human planted", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent();
			const mockOctokit = mockGetOctokit({
				issues: {
					listComments: vi.fn().mockResolvedValue({
						data: [
							{
								id: 1,
								body: `<!-- agentscanapp-ref:${BAIT_TOKEN} -->`,
								user: { type: "User" },
							},
						],
					}),
				},
			});

			await run();

			expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
		});

		it("does nothing when the thread has no bait at all", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent();
			const mockOctokit = mockGetOctokit();

			await run();

			expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
		});

		it("does not report the same thread twice", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent();
			const mockOctokit = mockGetOctokit(
				withBait([
					{
						id: 2,
						body: "<!-- agentscanapp-ref-check -->\n### Automated contributor detected",
						user: { type: "Bot" },
					},
				]),
			);

			await run();

			expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
			expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
		});

		it("ignores a reply from a known bot", async () => {
			setupInputs({ honeypot: "true" });
			Object.defineProperty(github, "context", {
				value: {
					actor: "dependabot[bot]",
					payload: {
						issue: {
							number: 123,
							user: { login: "dependabot[bot]" },
							pull_request: { url: "https://api.github.com" },
						},
						comment: {
							id: 9,
							body: BAIT_TOKEN,
							user: { login: "dependabot[bot]" },
						},
					},
					repo: { owner: "test-owner", repo: "test-repo" },
				},
				configurable: true,
			});
			mockGetOctokit(withBait());

			await run();

			expect(core.info).toHaveBeenCalledWith(
				expect.stringContaining("known automation"),
			);
		});

		it("labels only in 'labels' mode and comments only in 'comment' mode", async () => {
			setupInputs({ honeypot: "true", mode: "labels" });
			setupCommentEvent();
			let mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalled();
			expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();

			vi.clearAllMocks();
			setupCommonMocks();
			setupInputs({ honeypot: "true", mode: "comment" });
			setupCommentEvent();
			mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
			expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
		});

		it("calls the reply an issue when the thread is not a PR", async () => {
			setupInputs({ honeypot: "true", "scan-issues": "false" });
			setupCommentEvent({ isPR: false });
			const mockOctokit = mockGetOctokit(withBait());

			await run();

			expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
				expect.objectContaining({
					body: expect.stringContaining("on this issue"),
				}),
			);
		});

		it("warns instead of failing when the thread cannot be read", async () => {
			setupInputs({ honeypot: "true" });
			setupCommentEvent();
			mockGetOctokit({
				issues: {
					listComments: vi
						.fn()
						.mockRejectedValue(
							new Error("Resource not accessible by integration"),
						),
				},
			});

			await run();

			expect(core.warning).toHaveBeenCalledWith(
				expect.stringContaining("Could not run the honeypot check"),
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"honeypot-triggered",
				"false",
			);
			expect(core.setFailed).not.toHaveBeenCalled();
		});
	});
});
