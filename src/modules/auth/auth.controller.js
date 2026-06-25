import * as authService from "./auth.service.js";

export const signup = async (req, res, next) => {
  try {
    const user = await authService.signup(req.body);
    res.status(201).json({ message: "User registered successfully", user });
  } catch (err) {
    next(err);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { accessToken, refreshToken, user } = await authService.login(email, password);
    res.json({ accessToken, refreshToken, user });
  } catch (err) {
    next(err);
  }
};

export const logout = async (req, res, next) => {
  try {
    await authService.logout(req.user.id);
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    next(err);
  }
};

export const refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const accessToken = await authService.refreshAccessToken(refreshToken);
    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
};

export const profile = async (req, res, next) => {
  try {
    const user = await authService.getProfile(req.user.id);
    res.json(user);
  } catch (err) {
    next(err);
  }
};

export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const response = await authService.forgotPassword(email);
    res.json(response);
  } catch (err) {
    next(err);
  }
};

export const resetPasswordWithToken = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    const response = await authService.resetPasswordWithToken(token, newPassword);
    res.json(response);
  } catch (err) {
    next(err);
  }
};
