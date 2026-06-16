import { describe, it, expect } from "vitest";
import { mergeSettings, expandCheckTargets, chunk, type Settings } from "../src/index";

const base: Settings = {
  dryRun: true,
  apiDelayMs: 1000,
  expiryAlertDays: [30, 14, 7, 1],
  renewalMode: "AUTORENEW",
  period: "",
  transferLock: true,
};

describe("mergeSettings", () => {
  it("returns the base when there is no override", () => {
    expect(mergeSettings(base, {})).toEqual(base);
  });
  it("lets an override turn dry-run off", () => {
    expect(mergeSettings(base, { dryRun: false }).dryRun).toBe(false);
  });
  it("ignores an invalid (negative) delay", () => {
    expect(mergeSettings(base, { apiDelayMs: -5 }).apiDelayMs).toBe(1000);
  });
  it("accepts and sorts override thresholds", () => {
    expect(mergeSettings(base, { expiryAlertDays: [7, 60, 1] }).expiryAlertDays).toEqual([60, 7, 1]);
  });
  it("merges registration options", () => {
    const merged = mergeSettings(base, { renewalMode: "AUTODELETE", transferLock: false, period: "2Y" });
    expect(merged.renewalMode).toBe("AUTODELETE");
    expect(merged.transferLock).toBe(false);
    expect(merged.period).toBe("2Y");
  });
});

describe("expandCheckTargets", () => {
  it("normalizes a single domain to lowercase", () => {
    expect(expandCheckTargets({ domain: "Example.DE" })).toEqual(["example.de"]);
  });
  it("expands a keyword across tlds, stripping junk and leading dots", () => {
    expect(expandCheckTargets({ keyword: "My Brand!", tlds: [".de", "com", " "] })).toEqual([
      "mybrand.de",
      "mybrand.com",
    ]);
  });
  it("returns nothing without enough input", () => {
    expect(expandCheckTargets({})).toEqual([]);
    expect(expandCheckTargets({ keyword: "x" })).toEqual([]);
  });
});

describe("chunk", () => {
  it("splits into batches of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("handles empty and exact multiples", () => {
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
});
