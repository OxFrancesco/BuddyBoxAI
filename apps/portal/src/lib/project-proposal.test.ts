import { describe, expect, test } from "bun:test";

import {
  buildProjectProposal,
  validateProjectProposalInput,
} from "./project-proposal";

describe("project proposal input", () => {
  test("rejects blank and over-limit fields at the public form boundary", () => {
    expect(validateProjectProposalInput({ name: "   ", brief: "A useful brief" })).toEqual({
      ok: false,
      errors: { name: "Give your project a name." },
    });
    expect(validateProjectProposalInput({ name: "A".repeat(121), brief: "A useful brief" })).toEqual({
      ok: false,
      errors: { name: "Keep the name to 120 characters or fewer." },
    });
    expect(validateProjectProposalInput({ name: "Recipe Book", brief: "B".repeat(8_001) })).toEqual({
      ok: false,
      errors: { brief: "Keep the brief to 8,000 characters or fewer." },
    });
  });

  test("trims a valid name and brief before constructing authority-bound data", () => {
    expect(validateProjectProposalInput({
      name: "  Field Notes  ",
      brief: "  A calm field guide for seasonal ingredients.  ",
    })).toEqual({
      ok: true,
      value: {
        name: "Field Notes",
        brief: "A calm field guide for seasonal ingredients.",
      },
    });
  });
});

describe("project proposal payload", () => {
  test("builds a canonical minimal plan with a known SHA-256 binding", async () => {
    const proposal = await buildProjectProposal(
      {
        name: "Field Notes",
        brief: "A calm field guide for seasonal ingredients.",
      },
      Date.UTC(2026, 7, 20, 12, 0, 0),
    );

    expect(proposal).toEqual({
      name: "Field Notes",
      brief: "A calm field guide for seasonal ingredients.",
      planJson: "{\"version\":1,\"project\":{\"name\":\"Field Notes\",\"brief\":\"A calm field guide for seasonal ingredients.\"},\"stack\":[\"TanStack Start\",\"Clerk\",\"Convex\"],\"delivery\":{\"source\":\"GitHub\",\"hosting\":\"iChef managed Cloudflare\",\"approval\":\"verified messaging channel\"}}",
      payloadHash: "0a104b479d309238601161efbe4cb546ae6883ba924da49dcbdc95a779de4548",
      expiresAt: Date.UTC(2026, 7, 21, 11, 0, 0),
    });
  });

  test("refuses to construct a payload from invalid input", async () => {
    await expect(buildProjectProposal({ name: " ", brief: "Anything" }, 1_000)).rejects.toThrow(
      "Project proposal input is invalid",
    );
  });
});
