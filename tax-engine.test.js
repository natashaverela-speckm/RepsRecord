/**
 * tax-engine.test.js
 * Run with:  node --test tax-engine.test.js
 * No dependencies. Node 18+.
 *
 * These cases encode the boundary conditions that the review found unguarded.
 * If any of these fail, the app can report a qualification the regulation
 * forecloses — which is the single most damaging defect class for software
 * carrying a practitioner credential.
 */

'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Resolve the engine whether this file sits beside it or in a tests/ subfolder.
const T = (() => {
  for (const p of ['./tax-engine.js', '../tax-engine.js', '../public/tax-engine.js']) {
    try { return require(p); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error('tax-engine.js not found — set the path for your layout');
})();

/* ---------------------------------------------------------------------------
 * REPS — IRC §469(c)(7)(B)
 * ------------------------------------------------------------------------- */

test('750-hour test is a strict inequality — exactly 750 fails', () => {
  const r = T.calcREPS({ reHours: 750, nonREHours: 0 });
  assert.equal(r.hoursTest.met, false);
});

test('750-hour test passes above the threshold', () => {
  const r = T.calcREPS({ reHours: 750.5, nonREHours: 100 });
  assert.equal(r.hoursTest.met, true);
});

test('50% test is a strict inequality — exactly 50% fails', () => {
  const r = T.calcREPS({ reHours: 1000, nonREHours: 1000 });
  assert.equal(r.servicesTest.met, false);
  assert.equal(r.servicesPct, 50);
});

test('blank non-RE hours does not silently pass the 50% test', () => {
  const r = T.calcREPS({ reHours: 900, nonREHours: 0 });
  assert.equal(r.servicesTest.incomplete, true);
});

test('full-time W-2 requires RE hours to exceed total W-2 hours, not just 750', () => {
  const r = T.calcREPS({ reHours: 900, nonREHours: 2080 });
  assert.equal(r.hoursTest.met, true);
  assert.equal(r.servicesTest.met, false, '900 < 2080 must fail the 50% test');
});

test('employee hours are excluded when ownership is under 5% — §469(c)(7)(D)(ii)', () => {
  const r = T.calcREPS({ reHours: 1800, employeeHours: 1500, ownershipPct: 0, nonREHours: 100 });
  assert.equal(r.countableREHours, 300);
  assert.equal(r.hoursTest.met, false);
  assert.equal(r.employeeRuleApplied, true);
});

test('employee hours count at 5% ownership or more', () => {
  const r = T.calcREPS({ reHours: 1800, employeeHours: 1500, ownershipPct: 5, nonREHours: 100 });
  assert.equal(r.countableREHours, 1800);
  assert.equal(r.hoursTest.met, true);
});

/* ---------------------------------------------------------------------------
 * Test 7 gating — REVIEW FINDING C-3. These are the regressions to prevent.
 * ------------------------------------------------------------------------- */

test('C-3: Test 7 is UNAVAILABLE below 100 hours even if self-certified', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 18, otherHoursMax: 60, otherHoursTotal: 60, otherCompensated: false },
    { t7: true }
  );
  assert.equal(r.tests.t7.status, 'unavailable');
  assert.equal(r.tests.t7.met, false);
  assert.equal(r.materiallyParticipates, false);
});

test('C-3: Test 7 is UNAVAILABLE when a manager is compensated, at any hour count', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 400, otherHoursMax: 50, otherHoursTotal: 50, otherCompensated: true },
    { t7: true }
  );
  assert.equal(r.tests.t7.status, 'unavailable');
});

test('C-3: Test 7 is UNAVAILABLE when another individual does more management hours', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 150, otherHoursMax: 200, otherHoursTotal: 200, otherCompensated: false },
    { t7: true }
  );
  assert.equal(r.tests.t7.status, 'unavailable');
});

test('Test 7 self-certification is honoured when the facts permit it', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 150, otherHoursMax: 40, otherHoursTotal: 40, otherCompensated: false },
    { t7: true }
  );
  assert.equal(r.tests.t7.met, true);
});

test('C-3: a stale manual flag cannot survive a change in facts', () => {
  const facts = { taxpayerHours: 150, otherHoursMax: 40, otherHoursTotal: 40, otherCompensated: false };
  assert.equal(T.evaluateMPTests(facts, { t7: true }).tests.t7.met, true);
  // Owner later hires a paid co-host. Flag is unchanged in storage.
  const after = T.evaluateMPTests(Object.assign({}, facts, { otherCompensated: true }), { t7: true });
  assert.equal(after.tests.t7.met, false);
});

/* ---------------------------------------------------------------------------
 * Test 2 gating
 * ------------------------------------------------------------------------- */

test('C-3: Test 2 is UNAVAILABLE when others hold material recorded hours', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 18, otherHoursMax: 60, otherHoursTotal: 60 },
    { t2: true }
  );
  assert.equal(r.tests.t2.status, 'unavailable');
});

test('Test 2 remains available for a genuine solo operator', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 300, otherHoursMax: 2, otherHoursTotal: 2 },
    { t2: true }
  );
  assert.equal(r.tests.t2.met, true);
});

/* ---------------------------------------------------------------------------
 * Test 3 — "not less than", REVIEW FINDING M-4
 * ------------------------------------------------------------------------- */

test('M-4: Test 3 passes on an exact tie — the standard is "not less than"', () => {
  const r = T.evaluateMPTests({ taxpayerHours: 150, otherHoursMax: 150, otherHoursTotal: 150 }, {});
  assert.equal(r.tests.t3.met, true);
});

