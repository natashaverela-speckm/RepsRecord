/**
 * tax-engine.js — RepsRecord qualification logic
 * -----------------------------------------------------------------------------
 * Pure, dependency-free determination logic for IRC §469 real estate positions.
 * No DOM access, no network, no globals. Everything here is a pure function of
 * its inputs so it can be unit tested and reasoned about independently of the UI.
 *
 * Extracted from app.js lines ~600-731 (calcREPS, incomplete50, mpT,
 * mpGroupedLTR, ltrGroupMet, strGate, strQualifies).
 *
 * DESIGN PRINCIPLE
 * Every test returns a structured verdict, never a bare boolean:
 *
 *   { met, status, reason, citation, blocked, remaining }
 *
 * `status` is one of: 'met' | 'not_met' | 'unavailable' | 'needs_election'
 *
 * 'unavailable' means the regulation FORECLOSES the test on these facts. The UI
 * must render those controls disabled. This is the fix for review finding C-3:
 * previously a user could self-certify Test 7 with 18 hours logged, which
 * Temp. Reg. §1.469-5T(b)(2)(iii) categorically prohibits.
 *
 * IMPORTANT: manual self-certification flags are inputs, not outputs. They are
 * always re-validated here. A stale manualMP flag stored from an earlier state
 * of the facts can never survive a change in those facts.
 */

'use strict';

/* ============================================================================
 * Constants — thresholds fixed by statute or regulation
 * ========================================================================== */

const THRESHOLDS = Object.freeze({
  REPS_HOURS: 750,              // IRC §469(c)(7)(B)(ii) — must EXCEED
  REPS_SERVICES_PCT: 50,        // IRC §469(c)(7)(B)(i)  — must EXCEED
  EMPLOYEE_OWNERSHIP_PCT: 5,    // IRC §469(c)(7)(D)(ii)
  MP_500: 500,                  // Temp. Reg. §1.469-5T(a)(1)
  MP_100: 100,                  // §1.469-5T(a)(3), (a)(4), (b)(2)(iii)
  SPA_AGGREGATE: 500,           // §1.469-5T(a)(4)
  PRIOR_YEARS_5_OF_10: 5,       // §1.469-5T(a)(5)
  PRIOR_YEARS_3: 3,             // §1.469-5T(a)(6)
  STR_PERIOD_DAYS: 7,           // Temp. Reg. §1.469-1T(e)(3)(ii)(A)
  STR_PERIOD_DAYS_SPS: 30,      // Temp. Reg. §1.469-1T(e)(3)(ii)(B)
  NIIT_SAFE_HARBOR_HOURS: 500,  // Reg. §1.1411-4(g)(7)
  SEC_280A_DAYS: 14,            // IRC §280A(d)(1)
  SEC_280A_PCT_OF_RENTAL: 0.10, // IRC §280A(d)(1) — greater of 14 days or 10%
  // Practitioner convention only. "Substantially all" is UNDEFINED in the
  // regulations. This is NOT a safe harbor. See review finding M-1.
  SUBSTANTIALLY_ALL_CONVENTION: 0.95,
});

const CITE = Object.freeze({
  REPS_HOURS: 'IRC §469(c)(7)(B)(ii)',
  REPS_SERVICES: 'IRC §469(c)(7)(B)(i)',
  REPS_JOINT: 'IRC §469(c)(7)(B) (flush language)',
  EMPLOYEE: 'IRC §469(c)(7)(D)(ii)',
  GROUPING: 'Reg. §1.469-9(g)',
  GROUPING_STATUTE: 'IRC §469(c)(7)(A)',
  SPOUSE: 'IRC §469(h)(5); Temp. Reg. §1.469-5T(f)(3)',
  T1: 'Temp. Reg. §1.469-5T(a)(1)',
  T2: 'Temp. Reg. §1.469-5T(a)(2)',
  T3: 'Temp. Reg. §1.469-5T(a)(3)',
  T4: 'Temp. Reg. §1.469-5T(a)(4); (c)(2)',
  T5: 'Temp. Reg. §1.469-5T(a)(5)',
  T6: 'Temp. Reg. §1.469-5T(a)(6)',
  T7: 'Temp. Reg. §1.469-5T(a)(7)',
  T7_LIMITS: 'Temp. Reg. §1.469-5T(b)(2)(ii)-(iii)',
  INVESTOR: 'Temp. Reg. §1.469-5T(f)(2)(ii)',
  STR_PERIOD: 'Temp. Reg. §1.469-1T(e)(3)(ii)(A)',
  STR_SPS: 'Temp. Reg. §1.469-1T(e)(3)(ii)(B)',
  STR_AVG_CALC: 'Temp. Reg. §1.469-1T(e)(3)(iii)',
  SEC_469I: 'IRC §469(i)',
  SEC_280A: 'IRC §280A(c)(5), (d)(1)',
  SEC_461L: 'IRC §461(l)',
  SEC_465: 'IRC §465',
  NIIT: 'Reg. §1.1411-4(g)(7)',
});

