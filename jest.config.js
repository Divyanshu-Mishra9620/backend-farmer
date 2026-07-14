export default {
  testEnvironment: "node",
  testTimeout: 20000,
  setupFiles: ["<rootDir>/tests/setup/env.setup.js"],
  testPathIgnorePatterns: ["/node_modules/"],
};
