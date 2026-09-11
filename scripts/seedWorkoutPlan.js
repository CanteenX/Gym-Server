/**
 * One-off seed for the gym's default workout plan:
 *
 *  1. Creates the standard 6-day split (6 days x 5 exercises) as the ONE
 *     default plan, which every member without an explicit assignment follows.
 *
 * Run from the Gym Server directory:  node scripts/seedWorkoutPlan.js
 *
 * Safe to re-run — it checks for an existing default plan first and leaves it
 * alone. That matters more here than in most seeds: overwriting the default
 * would silently change the programme for every member still on it, including
 * any edits staff have made since.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import WorkoutPlan from "../models/WorkoutPlan.js";

dotenv.config();

/** A conventional commercial-gym 6-day split. */
const DEFAULT_PLAN_DAYS = [
  {
    dayNumber: 1,
    label: "Chest & Triceps",
    exercises: [
      { name: "Barbell Bench Press", targetSets: 4, targetReps: "8-10" },
      { name: "Incline Dumbbell Press", targetSets: 4, targetReps: "10-12" },
      { name: "Cable Chest Fly", targetSets: 3, targetReps: "12-15" },
      { name: "Triceps Rope Pushdown", targetSets: 3, targetReps: "12-15" },
      {
        name: "Overhead Triceps Extension",
        targetSets: 3,
        targetReps: "10-12",
      },
    ],
  },
  {
    dayNumber: 2,
    label: "Back & Biceps",
    exercises: [
      { name: "Deadlift", targetSets: 4, targetReps: "6-8", notes: "Keep a neutral spine" },
      { name: "Lat Pulldown", targetSets: 4, targetReps: "10-12" },
      { name: "Seated Cable Row", targetSets: 3, targetReps: "10-12" },
      { name: "Barbell Bicep Curl", targetSets: 3, targetReps: "10-12" },
      { name: "Hammer Curl", targetSets: 3, targetReps: "12-15" },
    ],
  },
  {
    dayNumber: 3,
    label: "Legs",
    exercises: [
      { name: "Barbell Back Squat", targetSets: 4, targetReps: "8-10" },
      { name: "Leg Press", targetSets: 4, targetReps: "10-12" },
      { name: "Romanian Deadlift", targetSets: 3, targetReps: "10-12" },
      { name: "Leg Extension", targetSets: 3, targetReps: "12-15" },
      { name: "Standing Calf Raise", targetSets: 4, targetReps: "15-20" },
    ],
  },
  {
    dayNumber: 4,
    label: "Shoulders & Abs",
    exercises: [
      { name: "Overhead Barbell Press", targetSets: 4, targetReps: "8-10" },
      { name: "Dumbbell Lateral Raise", targetSets: 4, targetReps: "12-15" },
      { name: "Rear Delt Fly", targetSets: 3, targetReps: "12-15" },
      { name: "Cable Crunch", targetSets: 3, targetReps: "15-20" },
      { name: "Hanging Leg Raise", targetSets: 3, targetReps: "12-15" },
    ],
  },
  {
    dayNumber: 5,
    label: "Arms",
    exercises: [
      { name: "Close Grip Bench Press", targetSets: 4, targetReps: "8-10" },
      { name: "Preacher Curl", targetSets: 3, targetReps: "10-12" },
      { name: "Skull Crusher", targetSets: 3, targetReps: "10-12" },
      { name: "Incline Dumbbell Curl", targetSets: 3, targetReps: "12-15" },
      { name: "Cable Triceps Kickback", targetSets: 3, targetReps: "12-15" },
    ],
  },
  {
    dayNumber: 6,
    label: "Full Body / Conditioning",
    exercises: [
      { name: "Kettlebell Swing", targetSets: 4, targetReps: "15-20" },
      { name: "Walking Lunge", targetSets: 3, targetReps: "12 each leg" },
      { name: "Push Up", targetSets: 3, targetReps: "AMRAP" },
      { name: "Battle Rope", targetSets: 4, targetReps: "30 seconds" },
      { name: "Plank", targetSets: 3, targetReps: "60 seconds" },
    ],
  },
];

const run = async () => {
  const uri = process.env.DATABASE;
  if (!uri) {
    console.error("❌ DATABASE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  const existing = await WorkoutPlan.findOne({ isDefault: true });
  if (existing) {
    console.log(
      `• Default plan '${existing.name}' already exists (${existing.days?.length || 0} days) — leaving it untouched`,
    );
    await mongoose.disconnect();
    console.log("✅ Done. Nothing to do.");
    return;
  }

  const plan = await new WorkoutPlan({
    name: "Standard 6-Day Split",
    isDefault: true,
    isActive: true,
    days: DEFAULT_PLAN_DAYS,
  }).save();

  const exerciseCount = plan.days.reduce(
    (sum, day) => sum + day.exercises.length,
    0,
  );
  console.log(`✅ Created default plan: ${plan.name}`);
  for (const day of plan.days) {
    console.log(
      `   Day ${day.dayNumber} — ${day.label} (${day.exercises.length} exercises)`,
    );
  }
  console.log(`✅ ${plan.days.length} days, ${exerciseCount} exercises total`);

  await mongoose.disconnect();
  console.log("✅ Done. Every member without a custom plan now follows this one.");
};

run().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
