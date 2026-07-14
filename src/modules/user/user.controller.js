import * as userService from "./user.service.js";

export const getProfile = async (req, res, next) => {
  try {
    const user = await userService.getProfile(req.user.id);
    res.json(user);
  } catch (err) {
    next(err);
  }
};

export const updateProfile = async (req, res, next) => {
  try {
    const updatedUser = await userService.updateProfile(req.user.id, req.body);
    res.json(updatedUser);
  } catch (err) {
    next(err);
  }
};

export const changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const result = await userService.changePassword(req.user.id, oldPassword, newPassword);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

export const updateEmail = async (req, res, next) => {
  try {
    const { newEmail } = req.body;
    const updatedUser = await userService.updateEmail(req.user.id, newEmail);
    res.json(updatedUser);
  } catch (err) {
    next(err);
  }
};

export const updatePushToken = async (req, res, next) => {
  try {
    const { pushToken } = req.body;
    const updatedUser = await userService.updatePushToken(req.user.id, pushToken);
    res.json(updatedUser);
  } catch (err) {
    next(err);
  }
};
