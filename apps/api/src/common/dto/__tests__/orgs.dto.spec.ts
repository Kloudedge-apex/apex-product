import { describe, expect, it } from "vitest";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateOrgDto } from "../orgs.dto";

/**
 * Sender-identity fields on UpdateOrgDto (audit B1).
 *
 * The global ValidationPipe runs with `whitelist: true`, so any field NOT
 * declared on this DTO is silently stripped from the body — which is exactly
 * how physicalAddress became unsettable and the CAN-SPAM gate in
 * send-outreach.worker.ts fail-closed every live send. These tests pin the
 * declared shape + validation rules so the fields can never be silently
 * stripped again.
 *
 * plainToInstance + validate mirrors what ValidationPipe does at runtime
 * (`transform: true`), so the @Transform trim is exercised too.
 */
describe("UpdateOrgDto sender identity validation", () => {
  async function validateBody(body: Record<string, unknown>) {
    const dto = plainToInstance(UpdateOrgDto, body);
    const errors = await validate(dto);
    return { dto, errors };
  }

  it("accepts a body with no sender-identity fields (all optional)", async () => {
    const { errors } = await validateBody({ name: "Acme" });
    expect(errors).toHaveLength(0);
  });

  describe("physicalAddress", () => {
    it("accepts a realistic postal address", async () => {
      const { dto, errors } = await validateBody({
        physicalAddress: "548 Market St, San Francisco, CA 94104, USA",
      });
      expect(errors).toHaveLength(0);
      expect(dto.physicalAddress).toBe(
        "548 Market St, San Francisco, CA 94104, USA",
      );
    });

    it("trims surrounding whitespace before validating", async () => {
      const { dto, errors } = await validateBody({
        physicalAddress: "  548 Market St, SF  ",
      });
      expect(errors).toHaveLength(0);
      expect(dto.physicalAddress).toBe("548 Market St, SF");
    });

    it("rejects a 600-char address (max 500)", async () => {
      const { errors } = await validateBody({
        physicalAddress: "a".repeat(600),
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe("physicalAddress");
    });

    it("rejects an address shorter than 5 chars after trimming", async () => {
      const { errors } = await validateBody({ physicalAddress: "  abc  " });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe("physicalAddress");
    });

    it("rejects non-string values", async () => {
      const { errors } = await validateBody({ physicalAddress: 12345 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe("physicalAddress");
    });
  });

  describe("senderName", () => {
    it("accepts a normal sender name", async () => {
      const { dto, errors } = await validateBody({ senderName: "Jane Doe" });
      expect(errors).toHaveLength(0);
      expect(dto.senderName).toBe("Jane Doe");
    });

    it("rejects whitespace-only names (empty after trim)", async () => {
      const { errors } = await validateBody({ senderName: "   " });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe("senderName");
    });

    it("rejects names longer than 120 chars", async () => {
      const { errors } = await validateBody({ senderName: "x".repeat(121) });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe("senderName");
    });
  });

  describe("country", () => {
    it("accepts uppercase ISO-3166 alpha-2 codes", async () => {
      for (const code of ["US", "IN", "DE"]) {
        const { dto, errors } = await validateBody({ country: code });
        expect(errors).toHaveLength(0);
        expect(dto.country).toBe(code);
      }
    });

    it("rejects lowercase codes (validator's isISO31661Alpha2 would uppercase-pass them)", async () => {
      const { errors } = await validateBody({ country: "us" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe("country");
    });

    it("rejects 3-letter codes", async () => {
      const { errors } = await validateBody({ country: "USA" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe("country");
    });

    it("rejects two-letter strings that are not assigned ISO-3166 codes", async () => {
      const { errors } = await validateBody({ country: "ZZ" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe("country");
    });
  });
});
