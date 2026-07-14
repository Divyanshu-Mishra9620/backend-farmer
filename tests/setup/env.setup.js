import dotenv from "dotenv";

dotenv.config();

process.env.NODE_ENV = "test";

// Redirect DATABASE_URL to a dedicated database on the same Atlas cluster so
// integration tests never read or write the same database as local dev or
// real farmer data. dotenv.config() calls made later by app code are no-ops
// once DATABASE_URL is already set, so this override sticks.
function withTestDb(uri) {
  const [base, query] = uri.split("?");
  const protoEnd = base.indexOf("://") + 3;
  const lastSlash = base.lastIndexOf("/");
  const hostAndSlash = lastSlash > protoEnd ? base.slice(0, lastSlash + 1) : `${base}/`;
  const testBase = `${hostAndSlash}agri-app-jest`;
  return query ? `${testBase}?${query}` : testBase;
}

if (process.env.DATABASE_URL) {
  const cleaned = process.env.DATABASE_URL.trim().replace(/^"|"$/g, "");
  process.env.DATABASE_URL = withTestDb(cleaned);
}
