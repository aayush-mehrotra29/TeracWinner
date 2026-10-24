// A hosted Tally form gives Terac participants an externally reachable task
// while the Orit dashboard and worker remain local. Credentials are checked by
// the worker before any provider call, and paid launch still needs owner approval.
export const TERAC_FIELDWORK_AVAILABLE = true;

export const TERAC_FIELDWORK_UNAVAILABLE_REASON =
  "Human feedback requires a Tally form and a Terac connection.";
