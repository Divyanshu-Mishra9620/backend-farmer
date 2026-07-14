import errorHandler from "../src/shared/middlewares/errorHandler.js";
import httpError from "../src/shared/utils/httpError.js";

function mockRes() {
  const res = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function mockReq() {
  return { method: "GET", originalUrl: "/api/test", user: null };
}

describe("errorHandler", () => {
  it("uses the real message and status for our own httpError()", () => {
    const res = mockRes();
    errorHandler(httpError(409, "Duplicate scheme"), mockReq(), res, () => {});

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: "CONFLICT", message: "Duplicate scheme" },
    });
  });

  it("maps Mongoose ValidationError to 400 VALIDATION_ERROR", () => {
    const err = new Error("Path `email` is required.");
    err.name = "ValidationError";
    const res = mockRes();
    errorHandler(err, mockReq(), res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("maps Mongoose CastError to 400 VALIDATION_ERROR", () => {
    const err = new Error("Cast to ObjectId failed");
    err.name = "CastError";
    const res = mockRes();
    errorHandler(err, mockReq(), res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("does not leak a third-party error's raw message when isAppError is unset", () => {
    // Simulates Express body-parser, which sets `.status` on malformed JSON
    // but whose message is a raw V8 parser string never meant for a client.
    const err = new Error("Unexpected token } in JSON at position 42");
    err.status = 400;
    const res = mockRes();
    errorHandler(err, mockReq(), res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).not.toContain("Unexpected token");
  });

  it("maps our own 503/504 httpErrors to distinct codes, not a generic 500", () => {
    const resAi = mockRes();
    errorHandler(httpError(503, "AI service unavailable"), mockReq(), resAi, () => {});
    expect(resAi.statusCode).toBe(503);
    expect(resAi.body.error.code).toBe("AI_SERVICE_ERROR");

    const resTimeout = mockRes();
    errorHandler(httpError(504, "Timed out"), mockReq(), resTimeout, () => {});
    expect(resTimeout.statusCode).toBe(504);
    expect(resTimeout.body.error.code).toBe("REQUEST_TIMEOUT");
  });

  it("falls back to 500 INTERNAL_ERROR for an unrecognized error", () => {
    const res = mockRes();
    errorHandler(new Error("something exploded"), mockReq(), res, () => {});

    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.body.error.message).not.toBe("something exploded");
  });
});
