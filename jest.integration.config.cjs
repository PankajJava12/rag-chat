module.exports = {
  ...require("./jest.config.cjs"),
  testMatch: ["<rootDir>/tests/integration/**/*.test.ts"],
  testTimeout: 20000,
};
