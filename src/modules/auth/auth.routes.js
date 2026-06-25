import { Router } from "express";
import * as authController from "./auth.controller.js";
import { authMiddleware, roleMiddleware } from "../../shared/middlewares/authMiddleware.js";
import { authLimiter } from "../../shared/middlewares/rateLimiter.js";
import validateRequest from "../../shared/middlewares/validateRequest.js";
import { createUserSchema, loginSchema } from "../user/user.validations.js";

const router = Router();

router.post("/signup", authLimiter, validateRequest(createUserSchema), authController.signup);
router.post("/login", authLimiter, validateRequest(loginSchema), authController.login);
router.post("/refresh", authController.refresh);
router.post("/logout", authMiddleware, authController.logout);
router.get("/profile", authMiddleware, authController.profile);
router.post("/forgot-password", authLimiter, authController.forgotPassword);
router.post("/reset-password-token", authLimiter, authController.resetPasswordWithToken);


router.get("/admin-only", authMiddleware, roleMiddleware("admin"), (req, res) => {
  res.json({ message: "Welcome, Admin!" });
});

export default router;
