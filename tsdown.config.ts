import { defineConfig } from "tsdown";

export default defineConfig({
	minify: true,
	deps: {
		alwaysBundle: [
			"@actions/github",
			"@actions/core",
			// Also covers subpath exports like /report and /providers/github
			/^@unveil\/identity(\/|$)/,
		],
	},
});