/* ============================================================================
 * Helpers
 * ========================================================================== */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round(v * 100) / 100;

function verdict(status, reason, citation, extra) {
  return Object.assign(
    { met: status === 'met', status, reason, citation },
    extra || {}
  );
}

/**
 * Spouse attribution policy for the "any other individual" comparison in
 * Tests 3 and 7. This is a genuinely unsettled question — see review M-3.
 *
 *   'majority'     — spouse hours are the taxpayer's own, so the spouse is not
 *                    "any other individual". Default.
 *   'conservative' — spouse counted as a third-party participant.
 */
function spouseIsOtherIndividual(policy) {
  return policy === 'conservative';
}

/* ============================================================================
 * REPS qualification — IRC §469(c)(7)(B)
 * ========================================================================== */

/**
 * @param {object} input
 * @param {number} input.reHours            Taxpayer's own qualifying RPTB hours.
 * @param {number} input.nonREHours         All other personal services (W-2 etc).
 * @param {number} input.employeeHours      Portion of reHours performed as an employee.
 * @param {number} input.ownershipPct       Ownership % of the employing entity.
 * @param {boolean} input.includeSTRinREPS  Whether STR hours roll into the 750.
 * @param {number} input.strHours
 *
 * NOTE ON SPOUSES: only the qualifying spouse's own hours count toward the 750
 * and 50% tests. Spouse hours are deliberately NOT accepted by this function.
 */
function calcREPS(input) {
  const employeeHours = num(input.employeeHours);
  const ownershipPct = num(input.ownershipPct);

  // §469(c)(7)(D)(ii): employee hours are disregarded entirely unless the
  // taxpayer owns 5%+ of the employer. Most common disqualifier for licensed
  // agents working under a brokerage they do not own.
  const employeeHoursDisallowed =
    employeeHours > 0 && ownershipPct < THRESHOLDS.EMPLOYEE_OWNERSHIP_PCT
      ? employeeHours
      : 0;

  const strContribution = input.includeSTRinREPS ? num(input.strHours) : 0;
  const countableREHours =
    Math.max(0, num(input.reHours) - employeeHoursDisallowed) + strContribution;

  const nonREHours = num(input.nonREHours);
  const totalServices = countableREHours + nonREHours;
  const servicesPct = totalServices > 0 ? (countableREHours / totalServices) * 100 : 0;

  // Both tests are strict inequalities.
  const hoursMet = countableREHours > THRESHOLDS.REPS_HOURS;
  const servicesMet = totalServices > 0 && servicesPct > THRESHOLDS.REPS_SERVICES_PCT;

  return {
    countableREHours: round2(countableREHours),
    employeeHoursDisallowed: round2(employeeHoursDisallowed),
    employeeRuleApplied: employeeHoursDisallowed > 0,
    nonREHours: round2(nonREHours),
    servicesPct: round2(servicesPct),

    hoursTest: verdict(
      hoursMet ? 'met' : 'not_met',
      hoursMet
        ? `${round2(countableREHours)} hrs exceeds the 750-hour threshold.`
        : `${round2(countableREHours)} hrs logged; must EXCEED 750. ` +
          `${round2(THRESHOLDS.REPS_HOURS + 0.01 - countableREHours)} hrs remaining.`,
      CITE.REPS_HOURS,
      { remaining: Math.max(0, round2(THRESHOLDS.REPS_HOURS - countableREHours)) }
    ),

    servicesTest: verdict(
      servicesMet ? 'met' : 'not_met',
      totalServices === 0
        ? 'Enter your non-real-estate hours so this test can be evaluated. ' +
          'Leaving it blank does not make it pass.'
        : servicesMet
          ? `${round2(servicesPct)}% of personal services are in real property trades or businesses.`
          : `${round2(servicesPct)}% of personal services are in real property trades or businesses; must EXCEED 50%.`,
      CITE.REPS_SERVICES,
      { incomplete: totalServices === 0 || nonREHours === 0 }
    ),

    qualified: hoursMet && servicesMet,

    notes: employeeHoursDisallowed > 0
      ? [`${round2(employeeHoursDisallowed)} hrs performed as an employee are excluded ` +
         `because ownership of the employing entity is under 5%. ${CITE.EMPLOYEE}`]
      : [],
  };
}

