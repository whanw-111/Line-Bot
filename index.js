const line = require("@line/bot-sdk");
const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const moment = require("moment");
const cron = require("node-cron");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.CHANNEL_SECRET || "",
};

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_LINE_ID = process.env.ADMIN_LINE_ID;

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const client = new line.Client(config);
const app = express();
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// สำหรับปลุกบอท (Cron-job.org)
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

async function saveNewMember(userId, displayName, groupId) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({
      "User ID": userId,
      "Display Name": displayName,
      "Join Date": moment().format("YYYY-MM-DD"),
      Status: "Active",
      "Group ID": groupId || "Direct Message",
    });
  } catch (err) {
    console.error("❌ Sheet Save Error:", err.message);
  }
}

// ระบบตรวจสอบอายุสมาชิก (9:00 AM)
cron.schedule("0 9 * * *", async () => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const today = moment();
    for (let row of rows) {
      if (row.get("Status") === "Active") {
        const joinDateStr = row.get("Join Date");
        if (!joinDateStr) continue;

        const joinDate = moment(joinDateStr);
        const daysDiff = today.diff(joinDate, "days");
        const uId = row.get("User ID");

        if (daysDiff >= 27 && daysDiff < 30) {
          await client
            .pushMessage(uId, {
              type: "text",
              text: `📢 แจ้งเตือน: อีก ${30 - daysDiff} วันจะหมดอายุสมาชิกค่ะ`,
            })
            .catch(() => {});
        } else if (daysDiff >= 30) {
          await client
            .pushMessage(uId, { type: "text", text: `🚫 หมดอายุสมาชิกแล้วค่ะ` })
            .catch(() => {});
          if (ADMIN_LINE_ID) {
            await client
              .pushMessage(ADMIN_LINE_ID, {
                type: "text",
                text: `🚨 [หมดอายุ] ${row.get("Display Name")} (${uId})`,
              })
              .catch(() => {});
          }
          await row.delete();
        }
      }
    }
  } catch (err) {
    console.error("Cron Error");
  }
});

// ✅ นำ Middleware กลับมาใส่เพื่อความปลอดภัย (ห้ามลบ)
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook Middleware Error");
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (!event.source || !event.source.userId) return null;

  const userId = event.source.userId;
  const groupId = event.source.groupId;

  // 1. กรณีคนเข้ากลุ่ม
  if (event.type === "memberJoined") {
    for (let member of event.joined.members) {
      try {
        let displayName = "สมาชิกใหม่";
        try {
          const profile = await client.getGroupMemberProfile(
            groupId,
            member.userId,
          );
          displayName = profile.displayName;
        } catch (e) {
          console.log("Profile Fetch Fail");
        }

        await saveNewMember(member.userId, displayName, groupId);

        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        await sheet.loadCells("F1:J1");

        const img1 = sheet.getCellByA1("F1").value;
        const img2 = sheet.getCellByA1("G1").value;
        const welTxt = sheet.getCellByA1("H1").value || "ยินดีต้อนรับค่ะ";

        const messages = [];
        if (img1 && img1.toString().startsWith("https")) {
          messages.push({
            type: "image",
            originalContentUrl: img1.toString().trim(),
            previewImageUrl: img1.toString().trim(),
          });
        }
        if (img2 && img2.toString().startsWith("https")) {
          messages.push({
            type: "image",
            originalContentUrl: img2.toString().trim(),
            previewImageUrl: img2.toString().trim(),
          });
        }
        messages.push({
          type: "text",
          text: `สวัสดีคุณ ${displayName} ${welTxt}`,
        });

        await client.replyMessage(event.replyToken, messages).catch(() => {});
      } catch (err) {
        console.error("Joined Event Error");
      }
    }
  }

  // 2. กรณีส่งข้อความ
  if (event.type === "message" && event.message.type === "text") {
    const userMsg = event.message.text;
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0];
      await sheet.loadCells("I1:J1");

      const payTxt = sheet.getCellByA1("I1").value || "รอแอดมินแจ้งนะคะ";
      const conTxt = sheet.getCellByA1("J1").value || "รอสักครู่นะคะ";

      if (userMsg === "สนใจ" || userMsg === "ช่องทางชำระเงิน") {
        await client
          .replyMessage(event.replyToken, { type: "text", text: payTxt })
          .catch(() => {});
      } else if (userMsg === "ติดต่อแอดมิด") {
        await client
          .replyMessage(event.replyToken, { type: "text", text: conTxt })
          .catch(() => {});
      } else {
        if (userId === ADMIN_LINE_ID) return null;
        await client
          .replyMessage(event.replyToken, { type: "text", text: conTxt })
          .catch(() => {});

        let name = "สมาชิก";
        try {
          const p = groupId
            ? await client.getGroupMemberProfile(groupId, userId)
            : await client.getProfile(userId);
          name = p.displayName;
        } catch (e) {}

        if (ADMIN_LINE_ID) {
          await client
            .pushMessage(ADMIN_LINE_ID, {
              type: "text",
              text: `📢 มีคนทัก!\n👤 ชื่อ: ${name}\n💬: ${userMsg}`,
            })
            .catch(() => {});
        }
      }
    } catch (err) {
      console.error("Message Processing Error");
    }
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 ระบบพร้อมทำงานที่พอร์ต ${PORT}`);
});