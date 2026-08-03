/**
 * remy-guardrails.js
 * -----------------------------------------------------------------------------
 * Constrains the in-app AI assistant. Addresses review finding N-1.
 *
 * THE PROBLEM THIS SOLVES
 * A reference page states general law. Remy applies law to one taxpayer's
 * specific facts and returns a conclusion. That is the shape of advice, and an
 * "educational only" disclaimer does less work than it appears to when the
 * output is individualized — particularly on a product whose central trust
 * claim is an Enrolled Agent and former Revenue Agent credential.
 *
 * THE APPROACH
 * Remy is confined to two jobs:
 *   (a) explain what the law says, and
 *   (b) read back what the user's own logged data shows.
 * Anything that asks it to PREDICT an outcome, ADVISE on a position, or
 * OPTIMIZE toward qualification is routed to a human consultation.
 *
 * Wire into app.js at remySend (~2935) and buildRemyCtx (~2873).
 */

'use strict';

/* ---------------------------------------------------------------------------
 * 1. Requests that must not be answered by a model
 * ------------------------------------------------------------------------- */

const ROUTE_TO_HUMAN = [
  {
    id: 'position_advice',
    // "should I", "can I claim", "will I qualify", "is it ok if"
    test: /\b(should i|can i (claim|take|deduct|count|check|mark)|will i (qualify|pass|be able)|is it (ok|okay|fine|safe|legal)|do i (qualify|have to|need to)|am i (allowed|able|safe))\b/i,
    reply:
      "That's a question about your specific position, and I'm not the right thing to answer it — " +
      "I can explain what the rules say, but whether they apply to your facts is a judgement call " +
      "that should be made by someone who can look at your whole situation and stand behind the answer.",
  },
  {
    id: 'audit_risk',
    test: /\b(audit risk|red flag|get away with|will the irs|chance of (being )?audit|likelihood of audit|trigger an audit|flagged)\b/i,
    reply:
      "I can't assess audit exposure for your return. That depends on your full filing picture, " +
      "not just the hours in this app.",
  },
  {
    id: 'optimization',
    test: /\b(how (do|can) i (get to|reach|hit|pass|qualify)|what.?s the (fastest|easiest) way to (qualify|pass)|minimum (hours|i need)|just enough|enough hours to)\b/i,
    reply:
      "I'd rather not help reverse-engineer a threshold. Material participation is supposed to " +
      "describe work you actually did — logs built backwards from a target are the ones that fail " +
      "in an examination. I'm happy to explain what each test requires, and you can log honestly against it.",
  },
  {
    id: 'fabrication',
    test: /\b(backdate|back-date|make up|fabricate|reconstruct (my|the) (hours|log)|estimate (my )?(past|prior) hours|fill in (the )?(missing|gaps)|what should i (write|put|say))\b/i,
    reply:
      "I can't help with that. Reconstructed or estimated hours are precisely what gets REPS and STR " +
      "claims disallowed, and this app timestamps when each entry was created — so a log filled in " +
      "afterward is visible as one. Log what you can substantiate going forward; that record is worth " +
      "far more than a fuller one you can't defend.",
  },
  {
    id: 'other_tax',
    test: /\b(cost segregation|1031|bonus depreciation|entity structure|s-?corp|llc election|estate|payroll|crypto|k-?1 allocation)\b/i,
    reply:
      "That's outside what I cover — I'm limited to REPS and short-term rental material participation " +
      "under §469, and specifically to your logged hours.",
  },
];

