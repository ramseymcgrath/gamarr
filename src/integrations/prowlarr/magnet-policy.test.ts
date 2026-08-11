import { describe, expect, it } from "vitest";

import {
  MagnetPolicyError,
  validateMagnet
} from "@/integrations/prowlarr/magnet-policy";

const KEY = "prowlarr-secret-key";
const HEX = "0123456789abcdef0123456789abcdef01234567";
const BASE32 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function reasonOf(uri: string, apiKey = KEY): string {
  try {
    validateMagnet(uri, apiKey);
  } catch (error) {
    if (error instanceof MagnetPolicyError) return error.reason;
    throw error;
  }
  return "accepted";
}

describe("validateMagnet", () => {
  it("accepts a 40-character hex infohash", () => {
    const uri = `magnet:?xt=urn:btih:${HEX}&dn=Some+Game`;
    expect(validateMagnet(uri, KEY)).toBe(uri);
  });

  it("accepts a 32-character base32 infohash", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${BASE32}`)).toBe("accepted");
  });

  it("accepts an uppercase hex infohash", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX.toUpperCase()}`)).toBe("accepted");
  });

  it("keeps tracker parameters untouched", () => {
    const uri = `magnet:?xt=urn:btih:${HEX}&tr=udp%3A%2F%2Ftracker.test%3A80`;
    expect(validateMagnet(uri, KEY)).toBe(uri);
  });

  it("rejects a non-magnet scheme", () => {
    expect(reasonOf(`https://tracker.test/?xt=urn:btih:${HEX}`))
      .toBe("unsupportedScheme");
  });

  it("rejects a magnet with no xt parameter", () => {
    expect(reasonOf("magnet:?dn=Some+Game")).toBe("missingInfoHash");
  });

  it("rejects a non-btih topic", () => {
    expect(reasonOf(`magnet:?xt=urn:sha1:${BASE32}`)).toBe("unsupportedTopic");
  });

  it("rejects a btih topic whose infohash is the wrong length", () => {
    expect(reasonOf("magnet:?xt=urn:btih:abc123")).toBe("missingInfoHash");
  });

  it("rejects when any xt is a non-btih topic", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX}&xt=urn:sha1:${BASE32}`))
      .toBe("unsupportedTopic");
  });

  it("rejects a URI longer than 4096 characters", () => {
    const long = `magnet:?xt=urn:btih:${HEX}&dn=${"a".repeat(4096)}`;
    expect(reasonOf(long)).toBe("tooLong");
  });

  it("rejects a URI containing the configured API key", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX}&tr=http%3A%2F%2Fx%2F${KEY}`))
      .toBe("credentialExposed");
  });

  it("rejects a URI containing the API key percent-encoded", () => {
    const encoded = encodeURIComponent(KEY).replace(/-/g, "%2D");
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX}&dn=${encoded}`))
      .toBe("credentialExposed");
  });

  it("does not treat an empty API key as present in every URI", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX}`, "")).toBe("accepted");
  });

  it("rejects an unparseable URI", () => {
    expect(reasonOf("magnet:%%%")).toBe("malformed");
  });

  it("never includes the offending URI in the message", () => {
    try {
      validateMagnet(`magnet:?xt=urn:btih:${HEX}&tr=${KEY}`, KEY);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MagnetPolicyError);
      expect((error as MagnetPolicyError).message).not.toContain(KEY);
      expect((error as MagnetPolicyError).message).not.toContain(HEX);
    }
  });
});
