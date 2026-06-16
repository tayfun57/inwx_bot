import { describe, it, expect } from "vitest";
import {
  normalizeConfig,
  parseDomainConfigs,
  toCsv,
  countsOf,
  detectRunChanges,
  parseThresholds,
  daysUntil,
  type DomainStatus,
  type StateMap,
} from "../src/index";

const status = (domain: string, action: DomainStatus["action"]): DomainStatus => ({
  domain,
  available: null,
  action,
  detail: "",
  api_code: null,
  api_msg: null,
});

describe("normalizeConfig", () => {
  it("turns a plain string into auto mode", () => {
    expect(normalizeConfig("a.de")).toEqual({ domain: "a.de", mode: "auto" });
  });
  it("returns null for blank input", () => {
    expect(normalizeConfig("   ")).toBeNull();
    expect(normalizeConfig({ mode: "watch" })).toBeNull();
  });
  it("defaults an unknown mode to auto", () => {
    expect(normalizeConfig({ domain: "a.de", mode: "bogus" })).toEqual({ domain: "a.de", mode: "auto" });
  });
  it("ignores a non-numeric maxPrice but keeps numeric ones and trims tags", () => {
    expect(normalizeConfig({ domain: "a.de", maxPrice: "x" })).toEqual({ domain: "a.de", mode: "auto" });
    expect(normalizeConfig({ domain: "a.de", mode: "watch", maxPrice: 9.5, tags: [" t1 ", ""] })).toEqual({
      domain: "a.de",
      mode: "watch",
      maxPrice: 9.5,
      tags: ["t1"],
    });
  });
});

describe("parseDomainConfigs", () => {
  it("parses newline text as auto mode and strips blanks", () => {
    expect(parseDomainConfigs("foo.de\n\n  bar.de  \n")).toEqual([
      { domain: "foo.de", mode: "auto" },
      { domain: "bar.de", mode: "auto" },
    ]);
  });
  it("parses a JSON array of strings", () => {
    expect(parseDomainConfigs('["a.de","b.de"]')).toEqual([
      { domain: "a.de", mode: "auto" },
      { domain: "b.de", mode: "auto" },
    ]);
  });
  it("parses config objects", () => {
    expect(parseDomainConfigs('[{"domain":"x.de","mode":"watch","maxPrice":15,"tags":["a"]}]')).toEqual([
      { domain: "x.de", mode: "watch", maxPrice: 15, tags: ["a"] },
    ]);
  });
});

describe("toCsv", () => {
  it("writes the header and escapes commas/quotes", () => {
    const csv = toCsv([
      { domain: "foo.de", available: true, action: "purchased", detail: 'a, "b"', api_code: 1000, api_msg: "ok" },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("domain,available,action,detail,api_code,api_msg");
    expect(lines[1]).toBe('foo.de,true,purchased,"a, ""b""",1000,ok');
  });
});

describe("countsOf", () => {
  it("counts actions", () => {
    expect(countsOf([status("a", "would_purchase"), status("b", "skipped"), status("c", "would_purchase")])).toEqual({
      would_purchase: 2,
      skipped: 1,
    });
  });
});

describe("detectRunChanges", () => {
  it("flags a newly interesting action", () => {
    expect(detectRunChanges({}, [status("a.de", "would_purchase")])).toEqual([
      { domain: "a.de", from: "new", to: "would_purchase" },
    ]);
  });
  it("de-duplicates an unchanged available status", () => {
    const prev: StateMap = { "a.de": { action: "would_purchase" } };
    expect(detectRunChanges(prev, [status("a.de", "would_purchase")])).toEqual([]);
  });
  it("ignores skipped domains", () => {
    expect(detectRunChanges({}, [status("a.de", "skipped")])).toEqual([]);
  });
});

describe("parseThresholds", () => {
  it("parses and sorts descending", () => {
    expect(parseThresholds("7,30,1,14")).toEqual([30, 14, 7, 1]);
  });
  it("defaults when empty or undefined", () => {
    expect(parseThresholds(undefined)).toEqual([30, 14, 7, 1]);
    expect(parseThresholds("")).toEqual([30, 14, 7, 1]);
  });
  it("filters out junk values", () => {
    expect(parseThresholds("5, x, 10")).toEqual([10, 5]);
  });
});

describe("daysUntil", () => {
  it("returns null for empty or invalid dates", () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil("nonsense")).toBeNull();
  });
  it("computes days for a future date", () => {
    const d = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const left = daysUntil(d);
    expect(left).toBeGreaterThanOrEqual(9);
    expect(left).toBeLessThanOrEqual(10);
  });
});