/* ============================================================================
 * Material participation — Temp. Reg. §1.469-5T(a)(1)-(7)
 * ========================================================================== */

/**
 * @param {object} a  Activity facts
 * @param {number} a.taxpayerHours
 * @param {number} a.spouseHours
 * @param {number} a.otherHoursMax        Hours of the single highest other participant.
 * @param {number} a.otherHoursTotal      All other participants combined.
 * @param {boolean} a.otherCompensated    Is ANY other person paid to manage?
 * @param {boolean} a.isRentalActivity    True for LTR; false once STR gate passes.
 * @param {object} m  Manual elections { t2, t4, t6, t7 } and { priorYears: [] }
 * @param {object} o  Options { spousePolicy, spaAggregateHours, spaCount }
 */
function evaluateMPTests(a, m, o) {
  m = m || {};
  o = o || {};
  const policy = o.spousePolicy || 'majority';

  const tp = num(a.taxpayerHours);
  const sp = num(a.spouseHours);
  const otherMax = num(a.otherHoursMax);
  const otherTotal = num(a.otherHoursTotal);

  // §469(h)(5): spouse participation is attributed to the taxpayer.
  const combined = tp + sp;

  // Under the conservative policy the spouse is also counted on the other side
  // of the "any other individual" comparison in Tests 3 and 7.
  const comparator = spouseIsOtherIndividual(policy)
    ? Math.max(otherMax, sp)
    : otherMax;

  const tests = {};

  /* -- Test 1: more than 500 hours ---------------------------------------- */
  tests.t1 = combined > THRESHOLDS.MP_500
    ? verdict('met', `${round2(combined)} hrs exceeds 500.`, CITE.T1)
    : verdict('not_met',
        `${round2(combined)} hrs logged; ${round2(THRESHOLDS.MP_500 - combined)} more needed to exceed 500.`,
        CITE.T1,
        { remaining: round2(THRESHOLDS.MP_500 - combined) });

  /* -- Test 2: substantially all ------------------------------------------ */
  // GATE (review C-3): where other participants have material recorded hours,
  // "substantially all" cannot be satisfied and the election is unavailable.
  const totalAllParticipants = combined + otherTotal;
  const tpShare = totalAllParticipants > 0 ? combined / totalAllParticipants : 0;

  if (otherTotal > 0 && tpShare < THRESHOLDS.SUBSTANTIALLY_ALL_CONVENTION) {
    tests.t2 = verdict('unavailable',
      `Other participants account for ${round2((1 - tpShare) * 100)}% of recorded hours ` +
      `(${round2(otherTotal)} hrs). "Substantially all" is not satisfied on these facts. ` +
      `Note: the standard is undefined in the regulations; 95% is a practitioner ` +
      `convention, not a safe harbor.`,
      CITE.T2,
      { blocked: true });
  } else if (m.t2) {
    tests.t2 = verdict('met', 'Self-certified. Retain documentation.', CITE.T2, { manual: true });
  } else {
    tests.t2 = verdict('not_met', 'Not certified.', CITE.T2, { manual: true });
  }

  /* -- Test 3: more than 100 hours AND not less than any other individual -- */
  // The statute says "not less than" — an equal-or-greater standard, NOT
  // strictly greater. See review finding M-4.
  const t3Hours = combined > THRESHOLDS.MP_100;
  const t3Compare = combined >= comparator;

  if (t3Hours && t3Compare) {
    tests.t3 = verdict('met',
      `${round2(combined)} hrs exceeds 100 and is not less than the highest other ` +
      `participant (${round2(comparator)} hrs).`,
      CITE.T3);
  } else {
    const needs = [];
    if (!t3Hours) needs.push(`${round2(THRESHOLDS.MP_100 + 0.01 - combined)} more hrs to exceed the 100-hour floor`);
    if (!t3Compare) needs.push(`at least ${round2(comparator)} hrs to match the highest other participant`);
    tests.t3 = verdict('not_met', `Needs ${needs.join(' and ')}.`, CITE.T3, {
      floorMet: t3Hours,
      comparatorHours: round2(comparator),
    });
  }

  /* -- Test 4: significant participation activities ------------------------ */
  // An SPA must be a TRADE OR BUSINESS activity in which the taxpayer does NOT
  // otherwise materially participate. Rental activities cannot be SPAs.
  // See review finding M-5.
  if (a.isRentalActivity) {
    tests.t4 = verdict('unavailable',
      'A rental activity cannot be a significant participation activity — an SPA ' +
      'must be a trade or business activity. This test is unavailable for long-term ' +
      'rentals that have not passed an exception to rental characterization.',
      CITE.T4,
      { blocked: true });
  } else if (combined <= THRESHOLDS.MP_100) {
    tests.t4 = verdict('unavailable',
      `An SPA requires more than 100 hours in the activity; ${round2(combined)} hrs logged.`,
      CITE.T4,
      { blocked: true });
  } else if (tests.t1.met) {
    tests.t4 = verdict('unavailable',
      'An SPA must be an activity in which you do NOT otherwise materially ' +
      'participate. Test 1 is already satisfied for this activity.',
      CITE.T4,
      { blocked: true });
  } else if (m.t4) {
    const agg = num(o.spaAggregateHours);
    if (agg > THRESHOLDS.SPA_AGGREGATE) {
      tests.t4 = verdict('met',
        `Aggregate significant participation of ${round2(agg)} hrs exceeds 500.`,
        CITE.T4, { manual: true });
    } else {
      tests.t4 = verdict('not_met',
        `Aggregate significant participation across all SPAs is ${round2(agg)} hrs; must exceed 500.`,
        CITE.T4, { manual: true });
    }
  } else {
    tests.t4 = verdict('not_met', 'Not certified.', CITE.T4, { manual: true });
  }

  /* -- Test 5: 5 of the last 10 years -------------------------------------- */
  const priorYears = Array.isArray(m.priorYears) ? m.priorYears.filter(Boolean) : [];
  tests.t5 = priorYears.length >= THRESHOLDS.PRIOR_YEARS_5_OF_10
    ? verdict('met',
        `Material participation confirmed for ${priorYears.length} of the 10 preceding years.`,
        CITE.T5, { manual: true, years: priorYears })
    : verdict('not_met',
        `${priorYears.length} of 10 preceding years confirmed; 5 required. ` +
        `Retain returns and prior logs substantiating each year.`,
        CITE.T5, { manual: true, years: priorYears });

  /* -- Test 6: 3 prior years, personal service activity --------------------- */
  if (a.isRentalActivity || a.isRental !== false) {
    // Rentals are essentially never personal service activities. Left available
    // but flagged, since the taxpayer may have an unusual fact pattern.
    tests.t6 = m.t6
      ? verdict('met', 'Self-certified as a personal service activity. Rare for rentals — retain documentation.', CITE.T6, { manual: true, caution: true })
      : verdict('not_met', 'Not certified. Rarely applicable to rental property.', CITE.T6, { manual: true, caution: true });
  } else {
    tests.t6 = m.t6
      ? verdict('met', 'Self-certified.', CITE.T6, { manual: true })
      : verdict('not_met', 'Not certified.', CITE.T6, { manual: true });
  }

  /* -- Test 7: facts and circumstances -------------------------------------- */
  // THIS IS THE FIX FOR REVIEW FINDING C-3.
  // §1.469-5T(b)(2)(iii): more than 100 hours is REQUIRED.
  // §1.469-5T(b)(2)(ii): unavailable if any person is COMPENSATED for managing
  //   the activity, or if any other individual performs more management hours.
  const t7Blocks = [];
  if (combined <= THRESHOLDS.MP_100) {
    t7Blocks.push(
      `Test 7 requires more than 100 hours of participation; ${round2(combined)} hrs logged ` +
      `(${round2(THRESHOLDS.MP_100 + 0.01 - combined)} more needed).`
    );
  }
  if (a.otherCompensated) {
    t7Blocks.push(
      'Test 7 is unavailable where any person is compensated for managing the activity. ' +
      'A paid property manager or co-host forecloses this test.'
    );
  }
  if (comparator > combined) {
    t7Blocks.push(
      `Test 7 is unavailable where another individual performs more management hours ` +
      `than you (${round2(comparator)} hrs vs your ${round2(combined)} hrs).`
    );
  }

  if (t7Blocks.length) {
    tests.t7 = verdict('unavailable', t7Blocks.join(' '), CITE.T7_LIMITS, { blocked: true });
  } else if (m.t7) {
    tests.t7 = verdict('met',
      'Self-certified as regular, continuous, and substantial participation. ' +
      'Retain a calendar, correspondence, and invoices evidencing ongoing involvement.',
      CITE.T7, { manual: true });
  } else {
    tests.t7 = verdict('not_met', 'Not certified.', CITE.T7, { manual: true });
  }

  const passing = Object.keys(tests).filter((k) => tests[k].met);

  return {
    tests,
    materiallyParticipates: passing.length > 0,
    passingTests: passing,
    combinedHours: round2(combined),
    comparatorHours: round2(comparator),
    spousePolicy: policy,
  };
}

