import mongoose from "mongoose";

const { Schema } = mongoose;

const BlogMasterSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    excerpt: {
      type: String,
      default: "",
    },
    content: {
      type: String,
      default: "",
    },
    featuredImage: {
      type: String,
      default: "",
    },
    featuredImageAlt: {
      type: String,
      default: "",
    },
    category: {
      type: String,
      default: "",
      trim: true,
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    author: {
      type: String,
      default: "Admin",
    },
    status: {
      type: String,
      enum: ["Draft", "Scheduled", "Published", "Archived"],
      default: "Draft",
    },
    publishDate: {
      type: Date,
      default: Date.now,
    },
    readingTime: {
      type: Number,
      default: 1, // in minutes
    },
    viewsCount: {
      type: Number,
      default: 0,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    isTrending: {
      type: Boolean,
      default: false,
    },
    allowComments: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // SEO & Meta Fields
    seo: {
      metaTitle: { type: String, default: "" },
      metaDescription: { type: String, default: "" },
      metaKeywords: [{ type: String }],
      canonicalUrl: { type: String, default: "" },
      ogTitle: { type: String, default: "" },
      ogDescription: { type: String, default: "" },
      ogImage: { type: String, default: "" },
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model("BlogMaster", BlogMasterSchema);
