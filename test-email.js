import mongoose from "mongoose";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import EmailSetup from "./models/EmailSetup.js";
import EmailFor from "./models/EmailFor.js";
import EmailTemplate from "./models/EmailTemplate.js";

dotenv.config();

const testRecipient = process.argv[2];

if (!testRecipient) {
  console.error("❌ Error: Please provide an email address where you want to receive the test email.");
  console.log("Usage: node test-email.js <your-personal-email@example.com>");
  process.exit(1);
}

const runTest = async () => {
  try {
    console.log("Connecting to Database...");
    await mongoose.connect(process.env.DATABASE, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ DB Connected.");

    // 1. Fetch Forget Password Email For Type
    const emailForObj = await EmailFor.findOne({ emailFor: "Forget Password" });
    if (!emailForObj) {
      console.error("❌ 'Forget Password' email purpose not found in EmailFor collection.");
      process.exit(1);
    }

    // 2. Fetch Active Email Template
    const template = await EmailTemplate.findOne({
      emailFor: emailForObj._id,
      isActive: true,
    }).populate("emailFrom");

    if (!template) {
      console.error("❌ No active EmailTemplate found for 'Forget Password'.");
      process.exit(1);
    }
    console.log(`✅ Found active template: "${template.templateName}"`);
    console.log(`✅ Sending FROM: "${template.emailFrom.email}"`);

    // 3. Prep data
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    let emailBody = template.emailSignature;
    emailBody = emailBody.replace("{{USERNAME}}", "Test User");
    emailBody = emailBody.replace("{{OTP_CODE}}", otp);

    // 4. Create Transporter
    let transporter;
    if (template.emailFrom.host.toLowerCase().includes("gmail")) {
      transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: template.emailFrom.email,
          pass: template.emailFrom.appPassword,
        },
      });
    } else {
      transporter = nodemailer.createTransport({
        host: template.emailFrom.host,
        port: template.emailFrom.port,
        secure: template.emailFrom.SSL,
        auth: {
          user: template.emailFrom.email,
          pass: template.emailFrom.appPassword,
        },
      });
    }

    console.log(`Sending test email TO: ${testRecipient}...`);
    
    // Send email
    const info = await transporter.sendMail({
      from: `"${template.mailerName}" <${template.emailFrom.email}>`,
      to: testRecipient,
      cc: template.emailCC || "",
      bcc: template.emailBCC || "",
      subject: `[TEST] ${template.emailSubject}`,
      html: emailBody,
    });

    console.log("🎉 Email sent successfully!");
    console.log("Message Info:", info);

  } catch (error) {
    console.error("❌ Error running email test:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database.");
  }
};

runTest();
