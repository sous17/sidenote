import assert from "node:assert/strict";
import { test } from "node:test";
import { splitNoteAnswers } from "../src/server/split.ts";

test("moves each marked section into its note and keeps the main answer", () => {
  const text = [
    "Here is the main answer.",
    "",
    "---",
    "",
    "**↳ Re: note 41**",
    "Replies go to the thread.",
    "",
    "**↳ Re: note 43**",
    "Second answer.",
  ].join("\n");
  const { mainText, answers } = splitNoteAnswers(text, new Set([41, 43]));
  assert.equal(mainText, "Here is the main answer.");
  assert.deepEqual(Object.fromEntries(answers), { 41: "Replies go to the thread.", 43: "Second answer." });
});

test("a reply made only of note sections has an empty main answer", () => {
  const { mainText, answers } = splitNoteAnswers("**↳ Re: note 7**\nonly notes", new Set([7]));
  assert.equal(mainText, "");
  assert.equal(answers.get(7), "only notes");
});

test("accepts heading markers and several notes on one marker", () => {
  const { answers } = splitNoteAnswers("Main\n\n### Re: notes 3 and #4\nBoth answered.", new Set([3, 4]));
  assert.equal(answers.get(3), "Both answered.");
  assert.equal(answers.get(4), "Both answered.");
});

test("ignores markers inside code fences and for notes that were not sent", () => {
  const text = ["Main", "```", "**↳ Re: note 41**", "```", "**↳ Re: note 99**", "tail"].join("\n");
  const { mainText, answers } = splitNoteAnswers(text, new Set([41]));
  assert.equal(answers.size, 0);
  assert.equal(mainText, text);
});

test("a marker for an unknown note stays inside the current section", () => {
  const text = "**↳ Re: note 1**\nfirst\n\n**↳ Re: note 99**\nstill first";
  const { answers } = splitNoteAnswers(text, new Set([1]));
  assert.equal(answers.get(1), "first\n\n**↳ Re: note 99**\nstill first");
});
