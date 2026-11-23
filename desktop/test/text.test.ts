import { describe, expect, test } from "bun:test"
import { applyFinal, joinText, shellQuote } from "../src/text"

describe("box arithmetic", () => {
  test("joins with one space", () => {
    expect(joinText("", "a")).toBe("a")
    expect(joinText("a", "b")).toBe("a b")
    expect(joinText("a ", "b")).toBe("a b")
    expect(joinText("a", "")).toBe("a")
  })

  test("a final replaces the last copy of its phrases", () => {
    expect(applyFinal("x one two", "one two", "One, two.")).toBe("x One, two.")
    expect(applyFinal("edited by hand", "one", "One.")).toBeUndefined()
    expect(applyFinal("x", "", "tail")).toBe("x tail")
  })
})

test("shellQuote survives a quote", () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
})
