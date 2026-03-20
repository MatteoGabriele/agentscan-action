import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    alwaysBundle: ["@actions/github", "@actions/core", "voight-kampff-test"],
  },
});
