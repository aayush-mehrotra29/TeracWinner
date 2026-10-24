/** Owner review stays available as feedback arrives and after an addendum is published. */
export function canReviewStudyResponse(status: string): boolean {
  return ["awaiting_response", "launched", "recruiting", "collecting", "completed"].includes(status);
}
