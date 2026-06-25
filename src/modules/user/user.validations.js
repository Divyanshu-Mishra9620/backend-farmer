import Joi from "joi";

export const createUserSchema = Joi.object({
  name: Joi.string().min(3).max(50).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required(),
  state: Joi.string().required(),
  district: Joi.string().required(),
  address: Joi.string().min(10).max(200).required(),
  dob: Joi.date().required(),
  phone: Joi.string().min(10).max(15),
  language: Joi.string().valid("en", "hi", "te"),
});

export const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});