test('Test 3 requires MORE than 100 hours — exactly 100 fails', () => {
  const r = T.evaluateMPTests({ taxpayerHours: 100, otherHoursMax: 10, otherHoursTotal: 10 }, {});
  assert.equal(r.tests.t3.met, false);
});

test('Test 3 fails when another participant does more', () => {
  const r = T.evaluateMPTests({ taxpayerHours: 120, otherHoursMax: 156, otherHoursTotal: 156 }, {});
  assert.equal(r.tests.t3.met, false);
});

/* ---------------------------------------------------------------------------
 * Spouse attribution — REVIEW FINDING M-3
 * ------------------------------------------------------------------------- */

test('spouse hours combine for Test 1 under §469(h)(5)', () => {
  const r = T.evaluateMPTests({ taxpayerHours: 300, spouseHours: 250 }, {});
  assert.equal(r.tests.t1.met, true);
});

test('M-3: majority vs conservative policy changes the Test 3 comparator', () => {
  const facts = { taxpayerHours: 120, spouseHours: 200, otherHoursMax: 50, otherHoursTotal: 50 };
  const majority = T.evaluateMPTests(facts, {}, { spousePolicy: 'majority' });
  const conservative = T.evaluateMPTests(facts, {}, { spousePolicy: 'conservative' });
  assert.equal(majority.tests.t3.met, true);
  assert.equal(conservative.comparatorHours, 200);
  assert.equal(conservative.tests.t3.met, true, '320 combined still >= 200');
});

/* ---------------------------------------------------------------------------
 * Test 4 SPA — REVIEW FINDING M-5
 * ------------------------------------------------------------------------- */

test('M-5: a rental activity cannot be a significant participation activity', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 200, isRentalActivity: true },
    { t4: true },
    { spaAggregateHours: 900 }
  );
  assert.equal(r.tests.t4.status, 'unavailable');
});

test('M-5: SPA unavailable where the taxpayer already materially participates via Test 1', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 600, isRentalActivity: false },
    { t4: true },
    { spaAggregateHours: 900 }
  );
  assert.equal(r.tests.t4.status, 'unavailable');
});

test('SPA requires aggregate participation above 500 hours', () => {
  const r = T.evaluateMPTests(
    { taxpayerHours: 150, isRentalActivity: false },
    { t4: true },
    { spaAggregateHours: 450 }
  );
  assert.equal(r.tests.t4.met, false);
});

/* ---------------------------------------------------------------------------
 * Test 5
 * ------------------------------------------------------------------------- */

test('Test 5 requires 5 confirmed prior years', () => {
  assert.equal(T.evaluateMPTests({}, { priorYears: [2021, 2022, 2023, 2024] }).tests.t5.met, false);
  assert.equal(T.evaluateMPTests({}, { priorYears: [2020, 2021, 2022, 2023, 2024] }).tests.t5.met, true);
});

/* ---------------------------------------------------------------------------
 * STR gate — REVIEW FINDING H-3
 * ------------------------------------------------------------------------- */

test('H-3: computed average from bookings is authoritative over a manual figure', () => {
  const g = T.strGate({
    avgRentalDays: 4.5,
    bookings: [{ nights: 10 }, { nights: 12 }, { nights: 14 }],
  });
  assert.equal(g.avg.days, 12);
  assert.equal(g.avg.source, 'computed');
  assert.equal(g.passes, false, '12-day average must not pass the 7-day gate');
});

test('H-3: a manual figure with no bookings is flagged unsubstantiated', () => {
  const g = T.strGate({ avgRentalDays: 4.5, bookings: [] });
  assert.equal(g.avg.substantiated, false);
  assert.equal(g.avg.source, 'manual');
  assert.ok(g.avg.warning);
});

test('7-day gate is inclusive — exactly 7 days passes', () => {
  assert.equal(T.strGate({ bookings: [{ nights: 7 }] }).passes, true);
});

test('8 to 30 days requires significant personal services', () => {
  assert.equal(T.strGate({ bookings: [{ nights: 20 }] }).passes, false);
  assert.equal(
    T.strGate({ bookings: [{ nights: 20 }], significantPersonalServices: true }).passes,
    true
  );
});

test('above 30 days remains a rental activity', () => {
  const g = T.strGate({ bookings: [{ nights: 45 }] });
  assert.equal(g.status, 'rental');
});

/* ---------------------------------------------------------------------------
 * §280A and §469(i) — REVIEW FINDINGS M-9 and H-1
 * ------------------------------------------------------------------------- */

test('M-9: personal use above the greater of 14 days or 10% triggers the §280A limit', () => {
  assert.equal(T.personalUseLimitation({ personalUseDays: 20, rentalDays: 100 }).limited, true);
  assert.equal(T.personalUseLimitation({ personalUseDays: 12, rentalDays: 100 }).limited, false);
  // 10% of 300 = 30, which exceeds 14, so 25 days is within the threshold.
  assert.equal(T.personalUseLimitation({ personalUseDays: 25, rentalDays: 300 }).limited, false);
});

test('H-1: §469(i) allowance phases out between $100k and $150k MAGI', () => {
  assert.equal(T.specialAllowance(90000, true).available, 25000);
  assert.equal(T.specialAllowance(125000, true).available, 12500);
  assert.equal(T.specialAllowance(150001, true).available, 0);
  assert.equal(T.specialAllowance(50000, false).available, 0);
});
