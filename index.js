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

app.get("/wake-up", (req, res) => res.status(200).send("Awake!"));
app.get("/", (req, res) => res.status(200).send("OK"));

// --- ฟังก์ชันเสริม: โหลด Sheet แบบรวดเร็ว ---
async function getActiveSheet() {
  await doc.loadInfo();
  return doc.sheetsByIndex[0];
}

async function saveNewMember(userId, displayName, groupId) {
  try {
    const sheet = await getActiveSheet();
    const newMember = {
      "User ID": userId || "N/A",
      "Display Name": displayName || "สมาชิกใหม่",
      "Join Date": moment().format("YYYY-MM-DD"),
      Status: "Active",
      "Group ID": groupId || "Direct Message",
    };
    await sheet.addRow(newMember);

    if (ADMIN_LINE_ID) {
      await client
        .pushMessage(ADMIN_LINE_ID, {
          type: "text",
          text: `✅ [บันทึกใหม่]\n👤: ${newMember["Display Name"]}\n📅: ${newMember["Join Date"]}`,
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error("❌ Save Error:", err);
  }
}

async function removeMember(userId) {
  try {
    const sheet = await getActiveSheet();
    const rows = await sheet.getRows();
    const targetRow = rows.find((row) => row.get("User ID") === userId);
    if (targetRow) {
      const name = targetRow.get("Display Name");
      await targetRow.delete();
      if (ADMIN_LINE_ID) {
        await client
          .pushMessage(ADMIN_LINE_ID, {
            type: "text",
            text: `🗑️ [ลบสมาชิก]\n👤: ${name}\n⚠️: ออกจากกลุ่ม/โดนลบ`,
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error("❌ Remove Error:", err);
  }
}

// ระบบตรวจสอบอายุรายวัน (09:00 น.)
cron.schedule("0 9 * * *", async () => {
  try {
    const sheet = await getActiveSheet();
    const rows = await sheet.getRows();
    const today = moment();
    for (let row of rows) {
      if (row.get("Status") === "Active") {
        const joinDateStr = row.get("Join Date");
        if (!joinDateStr) continue;
        const daysDiff = today.diff(moment(joinDateStr), "days");
        const uId = row.get("User ID");

        if (daysDiff >= 27 && daysDiff < 30) {
          await client
            .pushMessage(uId, {
              type: "text",
              text: `📢 อีก ${30 - daysDiff} วันจะหมดอายุสมาชิกค่ะ`,
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
                text: `🚨 [หมดอายุ]\n👤: ${row.get("Display Name")}\n🆔: ${uId}`,
              })
              .catch(() => {});
          }
          await row.delete();
        }
      }
    }
  } catch (err) {
    console.error("Cron Error", err);
  }
});

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => res.status(500).end());
});

async function handleEvent(event) {
  if (!event || !event.type || !event.source) return null;
  const groupId = event.source.groupId;
  const isGroup = !!groupId;

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
          try {
            const p = await client.getProfile(member.userId);
            displayName = p.displayName;
          } catch (e2) {}
        }

        await saveNewMember(member.userId, displayName, groupId);

        const sheet = await getActiveSheet();
        await sheet.loadCells("A1:K1");
        const img1 = sheet.getCellByA1("F1").value;
        const img2 = sheet.getCellByA1("G1").value;
        const welTxt = sheet.getCellByA1("H1").value || "ยินดีต้อนรับค่ะ";

        const messages = [];
        if (img1?.toString().startsWith("https")) {
          messages.push({
            type: "image",
            originalContentUrl: img1.toString().trim(),
            previewImageUrl: img1.toString().trim(),
          });
        }
        if (img2?.toString().startsWith("https")) {
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
        console.error("MemberJoin Error", err);
      }
    }
  }

  // 2. กรณีคนออก
  if (event.type === "memberLeft") {
    for (let member of event.left.members) {
      await removeMember(member.userId);
    }
  }

  // 3. กรณีส่งข้อความ
  if (event.type === "message" && event.message.type === "text") {
    const userId = event.source.userId;
    if (!userId) return null;
    const userMsg = event.message.text.trim();

    try {
      const sheet = await getActiveSheet();
      await sheet.loadCells("A1:K1");
      const payTxt = (sheet.getCellByA1("I1").value || "รอแอดมินแจ้งนะคะ")
        .toString()
        .trim();
      const conTxt = (sheet.getCellByA1("J1").value || "รอสักครู่นะคะ")
        .toString()
        .trim();

      if (!isGroup) {
        // ทำงานเฉพาะแชทส่วนตัว (ไม่ตอบอัตโนมัติในกลุ่มเพื่อลดความรำคาญ)
        const payKeyword =
          /สนใจ|ชำระเงิน|จ่ายเงิน|เลขบัญชี|ช่องทางชำระเงิน|ติดต่อแอดมิน/g;
        if (payKeyword.test(userMsg)) {
          await client
            .replyMessage(event.replyToken, { type: "text", text: payTxt })
            .catch(() => {});
        } else if (userId !== ADMIN_LINE_ID) {
          await client
            .replyMessage(event.replyToken, { type: "text", text: conTxt })
            .catch(() => {});
        }
      }

      // แจ้งเตือนแอดมิน (ทำงานทั้งในกลุ่มและส่วนตัว)
      if (userId !== ADMIN_LINE_ID && ADMIN_LINE_ID) {
        let name = "ไม่ทราบชื่อ";
        try {
          const p = isGroup
            ? await client.getGroupMemberProfile(groupId, userId)
            : await client.getProfile(userId);
          name = p.displayName;
        } catch (e) {}
        await client
          .pushMessage(ADMIN_LINE_ID, {
            type: "text",
            text: `💬 [ข้อความใหม่]\n👤: ${name}\n📍: ${isGroup ? "ในกลุ่ม" : "ส่วนตัว"}\n💬: ${userMsg}`,
          })
          .catch(() => {});
      }
    } catch (err) {
      console.error("Message Error", err);
    }
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 บอทพร้อมทำงานที่พอร์ต ${PORT}`));
