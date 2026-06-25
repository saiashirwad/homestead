import { expect, test } from "bun:test";
import { parsePrArg } from "./ref.ts";

test("parsePrArg parses a bare number", () => {
  expect(parsePrArg("87")).toEqual({ number: 87, ghArg: "87" });
});

test("parsePrArg parses a full PR URL", () => {
  expect(parsePrArg("https://github.com/o/r/pull/87")).toEqual({
    number: 87,
    owner: "o",
    repo: "r",
    ghArg: "https://github.com/o/r/pull/87",
  });
});

test("parsePrArg rejects an issue URL", () => {
  expect(parsePrArg("https://github.com/o/r/issues/87")).toBeUndefined();
});

test("parsePrArg rejects garbage", () => {
  expect(parsePrArg("not-a-pr")).toBeUndefined();
});
