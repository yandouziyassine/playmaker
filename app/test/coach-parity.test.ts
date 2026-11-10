// Python <-> TypeScript parity, ported from the portfolio site (tests/coach-parity.test.mjs): the frames in
// fixtures/coach-parity.json were computed by the library's coach/parity_fixtures.py on real tracking frames
// (IDSSE match J03WOH, CC BY 4.0). Same features, probabilities, values and ranking within 1e-6, explanations too.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { options, valueAt, type CoachOption } from "../src/coach/advice.ts";
import { PHRASES, explainOptions } from "../src/coach/explain.ts";
import { passFeatures, shotFeatures, valueFeatures, type Features, type State } from "../src/coach/features.ts";
import { coachFromModels, type ModelsJson } from "../src/coach/models.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fx: any = JSON.parse(readFileSync(new URL("./fixtures/coach-parity.json", import.meta.url), "utf8"));
const shipped: ModelsJson = JSON.parse(readFileSync(new URL("../public/coach/models.json", import.meta.url), "utf8"));
const TOL = 1e-6;
const coach = coachFromModels(fx.models);
const stateOf = (r: any): State => ({ att: r.state.att, attV: r.state.att_v, def: r.state.def, defV: r.state.def_v,
  attIdx: r.state.att_idx, defIdx: r.state.def_idx, ball: r.state.ball, direction: r.state.direction });
const key = (o: Pick<CoachOption, "kind" | "target" | "angle">) => (o.kind === "pass" ? `pass:${o.target}` : o.kind === "carry" ? `carry:${o.angle}` : "shot");
const close = (got: Features, want: Record<string, number>, what: string) => {
  for (const k of Object.keys(want)) expect(Math.abs(got[k]! - want[k]!), `${what}: ${k}`).toBeLessThan(TOL);
};

describe("coach parity with Python on real frames", () => {
  it("the shipped weights are the fixture's (models.json copied unchanged, credit fields kept)", () => {
    expect(shipped).toEqual(fx.models);
    expect(shipped.trained_on.length).toBeGreaterThan(0);
  });
  it("covers at least 20 frames from both halves", () => {
    expect(fx.frames.length).toBeGreaterThanOrEqual(20);
    expect(new Set(fx.frames.map((r: any) => r.half))).toEqual(new Set([0, 1]));
  });
  for (const r of fx.frames) {
    it(`half ${r.half}, frame ${r.frame}: features, probabilities, values and ranking`, () => {
      const s = stateOf(r);
      for (const { target, ...want } of r.pass_features) close(passFeatures(s, r.carrier_row, s.attIdx.indexOf(target), coach.pc), want, `pass to ${target}`);
      close(valueFeatures(s.att[r.carrier_row]!), r.value_features, "value");
      close(shotFeatures(s.att[r.carrier_row]!, s.def), r.shot_features, "shot");
      const got = options(s, r.carrier_row, coach);
      expect(got.map(key)).toEqual(r.options.map(key));
      got.forEach((o, i) => {
        const w = r.options[i];
        for (const k of ["p", "value", "score"] as const) expect(Math.abs(o[k] - w[k]), `${key(o)} ${k}`).toBeLessThan(TOL);
        if (w.v_lost !== undefined) expect(Math.abs(o.vLost! - w.v_lost), `${key(o)} v_lost`).toBeLessThan(TOL);
        expect(Math.max(Math.abs(o.to[0] - w.to[0]), Math.abs(o.to[1] - w.to[1])), `${key(o)} to`).toBeLessThan(TOL);
      });
    });
  }
});

describe("explanations: same contributions and phrases as Python", () => {
  it("the phrase table is the library's", () => {
    expect(PHRASES).toEqual(fx.explain.phrases);
  });
  let compared = 0;
  for (const r of fx.frames) {
    it(`half ${r.half}, frame ${r.frame}: contributions to 1e-9, phrases identical unless fragile`, () => {
      const s = stateOf(r);
      const opts = options(s, r.carrier_row, coach);
      const vNow = valueAt(coach, s.att[r.carrier_row]!);
      expect(Math.abs(vNow - r.v_now)).toBeLessThan(TOL);
      const got = explainOptions(s, r.carrier_row, opts, fx.models, vNow, coach.pc);
      expect(got.length).toBe(r.explanations.length);
      got.forEach((g, i) => {
        const w = r.explanations[i];
        expect(g.kind).toBe(w.kind);
        expect(g.contributions.map((c) => c.feature)).toEqual(w.contributions.map((c: any) => c.feature));
        g.contributions.forEach((c, k) => expect(Math.abs(c.contribution - w.contributions[k].contribution), `${w.kind} ${c.feature}`).toBeLessThan(1e-9));
        for (const k of Object.keys(w.value_terms)) expect(Math.abs(g.valueTerms[k]! - w.value_terms[k]), `${w.kind} ${k}`).toBeLessThan(1e-9);
        expect(g.phrases.length).toBe(w.phrases.length);
        if (!w.fragile) { expect(g.phrases).toEqual(w.phrases); expect(g.signs).toEqual(w.signs); compared++; }
      });
    });
  }
  it("most options were compared by text", () => {
    const total = fx.frames.reduce((n: number, r: any) => n + r.explanations.length, 0);
    expect(compared).toBeGreaterThan(total * 0.9);
  });
});
