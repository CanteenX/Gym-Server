import mongoose from "mongoose";
import BlogMaster from "../../models/BlogMaster.js";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const createSlug = (text = "") => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-");
};

// Calculate estimated reading time based on average 200 words per minute
const calculateReadingTime = (content = "") => {
  const words = content.replace(/<[^>]*>/g, "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
};

export const createBlog = async (req, res) => {
  try {
    const {
      title,
      excerpt,
      content,
      featuredImageAlt,
      category,
      tags,
      author,
      status,
      publishDate,
      isFeatured,
      isTrending,
      allowComments,
      isActive,
      seo,
    } = req.body;

    if (!title) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Blog title is required",
      });
    }

    const baseSlug = req.body.slug && req.body.slug.trim() ? req.body.slug.trim() : title;
    let slug = createSlug(baseSlug);
    if (!slug) slug = `blog-${Date.now()}`;
    let count = 1;
    while (await BlogMaster.findOne({ slug })) {
      slug = `${createSlug(baseSlug)}-${count}`;
      count++;
    }

    let featuredImage = "";
    if (req.file) {
      featuredImage = req.file.path.replace(/\\/g, "/");
    }

    let parsedTags = [];
    if (tags) {
      if (typeof tags === "string") {
        try {
          parsedTags = JSON.parse(tags);
        } catch {
          parsedTags = tags.split(",").map((t) => t.trim()).filter(Boolean);
        }
      } else if (Array.isArray(tags)) {
        parsedTags = tags;
      }
    }

    let parsedSeo = {};
    if (seo) {
      if (typeof seo === "string") {
        try {
          parsedSeo = JSON.parse(seo);
        } catch {
          parsedSeo = {};
        }
      } else {
        parsedSeo = seo;
      }
    }

    const readingTime = calculateReadingTime(content || "");

    let createdBy = null;
    if (req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id)) {
      createdBy = req.user.id;
    } else if (req.user?._id && mongoose.Types.ObjectId.isValid(req.user._id)) {
      createdBy = req.user._id;
    }

    const blog = new BlogMaster({
      title,
      slug,
      excerpt: excerpt || "",
      content: content || "",
      featuredImage,
      featuredImageAlt: featuredImageAlt || title,
      category: category || "",
      tags: parsedTags,
      author: author || "Admin",
      status: status || "Draft",
      publishDate: publishDate ? new Date(publishDate) : new Date(),
      readingTime,
      isFeatured: isFeatured === true || isFeatured === "true",
      isTrending: isTrending === true || isTrending === "true",
      allowComments: allowComments !== false && allowComments !== "false",
      isActive: isActive !== false && isActive !== "false" && isActive !== "undefined",
      seo: {
        metaTitle: parsedSeo.metaTitle || title,
        metaDescription: parsedSeo.metaDescription || excerpt || "",
        metaKeywords: Array.isArray(parsedSeo.metaKeywords)
          ? parsedSeo.metaKeywords
          : typeof parsedSeo.metaKeywords === "string"
          ? parsedSeo.metaKeywords.split(",").map((k) => k.trim())
          : [],
        canonicalUrl: parsedSeo.canonicalUrl || "",
        ogTitle: parsedSeo.ogTitle || parsedSeo.metaTitle || title,
        ogDescription: parsedSeo.ogDescription || parsedSeo.metaDescription || excerpt || "",
        ogImage: parsedSeo.ogImage || featuredImage,
      },
      createdBy,
    });

    await blog.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Blog post created successfully",
      data: blog,
    });
  } catch (error) {
    console.error("Error creating blog:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateBlog = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      excerpt,
      content,
      featuredImageAlt,
      category,
      tags,
      author,
      status,
      publishDate,
      isFeatured,
      isTrending,
      allowComments,
      isActive,
      seo,
    } = req.body;

    const blog = await BlogMaster.findById(id);
    if (!blog) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Blog post not found",
      });
    }

    if (title && title !== blog.title) {
      let slug = createSlug(title);
      let count = 1;
      while (await BlogMaster.findOne({ slug, _id: { $ne: id } })) {
        slug = `${createSlug(title)}-${count}`;
        count++;
      }
      blog.title = title;
      blog.slug = slug;
    }

    if (req.file) {
      blog.featuredImage = req.file.path.replace(/\\/g, "/");
    } else if (req.body.removeFeaturedImage === "true" || req.body.removeFeaturedImage === true) {
      blog.featuredImage = "";
    }

    if (excerpt !== undefined) blog.excerpt = excerpt;
    if (content !== undefined) {
      blog.content = content;
      blog.readingTime = calculateReadingTime(content);
    }
    if (featuredImageAlt !== undefined) blog.featuredImageAlt = featuredImageAlt;
    if (category !== undefined) blog.category = category || "";
    if (author !== undefined) blog.author = author;
    if (status !== undefined) blog.status = status;
    if (publishDate !== undefined) blog.publishDate = new Date(publishDate);
    if (isFeatured !== undefined) blog.isFeatured = isFeatured === true || isFeatured === "true";
    if (isTrending !== undefined) blog.isTrending = isTrending === true || isTrending === "true";
    if (allowComments !== undefined) blog.allowComments = allowComments === true || allowComments === "true";
    if (isActive !== undefined) blog.isActive = isActive === true || isActive === "true";

    if (tags !== undefined) {
      let parsedTags = [];
      if (typeof tags === "string") {
        try {
          parsedTags = JSON.parse(tags);
        } catch {
          parsedTags = tags.split(",").map((t) => t.trim()).filter(Boolean);
        }
      } else if (Array.isArray(tags)) {
        parsedTags = tags;
      }
      blog.tags = parsedTags;
    }

    if (seo !== undefined) {
      let parsedSeo = {};
      if (typeof seo === "string") {
        try {
          parsedSeo = JSON.parse(seo);
        } catch {
          parsedSeo = {};
        }
      } else {
        parsedSeo = seo;
      }
      blog.seo = {
        metaTitle: parsedSeo.metaTitle ?? blog.seo.metaTitle,
        metaDescription: parsedSeo.metaDescription ?? blog.seo.metaDescription,
        metaKeywords: Array.isArray(parsedSeo.metaKeywords)
          ? parsedSeo.metaKeywords
          : typeof parsedSeo.metaKeywords === "string"
          ? parsedSeo.metaKeywords.split(",").map((k) => k.trim())
          : blog.seo.metaKeywords,
        canonicalUrl: parsedSeo.canonicalUrl ?? blog.seo.canonicalUrl,
        ogTitle: parsedSeo.ogTitle ?? blog.seo.ogTitle,
        ogDescription: parsedSeo.ogDescription ?? blog.seo.ogDescription,
        ogImage: parsedSeo.ogImage ?? blog.seo.ogImage,
      };
    }

    blog.updatedBy = req.user?.id || null;

    await blog.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Blog post updated successfully",
      data: blog,
    });
  } catch (error) {
    console.error("Error updating blog:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const getBlogById = async (req, res) => {
  try {
    const { id } = req.params;
    const blog = await BlogMaster.findById(id);

    if (!blog) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Blog post not found",
      });
    }

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: blog,
    });
  } catch (error) {
    console.error("Error fetching blog:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const deleteBlog = async (req, res) => {
  try {
    const { id } = req.params;
    const blog = await BlogMaster.findById(id);

    if (!blog) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Blog post not found",
      });
    }

    await BlogMaster.findByIdAndDelete(id);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Blog post deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting blog:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const toggleBlogStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { field, value } = req.body; // field: 'isActive', 'isFeatured', 'isTrending', 'status'

    const allowedFields = ["isActive", "isFeatured", "isTrending", "allowComments", "status"];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({
        isOk: false,
        status: 400,
        message: "Invalid toggle field",
      });
    }

    const blog = await BlogMaster.findById(id);
    if (!blog) {
      return res.status(404).json({
        isOk: false,
        status: 404,
        message: "Blog post not found",
      });
    }

    if (field === "status") {
      blog.status = value;
      if (value === "Published") {
        blog.publishDate = new Date();
      }
    } else {
      blog[field] = value !== undefined ? Boolean(value) : !blog[field];
    }
    await blog.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: `Blog ${field} updated successfully`,
      data: blog,
    });
  } catch (error) {
    console.error("Error toggling blog status:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listBlogsByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, category, status, isActive } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 10;

    let matchCondition = {};
    if (isActive !== undefined && isActive !== "" && isActive !== "All" && isActive !== null) {
      matchCondition.isActive = isActive === true || isActive === "true";
    }
    if (status && status !== "All") {
      matchCondition.status = status;
    }
    if (category && category !== "All") {
      matchCondition.category = category;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { excerpt: { $regex: escaped, $options: "i" } },
        { author: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowedFields = ["title", "status", "publishDate", "viewsCount", "createdAt"];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "createdAt";
    const sortOrder = sortdir === "asc" ? 1 : -1;

    const totalCount = await BlogMaster.countDocuments(matchCondition);
    const data = await BlogMaster.find(matchCondition)
      .sort({ [safeSortField]: sortOrder })
      .skip(safeSkip)
      .limit(safePerPage);

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: [
        {
          count: totalCount,
          data: data,
        },
      ],
    });
  } catch (error) {
    console.error("Error listing blogs by params:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const getBlogStats = async (req, res) => {
  try {
    const totalBlogs = await BlogMaster.countDocuments();
    const publishedBlogs = await BlogMaster.countDocuments({ status: "Published" });
    const draftBlogs = await BlogMaster.countDocuments({ status: "Draft" });
    const viewsAggregate = await BlogMaster.aggregate([
      { $group: { _id: null, totalViews: { $sum: "$viewsCount" } } },
    ]);
    const totalViews = viewsAggregate[0]?.totalViews || 0;

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: {
        totalBlogs,
        publishedBlogs,
        draftBlogs,
        totalViews,
      },
    });
  } catch (error) {
    console.error("Error fetching blog stats:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
