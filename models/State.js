import mongoose from "mongoose";

const StateSchema = new mongoose.Schema(
  {
    stateName: {
      type: String,
      required: true,
    },
    stateCode: {
      type: String,
      required: true,
    },
    countryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Country",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  { timestamps: true },
);

// Create compound unique index for stateCode and countryId combination
StateSchema.index({ stateCode: 1, countryId: 1 }, { unique: true });
// Create compound unique index for stateName and countryId combination
StateSchema.index({ stateName: 1, countryId: 1 }, { unique: true });

export default mongoose.model("State", StateSchema);
