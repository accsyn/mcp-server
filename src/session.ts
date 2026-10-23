import type { LogReader } from "./logs.js";
import type { ProcessLogReader } from "./processlogs.js";

/** What the server needs from an accsyn `Session`. */
export interface AccsynSession extends LogReader, ProcessLogReader {}