/* ============================================================================
 * STR characterization gate — Temp. Reg. §1.469-1T(e)(3)
 * ========================================================================== */

/**
 * Computes the average period of customer use from booking records.
 * REVIEW FINDING H-3: a manually entered figure is accepted only when no
 * bookings exist, and is always reported as unsubstantiated.
 */
function averageRentalPeriod(property) {
  const bookings = Array.isArray(property.bookings) ? property.bookings : [];
  const valid = bookings.filter((b) => num(b.nights) > 0);

  if (valid.length > 0) {
    const totalNights = valid.reduce((s, b) => s + num(b.nights), 0);
    return {
      days: round2(totalNights / valid.length),
      source: 'computed',
      substantiated: true,
      bookingCount: valid.length,
      totalNights: round2(totalNights),
      citation: CITE.STR_AVG_CALC,
    };
  }

  const manual = num(property.avgRentalDays);
  return {
    days: manual > 0 ? round2(manual) : null,
    source: manual > 0 ? 'manual' : 'none',
    substantiated: false,
    bookingCount: 0,
    totalNights: 0,
    citation: CITE.STR_AVG_CALC,
    warning: manual > 0
      ? 'Average rental period was entered manually and is not supported by ' +
        'booking records. This is the threshold fact for the entire STR position. ' +
        'Add booking-level records before relying on this figure in an examination.'
      : 'No average rental period established. The STR exception cannot be evaluated.',
  };
}

