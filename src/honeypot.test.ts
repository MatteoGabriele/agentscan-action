import { describe, expect, it } from "vitest";
import {
	buildHoneypotComment,
	buildHoneypotResultComment,
	createHoneypotToken,
	extractHoneypotToken,
	HONEYPOT_RESULT_MARKER,
	hasHoneypotToken,
	isBotComment,
} from "./honeypot";

const TOKEN = "a1b2c3d4e5f6";

describe("createHoneypotToken", () => {
	it("creates a 12 hex character token that survives a round trip through the comment", () => {
		const token = createHoneypotToken();

		expect(token).toMatch(/^[0-9a-f]{12}$/);
		expect(
			extractHoneypotToken(
				buildHoneypotComment({ token, username: "someone", isPR: true }),
			),
		).toBe(token);
	});

	it("does not repeat itself, so a token from one thread cannot spring another", () => {
		const tokens = new Set(
			Array.from({ length: 50 }, () => createHoneypotToken()),
		);

		expect(tokens.size).toBe(50);
	});
});

describe("extractHoneypotToken", () => {
	it("returns null for a comment without the marker", () => {
		expect(extractHoneypotToken("just a regular comment")).toBeNull();
		expect(extractHoneypotToken(undefined)).toBeNull();
		expect(extractHoneypotToken(null)).toBeNull();
	});

	it("ignores a marker holding something that is not a token", () => {
		expect(
			extractHoneypotToken("<!-- agentscanapp-ref:not-a-token -->"),
		).toBeNull();
	});
});

describe("hasHoneypotToken", () => {
	it("matches a reply that is only the code", () => {
		expect(hasHoneypotToken(TOKEN, TOKEN)).toBe(true);
	});

	it("matches the code embedded in a sentence", () => {
		expect(hasHoneypotToken(`Sure, here it is: ${TOKEN}`, TOKEN)).toBe(true);
	});

	it("does not match a different code", () => {
		expect(hasHoneypotToken("ffffffffffff", TOKEN)).toBe(false);
	});

	it("ignores the code inside a quoted reply, so quoting the thread is not a trap", () => {
		expect(hasHoneypotToken(`> ${TOKEN}\n\nWhat is this?`, TOKEN)).toBe(false);
	});

	it("ignores the code inside an HTML comment, so the bait itself never counts", () => {
		const bait = buildHoneypotComment({
			token: TOKEN,
			username: "someone",
			isPR: true,
		});

		expect(hasHoneypotToken(bait, TOKEN)).toBe(false);
	});

	it("returns false for an empty body", () => {
		expect(hasHoneypotToken("", TOKEN)).toBe(false);
		expect(hasHoneypotToken(undefined, TOKEN)).toBe(false);
	});
});

describe("isBotComment", () => {
	it("accepts a comment posted by a bot account", () => {
		expect(isBotComment({ user: { type: "Bot" } })).toBe(true);
	});

	it("rejects a comment posted by a human, so bait cannot be planted by a third party", () => {
		expect(isBotComment({ user: { type: "User" } })).toBe(false);
		expect(isBotComment({ user: null })).toBe(false);
		expect(isBotComment({})).toBe(false);
	});
});

describe("buildHoneypotComment", () => {
	it("hides the instruction in an HTML comment so a human reader never sees it", () => {
		const body = buildHoneypotComment({
			token: TOKEN,
			username: "someone",
			isPR: true,
		});

		const visible = body.replace(/<!--[\s\S]*?-->/g, "");

		expect(visible).not.toContain(TOKEN);
		expect(visible).not.toContain("verification code");
		expect(visible).toContain("@someone");
	});

	it("reads as an ordinary greeting, with no mention of the check", () => {
		const body = buildHoneypotComment({
			token: TOKEN,
			username: "someone",
			isPR: false,
		});

		const visible = body.replace(/<!--[\s\S]*?-->/g, "");

		expect(visible.toLowerCase()).not.toContain("agentscan");
		expect(visible.toLowerCase()).not.toContain("automat");
		expect(visible).toContain("issue");
	});

	it("uses the first-time greeting for a first-time contributor", () => {
		const body = buildHoneypotComment({
			token: TOKEN,
			username: "someone",
			isPR: true,
			isFirstTime: true,
		});

		expect(body).toContain("first pull request");
	});

	it("replaces a custom greeting entirely, placeholders and all", () => {
		const body = buildHoneypotComment({
			token: TOKEN,
			username: "someone",
			isPR: true,
			greeting: "Hey {username}, thanks for the {type}!",
		});

		expect(body).toContain("Hey someone, thanks for the pull request!");
		expect(body).not.toContain("Thanks for opening this");
	});

	it("falls back to the default greeting when the custom one is blank", () => {
		const body = buildHoneypotComment({
			token: TOKEN,
			username: "someone",
			isPR: true,
			greeting: "   ",
		});

		expect(body).toContain("Thanks for opening this pull request!");
	});
});

describe("buildHoneypotResultComment", () => {
	it("carries the result marker so the same thread is not reported twice", () => {
		const body = buildHoneypotResultComment({
			username: "someone",
			isPR: true,
			closed: false,
		});

		expect(body).toContain(HONEYPOT_RESULT_MARKER);
		expect(body).toContain("@someone");
		expect(body).not.toContain("closed automatically");
	});

	it("says the thread was closed only when it actually was", () => {
		const body = buildHoneypotResultComment({
			username: "someone",
			isPR: false,
			closed: true,
		});

		expect(body).toContain("closed automatically");
		expect(body).toContain("issue");
	});

	it("does not carry a token marker, so the result cannot be mistaken for new bait", () => {
		const body = buildHoneypotResultComment({
			username: "someone",
			isPR: true,
			closed: true,
		});

		expect(extractHoneypotToken(body)).toBeNull();
	});
});
