import mongoose from "mongoose";

const CurrencyMasterSchema = new mongoose.Schema(
  {
    currencyName: {
      type: String,
      required: true,
      trim: true,
    },
    currencyCode: {
      type: String,
      required: true,
      trim: true,
    },
    currencySymbol: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("CurrencyMaster", CurrencyMasterSchema);
