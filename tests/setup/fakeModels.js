import mongoose from "mongoose";

// A tiny in-memory stand-in for the parts of the Mongoose model API the
// outbreak code uses, so its logic can be tested without a database. It
// understands equality (null matches a missing field), RegExp, $ne, $in, $gte,
// $lte, $or and dotted paths, and rejects any other operator loudly so a new
// query cannot silently pass here and fail against MongoDB.

const OPS = new Set(["$ne", "$in", "$gte", "$lte"]);

const isOperatorObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !(value instanceof Date) &&
  !(value instanceof RegExp) &&
  !(value instanceof mongoose.Types.ObjectId) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => key.startsWith("$"));

const getPath = (doc, path) =>
  path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), doc);

const same = (a, b) => {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return String(a) === String(b);
};

function matchValue(value, condition) {
  if (condition instanceof RegExp) {
    return typeof value === "string" && condition.test(value);
  }
  if (isOperatorObject(condition)) {
    return Object.entries(condition).every(([op, arg]) => {
      if (!OPS.has(op)) throw new Error(`fakeModels: unsupported operator ${op}`);
      if (op === "$ne") return !same(value, arg);
      if (op === "$in") return arg.some((item) => same(value, item));
      if (value == null) return false;
      return op === "$gte" ? value >= arg : value <= arg;
    });
  }
  return same(value, condition);
}

export function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((branch) => matches(doc, branch));
    if (key.startsWith("$")) throw new Error(`fakeModels: unsupported operator ${key}`);
    return matchValue(getPath(doc, key), condition);
  });
}

class FakeQuery {
  constructor(run) {
    this.run = run;
    this.limitN = null;
    this.sortSpec = null;
  }
  select() {
    return this;
  }
  limit(n) {
    this.limitN = n;
    return this;
  }
  sort(spec) {
    this.sortSpec = spec;
    return this;
  }
  exec() {
    try {
      let result = this.run();
      if (Array.isArray(result)) {
        if (this.sortSpec) {
          const [[field, dir]] = Object.entries(this.sortSpec);
          result = [...result].sort((a, b) =>
            getPath(a, field) > getPath(b, field) ? dir : getPath(a, field) < getPath(b, field) ? -dir : 0
          );
        }
        if (this.limitN != null) result = result.slice(0, this.limitN);
      }
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  then(resolve, reject) {
    return this.exec().then(resolve, reject);
  }
}

export function createFakeModel(name) {
  const rows = [];
  const calls = [];
  const failures = {};

  const guard = (method) => {
    calls.push(method);
    if (failures[method]) throw failures[method];
  };

  const model = {
    modelName: name,
    rows,
    calls,
    failNext(method, error) {
      failures[method] = error;
    },
    reset(seed = []) {
      rows.length = 0;
      calls.length = 0;
      Object.keys(failures).forEach((key) => delete failures[key]);
      seed.forEach((doc) => rows.push({ _id: new mongoose.Types.ObjectId(), ...doc }));
    },
    find(filter) {
      return new FakeQuery(() => {
        guard("find");
        return rows.filter((doc) => matches(doc, filter));
      });
    },
    findById(id) {
      return new FakeQuery(() => {
        guard("findById");
        return rows.find((doc) => same(doc._id, id)) || null;
      });
    },
    async insertMany(docs) {
      guard("insertMany");
      const now = new Date();
      const created = docs.map((doc) => ({
        _id: new mongoose.Types.ObjectId(),
        createdAt: now,
        updatedAt: now,
        dismissedAt: null,
        ...doc,
      }));
      rows.push(...created);
      return created.map((doc) => ({ ...doc }));
    },
    findOneAndUpdate(filter, update) {
      return new FakeQuery(() => {
        guard("findOneAndUpdate");
        const doc = rows.find((row) => matches(row, filter));
        if (!doc) return null;
        Object.assign(doc, update.$set || {});
        return { ...doc };
      });
    },
  };

  return model;
}
