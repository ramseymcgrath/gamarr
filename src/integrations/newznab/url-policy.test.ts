import { describe, expect, it } from "vitest";

import { validateDownloadUrl } from "@/integrations/newznab/url-policy";
import { AppError } from "@/lib/errors";

describe("validateDownloadUrl", () => {
  it("accepts a credential-free path on the configured indexer origin", () => {
    expect(validateDownloadUrl(
      "http://192.168.1.20:9696/1/api",
      "http://192.168.1.20:9696/1/api?t=get&id=abc&apikey=secret"
    )).toEqual({
      downloadPath: "/1/api?t=get&id=abc",
      origin: "http://192.168.1.20:9696"
    });
  });

  it("rejects metadata, cross-origin, userinfo, and fragment targets", () => {
    for (const target of [
      "http://169.254.169.254/latest/meta-data",
      "https://other.test/get/abc",
      "http://user:pass@192.168.1.20:9696/get/abc",
      "http://192.168.1.20:9696/get/abc#fragment"
    ]) {
      expect(() => validateDownloadUrl(
        "http://192.168.1.20:9696/1/api",
        target
      )).toThrowError(AppError);
    }
  });
});
