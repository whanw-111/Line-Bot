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
    console.log(`✅ บันทึกสมาชิกใหม่เรียบร้อย: ${displayName}`);
  } catch (err) {
    console.error("❌ Sheet Save Error:", err.message);
  }
}

// ระบบตรวจสอบอายุสมาชิก (รันทุกวัน 9:00 น.)
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
          await client.pushMessage(uId, {
            type: "text",
            text: `📢 แจ้งเตือน: อีก ${30 - daysDiff} วันจะหมดอายุสมาชิกค่ะ อย่าลืมต่ออายุนะคะ`,
          }).catch(() => {});
        } else if (daysDiff >= 30) {
          await client.pushMessage(uId, { type: "text", text: `🚫 หมดอายุสมาชิกแล้วค่ะ ขอบคุณที่ใช้บริการนะคะ` }).catch(() => {});
          if (ADMIN_LINE_ID) {
            await client.pushMessage(ADMIN_LINE_ID, {
              type: "text",
              text: `🚨 [ระบบลบชื่อ] หมดอายุสมาชิก:\n👤: ${row.get("Display Name")}\n🆔: ${uId}`,
            }).catch(() => {});
          }
          await row.delete();
        }
      }
    }
  } catch (err) {
    console.error("Cron Error:", err.message);
  }
});

// Webhook Endpoint พร้อม Middleware
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook Error");
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (!event.source || !event.source.userId) return null;

  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const isGroup = !!groupId;

  // 1. กรณีคนเข้ากลุ่ม (ส่งรูป F1, G1 และข้อความ H1)
  if (event.type === "memberJoined") {
    for (let member of event.joined.members) {
      try {
        let displayName = "สมาชิกใหม่";
        try {
          const profile = await client.getGroupMemberProfile(groupId, member.userId);
          displayName = profile.displayName;
        } catch (e) { console.log("Profile Fetch Fail"); }

        // บันทึกลงตาราง (A-E)
        await saveNewMember(member.userId, displayName, groupId);

        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        // ✅ โหลดตั้งแต่ A1:K1 ตามที่พี่ทัก เพื่อให้ระบบสมาชิกทำงานได้
        await sheet.loadCells("A1:K1");

        const img1 = sheet.getCellByA1("F1").value;
        const img2 = sheet.getCellByA1("G1").value;
        const welTxt = sheet.getCellByA1("H1").value || "ยินดีต้อนรับค่ะ";

        const messages = [];
        if (img1 && img1.toString().startsWith("https")) {
          messages.push({ type: "image", originalContentUrl: img1.toString().trim(), previewImageUrl: img1.toString().trim() });
        }
        if (img2 && img2.toString().startsWith("https")) {
          messages.push({ type: "image", originalContentUrl: img2.toString().trim(), previewImageUrl: img2.toString().trim() });
        }
        messages.push({ type: "text", text: `สวัสดีคุณ ${displayName} ${welTxt}` });

        await client.replyMessage(event.replyToken, messages).catch(() => {});
      } catch (err) {
        console.error("Joined Event Error:", err.message);
      }
    }
  }

  // 2. กรณีส่งข้อความ (แยกกลุ่ม และ OA)
  if (event.type === "message" && event.message.type === "text") {
    const userMsg = event.message.text;
    try {
      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0];
      // ✅ โหลดตั้งแต่ A1:K1 เพื่อความสมบูรณ์ของข้อมูล
      await sheet.loadCells("A1:K1");

      const payTxt = (sheet.getCellByA1("I1").value || "แจ้งชำระเงินได้เลยค่ะ").toString().trim();
      const conTxt = (sheet.getCellByA1("J1").value || "รอแอดมินสักครู่นะคะ").toString().trim();
      const groupRes = (sheet.getCellByA1("K1").value || "ทักแอดมินไวกว่านะคะพี่ 🙏").toString().trim();

      if (isGroup) {
        // --- อยู่ในกลุ่ม ---
        if (userId !== ADMIN_LINE_ID) {
          // ตอบกลับทุกคนด้วยข้อความในช่อง K1
          await client.replyMessage(event.replyToken, { type: "text", text: groupRes }).catch(() => {});
        }
      } else {
        // --- อยู่ในแชทส่วนตัว (OA) ---
        // ใช้ RegExp เช็คคำที่เกี่ยวข้องกับการจ่ายเงิน
        const payKeyword = /สนใจ|ชำระเงิน|จ่ายเงิน|เลขบัญชี|โอนเงิน/g;
        if (payKeyword.test(userMsg)) {
          await client.replyMessage(event.replyToken, { type: "text", text: payTxt }).catch(() => {});
        } else {
          // ถ้าทักอย่างอื่น ให้ส่งข้อความรอแอดมิน (J1)
          await client.replyMessage(event.replyToken, { type: "text", text: conTxt }).catch(() => {});
        }
      }

      // แจ้งเตือนแอดมินเสมอ (Push Message)
      if (userId !== ADMIN_LINE_ID && ADMIN_LINE_ID) {
        let name = "สมาชิก";
        try {
          const p = isGroup ? await client.getGroupMemberProfile(groupId, userId) : await client.getProfile(userId);
          name = p.displayName;
        } catch (e) {}
        await client.pushMessage(ADMIN_LINE_ID, {
          type: "text",
          text: `📢 มีคนทัก (${isGroup ? 'ในกลุ่ม' : 'ส่วนตัว'})\n👤 ชื่อ: ${name}\n💬: ${userMsg}`,
        }).catch(() => {});
      }
    } catch (err) {
      console.error("Message Error:", err.message);
    }
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 บอทพร้อมทำงานที่พอร์ต ${PORT}`);
});