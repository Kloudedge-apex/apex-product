import { describe, it, expect } from "vitest";
import { EVIDENCE_EVENT_KIND, SIGNAL_EVENT_KINDS } from "../evidence-event.types";

describe("signal evidence kinds", () => {
  it("defines the prospect-signal kinds the research brief queries", () => {
    expect(EVIDENCE_EVENT_KIND.recentHire).toBe("recent_hire");
    expect(EVIDENCE_EVENT_KIND.fundingEvent).toBe("funding_event");
    expect(EVIDENCE_EVENT_KIND.leadershipChange).toBe("leadership_change");
    expect(EVIDENCE_EVENT_KIND.productLaunch).toBe("product_launch");
    expect(EVIDENCE_EVENT_KIND.pressMention).toBe("press_mention");
  });
  it("exposes the signal-kind set for callers", () => {
    expect(SIGNAL_EVENT_KINDS).toEqual(
      expect.arrayContaining(["recent_hire", "funding_event", "leadership_change", "product_launch", "press_mention"]),
    );
    // Exactly these five — guards against accidental drift between the array and the documented kinds.
    expect(SIGNAL_EVENT_KINDS).toHaveLength(5);
  });
});
