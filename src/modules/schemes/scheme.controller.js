import * as schemeService from "./scheme.service.js";

export const getSchemes = async (req, res, next) => {
  try {
    const schemes = await schemeService.getAllSchemes();
    res.json({ schemes });
  } catch (err) {
    next(err);
  }
};

export const createScheme = async (req, res, next) => {
  try {
    const scheme = await schemeService.createScheme(req.body);
    res.status(201).json(scheme);
  } catch (err) {
    next(err);
  }
};

export const updateScheme = async (req, res, next) => {
  try {
    const scheme = await schemeService.updateScheme(req.params.id, req.body);
    res.json(scheme);
  } catch (err) {
    next(err);
  }
};

export const deleteScheme = async (req, res, next) => {
  try {
    const result = await schemeService.deleteScheme(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
};
