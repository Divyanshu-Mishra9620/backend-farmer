import { Router } from "express";
import * as schemeController from "./scheme.controller.js";
import {
  authMiddleware,
  roleMiddleware,
} from "../../shared/middlewares/authMiddleware.js";
import validateRequest from "../../shared/middlewares/validateRequest.js";
import { createSchemeSchema, updateSchemeSchema } from "./scheme.validations.js";

const router = Router();

// Public — scheme info is public-domain government data, same as the portals
// it links to, so farmers can see it without needing a valid session.
router.get("/", schemeController.getSchemes);

// Admin-only — lets scheme content be corrected/expanded without an app
// store release, the whole point of moving this off a hardcoded array.
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
