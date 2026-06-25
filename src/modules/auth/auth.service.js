import {
  comparePassword,
  hashPassword,
} from "../../shared/utils/hash.js";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
} from "../../shared/utils/jwt.js";
import User from "../user/user.model.js";
import { sendEmail } from "../../shared/utils/email.js";
import config from "../../config/env.js";
import crypto from "crypto";

export const signup = async (userData) => {
  const { name, email, password, state, district, address, dob, phone } =
    userData;

  const existingUser = await User.findOne({
    email: email,
  });
  if (existingUser) {
    throw new Error("User already exists with this email");
  }
  if (!name || !email || !password || !state || !district || !address || !dob) {
    throw new Error("All fields are required");
  }
  const hashedPwd = await hashPassword(password);
  const user = new User({
    ...userData,
    password: hashedPwd,
  });

  await user.save();
  user.password = undefined;
  return user;
};

export const login = async (email, password) => {
  const user = await User.findOne({ email });
  if (!user) {
    throw new Error("Invalid email or password");
  }
  if (!user.isActive) {
    throw new Error("Your Account is Blocked. Please contact the admin");
  }
  const isMatch = await comparePassword(password, user.password);

  if (!isMatch) {
    throw new Error("Invalid email or password");
  }

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  user.refreshToken = refreshToken;
  await user.save();

  user.password = undefined;
  user.refreshToken = undefined;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;

  return { user, accessToken, refreshToken };
};

export const refreshAccessToken = async (refreshToken) => {
  const payload = verifyToken(refreshToken, config.jwtRefreshSecret);
  const user = await User.findById(payload.id);
  if (!user || user.refreshToken !== refreshToken) {
    throw new Error("Invalid refresh token");
  }
  const accessToken = generateAccessToken(user);
  return { accessToken };
};

export const getProfile = async (userId) => {
  return await User.findById(userId).select("-password -refreshToken");
};

const GENERIC_FORGOT_PASSWORD_RESPONSE = {
  message: "If an account exists for that email, a reset link has been sent.",
};

export const forgotPassword = async (email) => {
  const user = await User.findOne({ email });
  // Always return the same response whether or not the email is registered,
  // so this endpoint can't be used to enumerate valid accounts.
  if (!user) return GENERIC_FORGOT_PASSWORD_RESPONSE;

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetTokenHash = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  user.resetPasswordToken = resetTokenHash;
  user.resetPasswordExpires = Date.now() + 15 * 60 * 1000;
  await user.save();

  const resetUrl = `${config.frontendUrl}/reset-password/${resetToken}`;
  await sendEmail(
    user.email,
    "Password Reset Request",
    `Reset your password using this link: ${resetUrl}`,
    `<p>Click <a href="${resetUrl}">here</a> to reset your password. Link expires in 15 minutes.</p>`
  );

  return GENERIC_FORGOT_PASSWORD_RESPONSE;
};

export const resetPasswordWithToken = async (token, newPassword) => {
  const resetTokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const user = await User.findOne({
    resetPasswordToken: resetTokenHash,
    resetPasswordExpires: { $gt: Date.now() },
  });

  if (!user) throw new Error("Invalid or expired reset token");

  user.password = await hashPassword(newPassword);
  user.resetPasswordToken = null;
  user.resetPasswordExpires = null;
  await user.save();

  return { message: "Password reset successful" };
};

export const logout = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  user.refreshToken = null;
  await user.save();

  return { message: "Logged out successfully" };
};
