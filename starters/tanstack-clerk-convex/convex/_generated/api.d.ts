/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 * To regenerate, run `bunx convex dev`.
 */
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as projects from "../projects.js";

declare const fullApi: ApiFromModules<{
  projects: typeof projects;
}>;

export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
