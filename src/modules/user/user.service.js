import User from "./user.model.js";
import { hashPassword, comparePassword } from "../../shared/utils/hash.js";


export const getProfile = async (userId) => {
  return await User.findById(userId).select("-password -refreshToken");
};

export const updateProfile = async (userId, data) => {
  const allowedFields = [
    "name",
    "phone",
    "language",
    "state",
    "district",
    "address",
    "dob"
  ];

  const updates = {};
  allowedFields.forEach((field) => {
    if (data[field] !== undefined) {
      updates[field] = data[field];
    }
  });

  return await User.findByIdAndUpdate(userId, updates, { new: true }).select(
    "-password -refreshToken"
  );
};

export const updateEmail = async (userId, newEmail) => {
  if (!newEmail) throw new Error("New email is required");

  const existingUser = await User.findOne({ email: newEmail });
  if (existingUser) throw new Error("Email is already in use");

  return await User.findByIdAndUpdate(
    userId,
    { email: newEmail },
    { new: true, runValidators: true }
  ).select("-password -refreshToken");
};

export const changePassword = async (userId, oldPassword, newPassword) => {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  const isMatch = await comparePassword(oldPassword, user.password);
  if (!isMatch) throw new Error("Old password is incorrect");

  user.password = await hashPassword(newPassword);
  await user.save();

  return { message: "Password updated successfully" };
};

