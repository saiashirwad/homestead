import type { HomesteadConfig } from "./src/types.ts";

export default {
  setup: [{ label: "install", run: ["bun", "install"] }],
} satisfies HomesteadConfig;
