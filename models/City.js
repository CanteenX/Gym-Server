import mongoose from "mongoose";

const { Schema } = mongoose;

const CitySchema = new mongoose.Schema(
  {
    cityName: {
      type: String,
      required: true,
    },
    cityCode: {
      type: String,
    },
    stateId: {
      type: Schema.Types.ObjectId,
      ref: "State",
      required: true,
    },
    countryId: {
      type: Schema.Types.ObjectId,
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

export default mongoose.model("City", CitySchema);