/* ---------------------------------------------------------------------------
 * 2. System prompt
 * ------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You are Remy, a reference assistant inside RepsRecord, an hour-tracking app for
IRC §469 real estate positions. You were built by an Enrolled Agent and former IRS Revenue Agent.

WHAT YOU DO
1. Explain what the law requires — the 750-hour and 50% services tests under §469(c)(7)(B), the seven
   material participation tests under Temp. Reg. §1.469-5T(a), the short-term rental exception under
   Temp. Reg. §1.469-1T(e)(3), and the limitations that survive a non-passive determination.
2. Read back what the user's own logged data shows, using only the figures in the context block below.
3. Explain how to use the app.

WHAT YOU DO NOT DO
- You never tell a user whether they qualify, will qualify, or should take a position. State what the
  test requires and what their data currently shows; stop there.
- You never suggest hours a user could log, estimate unlogged time, or help reconstruct a past period.
- You never help a user reach a threshold. If asked how to get to 100 or 500 hours, explain what the
  test measures and say the log should reflect work actually performed.
- You never advise on entity structure, cost segregation, depreciation, §1031, or anything outside §469.
- You never characterize audit risk.

HOW YOU WRITE
- Plain language first, citation second. "You need more than 100 hours (§1.469-5T(a)(3))" — not a
  citation dump.
- Be accurate about strict versus inclusive thresholds. The 750-hour and 50% tests require EXCEEDING
  the threshold. Test 3 requires participation NOT LESS THAN any other individual — an equal-or-greater
  standard. The 7-day average rental period test is inclusive of 7.
- Never state that materially participating removes rental income from the 3.8% NIIT. Rental income is
  presumptively net investment income; relief generally requires the 500-hour safe harbor at
  Reg. §1.1411-4(g)(7) or trade or business status.
- Never say REPS is the only route to offsetting ordinary income. §469(i) allows up to $25,000 with
  active participation, phased out between $100,000 and $150,000 MAGI.
- Where a user is pursuing material participation through substantial guest services, mention that
  short-term rental income may be subject to self-employment tax.
- When a test is shown as unavailable in the user's data, explain WHY the regulation forecloses it.
  Do not suggest workarounds.

WHEN TO HAND OFF
If a question calls for judgement about this user's position, say so plainly and point to a
consultation. Do not hedge your way into answering anyway. Do not tell the user to "consult your CPA" —
the practitioner who built this app is an Enrolled Agent and can take the question directly.

Keep answers short. Two or three paragraphs at most.`;

/* ---------------------------------------------------------------------------
 * 3. Context builder — replaces buildRemyCtx (~2873)
 *
 * Sends only derived figures. No notes, no addresses, no attachments, no
 * entry-level detail. privacy.html must disclose whatever this sends.
 * ------------------------------------------------------------------------- */

function buildRemyContext(state, TaxEngine) {
  const year = state.taxYear;
  const reps = TaxEngine.calcREPS(state.repsInput);

  const properties = (state.properties || []).map((p) => {
    const gate = TaxEngine.strGate(p);
    const mp = TaxEngine.evaluateMPTests(p.facts, p.manual, p.options);
    return {
      label: p.name,
      type: p.type,
      averageRentalPeriodDays: gate.avg.days,
      averagePeriodSubstantiated: gate.avg.substantiated,
      periodTestPassed: gate.passes,
      yourHours: mp.combinedHours,
      highestOtherParticipantHours: mp.comparatorHours,
      paidManagerPresent: !!p.facts.otherCompensated,
      testStatus: Object.keys(mp.tests).reduce((acc, k) => {
        acc[k] = mp.tests[k].status;   // met | not_met | unavailable
        return acc;
      }, {}),
      materiallyParticipates: mp.materiallyParticipates,
      personalUseLimited: TaxEngine.personalUseLimitation(p).limited,
    };
  });

  return {
    taxYear: year,
    reps: {
      countableHours: reps.countableREHours,
      hoursTest: reps.hoursTest.status,
      servicesPercent: reps.servicesPct,
      servicesTest: reps.servicesTest.status,
      nonREHoursEntered: reps.nonREHours > 0,
      employeeRuleApplied: reps.employeeRuleApplied,
      qualified: reps.qualified,
    },
    properties,
    groupingElectionOnFile: !!state.settings.groupingElection,
    spousePolicy: state.settings.spouseHoursPolicy || 'majority',
  };
}

/* ---------------------------------------------------------------------------
 * 4. Entry point — wrap remySend (~2935)
 * ------------------------------------------------------------------------- */

function screenMessage(text) {
  const t = String(text || '');
  for (const rule of ROUTE_TO_HUMAN) {
    if (rule.test.test(t)) {
      return { allowed: false, ruleId: rule.id, reply: rule.reply };
    }
  }
  return { allowed: true };
}

function buildRequest(userMessage, state, TaxEngine) {
  const screen = screenMessage(userMessage);
  if (!screen.allowed) return { blocked: true, ruleId: screen.ruleId, reply: screen.reply };

  return {
    blocked: false,
    system: SYSTEM_PROMPT,
    context: buildRemyContext(state, TaxEngine),
    message: userMessage,
  };
}

/**
 * Log every exchange for your own review. You are accountable for what this
 * says under your credential; you cannot review what you did not record.
 * Store server-side, not in localStorage.
 */
function auditRecord(userId, userMessage, result, responseText) {
  return {
    user_id: userId,
    created_at: new Date().toISOString(),
    message: userMessage,
    blocked: !!result.blocked,
    rule_id: result.ruleId || null,
    response: responseText || result.reply || null,
  };
}

const RemyGuardrails = {
  SYSTEM_PROMPT, ROUTE_TO_HUMAN,
  screenMessage, buildRemyContext, buildRequest, auditRecord,
};

if (typeof module !== 'undefined' && module.exports) module.exports = RemyGuardrails;
if (typeof window !== 'undefined') window.RemyGuardrails = RemyGuardrails;
