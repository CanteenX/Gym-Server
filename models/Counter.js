import mongoose from "mongoose";

/**
 * Atomic sequence source for receipt numbers.
 *
 * A `countDocuments() + 1` approach races: two staff recording payments at the
 * same moment would both read N and both write N+1, producing duplicate receipt
 * numbers — exactly the kind of bug an accountant finds a year later.
 * `findOneAndUpdate` with `$inc` is atomic at the document level, so every
 * caller gets a distinct number even under concurrency.
 *
 * One document per key; receipts use a per-financial-year key such as
 * "receipt:2026-27" so numbering restarts each FY.
 */
const CounterSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    seq: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  { timestamps: true },
);

/**
 * Reserve and return the next value for `key`.
 * Creates the counter on first use.
 */
CounterSchema.statics.nextValue = async function (key) {
  const doc = await this.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return doc.seq;
};

export default mongoose.model("Counter", CounterSchema);
