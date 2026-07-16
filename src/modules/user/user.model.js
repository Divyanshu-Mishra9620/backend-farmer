import mongoose from "mongoose";

// Google-created accounts skip password/state/district/address/dob at
// creation time — the complete-profile endpoint's Joi schema is what
// actually enforces those fields get filled in, this is just a backstop.
function requiredUnlessGoogle() {
  return this.authProvider !== "google";
}

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
      required: requiredUnlessGoogle,
      trim: true,
      minlength: 6,
      maxlength: 100,
      select: false,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    // False only for accounts created via Google sign-in that haven't yet
    // filled in state/district/address/dob through the complete-profile step.
    profileCompleted: {
      type: Boolean,
      default: true,
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
      required: requiredUnlessGoogle,
    },
    district: {
      type: String,
      trim: true,
      required: requiredUnlessGoogle,
    },
    address: {
      type: String,
      trim: true,
      required: requiredUnlessGoogle,
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
      required: requiredUnlessGoogle,
    },
    refreshToken: {
      type: String,
      default: null,
    },
    pushToken: {
      type: String,
      default: null,
      trim: true,
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
  if (!this.dob) return null;
  const ageDifMs = Date.now() - this.dob.getTime();
  const ageDate = new Date(ageDifMs);
  return Math.abs(ageDate.getUTCFullYear() - 1970);
});

export default mongoose.model("User", userSchema);
