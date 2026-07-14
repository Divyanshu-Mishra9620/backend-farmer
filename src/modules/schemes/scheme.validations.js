import Joi from "joi";

const titlesSchema = Joi.object({
  en: Joi.string().required(),
  hi: Joi.string().required(),
  te: Joi.string().required(),
}).required();

export const createSchemeSchema = Joi.object({
  sector: Joi.string().required(),
  icon: Joi.string().required(),
  titles: titlesSchema,
  description: Joi.string().required(),
  benefits: Joi.string().required(),
  eligibility: Joi.string().required(),
  source: Joi.string().required(),
  url: Joi.string().uri().required(),
  badge: Joi.string().required(),
  order: Joi.number(),
  isActive: Joi.boolean(),
});

export const updateSchemeSchema = Joi.object({
  sector: Joi.string(),
  icon: Joi.string(),
  titles: titlesSchema.optional(),
  description: Joi.string(),
  benefits: Joi.string(),
  eligibility: Joi.string(),
  source: Joi.string(),
  url: Joi.string().uri(),
  badge: Joi.string(),
  order: Joi.number(),
  isActive: Joi.boolean(),
}).min(1);
