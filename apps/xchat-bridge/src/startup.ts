import { guessesRemaining } from "@xdevplatform/chat-xdk";

export interface StartupFailure {
  errorCode: "xchat_pin_invalid" | "xchat_initialization_failed";
  exitCode: 0 | 1;
}

export function classifyStartupFailure(error: unknown): StartupFailure {
  if (guessesRemaining(error) !== null) {
    return { errorCode: "xchat_pin_invalid", exitCode: 0 };
  }
  return { errorCode: "xchat_initialization_failed", exitCode: 1 };
}
