import { describe, expect, test } from "bun:test";

import { classifyStartupFailure } from "../src/startup";

describe("X Chat bridge startup", () => {
  test("does not request a process restart after an invalid recovery PIN", () => {
    const failure = classifyStartupFailure(
      new Error("Juicebox recovery failed: reason=InvalidPin guesses_remaining=8"),
    );

    expect(failure).toEqual({ errorCode: "xchat_pin_invalid", exitCode: 0 });
  });

  test("keeps unexpected initialization failures retryable", () => {
    expect(classifyStartupFailure(new Error("network unavailable"))).toEqual({
      errorCode: "xchat_initialization_failed",
      exitCode: 1,
    });
  });
});
