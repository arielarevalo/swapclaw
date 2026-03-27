import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		restoreMocks: true,
		pool: "forks",
		sequence: {
			shuffle: false,
		},
	},
});
