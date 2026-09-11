import mongoose from "mongoose";

const CountrySchema = new mongoose.Schema(
  {
    countryName: {
      type: String,
      required: true,
      unique: true,
    },
    countryCode: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: false,
      required: true,
    },
  },
  { timestamps: true },
);

export default mongoose.model("Country", CountrySchema);
