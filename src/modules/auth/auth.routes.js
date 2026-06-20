import { Router } from "express";
import * as authController from "./auth.controller.js";
import {
  authMiddleware,
  roleMiddleware,
} from "../../shared/middlewares/authMiddleware.js";

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
router.post("/login", authController.login);
router.post("/refresh", authController.refresh);
router.post("/logout", authMiddleware, authController.logout);
router.post("/reset-password", authMiddleware, authController.resetPassword);
router.get("/profile", authMiddleware, authController.profile);
router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password-token", authController.resetPasswordWithToken);

router.get(
  "/admin-only",
  authMiddleware,
  roleMiddleware("admin"),
  (req, res) => {
    res.json({ message: "Welcome, Admin!" });
  },
);

export default router;
