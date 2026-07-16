import { Router } from "express";
import * as authController from "./auth.controller.js";
import {
  authMiddleware,
  roleMiddleware,
} from "../../shared/middlewares/authMiddleware.js";
import { authLimiter } from "../../shared/middlewares/rateLimiter.js";
import validateRequest from "../../shared/middlewares/validateRequest.js";
import {
  createUserSchema,
  loginSchema,
  googleAuthSchema,
  completeProfileSchema,
} from "../user/user.validations.js";

const router = Router();

// Validation
const validateSignup = (req, res, next) => {
  const { name, email, password, state, district, address, dob } = req.body;

  if (!name || !email || !password || !state || !district || !address || !dob) {
    return res.status(400).json({
      success: false,
      message:
        "Missing required fields: name, email, password, state, district, address, dob",
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 6 characters long",
    });
  }

  if (address.length < 10) {
    return res.status(400).json({
      success: false,
      message: "Address must be at least 10 characters long",
    });
  }

  next();
};

router.post("/signup", validateSignup, authController.signup);
router.post("/login", authLimiter, authController.login);
router.post(
  "/google",
  authLimiter,
  validateRequest(googleAuthSchema),
  authController.googleAuth,
);
router.patch(
  "/complete-profile",
  authMiddleware,
  validateRequest(completeProfileSchema),
  authController.completeProfile,
);
router.post("/refresh", authController.refresh);
router.post("/logout", authMiddleware, authController.logout);
router.get("/profile", authMiddleware, authController.profile);
router.post("/forgot-password", authLimiter, authController.forgotPassword);
router.post(
  "/reset-password-token",
  authLimiter,
  authController.resetPasswordWithToken,
);

router.get(
  "/admin-only",
  authMiddleware,
  roleMiddleware("admin"),
  (req, res) => {
    res.json({ message: "Welcome, Admin!" });
  },
);

export default router;
