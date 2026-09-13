import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectDelimiter,
  parseCardsCsv,
  parseDelimited,
  stringifyCsv,
} from "../src/lib/csv.ts";

describe("parseDelimited", () => {
  it("parses plain rows", () => {
    assert.deepEqual(parseDelimited("a,b\nc,d"), [
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles quoted fields containing the delimiter", () => {
    assert.deepEqual(parseDelimited('a,"b,c",d'), [["a", "b,c", "d"]]);
  });

  it("unescapes doubled quotes", () => {
    assert.deepEqual(parseDelimited('"say ""hi""",next'), [['say "hi"', "next"]]);
  });

  it("keeps newlines inside quoted fields", () => {
    assert.deepEqual(parseDelimited('"line one\nline two",b'), [["line one\nline two", "b"]]);
  });

  it("accepts CRLF line endings", () => {
    assert.deepEqual(parseDelimited("a,b\r\nc,d\r\n"), [
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    assert.deepEqual(parseDelimited("﻿a,b"), [["a", "b"]]);
  });

  it("drops blank lines", () => {
    assert.deepEqual(parseDelimited("a,b\n\n\nc,d"), [
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("preserves genuinely empty trailing fields", () => {
    assert.deepEqual(parseDelimited("a,,c"), [["a", "", "c"]]);
  });
});

describe("detectDelimiter", () => {
  it("finds commas", () => {
    assert.equal(detectDelimiter("front,back\nq,a\nq2,a2"), ",");
  });

  it("finds tabs, as exported by Anki", () => {
    assert.equal(detectDelimiter("front\tback\nq\ta\nq2\ta2"), "\t");
  });

  it("finds semicolons", () => {
    assert.equal(detectDelimiter("front;back\nq;a\nq2;a2"), ";");
  });

  it("is not fooled by commas inside tab-separated text", () => {
    const tsv = "front\tback\nWho, exactly?\tPaul\nWhere, though?\tArrakis";
    assert.equal(detectDelimiter(tsv), "\t");
  });
});

describe("stringifyCsv", () => {
  it("quotes only the fields that need it", () => {
    const out = stringifyCsv([["plain", "has,comma", 'has"quote', "has\nnewline"]]);
    assert.equal(out, 'plain,"has,comma","has""quote","has\nnewline"');
  });

  it("round-trips through the parser", () => {
    const rows = [
      ["front", "back"],
      ['A "tricky" one, with commas', "line1\nline2"],
    ];
    assert.deepEqual(parseDelimited(stringifyCsv(rows)), rows);
  });

  it("renders null as an empty field", () => {
    assert.equal(stringifyCsv([["a", null, "c"]]), "a,,c");
  });
});

describe("parseCardsCsv", () => {
  it("reads a canonical header", () => {
    const res = parseCardsCsv("front,back\nWho is Paul?,The heir\n");
    assert.equal(res.hadHeader, true);
    assert.equal(res.cards.length, 1);
    assert.equal(res.cards[0].front, "Who is Paul?");
    assert.equal(res.cards[0].back, "The heir");
  });

  it("accepts alternative header names", () => {
    const res = parseCardsCsv("Question,Answer,Notes\nQ1,A1,note\n");
    assert.equal(res.cards[0].front, "Q1");
    assert.equal(res.cards[0].back, "A1");
    assert.equal(res.cards[0].hint, "note");
  });

  it("falls back to positional columns with no header", () => {
    const res = parseCardsCsv("Q1,A1\nQ2,A2");
    assert.equal(res.hadHeader, false);
    assert.equal(res.cards.length, 2);
    assert.equal(res.cards[1].front, "Q2");
  });

  it("splits tags on any common separator", () => {
    const res = parseCardsCsv("front,back,hint,tags\nq,a,,alpha beta;gamma");
    assert.deepEqual(res.cards[0].tags, ["alpha", "beta", "gamma"]);
  });

  it("records skipped rows with line numbers", () => {
    const res = parseCardsCsv("front,back\nq1,a1\nonlyfront,\n,onlyback\n");
    assert.equal(res.cards.length, 1);
    assert.equal(res.skipped.length, 2);
    assert.equal(res.skipped[0].line, 3);
    assert.equal(res.skipped[0].reason, "missing answer");
    assert.equal(res.skipped[1].reason, "missing question");
  });

  it("reads scheduling columns when the header declares them", () => {
    const csv = [
      "front,back,hint,tags,state,interval_days,ease,reps,lapses,due_at,total_reviews,correct_reviews",
      "q,a,,,review,12.5,2.35,7,1,2026-04-01T00:00:00.000Z,10,8",
    ].join("\n");
    const res = parseCardsCsv(csv);
    const s = res.cards[0].scheduling;
    assert.ok(s);
    assert.equal(s.state, "review");
    assert.equal(s.intervalDays, 12.5);
    assert.equal(s.ease, 2.35);
    assert.equal(s.reps, 7);
    assert.equal(s.correctReviews, 8);
    assert.equal(s.dueAt, "2026-04-01T00:00:00.000Z");
  });

  it("ignores scheduling for a plain two-column file", () => {
    const res = parseCardsCsv("front,back\nq,a");
    assert.equal(res.cards[0].scheduling, undefined);
  });

  it("rejects an unparseable due date rather than storing NaN", () => {
    const csv = "front,back,state,due_at\nq,a,review,not-a-date";
    const res = parseCardsCsv(csv);
    assert.equal(res.cards[0].scheduling?.dueAt, null);
  });

  it("auto-detects a tab-separated file", () => {
    const res = parseCardsCsv("front\tback\nq1\ta1\nq2\ta2");
    assert.equal(res.delimiter, "\t");
    assert.equal(res.cards.length, 2);
  });

  it("returns an empty result for empty input", () => {
    assert.deepEqual(parseCardsCsv("").cards, []);
  });
});
