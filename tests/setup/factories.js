import { randomUUID } from "crypto";

export function uniqueEmail(prefix = "jest") {
  return `${prefix}-${randomUUID()}@example.com`;
}

export function testUserPayload(overrides = {}) {
  return {
    name: "Jest Test User",
    email: uniqueEmail(),
    password: "TestPass123!",
    phone: "9876543210",
    address: "123 Long Enough Test Street",
    state: "Delhi",
    district: "Delhi",
    dob: "1990-01-01",
    ...overrides,
  };
}
