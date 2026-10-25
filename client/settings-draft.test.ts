import { describe, expect, it } from "vitest";
import { parseBundleIds, parseTimeout } from "./settings-draft";

describe("computer settings drafts", () => {
  it("parses, trims, and de-duplicates bundle ids", () => {
    expect(parseBundleIds("com.apple.TextEdit\n com.example.App,com.apple.TextEdit")).toEqual(["com.apple.TextEdit", "com.example.App"]);
    expect(() => parseBundleIds("not a bundle")).toThrow('Expected a bundle id like com.apple.TextEdit, got "not a bundle"');
  });

  it("accepts only approval timeouts from 5 to 55 seconds", () => {
    expect(parseTimeout("5")).toBe(5);
    expect(parseTimeout("55")).toBe(55);
    expect(() => parseTimeout("")).toThrow("Expected approval timeout from 5 to 55 seconds, got an empty value");
    expect(() => parseTimeout("0")).toThrow("Expected approval timeout from 5 to 55 seconds, got 0");
    expect(() => parseTimeout("5.5")).toThrow('Expected a whole number for approval timeout, got "5.5"');
  });
});
