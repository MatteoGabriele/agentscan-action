import { describe, it, expect } from "vitest";
import { parseStringArray, parseTypedArray } from "./utils";
import type { IdentityClassification } from "@unveil/identity";

describe("parseStringArray", () => {
  it("should parse empty input as empty array", () => {
    expect(parseStringArray("")).toEqual([]);
  });

  it("should parse JSON array format", () => {
    expect(parseStringArray('["user1", "user2", "user3"]')).toEqual([
      "user1",
      "user2",
      "user3",
    ]);
  });

  it("should parse comma-separated format", () => {
    expect(parseStringArray("user1, user2, user3")).toEqual([
      "user1",
      "user2",
      "user3",
    ]);
  });

  it("should fall back to comma-separated if JSON parsing fails", () => {
    expect(parseStringArray("not valid json, user2, user3")).toEqual([
      "not valid json",
      "user2",
      "user3",
    ]);
  });
});

describe("parseTypedArray", () => {
  const isIdentityClassification = (
    item: string,
  ): item is IdentityClassification =>
    ["organic", "mixed", "automation"].includes(item);

  it("should parse empty input as empty array", () => {
    expect(parseTypedArray("", isIdentityClassification)).toEqual([]);
  });

  it("should parse and validate JSON array format", () => {
    expect(
      parseTypedArray(
        '["organic", "mixed", "automation"]',
        isIdentityClassification,
      ),
    ).toEqual(["organic", "mixed", "automation"]);
  });

  it("should parse and validate comma-separated format", () => {
    expect(
      parseTypedArray("organic, mixed, automation", isIdentityClassification),
    ).toEqual(["organic", "mixed", "automation"]);
  });

  it("should filter out invalid values", () => {
    expect(
      parseTypedArray(
        '["organic", "invalid", "mixed"]',
        isIdentityClassification,
      ),
    ).toEqual(["organic", "mixed"]);
  });

  it("should fall back to comma-separated if JSON parsing fails", () => {
    expect(
      parseTypedArray(
        "not valid json, organic, mixed",
        isIdentityClassification,
      ),
    ).toEqual(["organic", "mixed"]);
  });
});
