vi.mock("voight-kampff-compactor");

import { compactor } from "voight-kampff-compactor";
import { getAIAnalysis, type AIAnalysisInput, type AIAnalysisResult } from "./ai";

describe("getAIAnalysis", () => {
  const baseInput: AIAnalysisInput = {
    token: "test-token",
    model: "openai/gpt-4o-mini",
    username: "test-user",
    analysis: {
      classification: "organic",
      score: 20,
      flags: [{ label: "Test Flag", points: 10, detail: "This is a test flag" }],
      profile: { age: 365, repos: 10 },
    },
    accountCreatedAt: "2020-01-01T00:00:00Z",
    publicRepos: 10,
    events: [],
  };

  const mockAIResponse: AIAnalysisResult = {
    classification: "organic",
    confidence: 85,
    reasoning: "This is a genuine human account.",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(compactor).mockReturnValue("l:test-user|ca:0101|pr:10");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call GitHub Models API with correct parameters", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(mockAIResponse) } }],
        }),
      ),
    );

    await getAIAnalysis(baseInput);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://models.github.ai/inference/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.temperature).toBe(0.3);
  });

  it("should return parsed AI response as structured object", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(mockAIResponse) } }],
        }),
      ),
    );

    const result = await getAIAnalysis(baseInput);
    expect(result).toEqual(mockAIResponse);
  });

  it("should return null when response has no content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [] })),
    );

    const result = await getAIAnalysis(baseInput);
    expect(result).toBeNull();
  });

  it("should throw on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    );

    await expect(getAIAnalysis(baseInput)).rejects.toThrow("403 Forbidden");
  });

  it("should use compactor to compact all input data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(mockAIResponse) } }],
        }),
      ),
    );

    await getAIAnalysis({
      ...baseInput,
      events: [{ type: "PushEvent", created_at: "2024-03-01" }],
    });

    expect(compactor).toHaveBeenCalledWith(
      expect.stringContaining('"test-user"'),
    );
  });

  it("should include compacted data in the user prompt", async () => {
    vi.mocked(compactor).mockReturnValue("compacted-data-here");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(mockAIResponse) } }],
        }),
      ),
    );

    await getAIAnalysis(baseInput);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages[1].content).toContain("compacted-data-here");
  });
});
