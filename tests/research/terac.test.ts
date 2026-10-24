import assert from "node:assert/strict";
import test from "node:test";
import { IntegrationBlockedError } from "../../src/lib/providers/errors";
import { parseTeracOpportunity, TeracMcp } from "../../src/lib/providers/terac";

const opportunity = (id: string, internalTitle = "orit-run-123") => ({
  data: {
    opportunity: {
      id,
      project_id: "project-1",
      internal_title: internalTitle,
      status: "draft",
      num_participants: 5,
      pricing: { cost_per_participant_cents: 4000, total_cost_cents: 20000 },
      links: { dashboard: { draft_editor: `https://terac.com/researcher/opportunities/${id}/edit` } },
    },
  },
});

function stubCalls(adapter: TeracMcp, handler: (name: string, values: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  (adapter as unknown as { call: typeof handler }).call = handler;
}

test("draft details expose the provider total and all-in CPI without claiming participant payout", () => {
  assert.deepEqual(parseTeracOpportunity(opportunity("draft-1")), {
    id: "draft-1",
    projectId: "project-1",
    internalTitle: "orit-run-123",
    status: "draft",
    participantCount: 5,
    allInCostPerParticipantUsd: 40,
    totalUsd: 200,
    draftEditorUrl: "https://terac.com/researcher/opportunities/draft-1/edit",
  });
});

test("a direct opportunity draft omits feasibility linkage and saves an exact recovery title", async () => {
  const adapter = new TeracMcp();
  let sent: Record<string, unknown> = {};
  stubCalls(adapter, async (name, values) => {
    assert.equal(name, "terac_create_opportunity");
    sent = values;
    return opportunity("draft-1");
  });
  const draft = await adapter.createOpportunity({
    title: "Product feedback", internalTitle: "orit-run-123", description: "Review the product.",
    taskUrl: "https://tally.so/r/example", audience: "US shoppers", businessType: "b2c",
    count: 5, projectId: "project-1", screeningQuestions: [],
  });
  assert.equal(draft.id, "draft-1");
  assert.equal(draft.totalUsd, 200);
  assert.equal(draft.draftEditorUrl, "https://terac.com/researcher/opportunities/draft-1/edit");
  assert.equal(sent?.internal_title, "orit-run-123");
  assert.equal(sent?.num_participants, 5);
  assert.equal("feasibility_request_id" in sent, false);
});

test("a legacy priced opportunity still carries its feasibility request ID", async () => {
  const adapter = new TeracMcp();
  let sent: Record<string, unknown> = {};
  stubCalls(adapter, async (_name, values) => {
    sent = values;
    return opportunity("draft-legacy");
  });
  await adapter.createOpportunity({
    title: "Product feedback", description: "Review the product.", taskUrl: "https://tally.so/r/example",
    audience: "US shoppers", businessType: "b2c", count: 5, projectId: "project-1",
    feasibilityId: "feasibility-1", screeningQuestions: [],
  });
  assert.equal(sent.feasibility_request_id, "feasibility-1");
});

test("an uncertain write recovers only an exact draft in the expected project", async () => {
  const adapter = new TeracMcp();
  const calls: string[] = [];
  stubCalls(adapter, async (name, values) => {
    calls.push(name);
    if (name === "terac_list_opportunities") {
      assert.equal(values.projectId, "project-1");
      assert.equal(values.status, "draft");
      return { data: [{ id: "other" }, { id: "draft-1" }], pagination: { has_more: false } };
    }
    if (name === "terac_get_opportunity") return opportunity(String(values.opportunityId), String(values.opportunityId) === "draft-1" ? "orit-run-123" : "another-run");
    throw new Error(`Unexpected tool ${name}`);
  });
  const recovered = await adapter.findDraftOpportunityByInternalTitle("orit-run-123", "project-1");
  assert.equal(recovered?.id, "draft-1");
  assert.equal(recovered?.participantCount, 5);
  assert.deepEqual(calls, ["terac_list_opportunities", "terac_get_opportunity", "terac_get_opportunity"]);
});

test("draft recovery rereads when Terac's list is briefly stale", async () => {
  const adapter = new TeracMcp();
  let listings = 0;
  stubCalls(adapter, async (name, values) => {
    if (name === "terac_list_opportunities") {
      listings += 1;
      return { data: listings === 1 ? [] : [{ id: "draft-1" }], pagination: { has_more: false } };
    }
    if (name === "terac_get_opportunity") return opportunity(String(values.opportunityId));
    throw new Error(`Unexpected tool ${name}`);
  });
  const recovered = await adapter.findDraftOpportunityByInternalTitle("orit-run-123", "project-1");
  assert.equal(recovered?.id, "draft-1");
  assert.equal(listings, 2);
});

test("draft recovery refuses ambiguous matches", async () => {
  const adapter = new TeracMcp();
  stubCalls(adapter, async (name, values) => name === "terac_list_opportunities"
    ? { data: [{ id: "draft-1" }, { id: "draft-2" }], pagination: { has_more: false } }
    : opportunity(String(values.opportunityId)));
  await assert.rejects(
    () => adapter.findDraftOpportunityByInternalTitle("orit-run-123", "project-1"),
    (error: unknown) => error instanceof IntegrationBlockedError && /Multiple Terac drafts/.test(error.message),
  );
});
