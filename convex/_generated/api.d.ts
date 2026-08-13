/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as approvals from "../approvals.js";
import type * as audit from "../audit.js";
import type * as bridge from "../bridge.js";
import type * as bridgeActions from "../bridgeActions.js";
import type * as channels from "../channels.js";
import type * as codexConnectionActions from "../codexConnectionActions.js";
import type * as codexStore from "../codexStore.js";
import type * as connections from "../connections.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as deletions from "../deletions.js";
import type * as domainPolicy from "../domainPolicy.js";
import type * as http from "../http.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_bounds from "../lib/bounds.js";
import type * as lib_bridgeCrypto from "../lib/bridgeCrypto.js";
import type * as lib_providerCrypto from "../lib/providerCrypto.js";
import type * as lib_readiness from "../lib/readiness.js";
import type * as maintenance from "../maintenance.js";
import type * as modelValidators from "../modelValidators.js";
import type * as projects from "../projects.js";
import type * as providerOAuth from "../providerOAuth.js";
import type * as providerOAuthStore from "../providerOAuthStore.js";
import type * as releases from "../releases.js";
import type * as runEvents from "../runEvents.js";
import type * as runs from "../runs.js";
import type * as runtime from "../runtime.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  approvals: typeof approvals;
  audit: typeof audit;
  bridge: typeof bridge;
  bridgeActions: typeof bridgeActions;
  channels: typeof channels;
  codexConnectionActions: typeof codexConnectionActions;
  codexStore: typeof codexStore;
  connections: typeof connections;
  conversations: typeof conversations;
  crons: typeof crons;
  deletions: typeof deletions;
  domainPolicy: typeof domainPolicy;
  http: typeof http;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/bounds": typeof lib_bounds;
  "lib/bridgeCrypto": typeof lib_bridgeCrypto;
  "lib/providerCrypto": typeof lib_providerCrypto;
  "lib/readiness": typeof lib_readiness;
  maintenance: typeof maintenance;
  modelValidators: typeof modelValidators;
  projects: typeof projects;
  providerOAuth: typeof providerOAuth;
  providerOAuthStore: typeof providerOAuthStore;
  releases: typeof releases;
  runEvents: typeof runEvents;
  runs: typeof runs;
  runtime: typeof runtime;
  usage: typeof usage;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
