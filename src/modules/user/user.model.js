import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 50,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 5,
      maxlength: 100,
    },
    password: {
      type: String,
      required: true,
      trim: true,
      minlength: 6,
      maxlength: 100,
    },
    role: {
      type: String,
      enum: ["admin", "user", "support"],
      default: "user",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    language: {
      type: String,
      enum: ["en", "hi", "te"],
      default: "en",
    },
    state: {
      type: String,
      trim: true,
      required: true,
    },
    district: {
      type: String,
      trim: true,
      required: true,
    },
    address: {
      type: String,
      trim: true,
      required: true,
      minlength: 10,
      maxlength: 200,
    },
    phone: {
      type: String,
      trim: true,
      minlength: 10,
      maxlength: 15,
    },
    dob: {
      type: Date,
      required: true,
    },
    refreshToken: {
      type: String,
      default: null,
    },
    resetPasswordToken: {
      type: String,
      default: null,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

userSchema.virtual("age").get(function () {
  const ageDifMs = Date.now() - this.dob.getTime();
  const ageDate = new Date(ageDifMs);
  return Math.abs(ageDate.getUTCFullYear() - 1970);
});

export default mongoose.model("User", userSchema);
