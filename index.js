const line = require("@line/bot-sdk"),
  express = require("express"),
  { GoogleSpreadsheet } = require("google-spreadsheet"),
  { JWT } = require("google-auth-library"),
  moment = require("moment"),
  cron = require("node-cron");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.CHANNEL_SECRET || "",
};
const SPREADSHEET_ID = process.env.SPREADSHEET_ID,
  ADMIN_LINE_ID = process.env.ADMIN_LINE_ID;
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const client = new line.Client(config),
  app = express(),
  doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
const getSheet = async () => {
  await doc.loadInfo();
  return doc.sheetsByIndex[0];
};

// --- ฟังก์ชันหลัก ---
async function saveNewMember(userId, displayName, groupId) {
  try {
    const sheet = await getSheet();
    await sheet.addRow({
      "User ID": userId,
      "Display Name": displayName,
      "Join Date": moment().format("YYYY-MM-DD"),
      Status: "Active",
      "Group ID": groupId || "Direct Message",
    });
    if (ADMIN_LINE_ID)
      client
        .pushMessage(ADMIN_LINE_ID, {
          type: "text",
          text: `✅ [บันทึกใหม่]\n👤: ${displayName}`,
        })
        .catch(() => {});
  } catch (err) {
    console.error("Save Error:", err);
  }
}

async function removeMember(userId) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const row = rows.find((r) => r.get("User ID") === userId);
    if (row) {
      const name = row.get("Display Name");
      await row.delete();
      if (ADMIN_LINE_ID)
        client
          .pushMessage(ADMIN_LINE_ID, {
            type: "text",
            text: `🗑️ [ลบสมาชิก]\n👤: ${name}`,
          })
          .catch(() => {});
    }
  } catch (err) {
    console.error("Remove Error:", err);
  }
}

// --- Cron Job ---
cron.schedule("0 9 * * *", async () => {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    for (let row of rows) {
      if (row.get("Status") !== "Active") continue;
      const daysDiff = moment().diff(moment(row.get("Join Date")), "days");
      if (daysDiff >= 30) {
        client
          .pushMessage(row.get("User ID"), {
            type: "text",
            text: "🚫 หมดอายุสมาชิกแล้วค่ะ",
          })
          .catch(() => {});
        await removeMember(row.get("User ID"));
      } else if (daysDiff >= 27) {
        client
          .pushMessage(row.get("User ID"), {
            type: "text",
            text: `📢 อีก ${30 - daysDiff} วันจะหมดอายุค่ะ`,
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error("Cron Error", err);
  }
});

// --- Webhook ---
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((r) => res.json(r))
    .catch(() => res.status(500).end());
});

async function handleEvent(event) {
  if (!event.source) return null;
  const { userId, groupId } = event.source;

  // 1. Member Join
  if (event.type === "memberJoined") {
    for (let m of event.joined.members) {
      let p = await client
        .getGroupMemberProfile(groupId, m.userId)
        .catch(() => ({ displayName: "สมาชิกใหม่" }));
      await saveNewMember(m.userId, p.displayName, groupId);
      const sheet = await getSheet();
      await sheet.loadCells("F1:H1");
      const messages = [];
      ["F1", "G1"].forEach((cell) => {
        const url = sheet.getCellByA1(cell).value;
        if (url?.startsWith("http"))
          messages.push({
            type: "image",
            originalContentUrl: url,
            previewImageUrl: url,
          });
      });
      messages.push({
        type: "text",
        text: `สวัสดีคุณ ${p.displayName} ${sheet.getCellByA1("H1").value || "ยินดีต้อนรับค่ะ"}`,
      });
      await client.replyMessage(event.replyToken, messages).catch(() => {});
    }
  }

  // 2. Member Left
  if (event.type === "memberLeft") {
    for (let m of event.left.members) await removeMember(m.userId);
  }

  // 3. Message
  if (event.type === "message" && event.message.type === "text") {
    const msg = event.message.text.trim();
    const sheet = await getSheet();
    await sheet.loadCells("I1:J1");

    if (!groupId) {
      const isPay = /สนใจ|ชำระเงิน|จ่ายเงิน|เลขบัญชี|ช่องทางชำระเงิน/g.test(
        msg,
      );
      await client
        .replyMessage(event.replyToken, {
          type: "text",
          text: isPay
            ? sheet.getCellByA1("I1").value || "รอแอดมินแจ้ง"
            : sheet.getCellByA1("J1").value || "รอสักครู่",
        })
        .catch(() => {});
    }

    if (ADMIN_LINE_ID && userId !== ADMIN_LINE_ID) {
      const p = await client
        .getProfile(userId)
        .catch(() => ({ displayName: "ไม่ทราบชื่อ" }));
      await client
        .pushMessage(ADMIN_LINE_ID, {
          type: "text",
          text: `💬 [ข้อความจาก ${p.displayName}]\n💬: ${msg}`,
        })
        .catch(() => {});
    }
  }
}

app.listen(process.env.PORT || 10000);
