import { Router } from "express";
import * as schemeController from "./scheme.controller.js";
import {
  authMiddleware,
  roleMiddleware,
} from "../../shared/middlewares/authMiddleware.js";
import validateRequest from "../../shared/middlewares/validateRequest.js";
import { createSchemeSchema, updateSchemeSchema } from "./scheme.validations.js";

const router = Router();

router.get("/", schemeController.getSchemes);

router.post(
  "/",
  authMiddleware,
  roleMiddleware("admin"),
  validateRequest(createSchemeSchema),
  schemeController.createScheme,
);
router.put(
  "/:id",
  authMiddleware,
  roleMiddleware("admin"),
  validateRequest(updateSchemeSchema),
  schemeController.updateScheme,
);
router.delete(
  "/:id",
  authMiddleware,
  roleMiddleware("admin"),
  schemeController.deleteScheme,
);

export default router;
