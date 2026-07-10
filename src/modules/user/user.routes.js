import { Router } from "express";
import * as userController from "./user.controller.js";
import { authMiddleware } from "../../shared/middlewares/authMiddleware.js";
import { authLimiter } from "../../shared/middlewares/rateLimiter.js";
import validateRequest from "../../shared/middlewares/validateRequest.js";
import { changePasswordSchema, updateEmailSchema } from "./user.validations.js";

const router = Router();

router.get("/me", authMiddleware, userController.getProfile);
router.put("/me", authMiddleware, userController.updateProfile);
router.put(
  "/me/change-password",
  authMiddleware,
  authLimiter,
  validateRequest(changePasswordSchema),
  userController.changePassword
);
router.put(
  "/me/change-email",
  authMiddleware,
  authLimiter,
  validateRequest(updateEmailSchema),
  userController.updateEmail
);

export default router;
