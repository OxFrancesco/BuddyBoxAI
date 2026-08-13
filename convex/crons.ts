import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep expired control-plane state", { minutes: 15 }, internal.maintenance.sweepExpired, {});

export default crons;
