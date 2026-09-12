import mongoose from "mongoose";
import dotenv from "dotenv";
import { sendMail } from "./services/mailService.js";
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

    console.log(`Sending test email TO: ${testRecipient}...`);

    // 4. Send through the shared transport.
    //
    // This script used to build its own nodemailer transport, which made it a
    // test of a COPY of the send path rather than of the path production uses —
    // the two drifted the moment either changed. It now exercises exactly the
    // code an OTP or a lead notification runs through, so a green run here means
    // something.
    const info = await sendMail({
      setup: template.emailFrom,
      fromName: template.mailerName,
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