function strGate(property) {
  const avg = averageRentalPeriod(property);

  if (avg.days === null) {
    return {
      passes: false,
      status: 'unknown',
      avg,
      reason: 'No average rental period established.',
      citation: CITE.STR_PERIOD,
    };
  }

  if (avg.days <= THRESHOLDS.STR_PERIOD_DAYS) {
    return {
      passes: true,
      status: 'period_7',
      avg,
      reason: `Average period of customer use is ${avg.days} days (7 or fewer), so the ` +
              `activity is not a rental activity and material participation governs.`,
      citation: CITE.STR_PERIOD,
      requiresSignificantPersonalServices: false,
    };
  }

  if (avg.days <= THRESHOLDS.STR_PERIOD_DAYS_SPS) {
    return {
      passes: !!property.significantPersonalServices,
      status: 'period_30_sps',
      avg,
      reason: property.significantPersonalServices
        ? `Average period of customer use is ${avg.days} days (30 or fewer) with ` +
          `significant personal services provided.`
        : `Average period of customer use is ${avg.days} days. This route requires ` +
          `significant personal services — a distinct and more demanding standard than ` +
          `ordinary cleaning and maintenance. Document the specific services provided ` +
          `on specific dates.`,
      citation: CITE.STR_SPS,
      requiresSignificantPersonalServices: true,
    };
  }

  return {
    passes: false,
    status: 'rental',
    avg,
    reason: `Average period of customer use is ${avg.days} days. The activity remains a ` +
            `rental activity subject to the passive loss rules; REPS is required for ` +
            `non-passive treatment.`,
    citation: CITE.STR_PERIOD,
  };
}

