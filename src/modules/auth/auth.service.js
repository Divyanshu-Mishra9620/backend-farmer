import { comparePassword, hashPassword } from "../../shared/utils/hash.js";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
} from "../../shared/utils/jwt.js";
import User from "../user/user.model.js";
import { sendEmail } from "../../shared/utils/email.js";
import crypto from "crypto";

export const signup = async (userData) => {
  try {
    const { name, email, password, state, district, address, dob } = userData;

    const existingUser = await User.findOne({
      email: email,
    });
    if (existingUser) {
      throw new Error("User already exists with this email");
    }
    if (
      !name ||
      !email ||
      !password ||
      !state ||
      !district ||
      !address ||
      !dob
    ) {
      throw new Error("All fields are required");
    }
    const hashedPwd = await hashPassword(password);
    const user = new User({
      ...userData,
      password: hashedPwd,
    });

    await user.save();
    return user;
  } catch (error) {
    // Handle duplicate key error
    if (error.code === 11000) {
      throw new Error("User with this email already exists");
    }
    // Handle validation errors
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      throw new Error(`Validation failed: ${messages.join(", ")}`);
    }
    // Re-throw the error
    throw error;
  }
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

  return { user, accessToken, refreshToken };
};

export const refreshAccessToken = async (refreshToken) => {
  const payload = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  const user = await User.findById(payload.id);
  if (!user || user.refreshToken !== refreshToken) {
    throw new Error("Invalid refresh token");
  }
  const accessToken = generateAccessToken(user);
  return { accessToken };
};

export const resetPassword = async (userId, newPassword) => {
  const hashedPassword = await hashPassword(newPassword);
  return await User.findByIdAndUpdate(userId, { password: hashedPassword });
};

export const getProfile = async (userId) => {
  return await User.findById(userId).select("-password -refreshToken");
};

export const forgotPassword = async (email) => {
  const user = await User.findOne({ email });
  if (!user) throw new Error("User not found");

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetTokenHash = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  user.resetPasswordToken = resetTokenHash;
  user.resetPasswordExpires = Date.now() + 15 * 60 * 1000;
  await user.save();

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
  await sendEmail(
    user.email,
    "Password Reset Request",
    `Reset your password using this link: ${resetUrl}`,
    `<p>Click <a href="${resetUrl}">here</a> to reset your password. Link expires in 15 minutes.</p>`,
  );

  return { message: "Password reset email sent" };
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
