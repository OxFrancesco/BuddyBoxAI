import type { AdmissionRequest, PreviewRequest, RunRequest, ScreenshotRequest } from "./contracts/v1";

export interface RuntimeLocator {
  userId: string;
  projectId: string;
  sandboxGeneration: number;
  sandboxId: string;
}

export interface RuntimeHandle {
  materialize(request: AdmissionRequest): Promise<{ commitSha: string; restored: boolean }>;
  run(request: RunRequest): Promise<Response>;
  cancel(runId: string): Promise<{ accepted: boolean }>;
  heartbeat(runId?: string): Promise<{
    runId?: string;
    state: "idle" | "starting" | "running" | "stopping" | "stopped" | "missing";
    lastEventSequence: number;
    observedAt: string;
  }>;
  createCheckpoint(): Promise<{ bytes: Uint8Array; sha256: string }>;
  restoreCheckpoint(bytes: Uint8Array): Promise<{ commitSha: string; sessionCount: number }>;
  startPreview(request: PreviewRequest): Promise<{ url: string; port: number }>;
  captureScreenshot(request: ScreenshotRequest): Promise<{ bytes: Uint8Array; mediaType: "image/png" }>;
  readArtifact(path: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
  destroy(): Promise<void>;
}

export interface CheckpointStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export async function deriveSandboxId(userId: string, projectId: string, generation: number): Promise<string> {
  const source = new TextEncoder().encode(`${userId}\u0000${projectId}\u0000${generation}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  const suffix = [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ichef-${generation}-${suffix}`;
}

export function checkpointKey(userId: string, projectId: string, checkpointId: string): string {
  return `${userId}/${projectId}/${checkpointId}`;
}