/* ============================================================================
 * Downstream limitations — surfaced at the point of conclusion (M-7, M-9)
 * ========================================================================== */

/**
 * §280A: where personal use exceeds the greater of 14 days or 10% of rental
 * days, deductions are limited to rental income regardless of the §469 result.
 * Review finding M-9.
 */
function personalUseLimitation(property) {
  const personalDays = num(property.personalUseDays);
  const rentalDays = num(property.rentalDays);
  if (personalDays === 0) return { limited: false, citation: CITE.SEC_280A };

  const threshold = Math.max(
    THRESHOLDS.SEC_280A_DAYS,
    rentalDays * THRESHOLDS.SEC_280A_PCT_OF_RENTAL
  );

  const limited = personalDays > threshold;
  return {
    limited,
    personalDays,
    thresholdDays: round2(threshold),
    citation: CITE.SEC_280A,
    reason: limited
      ? `Personal use of ${personalDays} days exceeds the §280A threshold of ` +
        `${round2(threshold)} days (greater of 14 days or 10% of rental days). ` +
        `The property is treated as a residence and deductions are limited to rental ` +
        `income — this applies regardless of your material participation result.`
      : `Personal use of ${personalDays} days is within the §280A threshold of ` +
        `${round2(threshold)} days.`,
  };
}

/**
 * Standing limitations that apply to every non-passive loss. These must be
 * shown wherever the app concludes that losses offset ordinary income.
 * Review finding M-7.
 */
const STANDING_LIMITATIONS = Object.freeze([
  { code: '§465', citation: CITE.SEC_465,
    text: 'At-risk rules limit deductions to the amount you have at risk in the activity.' },
  { code: 'basis', citation: 'IRC §704(d) / §1366',
    text: 'Losses cannot exceed your basis in the property or pass-through interest.' },
  { code: '§461(l)', citation: CITE.SEC_461L,
    text: 'The excess business loss limitation caps the net business loss deductible ' +
          'against non-business income each year; the excess carries forward as an NOL.' },
  { code: '§1411', citation: CITE.NIIT,
    text: 'Rental income is presumptively net investment income. Non-passive treatment ' +
          'alone does not remove it — relief generally requires the 500-hour real estate ' +
          'professional safe harbor or trade or business status.' },
  { code: 'SE tax', citation: 'IRC §1402',
    text: 'Where substantial personal services are provided to guests, short-term rental ' +
          'income may be subject to self-employment tax.' },
]);

/**
 * §469(i): the baseline available WITHOUT REPS. Review finding H-1.
 */
function specialAllowance(magi, activelyParticipates) {
  if (!activelyParticipates) {
    return { available: 0, citation: CITE.SEC_469I,
      reason: 'The $25,000 special allowance requires active participation.' };
  }
  const m = num(magi);
  let allowance = 25000;
  if (m > 150000) allowance = 0;
  else if (m > 100000) allowance = round2(25000 - (m - 100000) * 0.5);

  return {
    available: allowance,
    citation: CITE.SEC_469I,
    reason: allowance === 25000
      ? 'Up to $25,000 of rental losses may offset ordinary income with active participation.'
      : allowance === 0
        ? 'The special allowance is fully phased out above $150,000 MAGI.'
        : `The special allowance is partially phased out at $${m.toLocaleString()} MAGI.`,
  };
}

/* ============================================================================
 * Exports
 * ========================================================================== */

const TaxEngine = {
  THRESHOLDS, CITE,
  calcREPS,
  evaluateMPTests,
  averageRentalPeriod,
  strGate,
  personalUseLimitation,
  specialAllowance,
  STANDING_LIMITATIONS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = TaxEngine;
if (typeof window !== 'undefined') window.TaxEngine = TaxEngine;
