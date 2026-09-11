import express from "express";
import { createSecureUpload } from "../../middlewares/secureUpload.js";
import {
  createGuide,
  updateGuide,
  deleteGuide,
  listGuidesByParams,
} from "../../controllers/v1/guide.controller.js";

const router = express.Router();

const guideUpload = createSecureUpload({
  destination: "uploads/guides",
  fieldName: "file",
  maxSize: 50 * 1024 * 1024, // 50MB maximum for videos
  allowedMimes: [
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ],
  allowedExts: [
    ".mp4",
    ".webm",
    ".ogg",
    ".mov",
    ".pdf",
    ".doc",
    ".docx"
  ]
});

router.post("/guides", guideUpload, createGuide);
router.put("/guides/:id", guideUpload, updateGuide);
router.delete("/guides/:id", deleteGuide);
router.post("/guides/list", listGuidesByParams);

export default router;
