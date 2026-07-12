import jwt from "jsonwebtoken";
import config from "../../config/env.js";

export const generateAccessToken = (user) => {
  return jwt.sign(
    { id: user._id, role: user.role },
    config.jwtSecret,
    { expiresIn: '2h' }
  );
}

export const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user._id },
    config.jwtRefreshSecret,
    { expiresIn: "7d" }
  );
};

export const verifyToken = (token, secret) => {
  return jwt.verify(token, secret, { algorithms: ["HS256"] });
};