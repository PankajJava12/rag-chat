module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "Node16",
          moduleResolution: "Node16",
          isolatedModules: true,
        },
      },
    ],
  },
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  collectCoverageFrom: ["apps/api/src/app.ts", "packages/shared/src/*.ts"],
};
