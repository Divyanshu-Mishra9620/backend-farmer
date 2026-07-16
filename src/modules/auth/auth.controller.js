import * as authService from "./auth.service.js";
import config from "../../config/env.js";

// Web clients get the refresh token as an httpOnly cookie (never readable by
// JS, so an XSS payload can't exfiltrate it from localStorage the way the
// audit flagged). Mobile clients have no cookie jar tied to a browser origin,
// so login/refresh still also return refreshToken in the JSON body for them
// — the frontend web app just no longer persists that body field anywhere.
const REFRESH_COOKIE_NAME = "refreshToken";
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: config.nodeEnv === "production",
  sameSite: config.nodeEnv === "production" ? "none" : "lax",
  path: "/api/auth",
  maxAge: 7 * 24 * 60 * 60 * 1000, // matches the refresh token's own 7d expiry
});

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
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
    res.json({ accessToken, refreshToken, user });
  } catch (err) {
    next(err);
  }
};

export const googleAuth = async (req, res, next) => {
  try {
    const { idToken } = req.body;
    const { accessToken, refreshToken, user } = await authService.googleAuth(idToken);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
    res.json({ accessToken, refreshToken, user });
  } catch (err) {
    next(err);
  }
};

export const completeProfile = async (req, res, next) => {
  try {
    const user = await authService.completeProfile(req.user.id, req.body);
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

export const logout = async (req, res, next) => {
  try {
    await authService.logout(req.user.id);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    next(err);
  }
};

export const refresh = async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;
    const { accessToken } = await authService.refreshAccessToken(refreshToken);
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
