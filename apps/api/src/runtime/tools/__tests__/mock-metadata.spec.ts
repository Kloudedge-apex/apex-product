import { describe, it, expect } from "vitest";
import { isMocked, markMocked } from "../mock-metadata";
describe("isMocked", () => {
  it("detects mock-tagged data", () => {
    expect(isMocked(markMocked({ a: 1 }, "no key"))).toBe(true);
  });
  it("treats real data and nullish as not mocked", () => {
    expect(isMocked({ a: 1 })).toBe(false);
    expect(isMocked(null)).toBe(false);
    expect(isMocked(undefined)).toBe(false);
  });
});
