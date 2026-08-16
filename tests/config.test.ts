import { expect, test } from "bun:test"
import { applyDefaults } from "../src/config.ts"
import type { HomesteadConfig } from "../src/types.ts"

test("applyDefaults fills missing arrays with empty defaults", () => {
  const config: HomesteadConfig = {}
  const defaulted = applyDefaults(config)
  expect(defaulted.ports).toEqual([])
  expect(defaulted.services).toEqual([])
  expect(defaulted.setup).toEqual([])
  expect(defaulted.teardown).toEqual([])
})

test("applyDefaults preserves existing config fields", () => {
  const derive = () => ({ DB: "postgres" })
  const config: HomesteadConfig = {
    ports: [{ key: "PORT", base: 3000 }],
    env: { derive },
    setup: [{ label: "install", run: ["bun", "install"] }],
    teardown: [{ label: "clean", run: ["echo", "done"] }],
  }
  const defaulted = applyDefaults(config)
  expect(defaulted.ports).toEqual([{ key: "PORT", base: 3000 }])
  expect(defaulted.env?.derive).toBe(derive)
  expect(defaulted.setup).toHaveLength(1)
  expect(defaulted.teardown).toHaveLength(1)
})
