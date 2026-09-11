import Guide from "../../models/Guide.js";
import fs from "fs";
import path from "path";

const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const deleteFileSafe = (relativeFilePath) => {
  if (!relativeFilePath) return;
  try {
    const fullPath = path.resolve(relativeFilePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`[FILE] Deleted file: ${fullPath}`);
    }
  } catch (err) {
    console.error(`[FILE] Failed to delete file: ${relativeFilePath}`, err.message);
  }
};

export const createGuide = async (req, res) => {
  try {
    const { title, type, description, youtubeUrl, sequence, isActive } = req.body;

    if (!title) {
      if (req.file) deleteFileSafe(req.file.path);
      return res.status(400).json({ isOk: false, status: 400, message: "Title is required" });
    }
    if (!type) {
      if (req.file) deleteFileSafe(req.file.path);
      return res.status(400).json({ isOk: false, status: 400, message: "Type is required" });
    }

    let filePath = "";
    if (type === "System Video" || type === "Document") {
      if (req.file) {
        filePath = req.file.path.replace(/\\/g, "/"); // Ensure unified web-friendly separators
      } else {
        return res.status(400).json({ isOk: false, status: 400, message: `File upload is required for type: ${type}` });
      }
    }

    const guide = new Guide({
      title: title.trim(),
      type,
      description: description ? description.trim() : "",
      youtubeUrl: type === "YouTube" ? (youtubeUrl || "").trim() : "",
      filePath,
      sequence: sequence !== undefined ? Number(sequence) : 0,
      isActive: isActive !== undefined ? (isActive === true || isActive === "true") : true,
    });

    await guide.save();

    return res.status(201).json({
      isOk: true,
      status: 201,
      message: "Guide created successfully",
      data: guide,
    });
  } catch (error) {
    console.error("Error creating guide:", error);
    if (req.file) deleteFileSafe(req.file.path);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const updateGuide = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, type, description, youtubeUrl, sequence, isActive } = req.body;

    const guide = await Guide.findById(id);
    if (!guide) {
      if (req.file) deleteFileSafe(req.file.path);
      return res.status(404).json({ isOk: false, status: 404, message: "Guide not found" });
    }

    if (title !== undefined) guide.title = title.trim();
    if (type !== undefined) guide.type = type;
    if (description !== undefined) guide.description = description.trim();
    if (sequence !== undefined) guide.sequence = Number(sequence);
    if (isActive !== undefined) guide.isActive = (isActive === true || isActive === "true");

    if (guide.type === "YouTube") {
      if (youtubeUrl !== undefined) guide.youtubeUrl = youtubeUrl.trim();
      // If switched from self-hosted to youtube, delete the old file
      if (guide.filePath) {
        deleteFileSafe(guide.filePath);
        guide.filePath = "";
      }
    } else {
      guide.youtubeUrl = "";
      // If a new file is uploaded
      if (req.file) {
        // Delete old file
        if (guide.filePath) {
          deleteFileSafe(guide.filePath);
        }
        guide.filePath = req.file.path.replace(/\\/g, "/");
      }
    }

    await guide.save();

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Guide updated successfully",
      data: guide,
    });
  } catch (error) {
    console.error("Error updating guide:", error);
    if (req.file) deleteFileSafe(req.file.path);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const deleteGuide = async (req, res) => {
  try {
    const { id } = req.params;
    const guide = await Guide.findById(id);
    if (!guide) {
      return res.status(404).json({ isOk: false, status: 404, message: "Guide not found" });
    }

    // Clean up file from disk
    if (guide.filePath) {
      deleteFileSafe(guide.filePath);
    }

    await Guide.findByIdAndDelete(id);

    return res.status(200).json({
      isOk: true,
      status: 200,
      message: "Guide deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting guide:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};

export const listGuidesByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive, type } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 10;

    let matchCondition = {};
    if (isActive !== undefined && isActive !== "") {
      matchCondition.isActive = isActive === true || isActive === "true";
    }
    if (type) {
      matchCondition.type = type;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";
    if (safeMatch) {
      const escaped = escapeRegex(safeMatch);
      matchCondition.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { description: { $regex: escaped, $options: "i" } },
      ];
    }

    const allowedFields = ["title", "sequence", "type", "isActive", "createdAt"];
    const safeSortField = allowedFields.includes(sorton) ? sorton : "sequence";
    const sortOrder = sortdir === "desc" ? -1 : 1; // Default to ascending sequence order, or specified

    const totalCount = await Guide.countDocuments(matchCondition);
    const data = await Guide.find(matchCondition)
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
    console.error("Error listing guides:", error);
    return res.status(500).json({
      isOk: false,
      status: 500,
      message: error.message || "Internal server error",
    });
  }
};
