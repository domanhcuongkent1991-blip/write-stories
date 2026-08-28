import { describe, expect, it } from "vitest";
import {
  isAllowedMutationOrigin,
  isPrivateIpv4,
  normalizeAllowedOrigins,
} from "./network-policy.js";

describe("trusted LAN network policy", () => {
  it("accepts only concrete private IPv4 addresses", () => {
    expect(isPrivateIpv4("192.168.1.20")).toBe(true);
    expect(isPrivateIpv4("10.0.0.8")).toBe(true);
    expect(isPrivateIpv4("172.20.0.4")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("172.31.255.254")).toBe(true);
    expect(isPrivateIpv4("172.15.255.255")).toBe(false);
    expect(isPrivateIpv4("172.32.0.4")).toBe(false);
    expect(isPrivateIpv4("0.0.0.0")).toBe(false);
    expect(isPrivateIpv4("127.0.0.1")).toBe(false);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });

  it("rejects malformed IPv4 values", () => {
    expect(isPrivateIpv4("192.168.1")).toBe(false);
    expect(isPrivateIpv4("192.168.1.1.1")).toBe(false);
    expect(isPrivateIpv4("192.168.1.256")).toBe(false);
    expect(isPrivateIpv4("192.168.-1.1")).toBe(false);
    expect(isPrivateIpv4("192.168.1.one")).toBe(false);
  });

  it("normalizes HTTP origins, strips path/query, and de-duplicates deterministically", () => {
    expect(
      normalizeAllowedOrigins([
        " https://EXAMPLE.com/path?q=1 ",
        "http://localhost:4567/other",
        "https://example.com",
        "ftp://invalid.example",
        "not an origin",
        "http://localhost:4567",
      ]),
    ).toEqual(["https://example.com", "http://localhost:4567"]);
  });

  it("rejects foreign browser origins but permits missing Origin for loopback tooling", () => {
    const origins = normalizeAllowedOrigins(["http://192.168.1.20:4568"]);
    expect(isAllowedMutationOrigin(undefined, origins)).toBe(true);
    expect(isAllowedMutationOrigin("http://192.168.1.20:4568", origins)).toBe(true);
    expect(isAllowedMutationOrigin("https://evil.example", origins)).toBe(false);
    expect(isAllowedMutationOrigin("http://192.168.1.20:4568/path", origins)).toBe(false);
    expect(isAllowedMutationOrigin("http://192.168.1.20:4568?x=1", origins)).toBe(false);
  });
});
