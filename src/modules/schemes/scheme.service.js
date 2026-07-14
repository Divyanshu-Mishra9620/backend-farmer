import Scheme from "./scheme.model.js";
import httpError from "../../shared/utils/httpError.js";

export const getAllSchemes = async () => {
  return Scheme.find({ isActive: true }).sort({ order: 1, createdAt: 1 });
};

// A duplicate (sector, titles.en) pair is rejected by the unique index on
// the model — translate MongoDB's raw E11000 into the same clean 409 shape
// the rest of the API uses, instead of letting it fall through as a 500.
function rethrowConflict(err) {
  if (err.code === 11000) {
    throw httpError(409, "A scheme with this title already exists in this sector");
  }
  throw err;
}

export const createScheme = async (data) => {
  try {
    return await Scheme.create(data);
  } catch (err) {
    rethrowConflict(err);
  }
};

export const updateScheme = async (id, data) => {
  let scheme;
  try {
    scheme = await Scheme.findByIdAndUpdate(id, data, {
      new: true,
      runValidators: true,
    });
  } catch (err) {
    rethrowConflict(err);
  }
  if (!scheme) throw httpError(404, "Scheme not found");
  return scheme;
};

export const deleteScheme = async (id) => {
  const scheme = await Scheme.findByIdAndDelete(id);
  if (!scheme) throw httpError(404, "Scheme not found");
  return { message: "Scheme deleted successfully" };
};
