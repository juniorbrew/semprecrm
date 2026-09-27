import { describe, expect, it } from "vitest";
import { failureReason, recipientErrorMessage } from "./failure-reason";

describe("failureReason", () => {
  it("formats code, title and details for a failed message", () => {
    expect(
      failureReason({
        status: "failed",
        error_code: 131049,
        error_title: "This message was not delivered to maintain healthy ecosystem engagement.",
        error_details: "Per-user marketing limit",
      }),
    ).toBe(
      "[131049] This message was not delivered to maintain healthy ecosystem engagement. — Per-user marketing limit",
    );
  });

  it("omits missing pieces", () => {
    expect(
      failureReason({ status: "failed", error_code: null, error_title: "Undeliverable", error_details: null }),
    ).toBe("Undeliverable");
  });

  it("is null for non-failed rows and for failed rows without a reason", () => {
    expect(
      failureReason({ status: "delivered", error_code: 1, error_title: "x", error_details: null }),
    ).toBeNull();
    expect(failureReason({ status: "failed" })).toBeNull();
  });
});

describe("recipientErrorMessage", () => {
  it("folds the reason into one line", () => {
    expect(recipientErrorMessage({ code: 131026, title: "Message undeliverable", details: "Receiver is incapable" })).toBe(
      "[131026] Message undeliverable: Receiver is incapable",
    );
    expect(recipientErrorMessage({ code: 131026, title: "Message undeliverable", details: null })).toBe(
      "[131026] Message undeliverable",
    );
  });
});
