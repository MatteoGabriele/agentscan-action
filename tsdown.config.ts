import { defineConfig } from "tsdown";

export default defineConfig({
	minify: true,
	deps: {
		alwaysBundle: ["@actions/github", "@actions/core", "@unveil/identity"],
	},
});
